// The iPhone app on TestFlight, through the App Store Connect API with the key in the config folder, the same key that
// notarizes the Mac app. scripts/testflight.sh and scripts/release.sh run it:
//   node scripts/testflight.ts key <config folder>            prints the key's exports for testflight.sh to eval
//   node scripts/testflight.ts check <config folder> <build>  fails unless Xcode is new enough for App Store Connect, it
//                                                             has the app, and <build> is newer than every build uploaded
//   node scripts/testflight.ts age <config folder>            warns when the last TestFlight build is over 60 days old
//   node scripts/testflight.ts revoke-runner <config folder>  on a GitHub Actions runner, revokes the certificates Xcode
//                                                             made there (.github/workflows/testflight.yml)
//   node scripts/testflight.ts testers <config folder> <build> once <build> is processed, gives it to the Testers group,
//                                                             whose public link anyone can join, submits it for Beta App
//                                                             Review, and prints the link
//   node scripts/testflight.ts needed <config folder>         whether this checkout's commit needs an upload: only when
//                                                             its iPhone native code differs from TestFlight's latest
//                                                             build's, as upload=true|false in $GITHUB_OUTPUT
//   node scripts/testflight.ts latest <config folder> <file>  writes the newest build testers can install, with its
//                                                             iPhone shell hash, to <file>, for the release pipeline's
//                                                             inbox (.github/workflows/testflight-review.yml)
// A build's number is its commit's time, so git's history tells which commit a build came from, and so its shell hash.
// None of this is in ios/, so none of it is in the iPhone app's shell hash (scripts/shell-hash.ts).

import { execFileSync } from 'node:child_process';
import { createHash, sign } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const API = 'https://api.appstoreconnect.apple.com';
const DAY_MS = 86_400_000;
// TestFlight builds stop opening 90 days after upload. Warning at 60 leaves a month to upload another.
const EXPIRES_AFTER_DAYS = 90;
const WARN_AFTER_DAYS = 60;
// App Store Connect refuses builds made with an older SDK than Xcode 26's.
const MIN_XCODE = 26;
// The repository's root, whose git history tells which commit a TestFlight build came from.
const REPO = join(import.meta.dirname, '../..');

export interface AscKey {
  path: string;
  keyId: string;
  issuerId: string;
}

/**
 * The App Store Connect key in the config folder: AuthKey_<key id>.p8, as App Store Connect names it on download, and
 * its issuer id in asc-issuer-id beside it. Errors name what's wrong, never what the files hold.
 */
// shortcut: the same rules as notarizeEnv in mac-signing.ts, copied since a script Node runs directly can only import it
// as mac-signing.ts, which this tsconfig refuses; share one once it sets allowImportingTsExtensions.
export function ascKey(dir: string): AscKey {
  const keys = existsSync(dir) ? readdirSync(dir).filter((name) => /^AuthKey_.*\.p8$/.test(name)) : [];
  const issuerFile = join(dir, 'asc-issuer-id');
  if (keys.length === 0 && !existsSync(issuerFile)) {
    throw new Error(`${dir} has no App Store Connect key: AuthKey_<key id>.p8 and asc-issuer-id. See docs/setup.md, TestFlight.`);
  }
  const problems: string[] = [];
  const keyId = keys.length === 1 ? /^AuthKey_([A-Z0-9]{10})\.p8$/.exec(keys[0]!)?.[1] : undefined;
  if (keys.length === 0) problems.push('asc-issuer-id needs its key, AuthKey_<key id>.p8, beside it');
  else if (keys.length > 1) problems.push(`holds ${keys.length} AuthKey_*.p8 files, so keep only the one to use`);
  else if (!keyId) problems.push('the key must be named AuthKey_<key id>.p8, as App Store Connect names it');
  const issuerId = existsSync(issuerFile) ? readFileSync(issuerFile, 'utf8').trim() : '';
  if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(issuerId)) {
    problems.push('asc-issuer-id must hold the issuer id from App Store Connect > Users and Access > Integrations');
  }
  if (problems.length > 0 || !keyId) throw new Error(`${dir}: ${problems.join('; ')}`);
  return { path: join(dir, keys[0]!), keyId, issuerId };
}

/** The app's bundle id from its xcconfig files, in the order Xcode reads them, so the last setting wins. */
export function bundleIdFrom(xcconfigs: string[]): string {
  let id: string | undefined;
  for (const text of xcconfigs) {
    for (const line of text.split('\n')) id = /^\s*MULTISCALE_BUNDLE_ID\s*=\s*([^\s/]+)/.exec(line)?.[1] ?? id;
  }
  if (!id) throw new Error('No MULTISCALE_BUNDLE_ID in the iPhone app’s xcconfig files');
  return id;
}

/** The project's bundle id: Config.xcconfig, then the git-ignored Config.local.xcconfig that may override it. */
function projectBundleId(): string {
  const dir = join(import.meta.dirname, '../ios/App');
  const files = ['Config.xcconfig', 'Config.local.xcconfig'].map((name) => join(dir, name)).filter((path) => existsSync(path));
  return bundleIdFrom(files.map((path) => readFileSync(path, 'utf8')));
}

/** A token for the App Store Connect API, signed with the key. Apple refuses any that lasts over 20 minutes. */
export function ascToken(key: { keyId: string; issuerId: string; pem: string }, now = Date.now()): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const iat = Math.floor(now / 1000);
  const unsigned = `${part({ alg: 'ES256', kid: key.keyId, typ: 'JWT' })}.${part({ iss: key.issuerId, iat, exp: iat + 15 * 60, aud: 'appstoreconnect-v1' })}`;
  // JWTs carry the signature as r and s side by side, not the DER that Node signs with by default.
  const signature = sign('sha256', Buffer.from(unsigned), { key: key.pem, dsaEncoding: 'ieee-p1363' });
  return `${unsigned}.${signature.toString('base64url')}`;
}

type Get = (path: string, query: Record<string, string>) => Promise<{ data: { id: string; attributes: Record<string, string> }[] }>;
type Delete = (path: string) => Promise<void>;
type Send = (method: 'POST' | 'PATCH', path: string, body: object) => Promise<{ data?: { id: string; attributes: Record<string, unknown> } }>;

/** A token, or a way to make one for each request: a token lasts 15 minutes, and waiting for processing can take longer. */
type Token = string | (() => string);

/** Requests from the App Store Connect API with the token. A refusal throws with Apple's own reason. */
async function ascRequest(fetchImpl: typeof fetch, token: Token, method: string, path: string, query = '', send?: object): Promise<unknown> {
  const headers: Record<string, string> = { authorization: `Bearer ${typeof token === 'function' ? token() : token}` };
  if (send) headers['content-type'] = 'application/json';
  const response = await fetchImpl(`${API}${path}${query}`, { method, headers, body: send && JSON.stringify(send) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = (body as { errors?: { code?: string; detail?: string; title?: string }[] }).errors?.[0];
    throw new Error(`App Store Connect refused ${method} ${path}: ${response.status} ${error?.code ?? ''}: ${error?.detail ?? error?.title ?? 'no reason given'}`);
  }
  return body;
}

export function ascGet(token: Token, fetchImpl: typeof fetch = fetch): Get {
  return (path, query) => ascRequest(fetchImpl, token, 'GET', path, `?${new URLSearchParams(query)}`) as ReturnType<Get>;
}

export function ascDelete(token: Token, fetchImpl: typeof fetch = fetch): Delete {
  return async (path) => void (await ascRequest(fetchImpl, token, 'DELETE', path));
}

export function ascSend(token: Token, fetchImpl: typeof fetch = fetch): Send {
  return (method, path, body) => ascRequest(fetchImpl, token, method, path, '', body) as ReturnType<Send>;
}

export interface TestflightState {
  /** Whether App Store Connect has an app record with the bundle id. */
  app: boolean;
  /** The latest build uploaded to it, if any. */
  last?: { build: number; uploaded: Date };
}

/** Whether App Store Connect has the app, and its latest upload. */
export async function testflightState(get: Get, bundleId: string): Promise<TestflightState> {
  // The filter can match more than the one id, so this picks the exact one.
  const apps = await get('/v1/apps', { 'filter[bundleId]': bundleId, 'fields[apps]': 'bundleId' });
  const app = apps.data.find((a) => a.attributes.bundleId === bundleId);
  if (!app) return { app: false };
  const builds = await get('/v1/builds', { 'filter[app]': app.id, sort: '-uploadedDate', limit: '1', 'fields[builds]': 'version,uploadedDate' });
  const last = builds.data[0]?.attributes;
  return last ? { app: true, last: { build: Number(last.version), uploaded: new Date(last.uploadedDate!) } } : { app: true };
}

/** Why a build can't be uploaded yet, or null when it can. App Store Connect refuses a build number it has had. */
export function uploadRefusal(state: TestflightState, bundleId: string, build: number): string | null {
  if (!state.app) {
    return `App Store Connect has no app with the bundle id ${bundleId} yet. Create it under Apps > New App, then run make testflight again.`;
  }
  if (state.last && build <= state.last.build) {
    return `TestFlight already has build ${state.last.build}, and this one is ${build}. A build is numbered by its commit's time, so commit something newer.`;
  }
  return null;
}

/** Why this Xcode can't make a build App Store Connect takes, from xcodebuild -version, or null when it can. */
export function xcodeRefusal(version: string): string | null {
  const found = /^Xcode (\d+)\S*/m.exec(version);
  if (found && Number(found[1]) >= MIN_XCODE) return null;
  return `App Store Connect takes only builds made with Xcode ${MIN_XCODE} or later, and this Mac has ${found?.[0] ?? 'no Xcode it could find'}. Update Xcode, or upload from GitHub Actions: docs/setup.md, TestFlight.`;
}

/** A warning when testers' TestFlight build is close to expiring, or they have none. Null when it's recent. */
export function ageWarning(state: TestflightState, now = new Date()): string | null {
  if (!state.app) return 'App Store Connect has no app for the iPhone app yet, so testers have no TestFlight build.';
  if (!state.last) return 'TestFlight has no build of the iPhone app yet. Run make testflight.';
  const days = Math.floor((now.getTime() - state.last.uploaded.getTime()) / DAY_MS);
  if (days <= WARN_AFTER_DAYS) return null;
  return `The last TestFlight build was uploaded ${days} days ago, and TestFlight builds expire after ${EXPIRES_AFTER_DAYS} days. Run make testflight.`;
}

/** The SHA-1 fingerprints of the signing identities that security find-identity lists. */
export function identityHashes(findIdentity: string): string[] {
  return [...new Set(findIdentity.match(/\b[0-9A-F]{40}\b/g) ?? [])];
}

/**
 * Revokes the team's certificates whose private keys are among the identities: on a fresh runner, those Xcode made for
 * the run's archive, which nothing can use once the runner is gone, and which would otherwise pile up a run at a time.
 * Returns their types.
 */
export async function revokeCertificates(get: Get, del: Delete, identities: string[]): Promise<string[]> {
  const certificates = await get('/v1/certificates', { 'fields[certificates]': 'certificateContent,certificateType', limit: '200' });
  const fingerprint = (content: string) => createHash('sha1').update(Buffer.from(content, 'base64')).digest('hex').toUpperCase();
  const made = certificates.data.filter((c) => identities.includes(fingerprint(c.attributes.certificateContent ?? '')));
  for (const certificate of made) await del(`/v1/certificates/${certificate.id}`);
  return made.map((c) => c.attributes.certificateType!);
}

// The external group whose public link testers join with.
const TESTERS = 'Testers';
const MINUTE_MS = 60_000;

interface BetaGroup {
  id: string;
  attributes: { name: string; isInternalGroup: boolean; publicLinkEnabled: boolean; publicLink: string | null };
}

/** Sends one, and treats App Store Connect's 409 as already done: a build already in the group, or already submitted. */
async function once(send: Send, path: string, body: object): Promise<void> {
  try {
    await send('POST', path, body);
  } catch (error) {
    if (!/: 409 /.test((error as Error).message)) throw error;
  }
}

/**
 * Apple's reasons for refusing build <build> once uploaded, or null while it hasn't. A refused upload never becomes a
 * build, and otherwise its reasons reach only the account holder's email.
 */
async function uploadRefusals(get: Get, appId: string, build: number): Promise<string | null> {
  const uploads = (await get(`/v1/apps/${appId}/buildUploads`, { 'filter[cfBundleVersion]': String(build), 'fields[buildUploads]': 'cfBundleVersion,state' })) as unknown as {
    data: { attributes: { state?: { state: string; errors?: { code: string; description: string }[] } } }[];
  };
  const failed = uploads.data.find((u) => u.attributes.state?.state === 'FAILED')?.attributes.state;
  return failed ? (failed.errors ?? []).map((e) => `ITMS-${e.code}: ${e.description}`).join(' ') || 'no reason given.' : null;
}

/**
 * Gives build <build> to the Testers group, making the group with its public link the first time, describes what to
 * test, and submits the build for Beta App Review, which external testers need. Waits, a minute at a time, while App
 * Store Connect processes the upload. Returns the public link.
 */
export async function publishToTesters(
  get: Get,
  send: Send,
  bundleId: string,
  build: number,
  whatToTest: string,
  wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  tries = 60,
): Promise<string> {
  const apps = await get('/v1/apps', { 'filter[bundleId]': bundleId, 'fields[apps]': 'bundleId' });
  const app = apps.data.find((a) => a.attributes.bundleId === bundleId);
  if (!app) throw new Error(`App Store Connect has no app with the bundle id ${bundleId}.`);
  let buildId = '';
  for (let tried = 1; !buildId; tried++) {
    const builds = await get('/v1/builds', { 'filter[app]': app.id, 'filter[version]': String(build), 'fields[builds]': 'version,processingState' });
    const state = builds.data[0]?.attributes.processingState;
    if (state === 'VALID') buildId = builds.data[0]!.id;
    else if (state && state !== 'PROCESSING') throw new Error(`App Store Connect couldn't process build ${build}: ${state}.`);
    else {
      const refused = state ? null : await uploadRefusals(get, app.id, build);
      if (refused) throw new Error(`App Store Connect refused build ${build} after its upload: ${refused}`);
      if (tried >= tries) throw new Error(`Build ${build} still wasn't ready in App Store Connect after ${tries} minutes. Run testflight.ts testers again later.`);
      await wait(MINUTE_MS);
    }
  }

  const groups = (await get(`/v1/apps/${app.id}/betaGroups`, { 'fields[betaGroups]': 'name,isInternalGroup,publicLinkEnabled,publicLink' })) as unknown as { data: BetaGroup[] };
  let group = groups.data.find((g) => g.attributes.name === TESTERS && !g.attributes.isInternalGroup);
  if (!group) {
    const attributes = { name: TESTERS, publicLinkEnabled: true, publicLinkLimitEnabled: false, feedbackEnabled: true };
    const made = await send('POST', '/v1/betaGroups', { data: { type: 'betaGroups', attributes, relationships: { app: { data: { type: 'apps', id: app.id } } } } });
    group = made.data as unknown as BetaGroup;
  } else if (!group.attributes.publicLinkEnabled || !group.attributes.publicLink) {
    const turnedOn = await send('PATCH', `/v1/betaGroups/${group.id}`, { data: { type: 'betaGroups', id: group.id, attributes: { publicLinkEnabled: true } } });
    group = turnedOn.data as unknown as BetaGroup;
  }

  const forBuild = { build: { data: { type: 'builds', id: buildId } } };
  await once(send, `/v1/betaGroups/${group.id}/relationships/builds`, { data: [{ type: 'builds', id: buildId }] });
  await once(send, '/v1/betaBuildLocalizations', { data: { type: 'betaBuildLocalizations', attributes: { locale: 'en-US', whatToTest }, relationships: forBuild } });
  await once(send, '/v1/betaAppReviewSubmissions', { data: { type: 'betaAppReviewSubmissions', relationships: forBuild } });
  if (!group.attributes.publicLink) throw new Error(`The ${TESTERS} group has no public link. Turn it on in App Store Connect > TestFlight.`);
  return group.attributes.publicLink;
}

/** The commits a build number names, from git log --format='%H %ct': testflight.sh numbers a build by its commit's time. */
export function commitsBuiltAs(log: string, build: number): string[] {
  return log.split('\n').flatMap((line) => {
    const [commit, time] = line.split(' ');
    return commit && Number(time) === build ? [commit] : [];
  });
}

// Run on the commit's own shell-hash.ts, in a process of its own. The iPhone app's hash doesn't depend on the Mac build.
const IOS_SHELL = "const [url, root] = process.argv.slice(1); const { shellHashes } = await import(url); console.log(shellHashes(root, { name: '', scheme: '', backendOrigins: [] }).ios);";

/**
 * The iPhone app's shell hash at <commit>, which its build carried and which the bundles it takes must match: from a
 * checkout of that commit, by that commit's own scripts/shell-hash.ts, so a build from before the hash changed is named
 * as it was. Throws when it can't tell.
 */
export function iosShellAt(repo: string, commit: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'testflight-shell-'));
  const checkout = join(dir, 'checkout');
  const frontend = join(checkout, 'frontend');
  try {
    execFileSync('git', ['worktree', 'add', '--quiet', '--detach', checkout, commit], { cwd: repo, stdio: 'ignore' });
    const shell = execFileSync(process.execPath, ['--input-type=module', '-e', IOS_SHELL, pathToFileURL(join(frontend, 'scripts/shell-hash.ts')).href, frontend], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (!/^\w+$/.test(shell)) throw new Error(`${commit}'s shell-hash.ts gave no iPhone shell hash`);
    return shell;
  } finally {
    // The checkout and git's note of it, so none pile up in the repository.
    try {
      execFileSync('git', ['worktree', 'remove', '--force', checkout], { cwd: repo, stdio: 'ignore' });
    } catch {
      // Never made: the commit isn't in the repository.
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The main commit TestFlight build <build> came from, and its iPhone shell hash, whoever uploaded it: GitHub Actions or
 * a Mac. Undefined when no commit on <ref> has its number, as for one uploaded from a branch, or the commits that share
 * the number have different native code.
 */
export function builtFrom(repo: string, build: number, ref = 'origin/main'): { commit: string; shell: string } | undefined {
  const commits = commitsBuiltAs(execFileSync('git', ['log', '--format=%H %ct', ref], { cwd: repo, encoding: 'utf8' }), build);
  const shells = new Set<string>();
  for (const commit of commits) {
    try {
      shells.add(iosShellAt(repo, commit));
    } catch {
      return undefined;
    }
  }
  return commits.length > 0 && shells.size === 1 ? { commit: commits[0]!, shell: [...shells][0]! } : undefined;
}

/**
 * Whether a push's commit, <build> by its number, needs a TestFlight upload, and why. Only when its iPhone native code
 * differs from TestFlight's latest build's, <last> as builtFrom found it: Beta App Review sees each build, GitHub's Macs
 * are shared with CI, and a build of the same native code takes the same updates from the feed anyway.
 */
export function uploadDecision(state: TestflightState, build: number, shell: string, last: { commit: string; shell: string } | undefined): { upload: boolean; why: string } {
  if (!state.app) return { upload: false, why: 'App Store Connect has no app for the iPhone app yet, so nothing uploads. See docs/setup.md, TestFlight.' };
  if (!state.last) return { upload: true, why: 'TestFlight has no build of the iPhone app yet.' };
  if (build <= state.last.build) return { upload: false, why: `TestFlight already has build ${state.last.build}, this commit’s or a newer one, so nothing uploads.` };
  if (!last) return { upload: true, why: `Couldn't tell which main commit TestFlight's build ${state.last.build} came from, so this one uploads.` };
  const from = `TestFlight's build ${state.last.build}, from ${last.commit.slice(0, 7)}`;
  if (last.shell === shell) return { upload: false, why: `${from}, has this commit's iPhone native code, ${shell}, so nothing uploads.` };
  return { upload: true, why: `The iPhone app's native code changed since ${from}: ${last.shell} then, ${shell} now.` };
}

/**
 * The TestFlight builds testers can install now, newest first: those in the Testers group that Beta App Review has
 * passed, so they're in beta testing, and that haven't expired.
 */
export async function availableBuilds(get: Get, bundleId: string): Promise<number[]> {
  const apps = await get('/v1/apps', { 'filter[bundleId]': bundleId, 'fields[apps]': 'bundleId' });
  const app = apps.data.find((a) => a.attributes.bundleId === bundleId);
  if (!app) throw new Error(`App Store Connect has no app with the bundle id ${bundleId}.`);
  const groups = (await get(`/v1/apps/${app.id}/betaGroups`, { 'fields[betaGroups]': 'name,isInternalGroup' })) as unknown as { data: BetaGroup[] };
  const group = groups.data.find((g) => g.attributes.name === TESTERS && !g.attributes.isInternalGroup);
  if (!group) return [];
  const builds = (await get('/v1/builds', {
    'filter[app]': app.id,
    'filter[betaGroups]': group.id,
    'filter[expired]': 'false',
    sort: '-uploadedDate',
    limit: '20',
    include: 'buildBetaDetail',
    'fields[builds]': 'version,expired,buildBetaDetail',
    'fields[buildBetaDetails]': 'externalBuildState',
  })) as unknown as {
    data: { attributes: { version: string; expired: boolean }; relationships?: { buildBetaDetail?: { data: { id: string } | null } } }[];
    included?: { type: string; id: string; attributes: { externalBuildState?: string } }[];
  };
  const states = new Map((builds.included ?? []).filter((i) => i.type === 'buildBetaDetails').map((i) => [i.id, i.attributes.externalBuildState]));
  return builds.data
    .filter((b) => !b.attributes.expired && states.get(b.relationships?.buildBetaDetail?.data?.id ?? '') === 'IN_BETA_TESTING')
    .map((b) => Number(b.attributes.version));
}

/**
 * What the release pipeline reads to switch the iPhone feed: the newest TestFlight build testers can install, the one
 * TestFlight offers them, with its commit and iPhone shell hash. Null where testers have no build, or its commit can't
 * be told, so the pipeline switches to nothing.
 */
export interface TestersBuild {
  build: number | null;
  commit: string | null;
  shell: string | null;
}

export function newestRecord(builds: number[], from: (build: number) => { commit: string; shell: string } | undefined): TestersBuild {
  if (builds.length === 0) return { build: null, commit: null, shell: null };
  const build = Math.max(...builds);
  const found = from(build);
  return { build, commit: found?.commit ?? null, shell: found?.shell ?? null };
}

function tokenFor(configDir: string) {
  const key = ascKey(configDir);
  return ascToken({ ...key, pem: readFileSync(key.path, 'utf8') });
}

async function state(configDir: string) {
  const bundleId = projectBundleId();
  return { bundleId, state: await testflightState(ascGet(tokenFor(configDir)), bundleId) };
}

/** Shell lines exporting the key's path and ids for xcodebuild, quoted so that any folder name survives eval. */
function exportLines(key: AscKey): string {
  const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
  return `export ASC_KEY_PATH=${quote(key.path)} ASC_KEY_ID=${quote(key.keyId)} ASC_ISSUER_ID=${quote(key.issuerId)}\n`;
}

async function main([command, configDir, arg]: string[]) {
  const build = arg;
  const out = arg;
  if (command === 'key' && configDir) {
    process.stdout.write(exportLines(ascKey(configDir)));
  } else if (command === 'check' && configDir && build) {
    let version = '';
    try {
      version = execFileSync('xcodebuild', ['-version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      // No Xcode, or only the command line tools: refused below.
    }
    const xcode = xcodeRefusal(version);
    if (xcode) throw new Error(xcode);
    const { bundleId, state: s } = await state(configDir);
    const refusal = uploadRefusal(s, bundleId, Number(build));
    if (refusal) throw new Error(refusal);
  } else if (command === 'age' && configDir) {
    // Only ever a warning: a release has already gone out by the time this runs.
    try {
      const warning = ageWarning((await state(configDir)).state);
      if (warning) console.log(`Warning: ${warning}`);
    } catch (error) {
      console.log(`Warning: couldn't check the last TestFlight build's age. ${(error as Error).message}`);
    }
  } else if (command === 'revoke-runner' && configDir) {
    // A runner's keychains hold only what its run made. A Mac's hold its owner's own certificates, which this would revoke.
    if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('revoke-runner runs only on a GitHub Actions runner.');
    const token = tokenFor(configDir);
    const identities = identityHashes(execFileSync('security', ['find-identity', '-p', 'codesigning'], { encoding: 'utf8' }));
    const revoked = await revokeCertificates(ascGet(token), ascDelete(token), identities);
    console.log(revoked.length > 0 ? `Revoked the certificates Xcode made on this runner: ${revoked.join(', ')}.` : 'No certificate of the team has its key on this runner.');
  } else if (command === 'testers' && configDir && build) {
    const token = () => tokenFor(configDir);
    const subject = execFileSync('git', ['log', '-1', '--format=%s'], { encoding: 'utf8' }).trim();
    const link = await publishToTesters(ascGet(token), ascSend(token), projectBundleId(), Number(build), `This build: ${subject}`);
    const line = `Build ${build} is with the ${TESTERS} group and submitted for Beta App Review. Once it passes, anyone can install it from ${link}`;
    console.log(line);
    if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`, { flag: 'a' });
  } else if (command === 'needed' && configDir) {
    const head = execFileSync('git', ['log', '-1', '--format=%H %ct'], { cwd: REPO, encoding: 'utf8' }).trim().split(' ');
    const { state: s } = await state(configDir);
    const decision = uploadDecision(s, Number(head[1]), iosShellAt(REPO, head[0]!), s.last && builtFrom(REPO, s.last.build));
    console.log(decision.why);
    if (process.env.GITHUB_OUTPUT) writeFileSync(process.env.GITHUB_OUTPUT, `upload=${decision.upload}\n`, { flag: 'a' });
    if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, `${decision.why}\n`, { flag: 'a' });
  } else if (command === 'latest' && configDir && out) {
    const record = newestRecord(await availableBuilds(ascGet(tokenFor(configDir)), projectBundleId()), (build) => builtFrom(REPO, build));
    writeFileSync(out, `${JSON.stringify(record)}\n`);
    if (record.build === null) console.log(`Testers can install no TestFlight build: none is with the ${TESTERS} group, passed by Beta App Review and unexpired.`);
    else if (record.shell === null) console.log(`Testers can install build ${record.build}, but no main commit tells its iPhone native code, so no release switches to it.`);
    else console.log(`Testers can install build ${record.build}, from ${record.commit!.slice(0, 7)}, with the iPhone native code ${record.shell}.`);
  } else {
    throw new Error(
      'Use: testflight.ts key <config folder> | check <config folder> <build> | age <config folder> | revoke-runner <config folder> | testers <config folder> <build> | needed <config folder> | latest <config folder> <file>',
    );
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]!).href) {
  main(process.argv.slice(2)).catch((error: Error) => {
    console.error(error.message);
    process.exit(1);
  });
}

// The iPhone app on TestFlight, through the App Store Connect API with the key in the config folder, the same key that
// notarizes the Mac app. scripts/testflight.sh and scripts/release.sh run it:
//   node scripts/testflight.ts key <config folder>            prints the key's exports for testflight.sh to eval
//   node scripts/testflight.ts check <config folder> <build>  fails unless App Store Connect has the app, and <build> is
//                                                             newer than every build uploaded to it
//   node scripts/testflight.ts age <config folder>            warns when the last TestFlight build is over 60 days old
// None of this is in ios/, so none of it is in the iPhone app's shell hash (scripts/shell-hash.ts).

import { sign } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const API = 'https://api.appstoreconnect.apple.com';
const DAY_MS = 86_400_000;
// TestFlight builds stop opening 90 days after upload. Warning at 60 leaves a month to upload another.
const EXPIRES_AFTER_DAYS = 90;
const WARN_AFTER_DAYS = 60;

export interface AscKey {
  path: string;
  keyId: string;
  issuerId: string;
}

/**
 * The App Store Connect key in the config folder: AuthKey_<key id>.p8, as App Store Connect names it on download, and
 * its issuer id in asc-issuer-id beside it. Errors name what's wrong, never what the files hold.
 */
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

/** GETs from the App Store Connect API with the token. A refusal throws with Apple's own reason. */
export function ascGet(token: string, fetchImpl: typeof fetch = fetch): Get {
  return async (path, query) => {
    const response = await fetchImpl(`${API}${path}?${new URLSearchParams(query)}`, { headers: { authorization: `Bearer ${token}` } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = (body as { errors?: { code?: string; detail?: string; title?: string }[] }).errors?.[0];
      throw new Error(`App Store Connect refused GET ${path}: ${response.status} ${error?.code ?? ''}: ${error?.detail ?? error?.title ?? 'no reason given'}`);
    }
    return body;
  };
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

/** A warning when testers' TestFlight build is close to expiring, or they have none. Null when it's recent. */
export function ageWarning(state: TestflightState, now = new Date()): string | null {
  if (!state.app) return 'App Store Connect has no app for the iPhone app yet, so testers have no TestFlight build.';
  if (!state.last) return 'TestFlight has no build of the iPhone app yet. Run make testflight.';
  const days = Math.floor((now.getTime() - state.last.uploaded.getTime()) / DAY_MS);
  if (days <= WARN_AFTER_DAYS) return null;
  return `The last TestFlight build was uploaded ${days} days ago, and TestFlight builds expire after ${EXPIRES_AFTER_DAYS} days. Run make testflight.`;
}

async function state(configDir: string) {
  const key = ascKey(configDir);
  const get = ascGet(ascToken({ ...key, pem: readFileSync(key.path, 'utf8') }));
  const bundleId = projectBundleId();
  return { bundleId, state: await testflightState(get, bundleId) };
}

/** Shell lines exporting the key's path and ids for xcodebuild, quoted so that any folder name survives eval. */
function exportLines(key: AscKey): string {
  const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
  return `export ASC_KEY_PATH=${quote(key.path)} ASC_KEY_ID=${quote(key.keyId)} ASC_ISSUER_ID=${quote(key.issuerId)}\n`;
}

async function main([command, configDir, build]: string[]) {
  if (command === 'key' && configDir) {
    process.stdout.write(exportLines(ascKey(configDir)));
  } else if (command === 'check' && configDir && build) {
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
  } else {
    throw new Error('Use: testflight.ts key <config folder> | check <config folder> <build> | age <config folder>');
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]!).href) {
  main(process.argv.slice(2)).catch((error: Error) => {
    console.error(error.message);
    process.exit(1);
  });
}

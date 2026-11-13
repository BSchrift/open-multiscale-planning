import { execFileSync } from 'node:child_process';
import { createHash, createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { shellHashes } from './shell-hash';
import {
  ageWarning, ascDelete, ascGet, ascKey, ascSend, ascToken, availableBuilds, builtFrom, bundleIdFrom, commitsBuiltAs, identityHashes, iosShellAt, newestRecord, publishToTesters,
  revokeCertificates, testflightState, uploadDecision, uploadRefusal, xcodeRefusal,
} from './testflight';

const ISSUER = '01234567-89ab-cdef-0123-456789abcdef';
const pem = () => generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

function configDir(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'asc-'));
  for (const [name, contents] of Object.entries(files)) writeFileSync(join(dir, name), contents);
  return dir;
}

describe('ascKey', () => {
  it('reads the key id from the file name and the issuer id beside it', () => {
    const dir = configDir({ 'AuthKey_ABC123DEF4.p8': pem(), 'asc-issuer-id': `${ISSUER}\n` });
    expect(ascKey(dir)).toEqual({ path: join(dir, 'AuthKey_ABC123DEF4.p8'), keyId: 'ABC123DEF4', issuerId: ISSUER });
  });

  it('says what is missing, and never what the files hold', () => {
    const key = pem();
    const cases: [Record<string, string>, RegExp][] = [
      [{}, /AuthKey_<key id>\.p8.*asc-issuer-id/],
      [{ 'asc-issuer-id': ISSUER }, /needs its key, AuthKey_<key id>\.p8/],
      [{ 'AuthKey_ABC123DEF4.p8': key }, /asc-issuer-id must hold the issuer id/],
      [{ 'AuthKey_ABC123DEF4.p8': key, 'asc-issuer-id': 'not-an-issuer' }, /asc-issuer-id must hold the issuer id/],
      [{ 'AuthKey_ABC123DEF4.p8': key, 'AuthKey_ZZZ123DEF4.p8': key, 'asc-issuer-id': ISSUER }, /holds 2 AuthKey_\*\.p8 files/],
      [{ 'AuthKey_mine.p8': key, 'asc-issuer-id': ISSUER }, /must be named AuthKey_<key id>\.p8/],
    ];
    for (const [files, message] of cases) {
      const error = (() => {
        try {
          ascKey(configDir(files));
        } catch (e) {
          return (e as Error).message;
        }
        return 'no error';
      })();
      expect(error).toMatch(message);
      expect(error).not.toContain('not-an-issuer');
      expect(error).not.toContain('PRIVATE KEY');
    }
  });
});

describe('bundleIdFrom', () => {
  it('takes the last setting, so the local file overrides the shared one, and skips comments', () => {
    const shared = 'MULTISCALE_BUNDLE_ID = io.example.shared\nMULTISCALE_APP_GROUP = group.$(MULTISCALE_BUNDLE_ID)\n';
    expect(bundleIdFrom([shared])).toBe('io.example.shared');
    expect(bundleIdFrom([shared, 'DEVELOPMENT_TEAM = X\n// MULTISCALE_BUNDLE_ID = com.example.multiscale\n'])).toBe('io.example.shared');
    expect(bundleIdFrom([shared, 'MULTISCALE_BUNDLE_ID=com.mine.multiscale // mine\n'])).toBe('com.mine.multiscale');
  });

  it('reads this repo’s project', () => {
    expect(bundleIdFrom([`MULTISCALE_BUNDLE_ID = io.github.bschrift.multiscale`])).toBe('io.github.bschrift.multiscale');
    expect(() => bundleIdFrom(['DEVELOPMENT_TEAM = X'])).toThrow(/MULTISCALE_BUNDLE_ID/);
  });
});

describe('ascToken', () => {
  it('is an ES256 token App Store Connect accepts: the key id, the issuer, its audience and at most 20 minutes', () => {
    const key = pem();
    const now = Date.UTC(2026, 10, 9, 12, 0, 0);
    const token = ascToken({ keyId: 'ABC123DEF4', issuerId: ISSUER, pem: key }, now);
    const [header, payload, signature] = token.split('.') as [string, string, string];
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({ alg: 'ES256', kid: 'ABC123DEF4', typ: 'JWT' });
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    expect(claims).toMatchObject({ iss: ISSUER, aud: 'appstoreconnect-v1', iat: now / 1000 });
    expect(claims.exp - claims.iat).toBeGreaterThan(0);
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(20 * 60);
    // JWTs carry ES256 signatures as the raw r and s, not DER.
    const raw = Buffer.from(signature, 'base64url');
    expect(raw).toHaveLength(64);
    expect(verify('sha256', Buffer.from(`${header}.${payload}`), { key: createPublicKey(key), dsaEncoding: 'ieee-p1363' }, raw)).toBe(true);
  });
});

/**
 * A fake App Store Connect: answers GETs by path, and other requests by '<method> <path>', and records each request. A
 * route that's a function answers with what it returns each time, and one that returns a Response answers with that.
 */
function fakeApi(routes: Record<string, unknown>, status = 200) {
  const requests: { method: string; url: string; auth: string | null; body?: unknown }[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    requests.push({ method, url, auth: new Headers(init?.headers).get('authorization'), ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    const path = decodeURIComponent(url.replace('https://api.appstoreconnect.apple.com', ''));
    const route = routes[method === 'GET' ? path : `${method} ${path}`];
    const body = typeof route === 'function' ? (route as () => unknown)() : route;
    if (body instanceof Response) return body;
    if (body === undefined) return new Response('{"errors":[{"status":"404","detail":"not faked"}]}', { status: 404 });
    return body === null ? new Response(null, { status: 204 }) : new Response(JSON.stringify(body), { status });
  };
  const fetchImpl = fetch as typeof globalThis.fetch;
  return { get: ascGet('the-token', fetchImpl), del: ascDelete('the-token', fetchImpl), send: ascSend('the-token', fetchImpl), requests };
}

const BUNDLE = 'io.example.multiscale';
const APPS = `/v1/apps?filter[bundleId]=${BUNDLE}&fields[apps]=bundleId`;
const BUILDS = '/v1/builds?filter[app]=42&sort=-uploadedDate&limit=1&fields[builds]=version,uploadedDate';
const app = { data: [{ id: '42', attributes: { bundleId: BUNDLE } }] };
const builds = (version: string, uploadedDate: string) => ({ data: [{ id: 'b', attributes: { version, uploadedDate } }] });

describe('testflightState', () => {
  it('finds the app by bundle id, then its latest upload, signed in with the token', async () => {
    const api = fakeApi({ [APPS]: app, [BUILDS]: builds('1794000000', '2026-11-01T10:00:00-08:00') });
    expect(await testflightState(api.get, BUNDLE)).toEqual({ app: true, last: { build: 1794000000, uploaded: new Date('2026-11-01T18:00:00Z') } });
    expect(api.requests.map((r) => r.auth)).toEqual(['Bearer the-token', 'Bearer the-token']);
  });

  it('knows an app with no builds, and no app', async () => {
    expect(await testflightState(fakeApi({ [APPS]: app, [BUILDS]: { data: [] } }).get, BUNDLE)).toEqual({ app: true });
    expect(await testflightState(fakeApi({ [APPS]: { data: [] } }).get, BUNDLE)).toEqual({ app: false });
  });

  it('matches the bundle id exactly, not an app whose id starts with it', async () => {
    const other = { data: [{ id: '7', attributes: { bundleId: `${BUNDLE}.beta` } }] };
    expect(await testflightState(fakeApi({ [APPS]: other }).get, BUNDLE)).toEqual({ app: false });
  });

  it("passes on App Store Connect's own reason for a refusal", async () => {
    const refused = { errors: [{ status: '403', code: 'FORBIDDEN_ERROR', title: 'This request is forbidden for security reasons', detail: 'The API key in use does not allow this request' }] };
    await expect(testflightState(fakeApi({ [APPS]: refused }, 403).get, BUNDLE)).rejects.toThrow(
      'App Store Connect refused GET /v1/apps: 403 FORBIDDEN_ERROR: The API key in use does not allow this request',
    );
  });
});

describe('uploadRefusal', () => {
  it('uploads a build newer than the last one', () => {
    expect(uploadRefusal({ app: true }, BUNDLE, 1794000000)).toBeNull();
    expect(uploadRefusal({ app: true, last: { build: 1793999999, uploaded: new Date() } }, BUNDLE, 1794000000)).toBeNull();
  });

  it('refuses until the app record exists, and a build number already used', () => {
    expect(uploadRefusal({ app: false }, BUNDLE, 1794000000)).toMatch(/App Store Connect has no app with the bundle id io\.example\.multiscale/);
    const last = { build: 1794000000, uploaded: new Date() };
    expect(uploadRefusal({ app: true, last }, BUNDLE, 1794000000)).toMatch(/TestFlight already has build 1794000000.*this one is 1794000000/);
    expect(uploadRefusal({ app: true, last }, BUNDLE, 1700000000)).toMatch(/already has build 1794000000/);
  });
});

describe('ageWarning', () => {
  const now = new Date('2026-11-09T12:00:00Z');
  const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000);

  it('stays quiet up to 60 days', () => {
    expect(ageWarning({ app: true, last: { build: 1, uploaded: daysAgo(1) } }, now)).toBeNull();
    expect(ageWarning({ app: true, last: { build: 1, uploaded: daysAgo(60) } }, now)).toBeNull();
  });

  it('warns past 60 days, since TestFlight builds expire after 90', () => {
    expect(ageWarning({ app: true, last: { build: 1, uploaded: daysAgo(61) } }, now)).toMatch(/61 days ago.*expire.*90 days/);
    expect(ageWarning({ app: true, last: { build: 1, uploaded: daysAgo(95) } }, now)).toMatch(/95 days ago/);
  });

  it('warns when testers have no build at all', () => {
    expect(ageWarning({ app: true }, now)).toMatch(/TestFlight has no build/);
    expect(ageWarning({ app: false }, now)).toMatch(/no app/);
  });
});

describe('xcodeRefusal', () => {
  it('takes Xcode 26 and later, which build with the SDK App Store Connect requires', () => {
    expect(xcodeRefusal('Xcode 26.6\nBuild version 17F113\n')).toBeNull();
    expect(xcodeRefusal('Xcode 27.0\nBuild version 18A1\n')).toBeNull();
  });

  it('refuses an older one before the slow part, and says where else to upload from', () => {
    expect(xcodeRefusal('Xcode 16.4\nBuild version 16F6\n')).toMatch(/Xcode 26 or later, and this Mac has Xcode 16\.4\..*GitHub Actions/);
    expect(xcodeRefusal('')).toMatch(/no Xcode it could find/);
  });
});

describe('revokeCertificates', () => {
  const der = (name: string) => Buffer.from(`certificate ${name}`).toString('base64');
  const sha1 = (name: string) => createHash('sha1').update(`certificate ${name}`).digest('hex').toUpperCase();
  const CERTS = '/v1/certificates?fields[certificates]=certificateContent,certificateType&limit=200';
  const certificates = {
    data: [
      { id: 'mine', attributes: { certificateContent: der('owner'), certificateType: 'DEVELOPMENT' } },
      { id: 'runner', attributes: { certificateContent: der('runner'), certificateType: 'DEVELOPMENT' } },
      { id: 'cloud', attributes: { certificateContent: der('cloud'), certificateType: 'DISTRIBUTION' } },
    ],
  };

  it("revokes only the certificates whose keys are on this runner, never the owner's or the cloud-managed one", async () => {
    const api = fakeApi({ [CERTS]: certificates, 'DELETE /v1/certificates/runner': null });
    expect(await revokeCertificates(api.get, api.del, [sha1('runner'), sha1('not the team’s')])).toEqual(['DEVELOPMENT']);
    expect(api.requests.map((r) => `${r.method} ${r.auth}`)).toEqual(['GET Bearer the-token', 'DELETE Bearer the-token']);
    expect(api.requests[1]!.url).toBe('https://api.appstoreconnect.apple.com/v1/certificates/runner');
  });

  it('revokes nothing when no key is on the runner, and passes on a refusal', async () => {
    expect(await revokeCertificates(fakeApi({ [CERTS]: certificates }).get, fakeApi({}).del, [])).toEqual([]);
    const api = fakeApi({ [CERTS]: certificates });
    await expect(revokeCertificates(api.get, api.del, [sha1('runner')])).rejects.toThrow('App Store Connect refused DELETE /v1/certificates/runner: 404');
  });

  it("reads security find-identity's fingerprints once each, whatever the identities are called", () => {
    const hash = sha1('runner');
    const output = `Policy: Code Signing\n  Matching identities\n  1) ${hash} "Apple Development: Created via API (ABCDE12345)"\n     1 identities found\n\n  Valid identities only\n  1) ${hash} "Apple Development: Created via API (ABCDE12345)"\n     1 valid identities found\n`;
    expect(identityHashes(output)).toEqual([hash]);
    expect(identityHashes('     0 identities found\n')).toEqual([]);
  });
});

describe('ascGet and ascSend', () => {
  it('sign each request with a new token when given a way to make them, since a long wait outlasts one', async () => {
    const auths: (string | null)[] = [];
    const fetchImpl = (async (_: string, init?: RequestInit) => {
      auths.push(new Headers(init?.headers).get('authorization'));
      return new Response('{"data":[]}');
    }) as unknown as typeof fetch;
    let n = 0;
    const token = () => `token-${++n}`;
    await ascGet(token, fetchImpl)('/v1/apps', {});
    await ascSend(token, fetchImpl)('POST', '/v1/betaGroups', {});
    expect(auths).toEqual(['Bearer token-1', 'Bearer token-2']);
  });
});

describe('publishToTesters', () => {
  const BUILD = '/v1/builds?filter[app]=42&filter[version]=1794000000&fields[builds]=version,processingState';
  const UPLOADS = '/v1/apps/42/buildUploads?filter[cfBundleVersion]=1794000000&fields[buildUploads]=cfBundleVersion,state';
  const GROUPS = '/v1/apps/42/betaGroups?fields[betaGroups]=name,isInternalGroup,publicLinkEnabled,publicLink';
  const LINK = 'https://testflight.apple.com/join/AbCdEf12';
  const processed = (state: string) => ({ data: [{ id: 'b1', attributes: { version: '1794000000', processingState: state } }] });
  const group = (attributes: object) => ({ id: 'g1', attributes: { name: 'Testers', isInternalGroup: false, publicLinkEnabled: true, publicLink: LINK, ...attributes } });
  const conflict = () => new Response('{"errors":[{"status":"409","code":"ENTITY_ERROR","detail":"already"}]}', { status: 409 });
  const upload = (state: string, errors: object[] = []) => ({ data: [{ id: 'u1', attributes: { cfBundleVersion: '1794000000', state: { state, errors, warnings: [], infos: [] } } }] });
  const nonGets = (api: ReturnType<typeof fakeApi>) =>
    api.requests.filter((r) => r.method !== 'GET').map((r) => [r.method, r.url.replace('https://api.appstoreconnect.apple.com', ''), r.body]);

  it('waits out processing, makes the Testers group with its public link, gives it the build, and submits it for review', async () => {
    const states = [{ data: [] }, processed('PROCESSING'), processed('VALID')];
    const api = fakeApi({
      [APPS]: app,
      [BUILD]: () => states.shift(),
      [UPLOADS]: upload('PROCESSING'),
      [GROUPS]: { data: [group({ name: 'App Store Connect Users', isInternalGroup: true })] },
      'POST /v1/betaGroups': { data: group({}) },
      'POST /v1/betaGroups/g1/relationships/builds': null,
      'POST /v1/betaBuildLocalizations': { data: { id: 'l1', attributes: {} } },
      'POST /v1/betaAppReviewSubmissions': { data: { id: 's1', attributes: {} } },
    });
    const waits: number[] = [];
    const link = await publishToTesters(api.get, api.send, BUNDLE, 1794000000, 'This build: Pause a block', async (ms) => void waits.push(ms));
    expect(link).toBe(LINK);
    expect(waits).toEqual([60_000, 60_000]);
    const forBuild = { build: { data: { type: 'builds', id: 'b1' } } };
    expect(nonGets(api)).toEqual([
      ['POST', '/v1/betaGroups', { data: { type: 'betaGroups', attributes: { name: 'Testers', publicLinkEnabled: true, publicLinkLimitEnabled: false, feedbackEnabled: true }, relationships: { app: { data: { type: 'apps', id: '42' } } } } }],
      ['POST', '/v1/betaGroups/g1/relationships/builds', { data: [{ type: 'builds', id: 'b1' }] }],
      ['POST', '/v1/betaBuildLocalizations', { data: { type: 'betaBuildLocalizations', attributes: { locale: 'en-US', whatToTest: 'This build: Pause a block' }, relationships: forBuild } }],
      ['POST', '/v1/betaAppReviewSubmissions', { data: { type: 'betaAppReviewSubmissions', relationships: forBuild } }],
    ]);
  });

  it('reuses the Testers group, turns its link on, and takes a 409 as already done', async () => {
    const api = fakeApi({
      [APPS]: app,
      [BUILD]: processed('VALID'),
      [GROUPS]: { data: [group({ publicLinkEnabled: false, publicLink: null })] },
      'PATCH /v1/betaGroups/g1': { data: group({}) },
      'POST /v1/betaGroups/g1/relationships/builds': conflict,
      'POST /v1/betaBuildLocalizations': conflict,
      'POST /v1/betaAppReviewSubmissions': conflict,
    });
    expect(await publishToTesters(api.get, api.send, BUNDLE, 1794000000, 'x', async () => {})).toBe(LINK);
    expect(nonGets(api)[0]).toEqual(['PATCH', '/v1/betaGroups/g1', { data: { type: 'betaGroups', id: 'g1', attributes: { publicLinkEnabled: true } } }]);
  });

  it("says when App Store Connect couldn't process the build, or took too long, and passes on other refusals", async () => {
    const send = fakeApi({}).send;
    await expect(publishToTesters(fakeApi({ [APPS]: app, [BUILD]: processed('INVALID') }).get, send, BUNDLE, 1794000000, 'x', async () => {})).rejects.toThrow(
      "App Store Connect couldn't process build 1794000000: INVALID.",
    );
    await expect(publishToTesters(fakeApi({ [APPS]: app, [BUILD]: { data: [] }, [UPLOADS]: { data: [] } }).get, send, BUNDLE, 1794000000, 'x', async () => {}, 3)).rejects.toThrow(
      "Build 1794000000 still wasn't ready in App Store Connect after 3 minutes.",
    );
    const api = fakeApi({ [APPS]: app, [BUILD]: processed('VALID'), [GROUPS]: { data: [group({})] }, 'POST /v1/betaGroups/g1/relationships/builds': null, 'POST /v1/betaBuildLocalizations': null });
    await expect(publishToTesters(api.get, api.send, BUNDLE, 1794000000, 'x', async () => {})).rejects.toThrow('refused POST /v1/betaAppReviewSubmissions: 404');
  });

  it("stops waiting when App Store Connect refused the upload, with Apple's reasons, which otherwise only reach the account holder's email", async () => {
    const refused = upload('FAILED', [
      { code: '90332', description: 'Invalid Symbolic Link.' },
      { code: '90333', description: 'Something else.' },
    ]);
    const waits: number[] = [];
    await expect(publishToTesters(fakeApi({ [APPS]: app, [BUILD]: { data: [] }, [UPLOADS]: refused }).get, fakeApi({}).send, BUNDLE, 1794000000, 'x', async (ms) => void waits.push(ms))).rejects.toThrow(
      'App Store Connect refused build 1794000000 after its upload: ITMS-90332: Invalid Symbolic Link. ITMS-90333: Something else.',
    );
    expect(waits).toEqual([]);
  });
});

describe('uploadDecision', () => {
  const state = { app: true, last: { build: 1794000000, uploaded: new Date('2026-11-10T10:00:00Z') } };
  const from = (shell: string) => ({ commit: 'c0ffee'.padEnd(40, '0'), shell });

  it("uploads a push's commit only when its iPhone native code differs from TestFlight's latest build's", () => {
    expect(uploadDecision(state, 1794000100, 'new', from('old'))).toEqual({
      upload: true,
      why: "The iPhone app's native code changed since TestFlight's build 1794000000, from c0ffee0: old then, new now.",
    });
    expect(uploadDecision(state, 1794000100, 'same', from('same'))).toEqual({
      upload: false,
      why: "TestFlight's build 1794000000, from c0ffee0, has this commit's iPhone native code, same, so nothing uploads.",
    });
  });

  it('uploads when TestFlight has no build yet, or one from a commit it can’t place, such as one uploaded from a branch', () => {
    expect(uploadDecision({ app: true }, 1794000100, 'new', undefined)).toEqual({ upload: true, why: 'TestFlight has no build of the iPhone app yet.' });
    expect(uploadDecision(state, 1794000100, 'new', undefined)).toEqual({
      upload: true,
      why: "Couldn't tell which main commit TestFlight's build 1794000000 came from, so this one uploads.",
    });
  });

  it('uploads nothing once TestFlight has this build or a newer one, or before the app exists', () => {
    expect(uploadDecision(state, 1794000000, 'new', from('old'))).toEqual({ upload: false, why: 'TestFlight already has build 1794000000, this commit’s or a newer one, so nothing uploads.' });
    expect(uploadDecision(state, 1793999999, 'new', from('old')).upload).toBe(false);
    expect(uploadDecision({ app: false }, 1794000100, 'new', undefined)).toEqual({
      upload: false,
      why: 'App Store Connect has no app for the iPhone app yet, so nothing uploads. See docs/setup.md, TestFlight.',
    });
  });
});

describe('commitsBuiltAs', () => {
  it("finds the commits a build number names, by the commit's time, as testflight.sh numbers builds", () => {
    const log = 'aaa 1794000200\nbbb 1794000100\nccc 1794000100\nddd 17940001000\n';
    expect(commitsBuiltAs(log, 1794000100)).toEqual(['bbb', 'ccc']);
    expect(commitsBuiltAs(log, 1794000150)).toEqual([]);
  });
});

// A repository holding the iPhone app's native code under frontend: one commit for each entry, at the time given, with
// the files given changed, or deleted when null. Each commit has this shell hash script unless it's given another.
const SHELL_HASH = readFileSync(join(import.meta.dirname, 'shell-hash.ts'), 'utf8');
function repoOf(commits: { at: number; files?: Record<string, string | null> }[]) {
  const dir = mkdtempSync(join(tmpdir(), 'testflight-repo-'));
  const run = (args: string[], at = 0) =>
    execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.name=Tester', '-c', 'user.email=tester@example.com', ...args], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_DATE: `@${at} +0000`, GIT_COMMITTER_DATE: `@${at} +0000` },
    }).trim();
  run(['init', '-q', '-b', 'main']);
  const first: Record<string, string> = {
    'frontend/package.json': '{ "type": "module" }\n',
    'frontend/package-lock.json': JSON.stringify({ packages: { '': {}, 'node_modules/@capacitor/core': { version: '7.0.0' } } }),
    'frontend/capacitor.config.json': '{}\n',
    'frontend/ios/App/App/AppDelegate.swift': 'one\n',
    'frontend/scripts/shell-hash.ts': SHELL_HASH,
  };
  const hashes: string[] = [];
  for (const [i, { at, files }] of commits.entries()) {
    for (const [path, contents] of Object.entries(i === 0 ? { ...first, ...files } : (files ?? {}))) {
      if (contents === null) {
        rmSync(join(dir, path), { force: true });
      } else {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), contents);
      }
    }
    run(['add', '-A']);
    run(['commit', '-q', '--allow-empty', '-m', `Commit ${i}`], at);
    hashes.push(run(['rev-parse', 'HEAD']));
  }
  return { dir, hashes, checkouts: () => run(['worktree', 'list']).split('\n').length };
}
const macBuild = { name: 'Multiscale', scheme: 'multiscale', backendOrigins: [] };

describe('iosShellAt', () => {
  it("hashes a commit's iPhone native code as that commit's build named it, and leaves no checkout behind", () => {
    const repo = repoOf([{ at: 1794000000 }]);
    expect(iosShellAt(repo.dir, repo.hashes[0]!)).toBe(shellHashes(join(repo.dir, 'frontend'), macBuild).ios);
    expect(repo.checkouts()).toBe(1);
  });

  it('tells commits apart by their native code only', () => {
    const repo = repoOf([
      { at: 1794000000 },
      { at: 1794000100, files: { 'frontend/src/app.ts': 'not native\n' } },
      { at: 1794000200, files: { 'frontend/ios/App/App/AppDelegate.swift': 'two\n' } },
    ]);
    const [one, web, native] = repo.hashes.map((commit) => iosShellAt(repo.dir, commit));
    expect(web).toBe(one);
    expect(native).not.toBe(one);
  });

  it("uses each commit's own shell hash script, so a build from before the hash changed is named as it was", () => {
    const older = "export function shellHashes() { return { electron: 'mac', ios: 'olderhash' }; }\n";
    const repo = repoOf([{ at: 1794000000, files: { 'frontend/scripts/shell-hash.ts': older } }, { at: 1794000100, files: { 'frontend/scripts/shell-hash.ts': SHELL_HASH } }]);
    expect(iosShellAt(repo.dir, repo.hashes[0]!)).toBe('olderhash');
    expect(iosShellAt(repo.dir, repo.hashes[1]!)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('throws for a commit with no shell hash script, and still leaves no checkout behind', () => {
    const repo = repoOf([{ at: 1794000000, files: { 'frontend/scripts/shell-hash.ts': null } }]);
    expect(() => iosShellAt(repo.dir, repo.hashes[0]!)).toThrow();
    expect(repo.checkouts()).toBe(1);
  });
});

describe('builtFrom', () => {
  it('finds the main commit a TestFlight build came from, with its iPhone native code', () => {
    const repo = repoOf([{ at: 1794000000 }, { at: 1794000100, files: { 'frontend/ios/App/App/AppDelegate.swift': 'two\n' } }]);
    expect(builtFrom(repo.dir, 1794000000, 'main')).toEqual({ commit: repo.hashes[0], shell: iosShellAt(repo.dir, repo.hashes[0]!) });
    expect(builtFrom(repo.dir, 1794000100, 'main')).toEqual({ commit: repo.hashes[1], shell: iosShellAt(repo.dir, repo.hashes[1]!) });
    expect(builtFrom(repo.dir, 1794000050, 'main')).toBeUndefined();
  });

  it('takes commits that share a time when their native code is the same, and none when it differs', () => {
    const same = repoOf([{ at: 1794000000 }, { at: 1794000000, files: { 'frontend/src/app.ts': 'web\n' } }]);
    expect(builtFrom(same.dir, 1794000000, 'main')).toEqual({ commit: same.hashes[1], shell: iosShellAt(same.dir, same.hashes[0]!) });
    const differ = repoOf([{ at: 1794000000 }, { at: 1794000000, files: { 'frontend/ios/App/App/AppDelegate.swift': 'two\n' } }]);
    expect(builtFrom(differ.dir, 1794000000, 'main')).toBeUndefined();
  });
});

describe('availableBuilds', () => {
  const GROUPS = '/v1/apps/42/betaGroups?fields[betaGroups]=name,isInternalGroup';
  const BUILDS =
    '/v1/builds?filter[app]=42&filter[betaGroups]=g1&filter[expired]=false&sort=-uploadedDate&limit=20&include=buildBetaDetail&fields[builds]=version,expired,buildBetaDetail&fields[buildBetaDetails]=externalBuildState';
  const testers = { data: [{ id: 'g0', attributes: { name: 'Testers', isInternalGroup: true } }, { id: 'g1', attributes: { name: 'Testers', isInternalGroup: false } }] };
  // Builds as App Store Connect lists them, each with its beta state beside it.
  const listed = (...builds: [string, string | null, boolean?][]) => ({
    data: builds.map(([version, state, expired = false]) => ({
      id: `b${version}`,
      attributes: { version, expired },
      relationships: { buildBetaDetail: { data: state ? { type: 'buildBetaDetails', id: `d${version}` } : null } },
    })),
    included: builds.filter(([, state]) => state).map(([version, state]) => ({ type: 'buildBetaDetails', id: `d${version}`, attributes: { externalBuildState: state } })),
  });

  it("lists the builds testers can install, newest first: the Testers group's, in beta testing once Beta App Review passed them, and not expired", async () => {
    const api = fakeApi({
      [APPS]: app,
      [GROUPS]: testers,
      [BUILDS]: listed(
        ['1794000400', 'WAITING_FOR_BETA_REVIEW'],
        ['1794000300', 'IN_BETA_TESTING'],
        ['1794000250', 'BETA_REJECTED'],
        ['1794000200', 'IN_BETA_TESTING', true],
        ['1794000150', null],
        ['1794000100', 'IN_BETA_TESTING'],
      ),
    });
    expect(await availableBuilds(api.get, BUNDLE)).toEqual([1794000300, 1794000100]);
  });

  it('lists none before the Testers group exists, and says when the app does not', async () => {
    expect(await availableBuilds(fakeApi({ [APPS]: app, [GROUPS]: { data: [testers.data[0]] } }).get, BUNDLE)).toEqual([]);
    await expect(availableBuilds(fakeApi({ [APPS]: { data: [] } }).get, BUNDLE)).rejects.toThrow(`App Store Connect has no app with the bundle id ${BUNDLE}.`);
  });
});

describe('newestRecord', () => {
  const from: Record<number, { commit: string; shell: string }> = {
    1794000300: { commit: 'ccc', shell: 'b'.repeat(16) },
    1794000100: { commit: 'aaa', shell: 'a'.repeat(16) },
  };

  it('records the newest build testers can install, which TestFlight offers them, with its iPhone native code', () => {
    expect(newestRecord([1794000100, 1794000300], (build) => from[build])).toEqual({ build: 1794000300, commit: 'ccc', shell: 'b'.repeat(16) });
  });

  it("records no native code when the newest build's commit can't be told, and no build when testers have none", () => {
    expect(newestRecord([1794000400, 1794000300], (build) => from[build])).toEqual({ build: 1794000400, commit: null, shell: null });
    expect(newestRecord([], (build) => from[build])).toEqual({ build: null, commit: null, shell: null });
  });
});

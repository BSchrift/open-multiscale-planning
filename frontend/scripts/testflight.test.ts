import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ageWarning, ascGet, ascKey, ascToken, bundleIdFrom, testflightState, uploadRefusal } from './testflight';

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

/** A fake App Store Connect: answers by path, and records each request. */
function fakeApi(routes: Record<string, unknown>, status = 200) {
  const requests: { url: string; auth: string | null }[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, auth: new Headers(init?.headers).get('authorization') });
    const path = decodeURIComponent(url.replace('https://api.appstoreconnect.apple.com', ''));
    const body = routes[path];
    if (body === undefined) return new Response('{"errors":[{"status":"404","detail":"not faked"}]}', { status: 404 });
    return new Response(JSON.stringify(body), { status });
  };
  return { get: ascGet('the-token', fetch as typeof globalThis.fetch), requests };
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

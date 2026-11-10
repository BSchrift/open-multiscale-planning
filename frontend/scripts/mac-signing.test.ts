import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ENTITLEMENTS, exportLines, notarizeEnv, signingIdentity } from './mac-signing';

const script = join(import.meta.dirname, 'mac-signing.ts');
const ISSUER = '11111111-2222-3333-4444-555555555555';
const KEY_TEXT = 'not-a-real-key';

function configDir(files: Record<string, string>, name = 'config') {
  const dir = join(mkdtempSync(join(tmpdir(), 'multiscale-notarize-')), name);
  mkdirSync(dir);
  for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text);
  return dir;
}

describe('signingIdentity', () => {
  const developerId = '2222222222222222222222222222222222222222';
  const keychain = [
    '  1) 1111111111111111111111111111111111111111 "Apple Development: someone@example.com (AAAAAAAAAA)"',
    `  2) ${developerId} "Developer ID Application: Someone (AAAAAAAAAA)"`,
    '     2 valid identities found',
  ].join('\n');

  it('signs with the Developer ID when the keychain has one', () => {
    expect(signingIdentity(keychain)).toBe(developerId);
  });

  it('signs ad hoc without one, so anyone can build the app', () => {
    expect(signingIdentity(keychain.replace('Developer ID Application', 'Apple Distribution'))).toBe('-');
    expect(signingIdentity('     0 valid identities found')).toBe('-');
    expect(signingIdentity('')).toBe('-');
  });
});

describe('notarizeEnv', () => {
  it('reads the App Store Connect key from the config folder, as App Store Connect names it', () => {
    const dir = configDir({ 'AuthKey_ABCDE12345.p8': KEY_TEXT, 'asc-issuer-id': `${ISSUER}\n`, 'staging.yaml': '' });
    expect(notarizeEnv(dir)).toEqual({ APPLE_API_KEY: join(dir, 'AuthKey_ABCDE12345.p8'), APPLE_API_KEY_ID: 'ABCDE12345', APPLE_API_ISSUER: ISSUER });
  });

  it('is null when there is no key, so the build skips notarizing', () => {
    expect(notarizeEnv(configDir({ 'staging.yaml': '' }))).toBeNull();
  });

  it('refuses a key that is half set up, naming what is wrong and never what the files hold', () => {
    const cases: [Record<string, string>, RegExp][] = [
      [{ 'AuthKey_ABCDE12345.p8': KEY_TEXT }, /asc-issuer-id must hold the issuer id/],
      [{ 'AuthKey_ABCDE12345.p8': KEY_TEXT, 'asc-issuer-id': 'not-an-id' }, /asc-issuer-id must hold the issuer id/],
      [{ 'asc-issuer-id': ISSUER }, /needs its key/],
      [{ 'AuthKey_ABCDE12345.p8': KEY_TEXT, 'AuthKey_FGHIJ67890.p8': KEY_TEXT, 'asc-issuer-id': ISSUER }, /2 AuthKey_\*\.p8 files/],
      [{ 'AuthKey_short.p8': KEY_TEXT, 'asc-issuer-id': ISSUER }, /named AuthKey_<key id>\.p8/],
    ];
    for (const [files, problem] of cases) {
      const run = () => notarizeEnv(configDir(files));
      expect(run).toThrow(problem);
      expect(run).not.toThrow(/not-a-real-key|not-an-id|ABCDE12345|11111111-2222/);
    }
  });
});

describe('the environment release.sh passes to the build', () => {
  const evaluated = (lines: string) =>
    execFileSync('bash', ['-c', 'eval "$1"; printf "%s\\n" "$APPLE_API_KEY" "$APPLE_API_KEY_ID" "$APPLE_API_ISSUER"', 'bash', lines], { encoding: 'utf8' });

  it('exports the key for bash to eval, whatever the folder is called', () => {
    const env = { APPLE_API_KEY: "/Users/me/My 'config'/$(touch x)/AuthKey_ABCDE12345.p8", APPLE_API_KEY_ID: 'ABCDE12345', APPLE_API_ISSUER: ISSUER };
    expect(evaluated(exportLines(env))).toBe(`${env.APPLE_API_KEY}\nABCDE12345\n${ISSUER}\n`);
    expect(exportLines(null)).toBe('');
  });

  it('comes from the config folder, and never includes the key itself', () => {
    const dir = configDir({ 'AuthKey_ABCDE12345.p8': KEY_TEXT, 'asc-issuer-id': ISSUER }, "my 'config'");
    const run = spawnSync(process.execPath, [script, 'env', dir], { encoding: 'utf8' });
    expect(run.status).toBe(0);
    expect(run.stdout).not.toContain('not-a-real-key');
    expect(evaluated(run.stdout)).toBe(`${join(dir, 'AuthKey_ABCDE12345.p8')}\nABCDE12345\n${ISSUER}\n`);
  });

  it('is empty without a key, and stops the release when the key is half set up', () => {
    const none = spawnSync(process.execPath, [script, 'env', configDir({})], { encoding: 'utf8' });
    expect([none.status, none.stdout]).toEqual([0, '']);
    const half = spawnSync(process.execPath, [script, 'env', configDir({ 'asc-issuer-id': ISSUER })], { encoding: 'utf8' });
    expect(half.status).toBe(1);
    expect(half.stdout).toBe('');
    expect(half.stderr).toMatch(/needs its key/);
  });
});

// V8 compiles JavaScript as it runs, which the hardened runtime blocks without allow-jit. Nothing else is granted: every
// library in a Developer ID build is signed by the same team, so library validation stays on, and so does the
// debugger lock.
it('lets Electron compile JavaScript under the hardened runtime, and loosens nothing else', () => {
  const plist = readFileSync(ENTITLEMENTS, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  expect([...plist.matchAll(/<key>([^<]+)<\/key>\s*<(\w+)\/>/g)].map((m) => [m[1], m[2]])).toEqual([['com.apple.security.cs.allow-jit', 'true']]);
});

import { spawnSync } from 'node:child_process';
import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { publicKeyOf, releaseKeyIn } from './sign-release.mjs';

const script = join(import.meta.dirname, 'sign-release.mjs');
const keyPem = () => generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

function dist(releaseKey: string) {
  const dir = mkdtempSync(join(tmpdir(), 'dist-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'version.json'), JSON.stringify({ version: '0.1.0-abc', build: 7, shell: { electron: 'e1', ios: 'i1' }, releaseKey }));
  writeFileSync(join(dir, 'index.html'), '<html></html>');
  writeFileSync(join(dir, 'assets/app.js'), 'run()');
  writeFileSync(join(dir, 'assets/app.js.map'), '{}');
  return dir;
}

const sign = (dir: string, key: string, record?: string) => {
  const out = mkdtempSync(join(tmpdir(), 'signed-'));
  // As the pipeline's signing step runs it: plain node, the key in the environment, and nothing else.
  const r = spawnSync(process.execPath, [script, dir, out, ...(record === undefined ? [] : [record])], { encoding: 'utf8', env: { PATH: process.env.PATH, RELEASE_KEY: key } });
  return { ...r, out };
};

// The MacApp step's record of the app that runs this build (mac-inbox.ts appRecord), in its output.
const app = { version: '0.1.5', build: 5, shell: 'e1', folder: 'mac/0.1.5/', file: 'Multiscale.zip', sha512: `${'A'.repeat(86)}==`, size: 123 };
const recordFile = (record: object) => {
  const path = join(mkdtempSync(join(tmpdir(), 'mac-apps-')), 'staging.json');
  writeFileSync(path, JSON.stringify(record));
  return path;
};

it('signs a manifest of every file but the source maps, and names each file by its hash', () => {
  const key = keyPem();
  const r = sign(dist(publicKeyOf(key)), key);
  expect(r.status, r.stderr).toBe(0);
  const { manifest, signature } = JSON.parse(readFileSync(join(r.out, 'release.json'), 'utf8'));
  expect(verify(null, Buffer.from(manifest), createPublicKey(key), Buffer.from(signature, 'base64'))).toBe(true);
  const parsed = JSON.parse(manifest);
  expect(parsed).toMatchObject({ version: '0.1.0-abc', build: 7, shell: { electron: 'e1', ios: 'i1' } });
  expect(parsed.files.map((f: { path: string }) => f.path)).toEqual(['assets/app.js', 'index.html', 'version.json']);
  expect(readdirSync(join(r.out, 'files')).sort()).toEqual(parsed.files.map((f: { sha256: string }) => f.sha256).sort());
});

it('refuses a build that carries another key, which the apps would never take an update from', () => {
  const r = sign(dist(publicKeyOf(keyPem())), keyPem());
  expect(r.status).not.toBe(0);
  expect(r.stderr).toContain('built without this release key');
});

it('needs the key in RELEASE_KEY', () => {
  const r = spawnSync(process.execPath, [script, 'dist', 'out'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  expect(r.status).not.toBe(0);
  expect(r.stderr).toContain('RELEASE_KEY');
});

it("uses Node's standard library alone, so the signing step installs nothing", () => {
  const imports = [...readFileSync(script, 'utf8').matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]!);
  expect(imports.length).toBeGreaterThan(0);
  expect(imports.filter((name) => !name.startsWith('node:'))).toEqual([]);
});

it("reads a build's public key from the key, or from its public half alone, which is all the pipeline's build has", () => {
  const key = keyPem();
  const dir = mkdtempSync(join(tmpdir(), 'config-'));
  expect(releaseKeyIn(dir, 'prod')).toBeUndefined();
  writeFileSync(join(dir, 'prod.release-key.pub'), `${publicKeyOf(key)}\n`);
  expect(releaseKeyIn(dir, 'prod')).toBe(publicKeyOf(key));
  const other = keyPem();
  writeFileSync(join(dir, 'prod.release-key.pem'), other);
  expect(releaseKeyIn(dir, 'prod')).toBe(publicKeyOf(other));
});

it("names the app that runs the build, from the MacApp step's record, in what it signs", () => {
  const key = keyPem();
  const r = sign(dist(publicKeyOf(key)), key, recordFile(app));
  expect(r.status, r.stderr).toBe(0);
  const { manifest, signature } = JSON.parse(readFileSync(join(r.out, 'release.json'), 'utf8'));
  expect(verify(null, Buffer.from(manifest), createPublicKey(key), Buffer.from(signature, 'base64'))).toBe(true);
  expect(JSON.parse(manifest).app).toEqual(app);
});

it('names no app when the MacApp step had no record to give, as before any app had one', () => {
  const key = keyPem();
  const r = sign(dist(publicKeyOf(key)), key, join(tmpdir(), 'no-such-record.json'));
  expect(r.status, r.stderr).toBe(0);
  expect(JSON.parse(JSON.parse(readFileSync(join(r.out, 'release.json'), 'utf8')).manifest).app).toBeUndefined();
});

it("refuses a record of an app for other native code than the build's, or one that isn't a record", () => {
  const key = keyPem();
  const other = sign(dist(publicKeyOf(key)), key, recordFile({ ...app, shell: 'e2' }));
  expect(other.status).not.toBe(0);
  expect(other.stderr).toContain("is for other native code than this build's");
  for (const bad of [{ ...app, folder: '../elsewhere/' }, { ...app, file: 'a/b.zip' }, { ...app, sha512: 'x' }, { ...app, size: -1 }, { ...app, version: '0.1.0-abc' }]) {
    const r = sign(dist(publicKeyOf(key)), key, recordFile(bad));
    expect(r.status, JSON.stringify(bad)).not.toBe(0);
    expect(r.stderr).toContain('not an app record');
  }
});

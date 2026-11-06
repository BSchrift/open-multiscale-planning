import { generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { packRelease } from '../scripts/release-files';
import type { DownloadedRelease } from '../src/core/updates';
import { webBundles } from './updates';

const pair = () => generateKeyPairSync('ed25519');
const publicOf = (key: ReturnType<typeof pair>) => key.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
const pemOf = (key: ReturnType<typeof pair>) => key.privateKey.export({ type: 'pkcs8', format: 'pem' });
const signWith = (key: ReturnType<typeof pair>, text: string) => sign(null, Buffer.from(text), key.privateKey).toString('base64');

let tmp: string;
beforeEach(() => void (tmp = mkdtempSync(join(tmpdir(), 'bundles-'))));
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function build(name: string, info: object, files: Record<string, string> = { 'index.html': `<p>${name}</p>`, 'assets/app.js': name }) {
  const root = join(tmp, name);
  for (const [path, body] of Object.entries({ ...files, 'version.json': JSON.stringify(info) })) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return root;
}

/** A signed release as the page hands it over: the manifest, its signature and every file's bytes. */
function download(dist: string, key: ReturnType<typeof pair>): DownloadedRelease {
  const { release, files } = packRelease(dist, pemOf(key));
  const { manifest, signature } = JSON.parse(release) as { manifest: string; signature: string };
  return { manifest, signature, files: Object.fromEntries(files.map((f) => [f.path, new Uint8Array(readFileSync(f.from))])) };
}

describe('webBundles', () => {
  const key = pair();
  const shell = { electron: 'e1', ios: 'i1' };
  const setup = () => {
    const embedded = build('embedded', { version: '0.1.0-a', build: 100, shell, releaseKey: publicOf(key) });
    return { embedded, bundles: webBundles(join(tmp, 'web'), embedded) };
  };
  const release = (buildNumber: number, over: object = {}, files?: Record<string, string>) =>
    download(build(`dist-${buildNumber}`, { version: `0.1.0-${buildNumber}`, build: buildNumber, shell, releaseKey: publicOf(key), ...over }, files), key);

  it('installs a signed, newer release for this native code, and runs it from then on', () => {
    const { embedded, bundles } = setup();
    expect(bundles.newest()).toEqual({ root: embedded, build: 100 });
    bundles.install(release(200), embedded);
    expect(bundles.newest()).toEqual({ root: join(tmp, 'web', '200'), build: 200 });
    expect(readFileSync(join(tmp, 'web', '200', 'assets', 'app.js'), 'utf8')).toBe('dist-200');
  });

  it('refuses a release signed with another key, or changed after signing', () => {
    const { embedded, bundles } = setup();
    const other = pair();
    const forged = download(build('forged', { version: 'x', build: 200, shell, releaseKey: publicOf(other) }), other);
    expect(() => bundles.install(forged, embedded)).toThrow('[signature]');

    const tampered = release(200);
    expect(() => bundles.install({ ...tampered, manifest: tampered.manifest.replace('"build":200', '"build":201') }, embedded)).toThrow('[signature]');
    expect(() => bundles.install({ ...tampered, files: { ...tampered.files, 'assets/app.js': new TextEncoder().encode('evil') } }, embedded)).toThrow('[file]');
    expect(bundles.newest().build).toBe(100);
    expect(existsSync(join(tmp, 'web', '200.partial'))).toBe(false);
  });

  it('refuses a release for other native code, an older or equal build, or one that was rolled back', () => {
    const { embedded, bundles } = setup();
    expect(() => bundles.install(release(200, { shell: { electron: 'e2', ios: 'i1' } }), embedded)).toThrow('[not-for-this-app]');
    expect(() => bundles.install(release(100), embedded)).toThrow('[not-for-this-app]');
    bundles.reject(300);
    expect(() => bundles.install(release(300), embedded)).toThrow('[rolled-back]');
  });

  it('refuses paths that climb out of the bundle', () => {
    const { embedded, bundles } = setup();
    const r = release(200, {}, { 'index.html': 'x', 'evil.js': 'x' });
    const manifest = r.manifest.replace('"evil.js"', '"../evil.js"');
    // Signed as written, so only the path check can stop it.
    const signed = { ...r, manifest, signature: signWith(key, manifest), files: { ...r.files, '../evil.js': r.files['evil.js']! } };
    expect(() => bundles.install(signed, embedded)).toThrow('[file]');
    expect(existsSync(join(tmp, 'web', 'evil.js'))).toBe(false);
  });

  it("refuses everything when the app was built without a release key", () => {
    const embedded = build('embedded', { version: '0.1.0-a', build: 100, shell });
    expect(() => webBundles(join(tmp, 'web'), embedded).install(release(200), embedded)).toThrow('[key]');
  });

  it('keeps the running bundle and the new one, and clears older downloads', () => {
    const { embedded, bundles } = setup();
    bundles.install(release(200), embedded);
    bundles.install(release(300), join(tmp, 'web', '200'));
    bundles.install(release(400), join(tmp, 'web', '200'));
    expect(readdirSync(join(tmp, 'web')).sort()).toEqual(['200', '400']);
  });

  it('skips a rejected bundle for good, and remembers which one last started', () => {
    const { embedded, bundles } = setup();
    bundles.install(release(200), embedded);
    expect(bundles.confirmed()).toBe(0);
    bundles.reject(200);
    expect(bundles.newest().build).toBe(100);
    bundles.confirm(150);
    expect(bundles.confirmed()).toBe(150);
  });

  it('ignores a download built for older native code once the app itself is replaced', () => {
    const { embedded, bundles } = setup();
    bundles.install(release(200), embedded);
    const newApp = build('new-app', { version: '0.1.0-b', build: 150, shell: { electron: 'e2', ios: 'i1' }, releaseKey: publicOf(key) });
    expect(webBundles(join(tmp, 'web'), newApp).newest()).toEqual({ root: newApp, build: 150 });
    expect(bundles.newest().build).toBe(200);
  });
});

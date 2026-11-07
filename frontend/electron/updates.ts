// Web bundles downloaded over the air, kept in the app's data folder beside the bundle inside the app. One is installed
// only when the key inside the app signed it, it was built for this app's native code, and every file matches.
// ios/App/App/BridgeViewController.swift does the same on iPhone.

import { createHash, createPublicKey, verify } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DownloadedRelease, Manifest } from '../src/core/updates';

/** version.json, which every build carries. */
interface BundleInfo {
  version: string;
  build: number;
  shell: { electron: string };
  releaseKey?: string;
}

/** Refused, with why as a code in brackets, which the page reports: see failure in src/core/updates.ts. */
const refused = (code: string, message: string) => new Error(`[${code}] ${message}`);

/** Each segment starts with a letter, digit or _, so no path climbs out or hides. */
const safePath = (path: string) => path.split('/').every((segment) => /^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(segment));

function readInfo(root: string): BundleInfo | null {
  try {
    return JSON.parse(readFileSync(join(root, 'version.json'), 'utf8')) as BundleInfo;
  } catch {
    return null;
  }
}

function readNumbers(file: string): number[] {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as number[];
  } catch {
    return [];
  }
}

/** dir holds the downloaded bundles; embeddedRoot is the bundle inside the app. */
export function webBundles(dir: string, embeddedRoot: string) {
  const embedded = readInfo(embeddedRoot);
  if (!embedded) throw new Error(`${embeddedRoot} has no version.json`);
  const badFile = join(dir, 'bad.json');
  const goodFile = join(dir, 'good.json');
  /** Why this app can't run a bundle, or null when it can. */
  const cannotRun = (info: { build: number; shell: { electron?: string } }) =>
    readNumbers(badFile).includes(info.build)
      ? 'rolled-back'
      : info.shell.electron !== embedded.shell.electron || info.build <= embedded.build
        ? 'not-for-this-app'
        : null;

  return {
    embedded,
    /** The newest installed bundle this app can run, else the one inside the app. */
    newest(): { root: string; build: number } {
      let best = { root: embeddedRoot, build: embedded.build };
      for (const name of existsSync(dir) ? readdirSync(dir) : []) {
        const info = /^\d+$/.test(name) ? readInfo(join(dir, name)) : null;
        if (info && info.build === Number(name) && !cannotRun(info) && info.build > best.build) best = { root: join(dir, name), build: info.build };
      }
      return best;
    },

    /** Throws, leaving what's installed as it was, unless every check passes. running is kept; older downloads go. */
    install(release: DownloadedRelease, running: string) {
      if (!embedded.releaseKey) throw refused('key', 'This app was built without a release key, so it takes no updates');
      const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(embedded.releaseKey, 'base64').toString('base64url') }, format: 'jwk' });
      if (typeof release.manifest !== 'string' || typeof release.signature !== 'string') throw refused('release', 'Bad release');
      if (!verify(null, Buffer.from(release.manifest), key, Buffer.from(release.signature, 'base64'))) throw refused('signature', 'The release signature does not match');
      const manifest = JSON.parse(release.manifest) as Manifest;
      const reason = cannotRun(manifest);
      if (reason === 'rolled-back') throw refused(reason, `Build ${manifest.build} was rolled back on this device`);
      if (reason) throw refused(reason, `Build ${manifest.build} is not newer, or not for this app's native code`);

      const target = join(dir, String(manifest.build));
      const partial = `${target}.partial`;
      rmSync(partial, { recursive: true, force: true });
      try {
        for (const file of manifest.files) {
          const data = release.files[file.path];
          if (!safePath(file.path)) throw refused('file', `Unsafe path in the release: ${file.path}`);
          if (!(data instanceof Uint8Array) || createHash('sha256').update(data).digest('hex') !== file.sha256) throw refused('file', `${file.path} does not match the release`);
          mkdirSync(dirname(join(partial, file.path)), { recursive: true });
          writeFileSync(join(partial, file.path), data);
        }
        if (readInfo(partial)?.build !== manifest.build || !existsSync(join(partial, 'index.html'))) throw refused('incomplete', 'The release has no index.html, or a version.json for another build');
      } catch (error) {
        rmSync(partial, { recursive: true, force: true });
        throw error;
      }
      rmSync(target, { recursive: true, force: true });
      renameSync(partial, target);
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (/^\d+(\.partial)?$/.test(name) && path !== target && path !== running) rmSync(path, { recursive: true, force: true });
      }
    },

    /** The newest bundle that has started and drawn the app. A newer one runs on trial until it does. */
    confirmed: () => readNumbers(goodFile)[0] ?? 0,
    confirm(build: number) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(goodFile, JSON.stringify([build]));
    },
    /** A bundle that failed its trial never runs again. */
    reject(build: number) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(badFile, JSON.stringify([...readNumbers(badFile), build]));
      rmSync(join(dir, String(build)), { recursive: true, force: true });
    },
  };
}

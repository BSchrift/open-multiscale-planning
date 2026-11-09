// Signs a web build as a release the apps update from: release.json, a signed manifest of every file, and each file
// under files/ named by its SHA-256, so an unchanged file is uploaded once and cached for good.
//
// Plain JavaScript on Node's standard library alone, so that the release pipeline's signing step runs it as it comes,
// from the tested build, with nothing installed. That step passes the key in RELEASE_KEY:
//   RELEASE_KEY=<key's PEM> node sign-release.mjs <dist> <out>
// On a Mac, scripts/release-files.ts packs with the same code.

import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));

/** The public half the apps check releases with, as a build carries it in version.json. */
export function publicKeyOf(key) {
  return createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
}

/**
 * The public half an environment's builds carry, from its key in the config folder, or from the public half alone in
 * <env>.release-key.pub, which is all the release pipeline's build step has.
 */
export function releaseKeyIn(configDir, env) {
  const keyFile = join(configDir, `${env}.release-key.pem`);
  if (existsSync(keyFile)) return publicKeyOf(readFileSync(keyFile));
  const publicFile = join(configDir, `${env}.release-key.pub`);
  return existsSync(publicFile) ? readFileSync(publicFile, 'utf8').trim() : undefined;
}

/** The release for the build in dist: the signed manifest, and where each listed file is on disk. */
export function packRelease(dist, privateKeyPem) {
  const info = JSON.parse(readFileSync(join(dist, 'version.json'), 'utf8'));
  const key = createPrivateKey(privateKeyPem);
  // The apps check releases with the key built into them, so a build without this one could never take its own update.
  if (info.releaseKey !== publicKeyOf(key)) throw new Error(`${dist} was built without this release key. Build it again now that the key exists.`);
  const paths = walk(dist)
    .map((path) => relative(dist, path).split('\\').join('/'))
    .filter((path) => !path.endsWith('.map'))
    .sort();
  const files = paths.map((path) => {
    const data = readFileSync(join(dist, path));
    return { path, sha256: createHash('sha256').update(data).digest('hex'), size: data.length };
  });
  const manifest = JSON.stringify({ version: info.version, build: info.build, shell: info.shell, files });
  const signature = sign(null, Buffer.from(manifest), key).toString('base64');
  return { release: JSON.stringify({ manifest, signature }), files: files.map((f) => ({ ...f, from: join(dist, f.path) })) };
}

/** Writes the release for dist into out: release.json, and files/<sha256> for each file. Returns its version. */
export function writeRelease(dist, privateKeyPem, out) {
  const { release, files } = packRelease(dist, privateKeyPem);
  mkdirSync(join(out, 'files'), { recursive: true });
  for (const f of files) copyFileSync(f.from, join(out, 'files', f.sha256));
  writeFileSync(join(out, 'release.json'), release);
  return `${JSON.parse(JSON.parse(release).manifest).version}: ${files.length} files`;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [dist, out] = process.argv.slice(2);
  if (!dist || !out || !process.env.RELEASE_KEY) {
    console.error('Use: RELEASE_KEY=<key PEM> node sign-release.mjs <dist> <out>');
    process.exit(1);
  }
  console.log(writeRelease(dist, process.env.RELEASE_KEY, out));
}

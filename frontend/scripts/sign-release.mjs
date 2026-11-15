// Signs a web build as a release the apps update from: release.json, a signed manifest of every file, and each file
// under files/ named by its SHA-256, so an unchanged file is uploaded once and cached for good.
//
// Plain JavaScript on Node's standard library alone, so that the release pipeline's signing step runs it as it comes,
// from the tested build, with nothing installed. That step passes the key in RELEASE_KEY, and the MacApp step's record
// of the Mac app that runs the build, when it has one (scripts/mac-inbox.ts appRecord):
//   RELEASE_KEY=<key's PEM> node sign-release.mjs <dist> <out> [<app record>]
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

/**
 * The app record's fields as the Mac checks them before downloading anything: a version only going up, a folder on the
 * downloads host and a file in it, and the zip's SHA-512 and size. Throws for anything else, and for a record of an app
 * for other native code than the build's, which couldn't run it.
 */
function checkedRecord(record, shell) {
  const ok =
    record && typeof record === 'object' &&
    typeof record.version === 'string' && /^\d+\.\d+\.\d+$/.test(record.version) &&
    Number.isInteger(record.build) && record.build > 0 &&
    typeof record.shell === 'string' &&
    record.folder === `mac/${record.version}/` &&
    typeof record.file === 'string' && /^[\w.-]+\.zip$/.test(record.file) &&
    typeof record.sha512 === 'string' && /^[A-Za-z0-9+/]{86}==$/.test(record.sha512) &&
    Number.isInteger(record.size) && record.size > 0;
  if (!ok) throw new Error(`${JSON.stringify(record)} is not an app record`);
  if (record.shell !== shell.electron) throw new Error(`The app record is for other native code than this build's: ${record.shell}, not ${shell.electron}`);
  const { version, build, folder, file, sha512, size } = record;
  return { version, build, shell: record.shell, folder, file, sha512, size };
}

/**
 * The release for the build in dist: the signed manifest, and where each listed file is on disk. With an app record,
 * the manifest names the Mac app that runs it, so even a release that changes no native code says which app to get.
 */
export function packRelease(dist, privateKeyPem, record) {
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
  const app = record === undefined ? {} : { app: checkedRecord(record, info.shell) };
  const manifest = JSON.stringify({ version: info.version, build: info.build, shell: info.shell, files, ...app });
  const signature = sign(null, Buffer.from(manifest), key).toString('base64');
  return { release: JSON.stringify({ manifest, signature }), files: files.map((f) => ({ ...f, from: join(dist, f.path) })) };
}

/** Writes the release for dist into out: release.json, and files/<sha256> for each file. Returns its version. */
export function writeRelease(dist, privateKeyPem, out, record) {
  const { release, files } = packRelease(dist, privateKeyPem, record);
  mkdirSync(join(out, 'files'), { recursive: true });
  for (const f of files) copyFileSync(f.from, join(out, 'files', f.sha256));
  writeFileSync(join(out, 'release.json'), release);
  return `${JSON.parse(JSON.parse(release).manifest).version}: ${files.length} files`;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [dist, out, recordPath] = process.argv.slice(2);
  if (!dist || !out || !process.env.RELEASE_KEY) {
    console.error('Use: RELEASE_KEY=<key PEM> node sign-release.mjs <dist> <out> [<app record>]');
    process.exit(1);
  }
  // No record yet, as before any app had one: the release names no app, and the Mac offers the disk image.
  const record = recordPath && existsSync(recordPath) ? JSON.parse(readFileSync(recordPath, 'utf8')) : undefined;
  try {
    console.log(writeRelease(dist, process.env.RELEASE_KEY, out, record));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

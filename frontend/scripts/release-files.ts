// Turns a web build into a signed release: release.json, and every file under files/ named by its SHA-256, so an
// unchanged file is uploaded once and cached for good. scripts/release.sh runs it.
//   node scripts/release-files.ts key <key file>               makes the signing key, if there is none yet
//   node scripts/release-files.ts pack <dist> <key file> <out>  writes the release into <out>

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));

/** The release for the build in dist: the signed manifest, and where each listed file is on disk. */
export function packRelease(dist: string, privateKeyPem: string | Buffer) {
  const info = JSON.parse(readFileSync(join(dist, 'version.json'), 'utf8')) as { version: string; build: number; shell: object; releaseKey?: string };
  const key = createPrivateKey(privateKeyPem);
  const publicKey = createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
  // The apps check releases with the key built into them, so a build without this one could never take its own update.
  if (info.releaseKey !== publicKey) throw new Error(`${dist} was built without this release key. Build it again now that the key exists.`);
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

function main([command, ...args]: string[]) {
  if (command === 'key') {
    const [file] = args as [string];
    if (existsSync(file)) return;
    writeFileSync(file, generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    console.log(`Made the release signing key ${file}. Back it up: apps built with it take updates only signed by it.`);
  } else if (command === 'pack') {
    const [dist, keyFile, out] = args as [string, string, string];
    const { release, files } = packRelease(dist, readFileSync(keyFile));
    mkdirSync(join(out, 'files'), { recursive: true });
    for (const f of files) copyFileSync(f.from, join(out, 'files', f.sha256));
    writeFileSync(join(out, 'release.json'), release);
    console.log(`${(JSON.parse((JSON.parse(release) as { manifest: string }).manifest) as { version: string }).version}: ${files.length} files`);
  } else {
    throw new Error('Use: release-files.ts key <key file> | pack <dist> <key file> <out>');
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]!).href) main(process.argv.slice(2));

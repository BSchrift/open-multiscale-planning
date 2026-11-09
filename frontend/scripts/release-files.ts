// Turns a web build into a signed release: release.json, and every file under files/ named by its SHA-256, so an
// unchanged file is uploaded once and cached for good. scripts/release.sh runs it.
//   node scripts/release-files.ts key <key file>               makes the signing key, if there is none yet
//   node scripts/release-files.ts pack <dist> <key file> <out>  writes the release into <out>

import { generateKeyPairSync } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { packRelease, writeRelease } from './sign-release.mjs';

// The release pipeline's signing step runs the same packing, on Node alone: sign-release.mjs.
export { packRelease };

function main([command, ...args]: string[]) {
  if (command === 'key') {
    const [file] = args as [string];
    if (existsSync(file)) return;
    writeFileSync(file, generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    console.log(`Made the release signing key ${file}. Back it up: apps built with it take updates only signed by it.`);
  } else if (command === 'pack') {
    const [dist, keyFile, out] = args as [string, string, string];
    console.log(writeRelease(dist, readFileSync(keyFile), out));
  } else {
    throw new Error('Use: release-files.ts key <key file> | pack <dist> <key file> <out>');
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]!).href) main(process.argv.slice(2));

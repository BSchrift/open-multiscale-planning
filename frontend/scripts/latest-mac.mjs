// latest-mac.yml, which electron-updater reads from an app's folder on the downloads host before it downloads the app
// (frontend/electron/appUpdates.ts, docs/releasing.md). The release pipeline writes it from the record of the zip the
// MacApp step checked, never from what GitHub Actions uploaded, and the Mac refuses an app unless it says exactly what
// the signed record does:
//   node latest-mac.mjs <app record> > latest-mac.yml
//
// Plain JavaScript on Node's standard library alone, like sign-release.mjs, so the pipeline and its tests run it with
// nothing installed.

import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * latest-mac.yml for an app record (scripts/mac-inbox.ts appRecord): its version, and its zip with the SHA-512 and size
 * electron-updater checks. Throws for a record whose fields aren't the ones sign-release.mjs signs, since a value
 * YAML reads otherwise would make the file say something the record doesn't.
 */
export function latestMacYml(record, releaseDate = new Date()) {
  const ok =
    record && typeof record === 'object' &&
    typeof record.version === 'string' && /^\d+\.\d+\.\d+$/.test(record.version) &&
    typeof record.file === 'string' && /^[\w.-]+\.zip$/.test(record.file) &&
    typeof record.sha512 === 'string' && /^[A-Za-z0-9+/]{86}==$/.test(record.sha512) &&
    Number.isInteger(record.size) && record.size > 0;
  if (!ok) throw new Error(`${JSON.stringify(record)} is not an app record`);
  const { version, file, sha512, size } = record;
  return `version: ${version}\nfiles:\n  - url: ${file}\n    sha512: ${sha512}\n    size: ${size}\npath: ${file}\nsha512: ${sha512}\nreleaseDate: '${releaseDate.toISOString()}'\n`;
}

// By its real path, as Node names this module: macOS's temporary folders are behind a symlink.
if (import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const [recordPath] = process.argv.slice(2);
  if (!recordPath) {
    console.error('Use: node latest-mac.mjs <app record>');
    process.exit(1);
  }
  try {
    process.stdout.write(latestMacYml(JSON.parse(readFileSync(recordPath, 'utf8'))));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

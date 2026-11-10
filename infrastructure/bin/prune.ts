// What scripts/pipeline.sh prune deletes from a release bucket, worked out from what it downloaded into <dir>: each
// version's web/version.json and release.json under versions/, state/history.json, and the listings of web/assets/ and
// release/files/ as `aws s3 ls --recursive` prints them. Prints one line per thing to delete: "version <version>",
// "asset <path under web/assets/>" or "file <sha256>".
// Usage: node bin/prune.ts <dir> <version each surface serves>...
//
// Kept: the newest 20 versions by build, every version a surface serves, and the last three in each surface's history.
// A file in the stores named by content goes only when no kept version's feed lists it, a source map with its file,
// and only once it's more than 14 days old, so a tab still on an old page can load its chunks and a device in the
// middle of a download finishes it. A version folder with no version.json may be one being uploaded, so it stays.
// It refuses, deleting nothing, when a surface serves a version with no folder, as before the first upload, since
// that version's files would go.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const NEWEST = 20;
const LAST_IN_HISTORY = 3;
const GRACE_MS = 14 * 24 * 3600 * 1000;

const [dir, ...live] = process.argv.slice(2) as [string, ...string[]];
const read = (path: string) => (existsSync(join(dir, path)) ? readFileSync(join(dir, path), 'utf8') : null);

const versions = (existsSync(join(dir, 'versions')) ? readdirSync(join(dir, 'versions')) : [])
  .map((version) => ({ version, info: read(`versions/${version}/web/version.json`), feed: read(`versions/${version}/release.json`) }))
  .filter((v): v is { version: string; info: string; feed: string | null } => v.info !== null)
  .map((v) => ({ ...v, build: (JSON.parse(v.info) as { build: number }).build }));
const known = new Set(versions.map((v) => v.version));

const missing = live.filter((version) => !known.has(version));
if (missing.length > 0) {
  console.error(`A surface serves ${missing.join(' and ')}, which has no folder under versions/, so nothing is pruned: its files would go.`);
  process.exit(1);
}

const history = JSON.parse(read('history.json') ?? '{}') as Record<string, { version: string }[]>;
const recent = Object.values(history).flatMap((lines) => [...new Set(lines.map((l) => l.version).reverse())].slice(0, LAST_IN_HISTORY));
const newest = [...versions].sort((a, b) => b.build - a.build).slice(0, NEWEST).map((v) => v.version);
const kept = new Set([...newest, ...live, ...recent]);
for (const v of versions) if (!kept.has(v.version)) console.log(`version ${v.version}`);

// The files every kept version lists. Without one kept version's feed, what it needs isn't known, so no file goes.
const keptVersions = versions.filter((v) => kept.has(v.version));
if (keptVersions.some((v) => v.feed === null)) {
  console.error('A kept version has no release.json yet, so no file is pruned this time.');
  process.exit(0);
}
const files = keptVersions.flatMap((v) => (JSON.parse(JSON.parse(v.feed!).manifest) as { files: { path: string; sha256: string }[] }).files);
const keptAssets = new Set(files.filter((f) => f.path.startsWith('assets/')).map((f) => f.path.slice('assets/'.length)));
const keptFiles = new Set(files.map((f) => f.sha256));

// Each line of a listing: its time, size and key.
const listed = (name: string, prefix: string) =>
  (read(name) ?? '').split('\n').flatMap((line) => {
    const m = /^(\S+ \S+) +\d+ (\S+)$/.exec(line);
    return m && m[2]!.startsWith(prefix) ? [{ at: new Date(m[1]!).getTime(), name: m[2]!.slice(prefix.length) }] : [];
  });
const old = (at: number) => Date.now() - at > GRACE_MS;
for (const { at, name } of listed('assets.txt', 'web/assets/')) {
  if (!keptAssets.has(name) && !keptAssets.has(name.replace(/\.map$/, '')) && old(at)) console.log(`asset ${name}`);
}
for (const { at, name } of listed('files.txt', 'release/files/')) if (!keptFiles.has(name) && old(at)) console.log(`file ${name}`);

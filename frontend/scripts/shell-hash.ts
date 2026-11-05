// Names the native code each app's web bundle was built against. A downloaded bundle only runs on an app whose native
// code hashes the same, since it may call what that code offers and nothing else.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const NOT_SHIPPED = /(\.test\.ts|\/e2e\/.*|\/UITests\/.*|playwright\.config\.ts|vitest\.electron\.config\.ts|\/harness\/.*|README\.md|\.gitignore)$/;

/** What each app's native code is made of: tracked files, and the installed versions of native packages. */
export const SHELL_SOURCES: Record<'electron' | 'ios', { paths: string[]; packages(name: string): boolean }> = {
  electron: { paths: ['electron', 'scripts/electron-compile.mjs'], packages: (name) => name === 'electron' || name === 'better-sqlite3' },
  ios: { paths: ['ios', 'capacitor.config.json'], packages: (name) => name.includes('capacitor') },
};

/** files: path to contents. versions: installed package name to version. */
export function shellHash(files: Record<string, string | Buffer>, versions: Record<string, string>): string {
  const hash = createHash('sha256');
  for (const path of Object.keys(files).filter((p) => !NOT_SHIPPED.test(p)).sort()) hash.update(`${path}\0${files[path]}\0`);
  for (const name of Object.keys(versions).sort()) hash.update(`${name}@${versions[name]}\0`);
  return hash.digest('hex').slice(0, 16);
}

/** Both apps' hashes for the frontend folder at root, from what git tracks there and the lockfile. */
export function shellHashes(root: string): Record<'electron' | 'ios', string> {
  const lock = (JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')) as { packages: Record<string, { version: string }> }).packages;
  const result = { electron: '', ios: '' };
  for (const app of ['electron', 'ios'] as const) {
    const { paths, packages } = SHELL_SOURCES[app];
    const tracked = execFileSync('git', ['ls-files', '--', ...paths], { cwd: root }).toString().split('\n').filter(Boolean);
    const files = Object.fromEntries(tracked.map((path) => [path, readFileSync(join(root, path))]));
    const versions = Object.fromEntries(
      Object.entries(lock)
        .filter(([key]) => key.startsWith('node_modules/') && packages(key.slice('node_modules/'.length)))
        .map(([key, value]) => [key.slice('node_modules/'.length), value.version]),
    );
    result[app] = shellHash(files, versions);
  }
  return result;
}

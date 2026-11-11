// Names the native code each app's web bundle was built against. A downloaded bundle only runs on an app whose native
// code hashes the same, since it may call what that code offers and nothing else.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const NOT_SHIPPED =
  /(\.test\.ts|\/e2e\/.*|\/UITests\/.*|playwright\.config\.ts|vitest\.electron\.config\.ts|node-sqlite-swap\.ts|Config\.example\.xcconfig|\/harness\/.*|README\.md|\.gitignore)$/;

/** What each app's native code is made of: tracked files, and the installed versions of native packages. */
export const SHELL_SOURCES: Record<'electron' | 'ios', { paths: string[]; packages(name: string): boolean }> = {
  electron: {
    // With the web app's own code that esbuild bundles into the main process. electron-compile.mjs checks this list
    // against what it bundled, so a new import from src fails the Mac build until it's added here.
    paths: ['electron', 'scripts/electron-compile.mjs', 'src/platform/shortcut.ts', 'src/core/captureTitle.ts'],
    packages: (name) => name === 'electron' || name === 'better-sqlite3',
  },
  ios: { paths: ['ios', 'capacitor.config.json'], packages: (name) => name.includes('capacitor') },
};

/** Whether the app's hash covers this file, as a path from the frontend folder. */
export function isHashed(app: 'electron' | 'ios', path: string): boolean {
  return SHELL_SOURCES[app].paths.some((p) => path === p || path.startsWith(`${p}/`)) && !NOT_SHIPPED.test(path);
}

/** What the Mac app's main process is built with besides its files: its __BUILD__, without the devUrl only a dev run has. */
export interface MacBuild {
  name: string;
  scheme: string;
  backendOrigins: string[];
}

/**
 * The Mac build for a config and the app's name and scheme. The main process bakes the backend origins into the page's
 * content security policy, so a bundle built for other origins can only run on an app built for them too.
 */
export function macBuild(
  config: { apiUrl: string; authUrl: string; releaseUrl?: string; filesUrl?: string; filesUploadUrl?: string },
  identity: { name: string; scheme: string },
): MacBuild {
  const reached = [config.apiUrl, config.authUrl, config.releaseUrl, config.filesUrl, config.filesUploadUrl];
  return {
    name: identity.name,
    scheme: identity.scheme,
    // The page reaches these: the API, sign-in, where updates come from, and attachments' storage.
    backendOrigins: [...new Set(reached.filter((url): url is string => Boolean(url)).map((url) => new URL(url).origin))],
  };
}

/** files: path to contents. versions: installed package name to version. build: the Mac build, for the Mac app. */
export function shellHash(files: Record<string, string | Buffer>, versions: Record<string, string>, build?: MacBuild): string {
  const hash = createHash('sha256');
  for (const path of Object.keys(files).filter((p) => !NOT_SHIPPED.test(p)).sort()) hash.update(`${path}\0${files[path]}\0`);
  for (const name of Object.keys(versions).sort()) hash.update(`${name}@${versions[name]}\0`);
  if (build) hash.update(`__BUILD__\0${JSON.stringify(build)}\0`);
  return hash.digest('hex').slice(0, 16);
}

/** Both apps' hashes for the frontend folder at root, from what git tracks there, the lockfile and the Mac build. */
export function shellHashes(root: string, build: MacBuild): Record<'electron' | 'ios', string> {
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
    result[app] = shellHash(files, versions, app === 'electron' ? build : undefined);
  }
  return result;
}

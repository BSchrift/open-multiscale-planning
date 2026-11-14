// Bundles the main process, preloads and capture page into dist-electron, with what this environment's build needs.

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { appIdentity } from '../electron/identity.ts';
import { loadAppConfig, loadBundleId } from '../src/core/appConfig.ts';
import { ELECTRON_PACKAGES, isHashed, macBuild } from './shell-hash.ts';

/** A bundled file's package, as the lockfile names it, such as electron-updater/node_modules/semver. */
export const packageKey = (path) =>
  path.split('node_modules/').slice(1).map((part) => part.split('/').slice(0, part.startsWith('@') ? 2 : 1).join('/')).join('/node_modules/');

const root = join(import.meta.dirname, '..');
const out = join(root, 'dist-electron');

const readConfig = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : null);

/** The environment's config and identity: outputs and app.bundleId from the config folder, built in for local. */
export function buildSettings(env = process.env.ENV) {
  const configDir = resolve(process.env.MULTISCALE_CONFIG_DIR || join(root, '../config'));
  const config = loadAppConfig(env, readConfig, configDir, process.env.LOCAL_API_URL);
  return { config, identity: appIdentity(config.env, loadBundleId(config.env, readConfig, configDir)) };
}

/** The main process's build-time values. Only an e2e build, MULTISCALE_E2E=1, keeps its stand-ins for the app's place and updater. */
export const mainDefines = (config, identity, devUrl) => ({
  __BUILD__: JSON.stringify({ ...macBuild(config, identity), devUrl: devUrl ?? null }),
  __E2E__: JSON.stringify(process.env.MULTISCALE_E2E === '1'),
});

export async function compile(env, devUrl) {
  const { config, identity } = buildSettings(env);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out);
  const common = {
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    sourcemap: true,
    logLevel: 'warning',
    outdir: out,
    outExtension: { '.js': '.cjs' },
    absWorkingDir: root,
    metafile: true,
  };
  const bundles = [];
  bundles.push(await build({
    ...common,
    entryPoints: [join(root, 'electron/main.ts')],
    external: ['electron', 'better-sqlite3'],
    // The web build hashes the same macBuild into the Mac app's shell hash.
    define: mainDefines(config, identity, devUrl),
    // Folds the e2e branches away, so a release build doesn't carry them.
    minifySyntax: true,
  }));
  // Sandboxed preloads get only what Electron gives them, so nothing else can be required at runtime.
  bundles.push(await build({ ...common, entryPoints: [join(root, 'electron/preload.ts'), join(root, 'electron/capture-preload.ts')], external: ['electron'] }));
  bundles.push(await build({ ...common, platform: 'browser', format: 'iife', outExtension: {}, entryPoints: [join(root, 'electron/capture.ts')], target: 'chrome120' }));
  // An installed app takes a downloaded web bundle only if its shell hash matches, so the hash has to cover every file
  // bundled here. Inputs like <define:__BUILD__> are this build's settings, not files.
  const files = bundles.flatMap((bundle) => Object.keys(bundle.metafile.inputs)).filter((path) => !path.startsWith('<'));
  const unhashed = files.filter((path) => !path.includes('node_modules/') && !isHashed('electron', path));
  if (unhashed.length > 0) throw new Error(`Add ${[...new Set(unhashed)].join(', ')} to SHELL_SOURCES in scripts/shell-hash.ts: the Mac app is built with them`);
  const unlisted = [...new Set(files.filter((path) => path.includes('node_modules/')).map(packageKey))].filter((key) => !ELECTRON_PACKAGES.has(key));
  if (unlisted.length > 0) throw new Error(`Add ${unlisted.join(', ')} to ELECTRON_PACKAGES in scripts/shell-hash.ts: the Mac app's main process bundles them`);
  cpSync(join(root, 'electron/capture.html'), join(out, 'capture.html'));
  cpSync(join(root, 'electron/capture.css'), join(out, 'capture.css'));
  cpSync(join(root, 'electron/assets'), join(out, 'assets'), { recursive: true });
  return { config, identity };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await compile();

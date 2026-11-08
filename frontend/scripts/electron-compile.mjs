// Bundles the main process, preloads and capture page into dist-electron, with what this environment's build needs.

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { appIdentity } from '../electron/identity.ts';
import { loadAppConfig, loadBundleId } from '../src/core/appConfig.ts';
import { isHashed, macBuild } from './shell-hash.ts';

const root = join(import.meta.dirname, '..');
const out = join(root, 'dist-electron');

const readConfig = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : null);

/** The environment's config and identity: outputs and app.bundleId from the config folder, built in for local. */
export function buildSettings(env = process.env.ENV) {
  const configDir = resolve(process.env.MULTISCALE_CONFIG_DIR || join(root, '../config'));
  const config = loadAppConfig(env, readConfig, configDir, process.env.LOCAL_API_URL);
  return { config, identity: appIdentity(config.env, loadBundleId(config.env, readConfig, configDir)) };
}

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
    define: { __BUILD__: JSON.stringify({ ...macBuild(config, identity), devUrl: devUrl ?? null }) },
  }));
  // Sandboxed preloads get only what Electron gives them, so nothing else can be required at runtime.
  bundles.push(await build({ ...common, entryPoints: [join(root, 'electron/preload.ts'), join(root, 'electron/capture-preload.ts')], external: ['electron'] }));
  bundles.push(await build({ ...common, platform: 'browser', format: 'iife', outExtension: {}, entryPoints: [join(root, 'electron/capture.ts')], target: 'chrome120' }));
  // An installed app takes a downloaded web bundle only if its shell hash matches, so the hash has to cover every file
  // bundled here. Inputs like <define:__BUILD__> are this build's settings, not files.
  const files = bundles.flatMap((bundle) => Object.keys(bundle.metafile.inputs)).filter((path) => !path.startsWith('<'));
  const unhashed = files.filter((path) => !isHashed('electron', path));
  if (unhashed.length > 0) throw new Error(`Add ${[...new Set(unhashed)].join(', ')} to SHELL_SOURCES in scripts/shell-hash.ts: the Mac app is built with them`);
  cpSync(join(root, 'electron/capture.html'), join(out, 'capture.html'));
  cpSync(join(root, 'electron/capture.css'), join(out, 'capture.css'));
  cpSync(join(root, 'electron/assets'), join(out, 'assets'), { recursive: true });
  return { config, identity };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await compile();

import { execSync } from 'node:child_process';
import { createPublicKey } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { forEnv } from '@multiscale/config';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { parse } from 'yaml';
import { loadRetention } from '../config/retention';
import { appIdentity } from './electron/identity';
import { loadAppConfig } from './src/core/appConfig';
import type { Retention } from './src/core/retention';
import { macBuild, shellHashes } from './scripts/shell-hash';

const readConfigFile = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : null);
const configDir = resolve(process.env.MULTISCALE_CONFIG_DIR || join(import.meta.dirname, '../config'));
const git = (command: string, fallback: string) => {
  try {
    return execSync(`git ${command}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return fallback;
  }
};
const version = `${(JSON.parse(readFileSync(join(import.meta.dirname, 'package.json'), 'utf8')) as { version: string }).version}-${git('rev-parse --short HEAD', 'dev')}`;
const build = Number(git('log -1 --format=%ct', '0'));
const appConfig = loadAppConfig(process.env.ENV, readConfigFile, configDir, process.env.LOCAL_API_URL);
// The Mac app built for this environment and backend, as electron-compile.mjs builds it. Its name and scheme don't
// depend on the bundle id, which only the Mac build reads.
const shell = shellHashes(import.meta.dirname, macBuild(appConfig, appIdentity(appConfig.env)));
// The repo's own retention policy, not the config folder's: it's the same for everyone who builds this code.
const retention: Retention = loadRetention(appConfig.env, { read: (path) => readFileSync(path, 'utf8'), parse });
const config = { ...appConfig, version, build, shell, settings: forEnv(appConfig.env), retention };
// The public half of the key releases are signed with, made by scripts/release.sh. Without it the apps take no updates.
const keyFile = join(configDir, `${config.env}.release-key.pem`);
const releaseKey = existsSync(keyFile) ? createPublicKey(readFileSync(keyFile)).export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64') : undefined;

export default defineConfig({
  plugins: [
    react(),
    {
      // Read by the native code: the bundle shipped inside each app says which key and which native code updates must match.
      name: 'version-json',
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ version, build, shell, ...(releaseKey ? { releaseKey } : {}) }) });
      },
    },
  ],
  // ENV picks the backend this build talks to, local (the default), staging or prod, and its retention block.
  // LOCAL_API_URL picks a local stack.
  define: { __APP_CONFIG__: JSON.stringify(config) },
  // This checkout's own config, even when node_modules is another checkout's, as the older one in make test-compat is.
  resolve: { alias: { '@multiscale/config': join(import.meta.dirname, '../config/app.gen.ts') } },
  // From the root, so the web app's /auth/callback page loads the same files as its home page. Electron's app scheme and
  // capacitor:// on iPhone serve the bundle at their root too.
  base: '/',
  build: { outDir: 'dist', sourcemap: true },
  // The OPFS database worker (platform/opfs.worker.ts) is a module, as SQLite's WebAssembly build is.
  worker: { format: 'es' },
  // As SQLite's WebAssembly build asks. Only the worker imports it, so prebundling would find it late and reload the page.
  optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
});

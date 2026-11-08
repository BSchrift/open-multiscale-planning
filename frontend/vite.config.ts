import { execSync } from 'node:child_process';
import { createPublicKey } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { loadAppConfig } from './src/core/appConfig';
import { shellHashes } from './scripts/shell-hash';

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
const shell = shellHashes(import.meta.dirname);
const config = { ...loadAppConfig(process.env.ENV, readConfigFile, configDir, process.env.LOCAL_API_URL), version, build, shell };
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
  // ENV picks the backend this build talks to: local (the default), staging or prod. LOCAL_API_URL picks a local stack.
  define: { __APP_CONFIG__: JSON.stringify(config) },
  // From the root, so the web app's /auth/callback page loads the same files as its home page. Electron's app scheme and
  // capacitor:// on iPhone serve the bundle at their root too.
  base: '/',
  build: { outDir: 'dist', sourcemap: true },
});

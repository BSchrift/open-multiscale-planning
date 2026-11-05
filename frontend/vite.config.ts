import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { loadAppConfig } from './src/core/appConfig';

const readConfigFile = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : null);
const configDir = resolve(process.env.MULTISCALE_CONFIG_DIR || join(import.meta.dirname, '../config'));

export default defineConfig({
  plugins: [react()],
  // ENV picks the backend this build talks to: local (the default), staging or prod. LOCAL_API_URL picks a local stack.
  define: { __APP_CONFIG__: JSON.stringify(loadAppConfig(process.env.ENV, readConfigFile, configDir, process.env.LOCAL_API_URL)) },
  // Relative paths so that the build loads from its own scheme in Electron and capacitor:// on iPhone.
  base: './',
  build: { outDir: 'dist', sourcemap: true },
  server: { port: 5173, strictPort: false },
});

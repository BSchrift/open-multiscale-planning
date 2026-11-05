// The app against Vite's dev server, with hot reload for the page. Restart this after changing the main process.

import { spawn } from 'node:child_process';
import electronPath from 'electron';
import { createServer } from 'vite';
import { compile } from './electron-compile.mjs';

const server = await createServer();
await server.listen();
await compile(undefined, server.resolvedUrls.local[0]);
const app = spawn(electronPath, ['.'], { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } });
app.on('exit', async (code) => {
  await server.close();
  process.exit(code ?? 0);
});

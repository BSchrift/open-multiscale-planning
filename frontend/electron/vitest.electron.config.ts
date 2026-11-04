import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// Runs the core database tests, query plans included, under Electron's runtime and through the app's own driver:
// the shared tests open their database through node-sqlite, so that import is pointed at better-sqlite3.
export default defineConfig({
  root: resolve(import.meta.dirname, '..'),
  resolve: {
    alias: [{ find: /^.*\/platform\/node-sqlite$/, replacement: resolve(import.meta.dirname, 'node-sqlite-swap.ts') }],
  },
  test: {
    environment: 'node',
    include: ['src/core/queries.test.ts', 'src/core/core.test.ts', 'electron/sqlite-driver.test.ts', 'electron/runtime.test.ts'],
  },
});

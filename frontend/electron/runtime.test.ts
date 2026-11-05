import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import * as sharedDriver from '../src/platform/node-sqlite';

// Under vitest.electron.config.ts this proves the other tests in that run really are on Electron's runtime. A plain
// npm test runs it on Node, where it has nothing to prove.
it.runIf(process.env.ELECTRON_RUN_AS_NODE)('is on Electron, with a current SQLite', () => {
  expect(process.versions.electron).toBeTruthy();
  expect('isAppDriver' in sharedDriver).toBe(true);
  const { version } = new Database(':memory:').prepare('SELECT sqlite_version() AS version').get() as { version: string };
  expect(version >= '3.45').toBe(true);
});

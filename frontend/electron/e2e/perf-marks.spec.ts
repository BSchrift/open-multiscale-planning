// The Mac app's own KPI mark (docs/performance.md): the global shortcut makes exactly one capture.global measure in the
// capture panel, from the press as the main process got it. Nothing here is timed.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';

const ROOT = join(import.meta.dirname, '../..');
const KEYCHAIN = process.platform === 'linux' ? ['-r', join(import.meta.dirname, 'linux-keychain.cjs')] : [];

let dataDir: string;
let app: ElectronApplication | undefined;

test.beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'multiscale-e2e-'));
  writeFileSync(join(dataDir, 'login-item-set'), '');
});

test.afterEach(async () => {
  await app?.close();
  app = undefined;
  rmSync(dataDir, { recursive: true, force: true });
});

test('the capture shortcut makes one capture.global measure in the panel', async () => {
  app = await electron.launch({ args: [...KEYCHAIN, ROOT, `--user-data-dir=${dataDir}`, '--use-mock-keychain'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } });
  await expect.poll(() => app!.windows().some((w) => w.url().endsWith('capture.html'))).toBe(true);
  const panel = app.windows().find((w) => w.url().endsWith('capture.html'))!;
  await app.evaluate(({ app: a }) => void a.emit('capture-shortcut'));
  await expect(panel.getByRole('textbox', { name: 'Capture' })).toBeFocused();
  await expect.poll(() => panel.evaluate(() => performance.getEntriesByType('measure').map((m) => m.name))).toEqual(['capture.global']);
});

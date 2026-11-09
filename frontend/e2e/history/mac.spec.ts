// The Mac app as a new install of the history user: how long its first sync takes to a usable app, and how long Today
// and Week take to read. Started the way frontend/electron/e2e starts it, on a data folder of its own, with the test
// playing the system browser for the sign-in.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, chromium, expect, test } from '@playwright/test';
import { appIdentity } from '../../electron/identity';
import type { AppEnv } from '../../src/core/appConfig';
import { historyFacts } from '../../src/core/history-testing';
import { account, go } from '../seed';
import { historyTarget, keptChanges, NETWORK, record, timeQueries, usableAt } from './history';

declare global {
  var browserUrls: string[];
}

const ROOT = join(import.meta.dirname, '../..');
const KEYCHAIN = process.platform === 'linux' ? ['-r', join(ROOT, 'electron/e2e/linux-keychain.cjs')] : [];
const t = historyTarget();

test('a new install of the five-year account: first sync, then Today and Week', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'multiscale-history-'));
  const app = await electron.launch({
    // The mock keychain keeps an unattended run from stopping at a keychain prompt.
    args: [...KEYCHAIN, ROOT, `--user-data-dir=${dir}`, '--use-mock-keychain'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
  });
  try {
    await app.evaluate(({ shell }) => {
      globalThis.browserUrls = [];
      shell.openExternal = async (url: string) => void globalThis.browserUrls.push(url);
    });
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect.poll(() => app.evaluate(() => globalThis.browserUrls.length)).toBe(1);
    const url = await app.evaluate(() => globalThis.browserUrls.pop()!);

    // Plays the browser: the sign-in page answers with a redirect to the app's link, which macOS would hand the app.
    let started = Date.now();
    let link = '';
    if (t.test_user) {
      const browser = await chromium.launch();
      try {
        const tab = await browser.newPage();
        await tab.goto(url);
        await tab.locator('input[name=username]:visible').fill(t.test_user.username, NETWORK);
        await tab.locator('input[name=password]:visible').fill(t.test_user.password);
        const scheme = appIdentity(t.env as AppEnv).scheme;
        const back = tab.waitForResponse((res) => (res.headers().location ?? '').startsWith(`${scheme}://`), NETWORK);
        started = Date.now();
        await tab.locator('input[name=signInSubmitButton]:visible').click();
        link = (await back).headers().location!;
      } finally {
        await browser.close();
      }
    } else {
      // The local sign-in lets the stack's own user straight in.
      link = (await fetch(url, { redirect: 'manual' })).headers.get('location') ?? '';
    }
    await app.evaluate(({ app }, u) => void app.emit('open-url', { preventDefault: () => undefined }, u), link);
    const firstSync = (await usableAt(page, historyFacts(keptChanges()).openInbox)) - started;
    console.log(`mac: usable ${(firstSync / 1000).toFixed(1)} s after the sign-in was sent`);

    await go(page, 'Settings');
    await expect(account(page).getByText('Synced', { exact: true })).toBeVisible(NETWORK);
    const queries = await timeQueries(page, 'electron');
    // Recorded before the count is checked, so the report sees a short count even when only reporting.
    record('mac', { first_sync_ms: firstSync, ...queries });
    expect(queries.records).toBeGreaterThanOrEqual(historyFacts(keptChanges()).records);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// Where a shared spec runs: the browser build by default, or the Mac app when E2E_PLATFORM is mac, which
// electron/playwright.config.ts sets for the specs it shares with the browser. On the Mac, each test gets the real app
// on a data folder of its own, so it starts at first-run setup as a browser context does.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test as base } from '@playwright/test';

export const onMac = process.env.E2E_PLATFORM === 'mac';

/** The app's home page: the dev server's root in the browser, the app's own scheme on the Mac. */
export const home = onMac ? 'multiscale-app://app/' : '/';

// Always the unpackaged app: the packaged one has its inspector fuse off, so Playwright can't attach to it.
const ROOT = join(import.meta.dirname, '..');
const KEYCHAIN = process.platform === 'linux' ? ['-r', join(import.meta.dirname, '../electron/e2e/linux-keychain.cjs')] : [];

const mac = base.extend({
  // The test's time zone and colour scheme reach the app as they reach a browser context.
  page: async ({ timezoneId, colorScheme }, use) => {
    const dir = mkdtempSync(join(tmpdir(), 'multiscale-e2e-'));
    // A packaged app registers itself as a login item on first run, which a test shouldn't do to this Mac.
    writeFileSync(join(dir, 'login-item-set'), '');
    const app = await electron.launch({
      // The mock keychain keeps an unattended run from stopping at a keychain prompt. Linux has none, see linux-keychain.cjs.
      args: [...KEYCHAIN, ROOT, `--user-data-dir=${dir}`, '--use-mock-keychain'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '', ...(timezoneId ? { TZ: timezoneId } : {}) },
      // The capture window's policy has no eval, which page.clock needs in every window. desktop.spec.ts checks the
      // policy itself, without this.
      bypassCSP: true,
      ...(timezoneId ? { timezoneId } : {}),
      ...(colorScheme ? { colorScheme } : {}),
    });
    const page = await app.firstWindow();
    await page.waitForFunction(() => document.getElementById('root')?.childElementCount);
    // page.clock reaches every window, so the hidden capture window has to have loaded first, or a clock installed while
    // it loads misses it.
    await expect.poll(() => app.windows().some((w) => w.url().endsWith('capture.html'))).toBe(true);
    await app.windows().find((w) => w.url().endsWith('capture.html'))!.waitForLoadState();
    await use(page);
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  },
});

export const test = onMac ? mac : base;
export { expect };

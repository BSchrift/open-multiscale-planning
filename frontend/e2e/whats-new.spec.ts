// What's new on the iPhone, in the browser at phone size, which stands in for it when the page says so (Shell.tsx). An
// update is simulated as the phone sees one: the newest line it has seen is older than the running bundle's newest.

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { newestId, WHATS_NEW_KEY } from '../src/core/whatsNew';
import { WHATS_NEW } from '../src/whatsNew';
import { expectTapTarget, saved, seed } from './seed';

const NEWEST = newestId(WHATS_NEW);
// Longer than the app waits to settle before it shows.
const SETTLE_MS = 3000;

test.beforeEach(async ({ page }, info) => {
  test.skip(info.project.name !== 'phone', 'The iPhone app is phone sized');
  await page.addInitScript(() => (window.multiscaleWhatsNew = true));
});

const sheet = (page: Page) => page.getByRole('dialog', { name: 'Multiscale has been updated!', exact: true });
const seen = (page: Page) => page.evaluate((key) => localStorage.getItem(key), WHATS_NEW_KEY);

/** A new install: first-run setup, then past it. */
async function install(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();
  await seed(page, [{ type: 'settings', id: 'settings', fields: { setup_done_at: '2026-01-01T00:00:00.000Z' } }]);
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  // Saved before a reload, which otherwise can come before phone WebKit's save and open a first-run app.
  await saved(page, '2026-01-01T00:00:00.000Z');
}

test('a new install shows nothing, then an update shows its new lines once, dated, until Got it', async ({ page }) => {
  await install(page);
  await expect.poll(() => seen(page)).toBe(String(NEWEST));
  await page.waitForTimeout(SETTLE_MS);
  await expect(sheet(page)).toHaveCount(0);

  // The phone last saw the line before the newest two, and the update brought those two.
  await page.evaluate(({ key, id }) => localStorage.setItem(key, String(id)), { key: WHATS_NEW_KEY, id: WHATS_NEW[2]!.id });
  await page.reload();
  await expect(sheet(page)).toBeVisible();
  await expect(sheet(page).getByRole('heading')).toHaveText(['Multiscale has been updated!', "What's new"]);
  await expect(sheet(page).getByText(/^[A-Z][a-z]{2} \d{1,2}$/)).toBeVisible();
  await expect(sheet(page).getByRole('listitem')).toHaveText(WHATS_NEW.slice(0, 2).map((e) => e.text));
  await expect(sheet(page)).toBeFocused();
  await expectTapTarget(sheet(page).getByRole('button', { name: 'Got it' }));

  await sheet(page).getByRole('button', { name: 'Got it' }).click();
  await expect(sheet(page)).toHaveCount(0);
  expect(await seen(page)).toBe(String(NEWEST));
  await expect(page.locator('.pane[aria-hidden="false"]')).toBeFocused();

  // The next launch on this phone shows nothing.
  await page.reload();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  await page.waitForTimeout(SETTLE_MS);
  await expect(sheet(page)).toHaveCount(0);
});

test('a phone updating from before What’s new shows the newest lines, and Esc puts them away', async ({ page }) => {
  await install(page);
  await page.evaluate((key) => localStorage.removeItem(key), WHATS_NEW_KEY);
  await page.reload();
  await expect(sheet(page).getByRole('listitem')).toHaveText(WHATS_NEW.slice(0, 6).map((e) => e.text));
  await page.keyboard.press('Escape');
  await expect(sheet(page)).toHaveCount(0);
  expect(await seen(page)).toBe(String(NEWEST));
});

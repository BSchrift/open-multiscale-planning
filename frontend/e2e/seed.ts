// Seeds records into the browser build before a test looks at a screen. Only dev builds expose the hook. Also the
// steps the browser and Electron specs share.

import { expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { formatDate } from '../src/core/dates';

export interface Seed {
  type: string;
  id?: string;
  fields: Record<string, unknown>;
}

/** Waits for the app to open its data, then writes the records in one transaction. */
export async function seed(page: Page, records: readonly Seed[]): Promise<void> {
  await page.waitForFunction(() => 'multiscaleSeed' in window);
  await page.evaluate((r) => (window as unknown as { multiscaleSeed(r: readonly Seed[]): Promise<void> }).multiscaleSeed(r), records);
}

/** Opens the app past first-run setup, with the given records already in place. */
export async function openSeeded(page: Page, records: readonly Seed[] = []): Promise<void> {
  await page.goto('/');
  await seed(page, [{ type: 'settings', id: 'settings', fields: { setup_done_at: '2026-01-01T00:00:00.000Z' } }, ...records]);
}

/** Checks a control is at least 44pt each way, the smallest a finger can hit reliably. */
export async function expectTapTarget(target: Locator): Promise<void> {
  const box = await target.boundingBox();
  const what = await target.evaluate((e) => e.outerHTML.slice(0, 80));
  expect(box?.height, what).toBeGreaterThanOrEqual(44);
  expect(box?.width, what).toBeGreaterThanOrEqual(44);
}

/** A main area's page. */
export const pane = (page: Page, label: string) => page.locator(`.pane[aria-label='${label}']:visible`);
export const account = (page: Page) => pane(page, 'Settings').getByRole('region', { name: 'Account' });

/** Opens a desktop tab and waits for its heading. */
export async function go(page: Page, label: string, heading: string | RegExp = label) {
  // Inbox carries its count.
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: new RegExp(`^${label}( \\d+)?$`) }).click();
  await expect(pane(page, label).getByRole('heading', { name: heading, level: 1 })).toBeVisible();
}

/** Presses Sync now and waits for it to finish, allowing for a deployment's slower network. */
export async function syncNow(page: Page) {
  await go(page, 'Settings');
  await account(page).getByRole('button', { name: 'Sync now' }).click();
  await expect(account(page).getByRole('button', { name: 'Sync now', disabled: true })).toHaveCount(0, { timeout: 30_000 });
}

/** A one off's row. */
export const oneOffRow = (page: Page, title: string) =>
  pane(page, 'One offs').locator('.maintrow').filter({ has: page.getByRole('checkbox', { name: `${title} done` }) });

export async function setDate(page: Page, title: string, date: string) {
  await go(page, 'One offs');
  await pane(page, 'One offs').getByRole('button', { name: `Add date for ${title}` }).click();
  await pane(page, 'One offs').getByLabel('Date', { exact: true }).fill(date);
  await pane(page, 'One offs').getByRole('button', { name: 'Set date' }).click();
  // The row's line starts with the date, then its estimate if it has one.
  await expect(oneOffRow(page, title).getByText(new RegExp(`^${formatDate(date)}(,|$)`))).toBeVisible();
}

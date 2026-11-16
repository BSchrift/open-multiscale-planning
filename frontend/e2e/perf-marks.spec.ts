// The KPI marks (src/core/perf.ts, docs/performance.md): each action makes exactly one measure of its name, so the
// performance runner can count on them. Nothing here is timed.

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { openSeeded, pane } from './seed';

/** How many measures of each name the page holds. */
const counts = (page: Page) =>
  page.evaluate(() => performance.getEntriesByType('measure').reduce<Record<string, number>>((all, m) => ({ ...all, [m.name]: (all[m.name] ?? 0) + 1 }), {}));

const clear = (page: Page) => page.evaluate(() => performance.clearMeasures());

test('each action makes one measure: Today interactive, opening capture, typing, saving and each screen', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  await openSeeded(page);
  await expect(pane(page, 'Today').getByRole('heading', { level: 1 }).first()).toBeVisible();
  await expect.poll(() => page.evaluate(() => performance.getEntriesByName('today:interactive', 'mark').length)).toBe(1);
  await clear(page);

  if (phone) await page.getByRole('button', { name: 'Capture a task' }).click();
  else await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: /^Capture/ }).click();
  const field = page.getByRole('dialog', { name: 'Capture' }).getByRole('textbox', { name: /Capture to Inbox/ });
  await expect(field).toBeFocused();
  await expect.poll(() => counts(page)).toEqual({ 'capture.open': 1 });
  await clear(page);

  await page.keyboard.type('Buy');
  await expect.poll(() => counts(page)).toEqual({ 'capture.key': 3 });
  await clear(page);
  await page.keyboard.press('Enter');
  await expect(page.getByText(/Saved to Inbox/).first()).toBeVisible();
  await expect.poll(() => counts(page)).toEqual({ 'capture.save': 1 });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Capture' })).toHaveCount(0);

  const main = page.getByRole('navigation', { name: 'Main' });
  const open = async (label: 'Week' | 'Done' | 'Analytics' | 'Today') => {
    await clear(page);
    if (phone && (label === 'Done' || label === 'Analytics')) {
      await main.getByRole('button', { name: 'More' }).click();
      await pane(page, 'More').getByRole('button', { name: new RegExp(`^${label}`) }).click();
    } else {
      await main.getByRole('button', { name: new RegExp(`^${label}`) }).click();
    }
    // Its measure ends once it's drawn with its data.
    await expect.poll(() => counts(page)).toEqual({ [`nav.${label.toLowerCase()}`]: 1 });
  };
  await open('Week');
  await open('Done');
  await open('Analytics');
  await open('Today');
});

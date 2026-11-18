// The performance KPIs' data (docs/performance.md), loaded straight into the browser's database: a year of history
// ending now, and a new account. The runner times screens on these, so here they only have to arrive whole, and, once
// the runner has launched the app on them, hold what that first launch leaves.

import { expect, test } from '@playwright/test';
import { emptyAccount, historyChanges, historyFacts } from '../src/core/history-testing';
import { openLaunched } from './perf/harness';
import { openWithHistory, pane, readRecord } from './seed';

test('a year of history arrives whole, ending this week', async ({ page }, info) => {
  const year = historyChanges({ weeks: 52, now: Date.now() });
  await openWithHistory(page, year);
  const open = historyFacts(year).openInbox;
  const main = page.getByRole('navigation', { name: 'Main' });
  if (info.project.name === 'phone') await expect(main.getByRole('button', { name: `Inbox, ${open} to sort` })).toBeVisible();
  else await expect(main.getByRole('button', { name: `Inbox ${open}` })).toBeVisible();
  // This week's blocks are on Today's timeline, so the history ends now rather than in the past.
  await expect(pane(page, 'Today').getByRole('heading', { level: 1 }).first()).toBeVisible();
});

test('a new account opens on Today with nothing in it', async ({ page }) => {
  await openWithHistory(page, emptyAccount(Date.now()));
  await expect(pane(page, 'Today').getByRole('heading', { level: 1 }).first()).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: /^Inbox/ })).toHaveAccessibleName(/^Inbox$/);
});

test('a history the runner has launched on holds what that first launch leaves, so no timed launch is it', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'The runner times Chromium only, whose database is on OPFS, where a reload keeps every commit.');
  const weeks = historyChanges({ weeks: 8, now: Date.now() });
  await openLaunched(page, weeks);
  // The records carry no expiry, as those from before retention don't. The first launch gives each its own
  // (core/expiry.ts), and removes what has expired.
  const block = weeks.find((c) => c.type === 'time_block' && !c.fields.deleted_at?.v)!;
  expect(await readRecord(page, 'time_block', block.id)).toMatchObject({ expires_at: expect.any(String) });
});

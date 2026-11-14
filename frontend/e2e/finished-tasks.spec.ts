import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { expectTapTarget, oneOffRow, openSeeded, pane } from './seed';
import type { Seed } from './seed';

// Finished tasks under the One offs list: every finish, newest first in month groups, ten at a time with more on
// request, and searchable. Unticking there reopens a one off, gives a repeating one back its date when it was the latest
// finish, or else removes just that finish.

test.use({ timezoneId: 'America/Chicago' });

const NOW = new Date('2026-11-02T20:00:00Z'); // Monday 2pm.

const finished = (id: string, title: string, at: string): Seed[] => [
  { type: 'task', id, fields: { kind: 'one_off', title, schedule: { type: 'once' }, done_at: at } },
  { type: 'task_completion', id: `c-${id}`, fields: { task_id: id, done_at: at } },
];

const records: Seed[] = [
  ...finished('drill', 'Return the drill', '2026-11-01T16:00:00Z'),
  ...finished('parcel', 'Post the parcel', '2026-11-01T15:00:00Z'),
  ...finished('gutters', 'Clear the gutters', '2026-10-20T15:00:00Z'),
  ...finished('oil', 'Oil the bike chain', '2026-10-10T15:00:00Z'),
  ...finished('smoke', 'Test the smoke alarm', '2026-09-28T15:00:00Z'),
  ...finished('tyres', 'Check the tyres', '2026-09-15T15:00:00Z'),
  ...finished('passport', 'Renew the passport', '2026-09-02T15:00:00Z'),
  ...finished('dentist', 'Book the dentist', '2026-09-01T15:00:00Z'),
  ...finished('presents', 'Wrap the presents', '2025-12-20T15:00:00Z'),
  ...finished('cards', 'Send the cards', '2025-12-10T15:00:00Z'),
  ...finished('tree', 'Buy the tree', '2025-12-05T15:00:00Z'),
  // Weekly on Mondays, finished on the last two: the latest put its next date on today.
  {
    type: 'task',
    id: 'fish',
    fields: { kind: 'one_off', title: 'Feed the fish', schedule: { type: 'recurring', every: 1, unit: 'week', anchor: '2026-10-05' }, next_due: '2026-11-02' },
  },
  { type: 'task_completion', id: 'c-fish1', fields: { task_id: 'fish', done_at: '2026-10-19T15:00:00Z', previous_next: '2026-10-19' } },
  { type: 'task_completion', id: 'c-fish2', fields: { task_id: 'fish', done_at: '2026-10-26T15:00:00Z', previous_next: '2026-10-26' } },
];

async function openFinished(page: Page, phone: boolean) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.clock.install({ time: NOW });
  await openSeeded(page, records);
  const nav = page.getByRole('navigation', { name: 'Main' });
  if (phone) {
    await nav.getByRole('button', { name: 'More' }).click();
    await page.getByRole('button', { name: /^One offs/ }).click();
  } else {
    await nav.getByRole('button', { name: 'One offs' }).click();
  }
  const toggle = pane(page, 'One offs').getByRole('button', { name: 'Finished tasks' });
  if (phone) await expectTapTarget(toggle);
  await toggle.click();
  return { errors, list: pane(page, 'One offs').getByRole('region', { name: 'Finished tasks' }), toggle };
}

const titles = (page: Page) =>
  pane(page, 'One offs')
    .getByRole('region', { name: 'Finished tasks' })
    .getByRole('checkbox')
    .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')!.replace(/ done$/, '')));

test('lists the newest ten finishes in month groups, more on request, and finds them by search', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const { errors, list } = await openFinished(page, phone);
  await expect(list.getByRole('status')).toHaveText('13 finished');
  await expect(list.getByRole('heading')).toHaveText(['November', 'October', 'September']);
  expect(await titles(page)).toEqual([
    'Return the drill',
    'Post the parcel',
    'Feed the fish',
    'Clear the gutters',
    'Feed the fish',
    'Oil the bike chain',
    'Test the smoke alarm',
    'Check the tyres',
    'Renew the passport',
    'Book the dentist',
  ]);
  await expect(list.getByText('Done Oct 26')).toBeVisible();

  const more = list.getByRole('button', { name: 'Show 3 more, 3 older' });
  if (phone) await expectTapTarget(more);
  await more.click();
  // Last year's month says its year.
  await expect(list.getByRole('heading')).toHaveText(['November', 'October', 'September', 'December 2025']);
  await expect(list.getByRole('checkbox')).toHaveCount(13);
  await expect(list.getByRole('button', { name: /^Show \d+ more/ })).toHaveCount(0);

  const search = list.getByRole('searchbox', { name: 'Search finished tasks' });
  await search.fill('fish');
  await expect(list.getByRole('status')).toHaveText('2 matching');
  expect(await titles(page)).toEqual(['Feed the fish', 'Feed the fish']);
  await search.fill('piano');
  await expect(list.getByRole('status')).toHaveText('0 matching');
  await expect(list.getByText('No finished tasks match.')).toBeVisible();
  await page.screenshot({ path: info.outputPath(`finished-search-${info.project.name}.png`) });
  expect(errors).toEqual([]);
});

test('unticking a finish reopens a one off, gives a repeating one back its date only from the latest finish, and re-ticking takes it back', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const { errors, list, toggle } = await openFinished(page, phone);
  const fish = oneOffRow(page, 'Feed the fish').first();
  await expect(fish).toContainText('Weekly, next Mon Nov 2');

  // A one off comes back to the list, and its finish stays here, not done, so a slip can be re-ticked.
  const drill = list.getByRole('checkbox', { name: 'Return the drill done' });
  await drill.click();
  await expect(drill).not.toBeChecked();
  const entry = list.locator('.maintrow').filter({ has: page.getByRole('checkbox', { name: 'Return the drill done' }) });
  await expect(entry).toContainText('Not done');
  // Its row in the list above, and its finish here.
  const rows = oneOffRow(page, 'Return the drill');
  await expect(rows).toHaveCount(2);
  await drill.click();
  await expect(drill).toBeChecked();
  await expect(entry).toContainText('Done Nov 1');
  await expect(rows).toHaveCount(1);

  // The older of the repeating one's finishes goes on its own, the date unchanged.
  await list.getByRole('checkbox', { name: 'Feed the fish done' }).last().click();
  await expect(list.getByRole('checkbox', { name: 'Feed the fish done' }).last()).not.toBeChecked();
  await expect(fish).toContainText('Weekly, next Mon Nov 2');
  // The latest gives back the date it moved on from.
  await list.getByRole('checkbox', { name: 'Feed the fish done' }).first().click();
  await expect(fish).toContainText('Weekly, next Mon Oct 26');
  await list.getByRole('checkbox', { name: 'Feed the fish done' }).first().click();
  await expect(fish).toContainText('Weekly, next Mon Nov 2');

  // Closed, the list keeps only what is finished.
  await list.getByRole('checkbox', { name: 'Return the drill done' }).click();
  await toggle.click();
  await toggle.click();
  await expect(list.getByRole('status')).toHaveText('11 finished');
  await expect(list.getByRole('checkbox', { name: 'Return the drill done' })).toHaveCount(0);
  await expect(list.getByRole('checkbox', { name: 'Feed the fish done' })).toHaveCount(1);
  expect(errors).toEqual([]);
});

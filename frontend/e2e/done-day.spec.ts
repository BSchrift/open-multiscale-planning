import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { openSeeded, pane } from './seed';
import type { Seed } from './seed';

// Done beyond done.spec.ts: the time worked split by kind, a finished task's name opening its popup, a deleted one
// marked so, a day with nothing finished, and today followed past midnight.

test.use({ timezoneId: 'America/Chicago' });

const NOW = new Date('2026-11-12T23:40:00Z'); // Thursday 5:40pm in Chicago.
// Chicago is six hours behind UTC in November.
const at = (day: number, time: string) => {
  const [h, m] = time.split(':').map(Number);
  return new Date(Date.UTC(2026, 10, day, h! + 6, m ?? 0)).toISOString().replace('.000Z', 'Z');
};
const THU = 12;

const block = (id: string, owner: Record<string, string>, from: string, to: string, extra: Record<string, unknown> = {}): Seed[] => [
  { type: 'time_block', id, fields: { ...owner, start: at(THU, from), end: at(THU, to), tz: 'America/Chicago' } },
  { type: 'block_outcome', id: `outcome:${id}`, fields: { result: 'done', answered_at: at(THU, to), ...extra } },
];

const records: Seed[] = [
  { type: 'project', id: 'p1', fields: { title: 'Write the report', state: 'active', start: '2026-10-01', end: '2026-12-31' } },
  { type: 'practice', id: 'pr', fields: { title: 'Piano practice', target_min: 30, per: 'day', state: 'active' } },
  ...block('b-piano', { practice_id: 'pr' }, '08:30', '09:00', { logged_min: 30 }),
  { type: 'task', id: 'summary', fields: { title: 'Draft the summary', kind: 'project', project_id: 'p1', estimate_min: 90, done_at: at(THU, '10:30') } },
  ...block('b-summary', { task_id: 'summary' }, '09:00', '10:30'),
  { type: 'task', id: 'old', fields: { title: 'Draft the old intro', kind: 'project', project_id: 'p1', done_at: at(THU, '11:30'), deleted_at: at(THU, '12:00') } },
  { type: 'task', id: 'water', fields: { title: 'Pay the water bill', kind: 'one_off', done_at: at(THU, '13:30') } },
  { type: 'task_completion', id: 'c-water', fields: { task_id: 'water', done_at: at(THU, '13:30') } },
  ...block('b-water', { task_id: 'water' }, '13:00', '13:30'),
];

async function openDone(page: Page, phone: boolean) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.clock.install({ time: NOW });
  await openSeeded(page, records);
  const nav = page.getByRole('navigation', { name: 'Main' });
  if (phone) {
    await nav.getByRole('button', { name: 'More' }).click();
    await page.getByRole('button', { name: /^Done/ }).click();
  } else {
    await nav.getByRole('button', { name: 'Done' }).click();
  }
  await expect(pane(page, 'Done').getByRole('heading', { name: 'Thursday, Nov 12' })).toBeVisible();
  return errors;
}

const done = (page: Page) => pane(page, 'Done');

test('the totals split time worked by kind, a finished task’s name opens its popup, and a deleted one is marked and doesn’t open', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors = await openDone(page, phone);
  const totals = done(page).getByRole('region', { name: 'Totals' });
  await expect(totals).toContainText('3 finished · 2h 30m worked');
  await expect(totals.getByRole('img')).toHaveAccessibleName('1h 30m projects, 30m practices, 30m one offs');
  await expect(totals).toContainText('Projects 1h 30m');
  await expect(totals).toContainText('Practices 30m');
  await expect(totals).toContainText('One offs 30m');

  const finished = done(page).getByRole('region', { name: 'Finished' });
  const old = finished.getByRole('listitem').filter({ hasText: 'Draft the old intro' });
  await expect(old).toContainText('deleted');
  await expect(old.getByRole('button')).toHaveCount(0);

  await finished.getByRole('button', { name: 'Draft the summary' }).click();
  const popup = page.locator('.sheet.taskpop[aria-label="Draft the summary"]');
  await expect(popup.getByRole('slider', { name: 'Time estimate' })).toHaveAttribute('aria-valuetext', '1h 30m');
  await page.keyboard.press('Escape');
  await expect(popup).toHaveCount(0);
  await page.screenshot({ path: info.outputPath(`done-${info.project.name}.png`), fullPage: true });
  expect(errors).toEqual([]);
});

test('a day with nothing finished says so, and Done left on today moves on to the new day at midnight', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors = await openDone(page, phone);
  await done(page).getByRole('button', { name: 'Previous day' }).click();
  await done(page).getByRole('button', { name: 'Previous day' }).click();
  await expect(done(page).getByRole('heading', { name: 'Tuesday, Nov 10' })).toBeVisible();
  await expect(done(page).getByText('Nothing finished on Tuesday')).toBeVisible();
  await expect(done(page).getByRole('region', { name: 'Totals' })).toHaveCount(0);
  await done(page).getByRole('button', { name: 'Today', exact: true }).click();

  // Midnight in Chicago.
  await page.clock.fastForward('06:21:00');
  await expect(done(page).getByRole('heading', { name: 'Friday, Nov 13' })).toBeVisible();
  await expect(done(page).getByText('Nothing finished yet today')).toBeVisible();
  await expect(done(page).getByRole('button', { name: 'Next day' })).toBeDisabled();
  await done(page).getByRole('button', { name: 'Previous day' }).click();
  await expect(done(page).getByRole('region', { name: 'Totals' })).toContainText('3 finished');
  expect(errors).toEqual([]);
});

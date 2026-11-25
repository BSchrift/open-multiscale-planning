// Reset this week's plan on Week, at desktop and phone sizes: it asks first, takes out what's still to come, and one
// Undo puts it all back. What goes and stays in every case is core/weekReset.test.ts; the copy is week/reset.test.tsx.

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { expectTapTarget, openSeeded, pane, readRecord } from './seed';
import type { Seed } from './seed';

test.use({ timezoneId: 'America/Chicago' });

const NOW = new Date('2026-11-02T20:00:00Z'); // Monday 2pm in Chicago.
const at = (day: number, time: string) => {
  const [h, m] = time.split(':').map(Number);
  return new Date(Date.UTC(2026, 10, day, h! + 6, m ?? 0)).toISOString().replace('.000Z', 'Z');
};

const records: Seed[] = [
  { type: 'week_plan', id: 'week:2026-11-02', fields: { week_start: '2026-11-02', finished_at: at(2, '08:00') } },
  { type: 'project', id: 'p', fields: { title: 'Write the report', state: 'active', start: '2026-10-01', end: '2026-12-31' } },
  { type: 'task', id: 't1', fields: { kind: 'project', project_id: 'p', title: 'Draft the summary', estimate_min: 120 } },
  { type: 'task', id: 't2', fields: { kind: 'one_off', title: 'Paint the fence', estimate_min: 60 } },
  { type: 'practice', id: 'pr', fields: { title: 'Piano practice', target_min: 30, per: 'day', state: 'active' } },
  { type: 'week_pick', id: 'pick:2026-11-02:t1', fields: { week_start: '2026-11-02', task_id: 't1', minutes: 120 } },
  { type: 'week_pick', id: 'pick:2026-11-02:t2', fields: { week_start: '2026-11-02', task_id: 't2', minutes: 60 } },
  // This morning's block was answered, so it stays; Tuesday's and Wednesday's practice session are still to come.
  { type: 'time_block', id: 'b0', fields: { task_id: 't2', start: at(2, '07:30'), end: at(2, '08:30'), tz: 'America/Chicago' } },
  { type: 'block_outcome', id: 'outcome:b0', fields: { result: 'partly', remaining_min: 30, answered_at: at(2, '08:30') } },
  { type: 'time_block', id: 'b1', fields: { task_id: 't1', start: at(3, '18:00'), end: at(3, '19:00'), tz: 'America/Chicago' } },
  { type: 'time_block', id: 'b2', fields: { practice_id: 'pr', start: at(4, '07:00'), end: at(4, '07:30'), tz: 'America/Chicago' } },
];

async function openWeek(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.clock.install({ time: NOW });
  await openSeeded(page, records);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Week' }).click();
  return errors;
}

const deleted = async (page: Page, type: string, id: string) => !!(await readRecord(page, type, id))?.deleted_at;

test("Reset this week's plan asks first, takes out what's to come, and Undo puts it all back", async ({ page }, info) => {
  const errors = await openWeek(page);
  const reset = page.getByRole('button', { name: "Reset this week's plan" });
  if (info.project.name === 'phone') await expectTapTarget(reset);
  await reset.click();

  const dialog = page.getByRole('dialog', { name: "Reset this week's plan?" });
  await expect(dialog).toContainText('2 tasks picked for this week.');
  await expect(dialog).toContainText('2 blocks still to come, 1 of them a practice session.');
  await expect(dialog).toContainText('1 block already started, answered or gone by.');
  if (info.project.name === 'phone') {
    await expectTapTarget(dialog.getByRole('button', { name: 'Reset plan' }));
    await expectTapTarget(dialog.getByRole('button', { name: 'Cancel' }));
  }
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await expect(reset).toBeFocused();
  expect(await deleted(page, 'time_block', 'b1')).toBe(false);

  await reset.click();
  await dialog.getByRole('button', { name: 'Reset plan' }).click();
  await expect(page.getByText("Reset this week's plan: 2 tasks and 2 blocks removed.")).toBeVisible();
  await expect(page.getByRole('button', { name: 'Undo' })).toBeFocused();
  // The week asks to be planned again.
  await expect(pane(page, 'Week').getByText(/This week isn't planned yet/).first()).toBeVisible();
  await expect(reset).toBeHidden();
  expect(await deleted(page, 'week_pick', 'pick:2026-11-02:t1')).toBe(true);
  expect(await deleted(page, 'time_block', 'b1')).toBe(true);
  expect(await deleted(page, 'time_block', 'b2')).toBe(true);
  expect(await deleted(page, 'time_block', 'b0')).toBe(false);
  expect((await readRecord(page, 'week_plan', 'week:2026-11-02'))?.finished_at ?? null).toBeNull();

  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(reset).toBeFocused();
  await expect(pane(page, 'Week').getByText(/This week isn't planned yet/)).toHaveCount(0);
  expect(await deleted(page, 'week_pick', 'pick:2026-11-02:t1')).toBe(false);
  expect(await deleted(page, 'time_block', 'b1')).toBe(false);
  expect(await deleted(page, 'time_block', 'b2')).toBe(false);
  expect((await readRecord(page, 'week_plan', 'week:2026-11-02'))?.finished_at).toBe(at(2, '08:00'));
  expect(errors).toEqual([]);
});

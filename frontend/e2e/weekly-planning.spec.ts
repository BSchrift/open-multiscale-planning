import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { processTo } from './journeys/journey';
import { expectTapTarget, openSeeded, readRecord, seed, startPlanningThenUndo } from './seed';
import type { Seed } from './seed';

// Weekly planning's steps around Pick tasks, which pick.spec.ts and planning.spec.ts cover: moving between the steps,
// the Inbox step, Schedule's practice choices and Review.

test.use({ timezoneId: 'America/Chicago' });

const NOW = new Date('2026-11-02T20:00:00Z'); // Monday 2pm in Chicago, with this week not yet planned.
const WEEK = '2026-11-02';

const records: Seed[] = [
  { type: 'project', id: 'report', fields: { title: 'Write the report', state: 'active', start: '2026-10-01', end: '2026-12-15', weekly_aim: 120 } },
  { type: 'milestone', id: 'm1', fields: { project_id: 'report', title: 'Draft chapters', due: '2026-11-20' } },
  { type: 'task', id: 't1', fields: { kind: 'project', project_id: 'report', milestone_id: 'm1', title: 'Write chapter one', estimate_min: 120 } },
  { type: 'week_pick', id: `pick:${WEEK}:t1`, fields: { week_start: WEEK, task_id: 't1', minutes: 120 } },
  { type: 'practice', id: 'pr', fields: { title: 'Morning stretch', target_min: 30, per: 'day', days: [1, 2], preferred_times: [420], state: 'active' } },
];
const inboxItem: Seed = { type: 'task', id: 'i1', fields: { kind: 'inbox', title: 'Rake the leaves' } };

const steps = (page: Page) => page.getByRole('navigation', { name: 'Planning steps' });
const current = (page: Page) => steps(page).locator('[aria-current="step"]');

async function open(page: Page, extra: readonly Seed[] = []) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.clock.install({ time: NOW });
  await openSeeded(page, [...records, ...extra]);
  await startPlanningThenUndo(page);
  return errors;
}

test('the step arrows and tabs move between the steps, and each main button names what comes next', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors = await open(page);
  if (phone) {
    const bar = page.locator('.flowbot');
    const back = bar.getByRole('button', { name: 'Previous step' });
    const next = bar.locator('[data-continue]');
    await expect(current(page)).toHaveText('Inbox');
    await expect(back).toBeDisabled();
    await expect(next).toHaveText('Continue to picking tasks');
    for (const target of [back, next, ...(await steps(page).getByRole('button').all())]) await expectTapTarget(target);
    await next.click();
    await expect(current(page)).toHaveText('Pick');
    await back.click();
    await expect(current(page)).toHaveText('Inbox');
    await steps(page).getByRole('button', { name: 'Schedule' }).click();
    await expect(current(page)).toHaveText('Schedule');
    await expect(next).toHaveText('Continue to review');
    await next.click();
    await expect(current(page)).toHaveText('Review');
    await expect(next).toHaveText('Finish plan');
    await back.click();
    await expect(current(page)).toHaveText('Schedule');
  } else {
    const nav = page.locator('.stepsnav');
    const back = nav.getByRole('button', { name: 'Previous step' });
    const next = nav.getByRole('button', { name: 'Next step' });
    await expect(current(page)).toHaveText('1. Inbox');
    await expect(back).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Continue to picking tasks' })).toBeVisible();
    await next.click();
    await expect(current(page)).toHaveText('2. Pick tasks');
    await next.click();
    await expect(current(page)).toHaveText('3. Schedule');
    await next.click();
    await expect(current(page)).toHaveText('4. Review');
    await expect(next).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Finish plan' })).toBeVisible();
    await back.click();
    await expect(current(page)).toHaveText('3. Schedule');
    await steps(page).getByRole('button', { name: '1. Inbox' }).click();
    await expect(current(page)).toHaveText('1. Inbox');
  }
  expect(errors).toEqual([]);
});

test('the Inbox step processes into the plan for the week being planned, then says the Inbox is empty with focus on it', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors = await open(page, [inboxItem]);
  await expect(current(page)).toHaveText(phone ? 'Inbox' : '1. Inbox');
  await page.getByRole('button', { name: 'Process 1 item' }).click();
  const card = page.getByRole('dialog', { name: 'Process Inbox' });
  await expect(card.getByRole('heading', { name: 'Rake the leaves', level: 1 })).toBeVisible();
  const toggle = card.getByRole('button', { name: 'Add to the plan for Nov 2 to 8' });
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await toggle.click();
  await expect(card.getByRole('button', { name: 'Adding to the plan for Nov 2 to 8' })).toHaveAttribute('aria-pressed', 'true');
  await processTo(page, phone, 'Write the report');
  await expect(page.locator('.toast')).toContainText('Added Rake the leaves to Write the report and to the plan.');

  // The only item, so Process closes itself, and focus goes to the step's heading.
  await expect(card).toHaveCount(0);
  await expect(page.getByText('Inbox is empty.', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Inbox', level: 2 })).toBeFocused();
  // In the week, an hour since it had no estimate, waiting for a time.
  expect(await readRecord(page, 'week_pick', `pick:${WEEK}:i1`)).toMatchObject({ week_start: WEEK, task_id: 'i1', minutes: 60 });
  expect(await readRecord(page, 'task', 'i1')).toMatchObject({ kind: 'project', project_id: 'report' });
  expect(errors).toEqual([]);
});

test('Skip a practice this week takes its sessions out of the week, and Include this week puts them back', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors = await open(page);
  await steps(page).getByRole('button', { name: phone ? 'Schedule' : '3. Schedule' }).click();
  let list = page.locator('.planning');
  if (phone) {
    await page.getByRole('button', { name: /^All picked tasks, / }).click();
    list = page.getByRole('dialog', { name: 'All picked tasks' });
    await expect(list.getByRole('heading', { name: 'Skip a practice this week' })).toBeVisible();
  } else {
    const more = page.getByRole('button', { name: 'Skip a practice this week' });
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    await more.click();
  }
  await expect(list.getByText('0 of 2 placed')).toBeAttached();
  const skip = list.getByRole('button', { name: 'Skip this week, Morning stretch' });
  if (phone) await expectTapTarget(skip);
  await skip.click();
  const include = list.getByRole('button', { name: 'Include this week, Morning stretch' });
  await expect(include).toBeVisible();
  await expect(list.getByText('0 of 1 placed')).toBeAttached();
  expect(await readRecord(page, 'week_plan', `week:${WEEK}`)).toMatchObject({ skipped_practices: ['pr'] });
  await include.click();
  await expect(list.getByRole('button', { name: 'Skip this week, Morning stretch' })).toBeVisible();
  await expect(list.getByText('0 of 2 placed')).toBeAttached();
  expect(errors).toEqual([]);
});

test("desktop: Yes on Schedule's practice question keeps the new time on that day in future weeks", async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'The grid is the desktop layout');
  // Morning stretch is already placed on both its days, Tuesday and Wednesday, at 7am in Chicago.
  const errors = await open(page, [
    { type: 'time_block', id: 's1', fields: { practice_id: 'pr', start: '2026-11-03T13:00:00Z', end: '2026-11-03T13:30:00Z', tz: 'America/Chicago' } },
    { type: 'time_block', id: 's2', fields: { practice_id: 'pr', start: '2026-11-04T13:00:00Z', end: '2026-11-04T13:30:00Z', tz: 'America/Chicago' } },
  ]);
  await steps(page).getByRole('button', { name: '3. Schedule' }).click();
  await page.getByRole('group', { name: /^Morning stretch, Tue Nov 3, 7am to 7:30am, Practice\./ }).focus();
  await page.keyboard.press('ArrowDown');
  const ask = page.getByRole('group', { name: 'Use 7:15am in future weeks too?' });
  await expect(ask.getByRole('button')).toHaveText(['No, just this week', 'Yes, on Tuesdays', 'Yes, on Tuesdays and Wednesdays']);
  await ask.getByRole('button', { name: 'Yes, on Tuesdays', exact: true }).click();
  await expect(page.getByText('Morning stretch is now 7:15am on Tuesdays.')).toBeVisible();
  await expect(ask).toHaveCount(0);
  // Tuesday's own time, by weekday from Monday; Wednesday keeps the practice's 7am.
  const times = (await readRecord(page, 'practice', 'pr'))?.day_times as (number | null)[];
  expect(times[1]).toBe(435);
  expect(times[2]).not.toBe(435);
  expect(errors).toEqual([]);
});

test('Review names each aim not reached, the weekly one offs aim among them, then says Ready to finish, and Undo takes the finish back', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors = await open(page, [
    // Write the report's 2h is placed on Tuesday, 9 to 11am in Chicago, so its aim is reached.
    { type: 'time_block', id: 'b1', fields: { task_id: 't1', start: '2026-11-03T15:00:00Z', end: '2026-11-03T17:00:00Z', tz: 'America/Chicago' } },
    { type: 'settings', id: 'settings', fields: { one_offs_weekly_aim: 60 } },
  ]);
  await steps(page).getByRole('button', { name: phone ? 'Review' : '4. Review' }).click();
  await expect(page.getByRole('heading', { name: '1 aim not reached' })).toBeVisible();
  await expect(page.getByText('One offs: 0m of 1h aim')).toBeVisible();
  await expect(page.getByText('You can still finish short of an aim.')).toBeVisible();
  await expect(page.getByText(/^Write the report:/)).toHaveCount(0);

  // The aim taken off in Settings, on this device or another, Review follows.
  await seed(page, [{ type: 'settings', id: 'settings', fields: { one_offs_weekly_aim: null } }]);
  await expect(page.getByRole('heading', { name: 'Ready to finish' })).toBeVisible();
  await expect(page.getByText('All weekly aims are reached.')).toBeVisible();
  await (phone ? page.locator('.flowbot').getByRole('button', { name: 'Finish plan' }) : page.getByRole('button', { name: 'Finish plan' })).click();
  await expect(steps(page)).toHaveCount(0);
  const toast = page.locator('.toast');
  await expect(toast).toContainText('Week planned.');
  expect(await readRecord(page, 'week_plan', `week:${WEEK}`)).toHaveProperty('finished_at', expect.any(String));
  await toast.getByRole('button', { name: 'Undo' }).click();
  // Not planned again, so Today asks for it.
  await expect(page.getByRole('button', { name: 'Start planning' }).first()).toBeVisible();
  expect((await readRecord(page, 'week_plan', `week:${WEEK}`))?.finished_at ?? null).toBeNull();
  expect(errors).toEqual([]);
});

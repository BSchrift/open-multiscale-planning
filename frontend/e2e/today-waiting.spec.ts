// What waits on Today besides the day's blocks: one offs dated today, Needs a new time, and Welcome back after time
// away.

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { expectTapTarget, openSeeded, pane } from './seed';
import type { Seed } from './seed';

test.use({ timezoneId: 'America/Chicago' });

const NOW = new Date('2026-11-02T20:00:00Z'); // Monday 2pm in Chicago.
const chicago = (month: number, day: number, time: string) => {
  const [h, m] = time.split(':').map(Number);
  // Chicago is six hours behind UTC in November, and five in October, before the clocks change on November 1.
  return new Date(Date.UTC(2026, month - 1, day, h! + (month === 11 ? 6 : 5), m ?? 0)).toISOString().replace('.000Z', 'Z');
};
const at = (day: number, time: string) => chicago(11, day, time);
const october = (day: number, time: string) => chicago(10, day, time);

const planned: Seed = { type: 'week_plan', id: 'week:2026-11-02', fields: { week_start: '2026-11-02', finished_at: at(2, '08:00') } };
const project: Seed = { type: 'project', id: 'p', fields: { title: 'Annual report', state: 'active', start: '2026-10-01', end: '2026-12-31' } };
const report: Seed = { type: 'task', id: 't1', fields: { kind: 'project', project_id: 'p', title: 'Write the report', estimate_min: 180 } };
const notes: Seed = { type: 'task', id: 't3', fields: { kind: 'project', project_id: 'p', title: 'Read the notes', estimate_min: 60 } };
const block = (id: string, task: string, start: string, end: string): Seed => ({ type: 'time_block', id, fields: { task_id: task, start, end, tz: 'America/Chicago' } });
const notDone = (id: string, answered: string): Seed => ({ type: 'block_outcome', id: `outcome:${id}`, fields: { result: 'not', answered_at: answered } });

async function open(page: Page, records: Seed[]) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.clock.install({ time: NOW });
  await openSeeded(page, records);
  return errors;
}

const tab = (page: Page, name: string) => page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name, exact: true }).click();

test('a one off dated today offers Change date, which takes it off Today with Undo, and Find a time, which places it from Week', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const fence: Seed = { type: 'task', id: 't2', fields: { kind: 'one_off', title: 'Paint the fence', estimate_min: 60, schedule: { type: 'once', from: '2026-11-02' } } };
  const errors = await open(page, [planned, fence]);
  const list = page.getByRole('region', { name: 'One offs today' });
  await expect(list.getByRole('checkbox', { name: 'Paint the fence done' })).toBeVisible();
  const [find, change] = [list.getByRole('button', { name: 'Find a time for Paint the fence' }), list.getByRole('button', { name: 'Change date for Paint the fence' })];
  if (phone) {
    await expectTapTarget(find);
    await expectTapTarget(change);
  }

  // A new date off today takes it off Today, and focus to the toast's Undo, with the list gone.
  await change.click();
  const dates = list.getByRole('form', { name: 'Dates for Paint the fence' });
  await dates.getByLabel('Date', { exact: true }).fill('2026-11-04');
  await dates.getByRole('button', { name: 'Set date' }).click();
  await expect(page.getByText('Paint the fence, Nov 4.')).toBeVisible();
  await expect(list).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Undo' })).toBeFocused();
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(list.getByRole('checkbox', { name: 'Paint the fence done' })).toBeVisible();

  // Find a time goes to Week with the one off being placed, at its best time to start with.
  await list.getByRole('button', { name: 'Find a time for Paint the fence' }).click();
  await expect(pane(page, 'Week')).toBeVisible();
  await page.getByRole('button', { name: 'Place here' }).click();
  await expect(page.getByText(/^Placed Paint the fence, /)).toBeVisible();
  // Placed, it's on the calendar, so no longer waiting on Today.
  await tab(page, 'Today');
  await expect(page.getByRole('heading', { name: 'Today', level: 1 })).toBeVisible();
  await expect(page.getByRole('region', { name: 'One offs today' })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('Needs a new time places a row at its best time in one tap with Undo, deletes one with Undo, and asks Still want this? first of work passed over at planning', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors = await open(page, [
    planned,
    project,
    report,
    notes,
    // Not done this morning, after this week was planned.
    block('b1', 't1', at(2, '09:00'), at(2, '10:00')),
    notDone('b1', at(2, '10:00')),
    // Not done last week, and not picked when this week was planned.
    block('b3', 't3', october(28, '09:00'), october(28, '10:00')),
    notDone('b3', october(28, '10:00')),
  ]);
  await (phone
    ? page.getByRole('button', { name: '2 tasks need a new time Review' })
    : page.getByRole('status').filter({ hasText: "2 tasks that didn't get done." }).getByRole('button', { name: 'Review' })
  ).click();
  const queue = phone ? page.getByRole('dialog', { name: 'Needs a new time' }) : page.getByRole('region', { name: 'Needs a new time' });
  await expect(queue.getByText('Not done today')).toBeVisible();
  await expect(queue.getByText('Ignored at last planning')).toBeVisible();
  await expect(queue.getByText('Still want this?')).toBeVisible();
  // Passed over, it asks before offering a time.
  await expect(queue.getByRole('button', { name: /^Place Read the notes, / })).toHaveCount(0);

  const offer = queue.getByRole('button', { name: /^Place Write the report, / });
  const label = (await offer.getAttribute('aria-label'))!.replace('Place Write the report, ', '');
  // Today's hours, or a later day's, then the time: "Mon Nov 2, 3pm".
  expect(label).toMatch(/^\w{3} Nov \d+, \d+(:\d\d)?(am|pm)$/);
  if (phone) {
    await expectTapTarget(offer);
    await expectTapTarget(queue.getByRole('button', { name: 'Delete Write the report' }));
    await expectTapTarget(queue.getByRole('button', { name: 'Keep Read the notes' }));
  }
  await page.screenshot({ path: info.outputPath(`needs-new-time-${info.project.name}.png`) });
  await offer.click();
  await expect(page.getByText(`Placed Write the report, ${label}`)).toBeVisible();
  await expect(queue.getByText('Not done today')).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(queue.getByText('Not done today')).toBeVisible();

  await queue.getByRole('button', { name: 'Delete Write the report' }).click();
  await expect(page.getByText('Deleted', { exact: true })).toBeVisible();
  await expect(queue.getByText('Write the report')).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(queue.getByText('Write the report')).toBeVisible();

  await queue.getByRole('button', { name: 'Keep Read the notes' }).click();
  await expect(page.getByText('Kept Read the notes.')).toBeVisible();
  await expect(queue.getByText('Not done Oct 28')).toBeVisible();
  await expect(queue.getByRole('button', { name: /^Place Read the notes, / })).toBeVisible();
  expect(errors).toEqual([]);
});

test('after a week away Today opens on Welcome back; returning the missed blocks leads to Pick one thing for today, and the pick waits in Next up', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const fence: Seed = { type: 'task', id: 't2', fields: { kind: 'one_off', title: 'Paint the fence', estimate_min: 60 } };
  // Two weeks ago, never answered, with nothing answered since.
  const errors = await open(page, [project, report, fence, block('b1', 't1', october(20, '09:00'), october(20, '10:00'))]);
  await expect(page.getByRole('heading', { name: 'Welcome back', level: 1 })).toBeVisible();
  await expect(page.getByText("Your plan from before the break has passed. You don't need to go through it.")).toBeVisible();
  const back = page.getByRole('button', { name: 'Return them and continue' });
  if (phone) await expectTapTarget(back);
  await page.screenshot({ path: info.outputPath(`welcome-back-${info.project.name}.png`) });
  await back.click();

  await expect(page.getByRole('heading', { name: 'Pick one thing for today', level: 1 })).toBeVisible();
  // One from each project or One offs.
  const pick = page.getByRole('button', { name: /^Paint the fence/ });
  await expect(page.getByRole('button', { name: /^Write the report/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Plan the rest of the week instead' })).toBeVisible();
  if (phone) await expectTapTarget(pick);
  await pick.click();

  // Picking skips planning this week, and the pick leads Next up.
  await expect(page.getByRole('heading', { name: 'Today', level: 1 })).toBeVisible();
  await expect(page.getByText("This week isn't planned", { exact: true })).toBeVisible();
  const next = page.getByRole('region', { name: 'Next up' });
  await expect(next.getByText('Your pick for today')).toBeVisible();
  await expect(next.getByRole('button', { name: /^Start / }).first()).toHaveAccessibleName('Start Paint the fence');
  // The missed block went back to its project: it isn't asked about again.
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(errors).toEqual([]);
});

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { expectTapTarget, openSeeded } from './seed';
import type { Seed } from './seed';

test.use({ timezoneId: 'America/Chicago' });

const NOW = new Date('2026-11-02T20:00:00Z'); // Monday 2pm in Chicago, with this week not yet planned.
const WEEK = '2026-11-02';
const pick = (task: string, minutes: number): Seed => ({ type: 'week_pick', id: `pick:${WEEK}:${task}`, fields: { week_start: WEEK, task_id: task, minutes } });

const records: Seed[] = [
  { type: 'project', id: 'report', fields: { title: 'Write the report', state: 'active', start: '2026-10-01', end: '2026-12-15' } },
  { type: 'milestone', id: 'm1', fields: { project_id: 'report', title: 'Gather notes', due: '2026-10-18' } },
  { type: 'milestone', id: 'm2', fields: { project_id: 'report', title: 'Draft chapters', due: '2026-11-09' } },
  { type: 'task', id: 't1', fields: { kind: 'project', project_id: 'report', milestone_id: 'm1', title: 'Collect the sources', estimate_min: 120 } },
  { type: 'task', id: 't2', fields: { kind: 'project', project_id: 'report', milestone_id: 'm2', title: 'Write chapter one', estimate_min: 240 } },
  { type: 'task', id: 'o1', fields: { kind: 'one_off', title: 'Paint the fence', estimate_min: 90, schedule: { type: 'once', from: '2026-11-04' } } },
  { type: 'practice', id: 'pr', fields: { title: 'Morning stretch', target_min: 30, per: 'day', days: [1, 2], preferred_times: [420], state: 'active' } },
  pick('t1', 120),
  pick('t2', 240),
  pick('o1', 90),
  // Morning stretch is already placed on both its days, 7am in Chicago.
  { type: 'time_block', id: 's1', fields: { practice_id: 'pr', start: '2026-11-03T13:00:00Z', end: '2026-11-03T13:30:00Z', tz: 'America/Chicago' } },
  { type: 'time_block', id: 's2', fields: { practice_id: 'pr', start: '2026-11-04T13:00:00Z', end: '2026-11-04T13:30:00Z', tz: 'America/Chicago' } },
];

async function openSchedule(page: Page, phone: boolean) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.clock.install({ time: NOW });
  await openSeeded(page, records);
  await page.getByRole('button', { name: 'Start planning' }).first().click();
  await page.getByRole('navigation', { name: 'Planning steps' }).getByRole('button', { name: phone ? 'Schedule' : '3. Schedule' }).click();
  return errors;
}

test('desktop: drag the task to a time, place it, then place the rest with Undo', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'The grid is the desktop layout');
  const errors = await openSchedule(page, false);
  await expect(page.getByText('1 of 4 placed')).toBeVisible();
  const draft = page.getByRole('group', { name: /^Collect the sources, Mon Nov 2, 2pm to 4pm, Project\./ });
  await expect(draft).toBeVisible();
  await expect(page.getByRole('group', { name: /^Morning stretch, Tue Nov 3, 7am to 7:30am, Practice\./ })).toBeVisible();
  await page.screenshot({ path: info.outputPath('schedule-desktop.png') });

  // One column right and 40px down: a day later and an hour later, at 40px an hour.
  const box = (await draft.boundingBox())!;
  const column = (await page.locator('.colbody').first().boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 8);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + column.width / 2, box.y + 30, { steps: 4 });
  await page.mouse.move(box.x + box.width / 2 + column.width + 2, box.y + 48, { steps: 4 });
  await page.mouse.up();
  await expect(page.getByRole('group', { name: /^Collect the sources, Tue Nov 3, 3pm to 5pm, Project\./ })).toBeVisible();
  await expect(page.getByText('Tue Nov 3, 3pm to 5pm (2h)')).toBeVisible();

  await page.getByRole('button', { name: 'Place here' }).click();
  await expect(page.getByText('2 of 4 placed')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Write chapter one/ })).toHaveAttribute('aria-current', 'step');
  // Its row closed, so focus moves on to the next task rather than falling to the page.
  await expect(page.getByRole('button', { name: /^Write chapter one/ })).toBeFocused();

  await page.getByRole('button', { name: 'Place the rest at suggested times' }).click();
  await expect(page.getByText('4 of 4 placed')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'All tasks are placed' })).toBeFocused();
  await page.screenshot({ path: info.outputPath('schedule-desktop-placed.png') });
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByText('2 of 4 placed')).toBeVisible();
  expect(errors).toEqual([]);
});

test('desktop: moving a practice session asks whether to keep it every week', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'The grid is the desktop layout');
  const errors = await openSchedule(page, false);
  const session = page.getByRole('group', { name: /^Morning stretch, Tue Nov 3, 7am to 7:30am, Practice\./ });
  await session.focus();
  await page.keyboard.press('ArrowDown');
  const ask = page.getByRole('status', { name: 'Make this change permanent?' });
  await expect(ask.getByText('Morning stretch is now Tue Nov 3, 7:15am to 7:45am.')).toBeVisible();
  await ask.getByRole('button', { name: 'No, this week only' }).click();
  await expect(ask).toHaveCount(0);
  await expect(page.getByRole('group', { name: /^Morning stretch, Tue Nov 3, 7:15am to 7:45am, Practice\./ })).toBeVisible();
  expect(errors).toEqual([]);
});

test('desktop: the draft floats over a placed block, which stays put, and Place here takes it off to place again', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'The grid is the desktop layout');
  const errors = await openSchedule(page, false);
  const session = page.getByRole('group', { name: /^Morning stretch, Tue Nov 3, 7am to 7:30am, Practice\./ });
  const was = await session.boundingBox();
  const draft = page.getByRole('group', { name: /^Collect the sources, Mon Nov 2, 2pm to 4pm, Project\. Being placed\./ });

  // One column right and 280px up: a day later and seven hours earlier, at 40px an hour.
  const box = (await draft.boundingBox())!;
  const column = (await page.locator('.colbody').first().boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 8);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + column.width / 2, box.y - 140, { steps: 4 });
  await page.mouse.move(box.x + box.width / 2 + column.width + 2, box.y - 272, { steps: 4 });
  await page.mouse.up();
  await expect(page.getByRole('group', { name: /^Collect the sources, Tue Nov 3, 7am to 9am, Project\. Being placed\./ })).toBeVisible();
  await expect(page.getByText('Placing here takes Morning stretch off the calendar to place again.')).toBeVisible();
  expect(await session.boundingBox()).toEqual(was);
  await page.screenshot({ path: info.outputPath('schedule-overlap-desktop.png') });

  await page.getByRole('button', { name: 'Place here' }).click();
  await expect(session).toHaveCount(0);
  await expect(page.getByText('Took Morning stretch off the calendar to place again')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Morning stretch/ }).locator('.schedmark')).not.toHaveText('✓');
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(session).toBeVisible();
  await expect(page.getByRole('group', { name: /^Collect the sources, Mon Nov 2, 2pm to 4pm/ })).toBeVisible();
  expect(errors).toEqual([]);
});

test('phone: the draft floats beside a placed block, which stays put, and Place here takes it off to place again', async ({ page }, info) => {
  test.skip(info.project.name !== 'phone', 'The strip and dock are the phone layout');
  const errors = await openSchedule(page, true);
  await page.getByRole('group', { name: 'Compare days' }).getByRole('button', { name: /^Tue Nov 3,/ }).click();
  await page.getByRole('button', { name: 'Move to Tue Nov 3' }).click();
  const session = page.getByRole('slider', { name: /^Morning stretch\./ });
  const was = await session.boundingBox();
  const handle = page.getByRole('slider', { name: /^Time for Collect the sources, being placed\./ });
  await expect(handle).toHaveAttribute('aria-valuetext', 'Tue Nov 3, 7:30am to 9:30am');

  // Half an hour up, at 48px an hour.
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 12);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y, { steps: 3 });
  await page.mouse.move(box.x + box.width / 2, box.y - 12, { steps: 3 });
  await page.mouse.up();
  await expect(handle).toHaveAttribute('aria-valuetext', 'Tue Nov 3, 7am to 9am');
  await expect(page.getByText('Placing here takes Morning stretch off the calendar to place again.')).toBeVisible();
  expect(await session.boundingBox()).toEqual(was);
  await page.screenshot({ path: info.outputPath('schedule-overlap-phone.png') });

  await page.getByRole('button', { name: 'Place here' }).click();
  await expect(session).toHaveCount(0);
  const said = page.locator('.pktoast', { hasText: 'Took Morning stretch off the calendar to place again' });
  await said.getByRole('button', { name: 'Undo' }).click();
  await page.getByRole('group', { name: 'Compare days' }).getByRole('button', { name: /^Tue Nov 3,/ }).click();
  await expect(session).toBeVisible();
  expect(errors).toEqual([]);
});

test('phone: compare days, move the task to another day, place it, and place the rest from All tasks', async ({ page }, info) => {
  test.skip(info.project.name !== 'phone', 'The strip and dock are the phone layout');
  const errors = await openSchedule(page, true);
  const strip = page.getByRole('group', { name: 'Compare days' });
  await expect(strip.getByRole('button')).toHaveCount(7);
  await expectTapTarget(strip.getByRole('button').first());
  await expect(page.getByText('Mon Nov 2, 2pm to 4pm (2h)')).toBeVisible();
  const summary = page.getByRole('button', { name: 'All picked tasks, 1 of 4 placed' });
  await expectTapTarget(summary);
  await page.screenshot({ path: info.outputPath('schedule-phone.png') });

  await strip.getByRole('button', { name: /^Tue Nov 3, .*suggested 7:30am$/ }).click();
  await expect(page.getByRole('heading', { name: 'Tue Nov 3' })).toBeVisible();
  const moveHere = page.getByRole('button', { name: 'Move to Tue Nov 3' });
  await expectTapTarget(moveHere);
  await moveHere.click();
  await expect(page.getByText('Tue Nov 3, 7:30am to 9:30am (2h)')).toBeVisible();

  // The block moves by keys too, 15 minutes a step, and the practice at 7am stays where it is.
  const handle = page.getByRole('slider', { name: /^Time for Collect the sources/ });
  await handle.focus();
  await page.keyboard.press('ArrowDown');
  await expect(handle).toHaveAttribute('aria-valuetext', 'Tue Nov 3, 7:45am to 9:45am');

  const place = page.getByRole('button', { name: 'Place here' });
  await expectTapTarget(place);
  await place.click();
  await expect(page.getByRole('button', { name: 'All picked tasks, 2 of 4 placed' })).toBeVisible();

  await page.getByRole('button', { name: 'All picked tasks, 2 of 4 placed' }).click();
  const sheet = page.getByRole('dialog', { name: 'All picked tasks' });
  await expect(sheet.getByRole('button', { name: /^Morning stretch/ })).toBeVisible();
  await page.screenshot({ path: info.outputPath('schedule-phone-list.png') });
  await sheet.getByRole('button', { name: 'Place the rest at suggested times' }).click();
  await expect(sheet).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'All picked tasks, 4 of 4 placed' })).toBeVisible();
  await expect(page.getByText('All tasks are placed')).toBeVisible();
  await page.screenshot({ path: info.outputPath('schedule-phone-placed.png') });
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole('button', { name: 'All picked tasks, 2 of 4 placed' })).toBeVisible();
  expect(errors).toEqual([]);
});

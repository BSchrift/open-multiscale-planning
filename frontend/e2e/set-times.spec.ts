import { expect, test } from '@playwright/test';
import type { Page, TestInfo } from '@playwright/test';
import { openSeeded, pane, readRecord, saved, touchDrag } from './seed';
import type { Seed } from './seed';

// Practices at their set times: on opening, the app places each set day at its time, this week and next once its
// planning has appeared, and says so once with Undo. A day whose time is taken waits, saying why, on Week and in
// planning's Schedule step, where the rest form a ticked group.

test.use({ timezoneId: 'America/Chicago' });

// Friday Nov 27, 7pm: next week's planning has appeared, and this week is planned.
const NOW = new Date('2026-11-28T01:00:00Z');
const NEXT = '2026-11-30';

const records: Seed[] = [
  { type: 'week_plan', id: 'week:2026-11-23', fields: { week_start: '2026-11-23', finished_at: '2026-11-23T14:00:00Z' } },
  { type: 'practice', id: 'run', fields: { title: 'Morning run', target_min: 30, per: 'day', days: [0, 1, 2, 3, 4], preferred_times: [420], state: 'active' } },
  { type: 'practice', id: 'piano', fields: { title: 'Piano practice', target_min: 45, per: 'day', days: [0, 2, 4], preferred_times: [1080], state: 'active' } },
  { type: 'practice', id: 'stretch', fields: { title: 'Stretching', target_min: 60, per: 'week', sessions: 3, preferred_times: [], state: 'active' } },
  // Dentist takes Thursday's 7am.
  {
    type: 'calendar',
    id: 'calendar',
    fields: { connected: true, events: [{ id: 'e1', calendar: 'primary', title: 'Dentist', start: '2026-12-03T12:45:00Z', end: '2026-12-03T14:00:00Z' }] },
  },
];

async function open(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.clock.install({ time: NOW });
  await openSeeded(page, records);
  return errors;
}

/** The screen in light and dark, for the record. */
async function shoot(page: Page, info: TestInfo, name: string) {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.screenshot({ path: info.outputPath(`set-times-${name}-${info.project.name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

const session = (page: Page, practice: string, date: string) => readRecord(page, 'time_block', `session:${practice}:${date}`);

test('on opening, next week lands at its set times, said once with Undo, and Undo takes them off for good', async ({ page }) => {
  const errors = await open(page);
  const toast = page.getByText('Placed 7 practice sessions at their set times next week.');
  await expect(toast).toBeVisible();
  expect(await session(page, 'run', NEXT)).toMatchObject({ start: '2026-11-30T13:00:00Z', end: '2026-11-30T13:30:00Z' });
  expect(await session(page, 'piano', '2026-12-04')).toMatchObject({ start: '2026-12-05T00:00:00Z', end: '2026-12-05T00:45:00Z' });
  // Thursday's 7am is the Dentist's, and a count is never placed.
  expect(await session(page, 'run', '2026-12-03')).toBeUndefined();
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(async () => (await session(page, 'run', NEXT))?.cancelled).toBe(true);
  // Taken off, never placed again. Phone's WebKit keeps the file a moment after the last change, so wait for it.
  await saved(page, '"cancelled":true');
  await page.reload();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  // Placing runs once the app has drawn; give it the moment it takes, then nothing has been said or placed.
  await page.waitForTimeout(1000);
  await expect(page.getByText(/^Placed \d+ practice sessions/)).toHaveCount(0);
  expect((await session(page, 'run', NEXT))?.cancelled).toBe(true);
  expect(errors).toEqual([]);
});

test('Week shows them as planned, and the day whose time is taken waits above it, with the warning', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  await open(page);
  await expect(page.getByText('Placed 7 practice sessions at their set times next week.')).toBeVisible();
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Week' }).click();
  await page.getByRole('button', { name: 'Next week', exact: true }).click();
  const week = pane(page, 'Week');
  if (phone) {
    await week.getByRole('button', { name: /^Thu/ }).first().click();
    const card = week.getByRole('button', { name: 'Morning run, Practice, 30 minutes on Thursday, 7 AM is taken, to schedule' });
    await expect(card).toBeVisible();
    await expect(card.getByText('Thu · 7am is taken')).toBeVisible();
  } else {
    await expect(week.getByRole('button', { name: /^Morning run, Mon Nov 30, 7am to 7:30am/ })).toBeVisible();
    await expect(week.getByRole('button', { name: /^Piano practice, Fri Dec 4, 6pm to 6:45pm/ })).toBeVisible();
    await expect(week.getByRole('button', { name: /^Morning run, \w{3} \w{3} \d+, 7am/ })).toHaveCount(4);
    const chip = week.getByRole('button', { name: 'Morning run, Practice, 30 minutes on Thursday, 7 AM is taken, to schedule' });
    await expect(chip.locator('[data-icon="warning"]')).toBeVisible();
  }
  await shoot(page, info, 'week');
});

test("planning's Schedule step ticks the sessions at their set times, and asks first about the one whose time is taken", async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  await open(page);
  await expect(page.getByText('Placed 7 practice sessions at their set times next week.')).toBeVisible();
  await page.getByRole('button', { name: 'Start planning' }).first().click();
  await expect(page.getByRole('navigation', { name: 'Planning steps' })).toBeVisible();
  await page.getByRole('button', { name: 'Undo' }).click();
  await page.getByRole('navigation', { name: 'Planning steps' }).getByRole('button', { name: phone ? 'Schedule' : '3. Schedule' }).click();
  await expect(page.getByText('7am is taken by Dentist, so 8am')).toBeVisible();
  if (phone) {
    const list = page.getByRole('button', { name: 'All picked tasks, 2 to place · 7 at their set times' });
    await expect(list).toBeVisible();
    await shoot(page, info, 'schedule');
    await list.click();
    const sheet = page.getByRole('dialog', { name: 'All picked tasks' });
    await expect(sheet.getByText('Thu Dec 3 · 7am is taken')).toBeVisible();
    await expect(sheet.getByRole('list', { name: 'At their set times · 7' }).getByText('Mon, Tue, Wed and Fri at 7am')).toBeVisible();
    await shoot(page, info, 'schedule-list');
  } else {
    await expect(page.getByText('2 to place · 7 at their set times')).toBeVisible();
    await expect(page.getByRole('list', { name: 'Practices' }).getByText('Thu Dec 3 · 7am is taken')).toBeVisible();
    const group = page.getByRole('list', { name: 'At their set times · 7' });
    await expect(group.getByText('Mon, Tue, Wed and Fri at 7am')).toBeVisible();
    await expect(group.getByText('Mon, Wed and Fri at 6pm')).toBeVisible();
    await shoot(page, info, 'schedule');
  }
});

test('Today shows the session at its set time, and Take off calendar puts it in To schedule with its time first', async ({ page }, info) => {
  // Tuesday Dec 1, 6:40am, with the week planned.
  await page.clock.install({ time: new Date('2026-12-01T12:40:00Z') });
  await openSeeded(page, [...records, { type: 'week_plan', id: 'week:2026-11-30', fields: { week_start: NEXT, finished_at: '2026-11-30T14:00:00Z' } }]);
  await expect(page.getByText('Placed 5 practice sessions at their set times this week.')).toBeVisible();
  const today = pane(page, 'Today');
  // Phone draws the day's blocks as handles to drag.
  const block = today.getByRole(info.project.name === 'phone' ? 'slider' : 'button', { name: /^Morning run, 7am to 7:30am/ });
  await expect(block).toBeVisible();
  // The toast goes before the screen is kept.
  await expect(page.getByText(/^Placed 5 practice sessions/)).toHaveCount(0, { timeout: 15_000 });
  await shoot(page, info, 'today');
  // Its quick menu: a right-click on desktop, a finger held and let go on phone.
  if (info.project.name === 'phone') {
    await block.scrollIntoViewIfNeeded();
    const box = (await block.boundingBox())!;
    await touchDrag(page, block, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
  } else await block.click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Take off calendar' })).toBeVisible();
  await shoot(page, info, 'remove');
  await page.getByRole('menuitem', { name: 'Take off calendar' }).click();
  await expect(page.getByText("Took Morning run off Tue 7am. It's in To schedule.")).toBeVisible();
  const card = today.getByRole('region', { name: 'To schedule' }).getByRole('button', { name: /^Morning run, Practice, 30 minutes on Tuesday around 7 AM/ });
  await expect(card.getByText('30m · usually 7am')).toBeVisible();
  await card.click();
  // Its set time first: in the card on desktop, in a sheet on phone.
  await expect(page.getByRole('button', { name: /^Tue 7am to 7:30am$/ })).toBeVisible();
  await shoot(page, info, 'removed');
});

import { expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { goals, tab } from './journeys/journey';
import { expectSaved, goOffline, loadEveryScreen, reloadOnline, SCREEN_URLS } from './offline';
import type { Offline } from './offline';
import { openSeeded, pane, readRecord, startPlanningThenUndo } from './seed';
import type { Seed } from './seed';

// Each main flow done with no connection, start to finish, by a signed-out app: everything it does is on this device,
// so offline it should work as it does online, ask for nothing over the network, and keep the work through a reload.

test.use({ timezoneId: 'America/Chicago' });

const NOW = new Date('2026-11-02T20:00:00Z'); // Monday 2pm in Chicago, with this week not yet planned.
const WEEK = '2026-11-02';
const running = { state: 'active', start: '2026-10-01', end: '2026-12-31' };
// Chicago is six hours behind UTC in November.
const at = (day: number, time: string) => {
  const [h, m] = time.split(':').map(Number);
  return new Date(Date.UTC(2026, 10, day, h! + 6, m ?? 0)).toISOString().replace('.000Z', 'Z');
};
const planned: Seed = { type: 'week_plan', id: `week:${WEEK}`, fields: { week_start: WEEK, finished_at: at(2, '08:00') } };

const nav = (page: Page) => page.getByRole('navigation', { name: 'Main' });
const steps = (page: Page) => page.getByRole('navigation', { name: 'Planning steps' });
const toast = (page: Page) => page.locator('.toast');
/** What shows in place of a screen that failed, each with a heading of its own: the app's error, or a screen's code that didn't arrive. */
const broken = (page: Page) => page.getByRole('alert').filter({ hasText: /Something went wrong|Couldn't open this screen/ });

/** Opens the app with the records in place and every screen's code loaded, then cuts the connection. */
async function openOffline(page: Page, context: BrowserContext, records: readonly Seed[]): Promise<Offline> {
  await page.clock.install({ time: NOW });
  await openSeeded(page, records);
  await loadEveryScreen(page);
  return goOffline(page, context);
}

/** Offline, nothing was asked of the network, and nothing threw from then on. */
function expectOffline(offline: Offline) {
  expect(offline.requests).toEqual([]);
  expect(offline.errors).toEqual([]);
}

test('every main screen opens offline for the first time, once the app has loaded', async ({ page, context }, info) => {
  test.fail(true, "Waiting on the offline screen-loading fix: the app doesn't load a screen's code until it first opens, so offline that screen can't open until a restart.");
  const phone = info.project.name === 'phone';
  const requested = new Set<string>();
  page.on('request', (request) => requested.add(new URL(request.url()).pathname));
  await page.clock.install({ time: NOW });
  await openSeeded(page, [
    { type: 'task', id: 'i1', fields: { kind: 'inbox', title: 'Call the bank' } },
    { type: 'project', id: 'p1', fields: { title: 'Paint the fence', ...running } },
  ]);
  await expect(pane(page, 'Today').getByRole('heading').first()).toBeVisible();
  // The app loads each screen's code by itself once it has opened, then whatever that code imports. Soft, so a screen
  // that never loaded still goes on to show what opening it offline does.
  await expect.soft.poll(() => SCREEN_URLS.filter((url) => !requested.has(url)), { timeout: 15_000 }).toEqual([]);
  await page.waitForLoadState('networkidle');

  const offline = await goOffline(page, context);
  for (const name of ['Today', 'Inbox', 'Week', 'Plan', 'Goals', 'One offs', 'Analytics', 'Done', 'Settings']) {
    await tab(page, phone, name);
    await expect(broken(page), name).toHaveCount(0);
  }
  // The two flows a tab opens: Process over the Inbox, and planning the week from Today.
  await tab(page, phone, 'Inbox');
  await pane(page, 'Inbox').getByRole('button', { name: 'Process 1 item' }).click();
  const card = page.getByRole('dialog', { name: 'Process Inbox' });
  await expect(card.getByRole('heading', { name: 'Call the bank', level: 1 })).toBeVisible();
  await card.getByRole('button', { name: 'Exit' }).click();
  await expect(card).toHaveCount(0);
  await tab(page, phone, 'Today');
  await page.getByRole('button', { name: 'Start planning' }).first().click();
  await expect(steps(page)).toBeVisible();
  await expect(broken(page)).toHaveCount(0);
  expectOffline(offline);
});

test('captures to the Inbox offline', async ({ page, context }, info) => {
  const phone = info.project.name === 'phone';
  const offline = await openOffline(page, context, [{ type: 'task', fields: { kind: 'inbox', title: 'Call the bank' } }]);

  await tab(page, phone, 'Inbox');
  await (phone ? page.getByRole('button', { name: 'Capture a task' }) : nav(page).getByRole('button', { name: /Capture/ })).click();
  const capture = page.getByRole('dialog', { name: 'Capture' });
  await capture.getByRole('textbox', { name: 'Capture to Inbox' }).fill('Return the books');
  if (phone) await capture.getByRole('button', { name: 'Save' }).click();
  else await capture.getByRole('textbox', { name: 'Capture to Inbox' }).press('Enter');
  await expect(capture).toHaveCount(0);
  const row = pane(page, 'Inbox').locator('.inboxrow').filter({ hasText: 'Return the books' });
  await expect(row).toBeVisible();
  const id = (await row.getAttribute('data-id'))!;
  expect(await readRecord(page, 'task', id)).toMatchObject({ kind: 'inbox', title: 'Return the books' });
  await expectSaved(page, 'task', id, { kind: 'inbox', title: 'Return the books' });

  await reloadOnline(page, offline);
  await tab(page, phone, 'Inbox');
  await expect(pane(page, 'Inbox').locator('.inboxrow')).toHaveText([/Call the bank/, /Return the books/]);
  expectOffline(offline);
});

test('processes the Inbox offline: a home for each item, Undo, and Delete', async ({ page, context }, info) => {
  const phone = info.project.name === 'phone';
  const offline = await openOffline(page, context, [
    { type: 'project', id: 'p1', fields: { title: 'Paint the fence', ...running } },
    { type: 'task', id: 'i1', fields: { kind: 'inbox', title: 'Call the bank' } },
    { type: 'task', id: 'i2', fields: { kind: 'inbox', title: 'Fix the gate', estimate_min: 120 } },
    { type: 'task', id: 'i3', fields: { kind: 'inbox', title: 'Buy stamps' } },
  ]);

  await tab(page, phone, 'Inbox');
  await pane(page, 'Inbox').getByRole('button', { name: 'Process 3 items' }).click();
  const card = page.getByRole('dialog', { name: 'Process Inbox' });
  await expect(card.getByRole('heading', { name: 'Call the bank', level: 1 })).toBeVisible();
  /** Picks a place: typed and Enter on desktop, a tap in the sheet on phone. */
  const addTo = async (typed: string, option: string) => {
    if (!phone) {
      const field = page.getByRole('combobox', { name: 'Add to a project or One offs' });
      await field.fill(typed);
      await expect(page.getByRole('option', { name: option })).toHaveAttribute('aria-selected', 'true');
      return field.press('Enter');
    }
    await card.getByRole('button', { name: /^Add to a project or One offs/ }).click();
    const sheet = page.getByRole('dialog', { name: 'Add to' });
    await sheet.getByRole('combobox', { name: 'Add to a project or One offs' }).fill(typed);
    await sheet.getByRole('option', { name: option }).click();
  };

  await addTo('paint', 'Paint the fence');
  await expect(toast(page)).toContainText('Added Call the bank to Paint the fence.');
  await card.getByRole('button', { name: 'Add to this week' }).click();
  await addTo('one', 'One offs, and to this week');
  await expect(toast(page)).toContainText('Added Fix the gate to One offs and to this week.');
  await toast(page).getByRole('button', { name: 'Undo' }).click();
  await expect(card.getByRole('heading', { name: 'Fix the gate' })).toBeVisible();
  expect(await readRecord(page, 'task', 'i2')).toMatchObject({ kind: 'inbox' });
  await addTo('one', 'One offs, and to this week');
  await expect(card.getByRole('heading', { name: 'Buy stamps' })).toBeVisible();
  await card.getByRole('button', { name: 'Delete/done' }).click();
  await card.getByRole('button', { name: 'Yes, delete' }).click();
  await expect(card).toHaveCount(0);
  await expect(page.locator('.clearveil')).toHaveText('Inbox clear3 items processed');
  expect(await readRecord(page, 'task', 'i1')).toMatchObject({ kind: 'project', project_id: 'p1' });
  expect(await readRecord(page, 'task', 'i2')).toMatchObject({ kind: 'one_off' });
  expect(await readRecord(page, 'week_pick', `pick:${WEEK}:i2`)).toMatchObject({ minutes: 120 });
  expect(await readRecord(page, 'task', 'i3')).toMatchObject({ deleted_at: expect.any(String) });
  await expectSaved(page, 'task', 'i3', { deleted_at: expect.any(String) });

  await reloadOnline(page, offline);
  await tab(page, phone, 'Inbox');
  await expect(pane(page, 'Inbox').getByText(phone ? 'Inbox is empty. Anything you capture lands here.' : 'Inbox is empty.')).toBeVisible();
  await tab(page, phone, 'One offs');
  await expect(pane(page, 'One offs').getByRole('checkbox', { name: 'Fix the gate done' })).toBeVisible();
  expectOffline(offline);
});

test('plans the week offline, through each step: Inbox, Pick, Schedule and Review', async ({ page, context }, info) => {
  const phone = info.project.name === 'phone';
  const offline = await openOffline(page, context, [
    { type: 'project', id: 'report', fields: { title: 'Write the report', ...running, weekly_aim: 240 } },
    { type: 'milestone', id: 'm2', fields: { project_id: 'report', title: 'Draft chapters', due: '2026-11-20' } },
    { type: 'task', id: 't2', fields: { kind: 'project', project_id: 'report', milestone_id: 'm2', title: 'Write chapter one', estimate_min: 120 } },
    { type: 'task', id: 'i1', fields: { kind: 'inbox', title: 'Rake the leaves' } },
  ]);

  await page.getByRole('button', { name: 'Start planning' }).first().click();
  // Inbox: its item goes to the project, and Process hands back to planning.
  await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible();
  await page.getByRole('button', { name: 'Process 1 item' }).click();
  const card = page.getByRole('dialog', { name: 'Process Inbox' });
  if (phone) {
    await card.getByRole('button', { name: /^Add to a project or One offs/ }).click();
    await page.getByRole('dialog', { name: 'Add to' }).getByRole('option', { name: 'Write the report' }).click();
  } else {
    await page.getByRole('combobox', { name: 'Add to a project or One offs' }).fill('report');
    await page.getByRole('combobox', { name: 'Add to a project or One offs' }).press('Enter');
  }
  await expect(card).toHaveCount(0);
  await page.getByRole('button', { name: 'Continue to picking tasks' }).click();

  // Pick: a task's time button adds it to the week.
  await page.getByRole('button', { name: 'Add 2h to this week: Write chapter one' }).click();
  await expect(page.getByRole('button', { name: '2h this week: Write chapter one' })).toBeVisible();
  expect(await readRecord(page, 'week_pick', `pick:${WEEK}:t2`)).toMatchObject({ minutes: 120 });

  // Schedule: it goes at the time suggested.
  await steps(page).getByRole('button', { name: phone ? 'Schedule' : '3. Schedule' }).click();
  await page.getByRole('button', { name: 'Place here' }).click();
  await expect(page.getByText('All tasks are placed')).toBeVisible();

  // Review, then Finish.
  await steps(page).getByRole('button', { name: phone ? 'Review' : '4. Review' }).click();
  await page.getByRole('button', { name: 'Finish plan' }).click();
  await expect(steps(page)).toHaveCount(0);
  await expect(page.getByText('Week planned.')).toBeVisible();
  expect(await readRecord(page, 'task', 'i1')).toMatchObject({ kind: 'project', project_id: 'report' });
  expect(await readRecord(page, 'week_plan', `week:${WEEK}`)).toMatchObject({ finished_at: expect.any(String) });
  await expectSaved(page, 'week_plan', `week:${WEEK}`, { finished_at: expect.any(String) });

  await reloadOnline(page, offline);
  await expect(page.getByRole('button', { name: 'Start planning' })).toHaveCount(0);
  expect(await readRecord(page, 'week_plan', `week:${WEEK}`)).toMatchObject({ finished_at: expect.any(String) });
  await tab(page, phone, 'Week');
  await expect(pane(page, 'Week').getByText('Everything this week is on the calendar.')).toBeVisible();
  // Its suggested time was Tuesday's first free one.
  if (phone) await page.getByRole('group', { name: 'Choose a day' }).getByRole('button', { name: /^Tue Nov 3/ }).click();
  await expect(pane(page, 'Week').getByText('Write chapter one').first()).toBeVisible();
  expectOffline(offline);
});

test('schedules the week offline: one task by hand, then the rest, with Undo', async ({ page, context }, info) => {
  const phone = info.project.name === 'phone';
  const pick = (task: string, minutes: number): Seed => ({ type: 'week_pick', id: `pick:${WEEK}:${task}`, fields: { week_start: WEEK, task_id: task, minutes } });
  const offline = await openOffline(page, context, [
    { type: 'project', id: 'report', fields: { title: 'Write the report', ...running } },
    { type: 'milestone', id: 'm1', fields: { project_id: 'report', title: 'Gather notes', due: '2026-10-18' } },
    { type: 'task', id: 't1', fields: { kind: 'project', project_id: 'report', milestone_id: 'm1', title: 'Collect the sources', estimate_min: 120 } },
    { type: 'task', id: 't2', fields: { kind: 'project', project_id: 'report', title: 'Write chapter one', estimate_min: 120 } },
    { type: 'task', id: 'o1', fields: { kind: 'one_off', title: 'Paint the fence', estimate_min: 90, schedule: { type: 'once', from: '2026-11-04' } } },
    { type: 'practice', id: 'pr', fields: { title: 'Morning stretch', target_min: 30, per: 'day', days: [1, 2], preferred_times: [420], state: 'active' } },
    pick('t1', 120),
    pick('t2', 120),
    pick('o1', 90),
    // Morning stretch is already placed on both its days, 7am in Chicago.
    { type: 'time_block', id: 's1', fields: { practice_id: 'pr', start: at(3, '07:00'), end: at(3, '07:30'), tz: 'America/Chicago' } },
    { type: 'time_block', id: 's2', fields: { practice_id: 'pr', start: at(4, '07:00'), end: at(4, '07:30'), tz: 'America/Chicago' } },
  ]);
  // Start planning puts planning on the clock from now; its Undo keeps this week's times free for the work below.
  await startPlanningThenUndo(page);
  await steps(page).getByRole('button', { name: phone ? 'Schedule' : '3. Schedule' }).click();
  const placed = (n: number) => (phone ? page.getByRole('button', { name: `All picked tasks, ${n} of 4 placed` }) : page.getByText(`${n} of 4 placed`));
  await expect(placed(1)).toBeVisible();

  // The first task by hand: on Tuesday, then a quarter hour later by key on phone; a day and an hour later by mouse on
  // desktop, one column right and 40px down at 40px an hour.
  let start: string;
  if (phone) {
    await page.getByRole('group', { name: 'Compare days' }).getByRole('button', { name: /^Tue Nov 3, .*suggested 7:30am$/ }).click();
    await page.getByRole('button', { name: 'Move to Tue Nov 3' }).click();
    const handle = page.getByRole('slider', { name: /^Time for Collect the sources/ });
    await handle.focus();
    await page.keyboard.press('ArrowDown');
    await expect(handle).toHaveAttribute('aria-valuetext', 'Tue Nov 3, 7:45am to 9:45am');
    start = at(3, '07:45');
  } else {
    const draft = page.getByRole('group', { name: /^Collect the sources, Mon Nov 2, 2pm to 4pm, Project\./ });
    const box = (await draft.boundingBox())!;
    const column = (await page.locator('.colbody').first().boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + 8);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + column.width / 2, box.y + 30, { steps: 4 });
    await page.mouse.move(box.x + box.width / 2 + column.width + 2, box.y + 48, { steps: 4 });
    await page.mouse.up();
    await expect(page.getByRole('group', { name: /^Collect the sources, Tue Nov 3, 3pm to 5pm, Project\./ })).toBeVisible();
    start = at(3, '15:00');
  }
  await page.getByRole('button', { name: 'Place here' }).click();
  await expect(placed(2)).toBeVisible();

  // The rest at suggested times, then Undo.
  if (phone) await placed(2).click();
  await (phone ? page.getByRole('dialog', { name: 'All picked tasks' }) : page).getByRole('button', { name: 'Place the rest at suggested times' }).click();
  await expect(placed(4)).toBeVisible();
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(placed(2)).toBeVisible();
  // Placed blocks get ids of their own, so they're found by their task.
  await expectSaved(page, 'time_block', { task_id: 't1' }, { start });
  await expectSaved(page, 'time_block', { task_id: 'o1' }, { deleted_at: expect.any(String) });

  await reloadOnline(page, offline);
  await tab(page, phone, 'Week');
  if (phone) await page.getByRole('group', { name: 'Choose a day' }).getByRole('button', { name: /^Tue Nov 3/ }).click();
  await expect(pane(page, 'Week').getByText('Collect the sources').first()).toBeVisible();
  expectOffline(offline);
});

test('answers time blocks on Today offline: how the last one went, then Start and Mark done with Undo', async ({ page, context }) => {
  const block = (id: string, task: string, from: string, to: string): Seed => ({ type: 'time_block', id, fields: { task_id: task, start: at(2, from), end: at(2, to), tz: 'America/Chicago' } });
  const offline = await openOffline(page, context, [
    planned,
    { type: 'task', id: 't1', fields: { kind: 'one_off', title: 'Write the report', estimate_min: 180 } },
    { type: 'task', id: 't2', fields: { kind: 'one_off', title: 'Paint the fence', estimate_min: 60 } },
    { type: 'task', id: 't3', fields: { kind: 'one_off', title: 'Sort the receipts', estimate_min: 30 } },
    block('b1', 't1', '12:00', '13:00'),
    block('b2', 't2', '13:58', '15:00'),
    block('b3', 't3', '16:00', '16:30'),
  ]);

  // The block gone by asks how it went: Partly, with the time left.
  const prompt = page.getByRole('dialog', { name: 'Block finished' });
  await expect(prompt.getByText('Write the report')).toBeVisible();
  await prompt.getByRole('button', { name: 'Partly' }).click();
  const left = page.getByRole('dialog', { name: 'How much is left?' }).getByRole('slider', { name: 'Time left' });
  await left.focus();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expect(left).toHaveAttribute('aria-valuetext', '1h 30m');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Added to Needs a new time. No need to decide now.')).toBeVisible();
  expect(await readRecord(page, 'block_outcome', 'outcome:b1')).toMatchObject({ result: 'partly', remaining_min: 90 });

  // The one under way: Start, then Mark done now, and Undo puts it back.
  const now = page.getByRole('region', { name: 'Current block' });
  await expect(now.getByText('Now, 1:58pm to 3pm')).toBeVisible();
  await now.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(now.getByText('In progress, time left')).toBeVisible();
  await now.getByRole('button', { name: 'Mark done now' }).click();
  await expect(page.getByText("Marked done. You're free until 4pm.")).toBeVisible();
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(now.getByText('Now, 1:58pm to 3pm')).toBeVisible();
  expect(await readRecord(page, 'time_block', 'b2')).toMatchObject({ started_at: expect.any(String) });
  await expectSaved(page, 'time_block', 'b2', { started_at: expect.any(String) });
  await expectSaved(page, 'block_outcome', 'outcome:b1', { result: 'partly', remaining_min: 90 });

  await reloadOnline(page, offline);
  await expect(page.getByRole('region', { name: 'Current block' }).getByText('In progress, time left')).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Block finished' })).toHaveCount(0);
  expectOffline(offline);
});

test("saves a task's popup offline, and Undo takes it back", async ({ page, context }, info) => {
  const phone = info.project.name === 'phone';
  const offline = await openOffline(page, context, [
    { type: 'objective', id: 'g1', fields: { title: 'Write the quarterly report', state: 'active' } },
    { type: 'project', id: 'p1', fields: { objective_id: 'g1', title: 'Report', ...running } },
    { type: 'task', id: 't1', fields: { kind: 'project', project_id: 'p1', title: 'Draft the summary', estimate_min: 120 } },
  ]);
  const openProject = async () => {
    await tab(page, phone, 'Goals');
    await page.getByRole('button', { name: /^Write the quarterly report/ }).click();
    await page.getByRole('button', { name: /^Report/ }).click();
  };
  const rename = async (from: string, to: string) => {
    await page.getByRole('button', { name: new RegExp(`^Edit task ${from}`) }).click();
    const popup = page.getByRole('dialog', { name: from });
    await popup.getByRole('button', { name: `Rename ${from}` }).click();
    await popup.getByRole('textbox', { name: 'Name' }).fill(to);
    await popup.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText(`Saved ${to}.`)).toBeVisible();
    await expect(page.getByRole('button', { name: new RegExp(`^Edit task ${to}`) })).toBeVisible();
  };
  await openProject();
  await rename('Draft the summary', 'Draft the executive summary');
  expect(await readRecord(page, 'task', 't1')).toMatchObject({ title: 'Draft the executive summary' });
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole('button', { name: /^Edit task Draft the summary/ })).toBeVisible();
  expect(await readRecord(page, 'task', 't1')).toMatchObject({ title: 'Draft the summary' });
  await rename('Draft the summary', 'Draft the short summary');
  await expectSaved(page, 'task', 't1', { title: 'Draft the short summary' });

  await reloadOnline(page, offline);
  await openProject();
  await expect(page.getByRole('button', { name: /^Edit task Draft the short summary/ })).toBeVisible();
  expectOffline(offline);
});

test('adds, dates and ticks one offs offline', async ({ page, context }, info) => {
  const phone = info.project.name === 'phone';
  const offline = await openOffline(page, context, [
    { type: 'task', id: 'undated', fields: { kind: 'one_off', title: 'Tidy the shed', schedule: { type: 'once' } } },
    { type: 'task', id: 'day', fields: { kind: 'one_off', title: 'Return the drill', schedule: { type: 'once', from: '2026-11-07' }, next_due: '2026-11-07', estimate_min: 30 } },
  ]);
  await tab(page, phone, 'One offs');
  const p = pane(page, 'One offs');

  let form = p.getByRole('form', { name: 'Add a one off' });
  if (phone) {
    await p.getByRole('button', { name: 'Add one off' }).click();
    form = page.getByRole('dialog', { name: 'Add a one off' });
  }
  await form.getByLabel('Title').fill('Wash the car');
  await form.getByLabel('Repeats').selectOption('seasonal');
  await form.getByRole('button', { name: 'April' }).click();
  await form.getByRole('button', { name: 'October' }).click();
  await form.getByRole('button', { name: 'Add one off' }).click();
  await expect(p.getByText('In April and October, next in April, 30m')).toBeVisible();

  await p.getByRole('button', { name: 'Add date for Tidy the shed' }).click();
  await p.getByLabel('Date', { exact: true }).fill('2026-11-04');
  await p.getByRole('button', { name: 'Set date' }).click();
  await expect(p.getByText('Nov 4', { exact: true })).toBeVisible();
  expect(await readRecord(page, 'task', 'undated')).toMatchObject({ schedule: { type: 'once', from: '2026-11-04' } });

  await p.getByRole('checkbox', { name: 'Return the drill done' }).click();
  await expect(page.getByText('Completed Return the drill.')).toBeVisible();
  expect(await readRecord(page, 'task', 'day')).toMatchObject({ done_at: expect.any(String) });
  await expectSaved(page, 'task', 'day', { done_at: expect.any(String) });

  await reloadOnline(page, offline);
  await tab(page, phone, 'One offs');
  await expect(p.getByText('In April and October, next in April, 30m')).toBeVisible();
  await expect(p.getByText('Nov 4', { exact: true })).toBeVisible();
  await expect(p.getByRole('checkbox', { name: 'Return the drill done' })).toHaveCount(0);
  expectOffline(offline);
});

test('adds a goal, a project and a task offline, and finishes a task', async ({ page, context }, info) => {
  const phone = info.project.name === 'phone';
  const offline = await openOffline(page, context, [
    { type: 'objective', id: 'g1', fields: { title: 'Learn to bake bread', state: 'active' } },
    { type: 'project', id: 'p1', fields: { objective_id: 'g1', title: 'Bake a sourdough loaf', ...running } },
    { type: 'milestone', id: 'm1', fields: { project_id: 'p1', title: 'Make a starter', due: '2026-11-25' } },
    { type: 'task', id: 't2', fields: { kind: 'project', project_id: 'p1', milestone_id: 'm1', title: 'Feed the starter', estimate_min: 120 } },
  ]);
  const openProject = async () => {
    await goals(page, phone);
    await page.getByRole('button', { name: /^Learn to bake bread/ }).click();
    await page.getByRole('button', { name: /^Bake a sourdough loaf/ }).click();
  };
  await goals(page, phone);

  if (phone) await page.getByRole('button', { name: '+ New goal' }).click();
  await page.getByRole('textbox', { name: 'New goal' }).fill('Write a book');
  await page.getByRole('textbox', { name: 'New goal' }).press('Enter');
  await page.getByRole('button', { name: /^Write a book/ }).click();
  await page.getByRole('button', { name: phone ? '+ Project' : 'Add project' }).click();
  const form = page.getByRole('form', { name: 'Add project' });
  await form.getByLabel('Name').fill('Draft chapters');
  await form.getByLabel('Ends').fill('2027-02-01');
  await form.getByRole('button', { name: 'Add project' }).click();
  await expect(page.getByText('Project added, Nov 2 to Feb 1.')).toBeVisible();

  await openProject();
  await page.getByRole('button', { name: 'Add task to Make a starter' }).click();
  const editor = page.getByRole('dialog', { name: 'Add task' });
  await editor.getByLabel('Title').fill('Proof the dough');
  await editor.getByRole('button', { name: 'Add' }).click();
  await expect(editor.getByText('Added Proof the dough.')).toBeVisible();
  await editor.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('button', { name: 'Edit task Proof the dough, 1h' })).toBeVisible();
  await page.getByRole('checkbox', { name: 'Feed the starter done' }).click();
  await expect(page.getByText('Completed Feed the starter.')).toBeVisible();
  expect(await readRecord(page, 'task', 't2')).toMatchObject({ done_at: expect.any(String) });
  await expectSaved(page, 'task', 't2', { done_at: expect.any(String) });

  await reloadOnline(page, offline);
  await goals(page, phone);
  await page.getByRole('button', { name: /^Write a book/ }).click();
  await expect(page.getByRole('button', { name: /^Draft chapters/ })).toBeVisible();
  await openProject();
  await expect(page.getByRole('button', { name: 'Edit task Proof the dough, 1h' })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Feed the starter done' })).toHaveCount(0);
  expectOffline(offline);
});

test('plans the next stretch offline: a milestone in, then Finish', async ({ page, context }, info) => {
  const phone = info.project.name === 'phone';
  const offline = await openOffline(page, context, [
    { type: 'settings', id: 'settings', fields: { plan_stretch: { last_planned: '2026-10-01' } } },
    { type: 'objective', id: 'g1', fields: { title: 'Learn to bake bread', state: 'active' } },
    { type: 'project', id: 'p1', fields: { objective_id: 'g1', title: 'Bake a sourdough loaf', state: 'active', start: '2026-10-01', end: '2027-06-30' } },
    { type: 'milestone', id: 'm2', fields: { project_id: 'p1', title: 'Share a loaf', due: '2027-05-01' } },
  ]);
  await tab(page, phone, 'Plan');
  await page.getByRole('button', { name: 'Plan now' }).click();
  await steps(page).getByRole('button', { name: /Projects/ }).click();
  await page.getByRole('button', { name: 'Add milestone Share a loaf to this plan' }).click();
  await expect(page.getByRole('button', { name: 'Undo: Added Share a loaf to this plan, by Mar 31.' })).toBeVisible();
  await steps(page).getByRole('button', { name: /Finish/ }).click();
  await (phone ? page.locator('.flowdock').getByRole('button', { name: 'Finish' }) : page.getByRole('button', { name: 'Finish', exact: true })).click();
  await expect(page.getByText('Your plan for Jan 1 to Mar 31 is set.')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Next plan, Jan 1 to Mar 31' })).toContainText('Share a loaf');
  expect(await readRecord(page, 'settings', 'settings')).toMatchObject({ plan_stretch: { last_planned: '2027-01-01' } });
  await expectSaved(page, 'settings', 'settings', { plan_stretch: { last_planned: '2027-01-01' } });

  await reloadOnline(page, offline);
  await tab(page, phone, 'Plan');
  await expect(page.getByRole('region', { name: 'Next plan, Jan 1 to Mar 31' })).toContainText('Share a loaf');
  expectOffline(offline);
});

test('edits settings offline', async ({ page, context }, info) => {
  const phone = info.project.name === 'phone';
  const offline = await openOffline(page, context, []);
  await tab(page, phone, 'Settings');
  const p = pane(page, 'Settings');

  const hours = p.getByRole('region', { name: 'Available hours' });
  await hours.getByRole('button', { name: 'Add unavailable time' }).click();
  await hours.getByRole('group', { name: 'Unavailable, 12pm to 1pm' }).getByRole('combobox', { name: 'Days' }).selectOption('weekdays');
  await expect(hours.getByText(/^100h a week for projects and 100h for one offs/)).toBeVisible();

  const away = p.getByRole('region', { name: 'Away dates' });
  await away.getByLabel('From').fill('2026-12-20');
  await away.getByLabel(/^to$/i).fill('2026-12-28');
  await away.getByRole('button', { name: 'Add' }).click();
  await expect(away.getByText('Dec 20 to Dec 28')).toBeVisible();

  const reminders = p.getByRole('region', { name: 'Reminders' });
  await reminders.getByRole('checkbox', { name: "Ask if I've started, unless I already tapped Start" }).click();
  await expect(reminders.getByRole('slider', { name: 'After' })).toHaveCount(0);
  expect(await readRecord(page, 'settings', 'settings')).toMatchObject({ reminders: { check_in: false } });
  await expectSaved(page, 'settings', 'settings', { reminders: { check_in: false } });

  await reloadOnline(page, offline);
  await tab(page, phone, 'Settings');
  await expect(hours.getByRole('group', { name: 'Unavailable, 12pm to 1pm' })).toBeVisible();
  await expect(away.getByText('Dec 20 to Dec 28')).toBeVisible();
  await expect(reminders.getByRole('checkbox', { name: "Ask if I've started, unless I already tapped Start" })).not.toBeChecked();
  expectOffline(offline);
});

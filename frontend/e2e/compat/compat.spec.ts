import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { formatDate } from '../../src/core/dates';
import { account, go, oneOffRow, openSeeded, pane, seed, setDate, syncNow } from '../seed';
import type { Seed } from '../seed';
import { capture, closeDevices, daysAhead, deleteFromInbox, device, oneOff, signIn } from '../stack/devices';

// The last release's bundle, old, and this checkout's, new, as scripts/test-compat.sh built them. serve.mjs serves each
// browser context the one its bundle cookie names, from one origin. In one context the two share a database, as an
// update and the bundle before it do on a device, and a rollback after a failed trial opens what the update wrote. In
// two, they're an old and a new device of one user, syncing. One spec drives both bundles, so it keeps to controls both
// have.

test.use({ baseURL: `http://localhost:${process.env.COMPAT_WEB_PORT}` });
test.afterEach(closeDevices);

type Bundle = 'old' | 'new';
const bundle = (name: Bundle) => ({ name: 'bundle', value: name, domain: 'localhost', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' as const });
const on = (name: Bundle) => ({ storageState: { cookies: [bundle(name)], origins: [] } });

/** Notes what the page logs as an error, such as a query the database refused. */
function consoleErrors(page: Page, errors: string[], name: Bundle) {
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`${name}: ${message.text()}`);
  });
}

/** Ticks a one off, which then waits behind Show completed. A failed save shows in the errors. */
async function tick(page: Page, title: string, errors: string[]) {
  await go(page, 'One offs');
  await pane(page, 'One offs').getByRole('checkbox', { name: `${title} done` }).click();
  await expect(page.getByText(`Completed ${title}.`), errors.join('\n')).toBeVisible();
}

async function expectTicked(page: Page, title: string) {
  await go(page, 'One offs');
  const box = pane(page, 'One offs').getByRole('checkbox', { name: `${title} done` });
  await expect(box).toHaveCount(0);
  await pane(page, 'One offs').getByRole('button', { name: /^Show \d+ completed in One offs$/ }).click();
  await expect(box).toBeChecked();
  await pane(page, 'One offs').getByRole('button', { name: 'Hide completed in One offs' }).click();
}

const dated = (page: Page, title: string, date: string) => oneOffRow(page, title).getByText(new RegExp(`^${formatDate(date)}(,|$)`));

test.describe('one device', () => {
  test.use({ timezoneId: 'America/Chicago' });

  const NOW = new Date('2026-11-04T16:20:00Z'); // Wednesday 10:20am in Chicago.
  const WEEK = '2026-11-02';
  // Chicago is six hours behind UTC in November.
  const at = (day: number, time: string) => {
    const [h, m] = time.split(':').map(Number);
    return new Date(Date.UTC(2026, 10, day, h! + 6, m ?? 0)).toISOString().replace('.000Z', 'Z');
  };
  const tz = 'America/Chicago';

  // A lived-in week with a record of every type, including fields newer code may stop using but older bundles read.
  const week: Seed[] = [
    { type: 'objective', id: 'g1', fields: { title: 'Write a book', state: 'active' } },
    { type: 'project', id: 'p1', fields: { objective_id: 'g1', title: 'Finish the first draft', state: 'active', start: '2026-09-01', end: '2026-12-20', weekly_aim: 360 } },
    { type: 'milestone', id: 'm1', fields: { project_id: 'p1', title: 'Half the chapters', start: '2026-10-16', due: '2026-11-20' } },
    {
      type: 'task',
      id: 't1',
      fields: { kind: 'project', project_id: 'p1', milestone_id: 'm1', title: 'Draft chapter five', estimate_min: 180, remaining_min: 120, first_step: 'Reread the end of chapter four', link: 'https://example.com/outline' },
    },
    { type: 'task', id: 't2', fields: { kind: 'project', project_id: 'p1', milestone_id: 'm1', title: 'Ask for feedback', estimate_min: 30, waiting_until: '2026-11-20' } },
    { type: 'practice', id: 'pr1', fields: { objective_id: 'g1', title: 'Read fiction', target_min: 120, per: 'week', state: 'active', preferred_times: [1260] } },
    { type: 'task', id: 'o1', fields: { kind: 'one_off', title: 'Renew the library card', estimate_min: 30, schedule: { type: 'once' } } },
    { type: 'task', id: 'o2', fields: { kind: 'one_off', title: 'Sort old photos', estimate_min: 60, schedule: { type: 'once' } } },
    { type: 'task', id: 'o3', fields: { kind: 'one_off', title: 'Pay the water bill', estimate_min: 15, schedule: { type: 'recurring', every: 1, unit: 'month', anchor: '2026-10-06' }, next_due: '2026-11-06' } },
    { type: 'task', id: 'o4', fields: { kind: 'one_off', title: 'Return the borrowed ladder', schedule: { type: 'once' }, done_at: at(3, '18:00') } },
    { type: 'task_completion', id: 'c1', fields: { task_id: 'o4', done_at: at(3, '18:00') } },
    { type: 'task', id: 'i1', fields: { kind: 'inbox', title: 'Look up a bike repair shop' } },
    { type: 'task', id: 'i2', fields: { kind: 'inbox', title: 'Order more coffee beans' } },
    { type: 'week_plan', id: `week:${WEEK}`, fields: { week_start: WEEK, finished_at: at(2, '08:00') } },
    { type: 'week_pick', id: `pick:${WEEK}:t1`, fields: { week_start: WEEK, task_id: 't1', minutes: 180 } },
    { type: 'week_pick', id: `pick:${WEEK}:t2`, fields: { week_start: WEEK, task_id: 't2', minutes: 30, skipped: true } },
    { type: 'time_block', id: 'b1', fields: { task_id: 't1', start: at(3, '09:00'), end: at(3, '11:00'), tz, edited: true } },
    { type: 'block_outcome', id: 'outcome:b1', fields: { result: 'partly', remaining_min: 120, answered_at: at(3, '11:05') } },
    { type: 'time_block', id: 'b2', fields: { task_id: 't1', start: at(4, '10:00'), end: at(4, '11:30'), tz, started_at: at(4, '10:01') } },
    { type: 'time_block', id: 'b3', fields: { practice_id: 'pr1', start: at(4, '21:00'), end: at(4, '21:30'), tz } },
    { type: 'away_period', id: 'a1', fields: { start: '2026-12-21', end: '2026-12-28' } },
    { type: 'calendar_source', id: 'cs1', fields: { google_id: 'work', name: 'Work', mode: 'block' } },
    {
      type: 'calendar',
      id: 'calendar',
      fields: { connected: true, synced_at: at(4, '10:00'), events: [{ id: 'e1', calendar: 'work', title: 'Team meeting', start: at(4, '13:00'), end: at(4, '14:00') }] },
    },
  ];

  /** A new tab at NOW, noting errors. */
  async function launch(context: BrowserContext, name: Bundle, errors: string[]): Promise<Page> {
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(`${name}: ${error.message}`));
    consoleErrors(page, errors, name);
    await page.clock.install({ time: NOW });
    return page;
  }

  /** Quits the app once its last change is saved, and opens it on the other bundle, as an update or a rollback does. */
  async function relaunch(page: Page, name: Bundle, errors: string[]): Promise<Page> {
    // The browser build saves 200ms after the last change, and a tab closed sooner loses it (platform/web.ts).
    await page.waitForTimeout(600);
    const context = page.context();
    await page.close();
    await context.addCookies([bundle(name)]);
    const next = await launch(context, name, errors);
    await next.goto('/');
    const nav = next.getByRole('navigation', { name: 'Main' });
    await expect(nav.or(next.getByText("Couldn't open your data", { exact: false }))).toBeVisible();
    await expect(nav, `The ${name} bundle couldn't open the database:\n${errors.join('\n')}`).toBeVisible();
    return next;
  }

  /** Each screen opens. Any query a view can't answer shows up in the errors. */
  async function everyScreen(page: Page) {
    for (const label of ['Today', 'Inbox', 'Week', 'Plan', 'Goals', 'One offs', 'Analytics', 'Settings']) await go(page, label, /./);
  }

  test('an update opens what the bundle before wrote, and that bundle opens what the update wrote after a rollback', async ({ context }) => {
    const errors: string[] = [];
    await context.addCookies([bundle('old')]);
    let page = await launch(context, 'old', errors);
    await openSeeded(page, week);
    await capture(page, 'Ask about the gutter');
    await everyScreen(page);

    // The update opens the old bundle's data, and changes it.
    page = await relaunch(page, 'new', errors);
    await go(page, 'Inbox');
    for (const title of ['Ask about the gutter', 'Look up a bike repair shop', 'Order more coffee beans']) await expect(pane(page, 'Inbox').getByText(title)).toBeVisible();
    await go(page, 'Goals');
    await expect(pane(page, 'Goals').getByText('Write a book').first()).toBeVisible();
    await capture(page, 'Call the plumber');
    await setDate(page, 'Sort old photos', '2026-11-20');
    await tick(page, 'Renew the library card', errors);
    await deleteFromInbox(page, 'Look up a bike repair shop');
    await everyScreen(page);

    // It fails its trial, and the old bundle opens what it wrote, and carries on: a tick reads the views the update left.
    page = await relaunch(page, 'old', errors);
    await go(page, 'Inbox');
    for (const title of ['Ask about the gutter', 'Call the plumber']) await expect(pane(page, 'Inbox').getByText(title)).toBeVisible();
    await expect(pane(page, 'Inbox').getByText('Look up a bike repair shop')).toHaveCount(0);
    await go(page, 'One offs');
    await expect(dated(page, 'Sort old photos', '2026-11-20')).toBeVisible();
    await expectTicked(page, 'Renew the library card');
    await tick(page, 'Sort old photos', errors);
    await everyScreen(page);
    expect(errors).toEqual([]);
  });
});

test('an old and a new device of one user sync captures, dates, ticks and deletes both ways', async ({ browser }) => {
  const run = randomUUID().slice(0, 8);
  const fence = `Paint the fence ${run}`;
  const hinges = `Oil the hinges ${run}`;
  const gutter = `Clear the gutter ${run}`;
  const shed = `Tidy the shed ${run}`;
  const ids = { fence: `e2e-${run}-fence`, hinges: `e2e-${run}-hinges`, gutter: `e2e-${run}-gutter`, shed: `e2e-${run}-shed` };
  const plumber = `Call the plumber ${run}`;
  const brushes = `Buy brushes ${run}`;

  const oldDevice = await device(browser, `e2e-${run}`, on('old'));
  const newDevice = await device(browser, `e2e-${run}`, on('new'));
  consoleErrors(oldDevice.page, oldDevice.errors, 'old');
  consoleErrors(newDevice.page, newDevice.errors, 'new');
  await seed(oldDevice.page, [oneOff(ids.fence, fence), oneOff(ids.hinges, hinges), oneOff(ids.gutter, gutter), oneOff(ids.shed, shed)]);
  await signIn(oldDevice.page);
  await signIn(newDevice.page);

  // Each dates one, ticks one and captures one.
  const date = daysAhead(10);
  await setDate(oldDevice.page, fence, date);
  await tick(oldDevice.page, hinges, oldDevice.errors);
  await capture(oldDevice.page, plumber);
  await setDate(newDevice.page, gutter, date);
  await tick(newDevice.page, shed, newDevice.errors);
  await capture(newDevice.page, brushes);
  for (const d of [oldDevice, newDevice, oldDevice]) await syncNow(d.page);
  for (const d of [oldDevice, newDevice]) {
    await go(d.page, 'One offs');
    for (const title of [fence, gutter]) await expect(dated(d.page, title, date)).toBeVisible();
    for (const title of [hinges, shed]) await expectTicked(d.page, title);
    await go(d.page, 'Inbox');
    for (const title of [plumber, brushes]) await expect(pane(d.page, 'Inbox').getByText(title)).toBeVisible();
  }

  // Each deletes what the other captured.
  await deleteFromInbox(oldDevice.page, brushes);
  await deleteFromInbox(newDevice.page, plumber);
  for (const d of [oldDevice, newDevice, oldDevice]) await syncNow(d.page);
  for (const d of [oldDevice, newDevice]) {
    await go(d.page, 'Inbox');
    for (const title of [plumber, brushes]) await expect(pane(d.page, 'Inbox').getByText(title)).toHaveCount(0);
  }

  // The rest goes too, the ticks' completions with them, so a deployment's test user keeps nothing live.
  const now = new Date().toISOString();
  const today = daysAhead(0);
  await seed(oldDevice.page, [
    ...Object.values(ids).map((id) => ({ type: 'task', id, fields: { deleted_at: now } })),
    ...[ids.hinges, ids.shed].map((id) =>({ type: 'task_completion', id: `occ-done:${id}:${today}`, fields: { deleted_at: now } })),
  ]);
  await syncNow(oldDevice.page);
  await expect(account(oldDevice.page).getByText('Synced', { exact: true })).toBeVisible();

  expect(oldDevice.errors).toEqual([]);
  expect(newDevice.errors).toEqual([]);
});

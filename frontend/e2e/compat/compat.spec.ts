import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { formatDate } from '../../src/core/dates';
import { clearLeftChecks, putPromptsAway, timezoneWithRoom, workJourney } from '../deployed/journey';
import { goals, openProject } from '../journeys/journey';
import { account, go, oneOffRow, openSeeded, pane, readRecord, seed, setDate, syncNow } from '../seed';
import type { Seed } from '../seed';
import { capture, closeDevices, daysAhead, DELETED, deleteAccount, deleteFromInbox, device, oneOff, signIn } from '../stack/devices';
import { target } from '../stack/target';

// The last release's bundle, old, and this checkout's, new, as scripts/test-compat.sh built them. serve.mjs serves each
// browser context the one its bundle cookie names, from one origin. In one context the two share a database, as an
// update and the bundle before it do on a device, and a rollback after a failed trial opens what the update wrote. In
// two, they're an old and a new device of one user, syncing. One spec drives both bundles, so it keeps to controls both
// have.

test.use({ baseURL: `http://localhost:${process.env.COMPAT_WEB_PORT}` });
test.afterEach(closeDevices);

// The two-device pause test's block is live for an hour on a deployment's shared test user, and one a failed run left
// takes the Current block card from every run in that hour. So it's deleted even when the test fails, from a fresh
// device, since a test that timed out has no page left to do it from.
let live: { run: string; task: string; block: string } | null = null;
test.afterEach(async ({ browser }) => {
  if (!live) return;
  const { run, task, block } = live;
  live = null;
  const gone = new Date().toISOString();
  const d = await device(browser, `e2e-${run}`, on('new'));
  await seed(d.page, [
    { type: 'time_block', id: block, fields: { deleted_at: gone } },
    { type: 'task', id: task, fields: { deleted_at: gone } },
  ]);
  await signIn(d.page);
  await syncNow(d.page);
  await d.page.context().close();
});

type Bundle = 'old' | 'new';
const bundle = (name: Bundle) => ({ name: 'bundle', value: name, domain: 'localhost', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' as const });
const on = (name: Bundle) => ({ storageState: { cookies: [bundle(name)], origins: [] } });
// Whether the bundle before already pauses blocks. Without prod's outputs, as on CI, it's origin/main rather than prod's
// release, so once pausing is on main the pause tests have no older bundle to run against. Staging's cross-version
// suite still runs them against prod's.
const oldPauses = () => {
  const assets = join(process.env.COMPAT_OLD ?? '', 'assets');
  return readdirSync(assets).some((f) => f.endsWith('.js') && readFileSync(join(assets, f), 'utf8').includes('unless you resume.'));
};
const noOlderThanPausing = 'The bundle before already pauses blocks, so there is no older one to run against.';
// The same for the stretch flow from goals to the Inbox, once it's on main.
const oldPlansToInbox = () => {
  const assets = join(process.env.COMPAT_OLD ?? '', 'assets');
  return readdirSync(assets).some((f) => f.endsWith('.js') && readFileSync(join(assets, f), 'utf8').includes('Give each item a home'));
};
const noOlderThanInboxStep = 'The bundle before already plans a stretch through the Inbox, so there is no older one to run against.';
// Whether the bundle before already erases a deleted account's copy, as every bundle since account deletion does: on CI,
// origin/main once that's merged.
const oldErasesDeletedAccounts = () => {
  const assets = join(process.env.COMPAT_OLD ?? '', 'assets');
  return readdirSync(assets).some((f) => f.endsWith('.js') && readFileSync(join(assets, f), 'utf8').includes(DELETED));
};

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

/** A goal with a project to finish, which has an open task, and one to pause. */
function house(run: string, dates: { start: string; end: string; due: string }) {
  const titles = { goal: `Fix up the house${run}`, fence: `Paint the fence${run}`, shed: `Clear out the shed${run}`, task: `Sand the boards${run}` };
  const id = (name: string) => `house${run.replace(/\W/g, '-')}-${name}`;
  const records: Seed[] = [
    { type: 'objective', id: id('goal'), fields: { title: titles.goal, state: 'active' } },
    { type: 'project', id: id('fence'), fields: { objective_id: id('goal'), title: titles.fence, state: 'active', start: dates.start, end: dates.end } },
    { type: 'milestone', id: id('coat'), fields: { project_id: id('fence'), title: 'First coat', due: dates.due } },
    { type: 'task', id: id('task'), fields: { kind: 'project', project_id: id('fence'), milestone_id: id('coat'), title: titles.task, estimate_min: 60 } },
    { type: 'project', id: id('shed'), fields: { objective_id: id('goal'), title: titles.shed, state: 'active', start: dates.start, end: dates.end } },
  ];
  return { titles, records };
}

type House = ReturnType<typeof house>['titles'];

/** Finishes the fence from its settings, which cancels its open task. */
async function finishFence(page: Page, h: House) {
  const project = await openProject(page, false, h.goal, h.fence);
  await project.getByRole('button', { name: 'Project settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Project settings' });
  await dialog.getByRole('button', { name: 'Finish', exact: true }).click();
  await dialog.getByRole('button', { name: 'Yes, finish' }).click();
  await expect(page.getByText('Finished. Open tasks cancelled.')).toBeVisible();
}

/** Restores the fence from Archived, and finds the task finishing it cancelled open again. */
async function restoreFence(page: Page, h: House) {
  await goals(page, false);
  const archived = page.getByRole('button', { name: /^Archived \(\d+\)$/ });
  if ((await archived.getAttribute('aria-expanded')) !== 'true') await archived.click();
  await page.getByRole('button', { name: `Restore ${h.fence}` }).click();
  await expect(page.getByText(`${h.fence} restored.`)).toBeVisible();
  const project = await openProject(page, false, h.goal, h.fence);
  await expect(project.getByRole('button', { name: `Edit task ${h.task}, 1h` })).toBeVisible();
}

/** Pauses or resumes the shed from its settings. Resuming moves its end by the days it was paused. */
async function pauseShed(page: Page, h: House, action: 'Pause' | 'Resume', end?: string) {
  const project = await openProject(page, false, h.goal, h.shed);
  await project.getByRole('button', { name: 'Project settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Project settings' });
  await dialog.getByRole('button', { name: action }).click();
  await expect(dialog.getByRole('button', { name: action === 'Pause' ? 'Resume' : 'Pause' })).toBeVisible();
  if (end) await expect(dialog.getByLabel('Ends')).toHaveValue(end);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
}

// The deployed web suite's journey, on a device of its own, signed out. The prod Test step takes it against the web app
// prod still serves, the release before, which here is the old bundle: main's on CI, and on staging prod's web app's.
// When one of prod's app feeds serves an older bundle than its web app, staging's old bundle is that one, and the
// journey's steps need only work back as far as the web app. The device starts with what failed runs left on prod's
// shared test user, which CI's and staging's users never hold: three practices, putting a row above every day, a check
// that ended unanswered, whose question sits in the corner, and four checks at 7pm on the last day, the time the journey
// drags to. Drawn side by side there, each one's × sits under the next block, as on prod on 20 November, so the clean-up
// can't take them off by pointer. The deployed suite's clean-up runs first, as it does there.
for (const name of ['old', 'new'] as const) {
  test(`the deployed suite's clean-up and journey, from Capture to the calendar and back, work on the ${name} bundle`, async ({ browser }) => {
    const from = process.env.COMPAT_OLD_SURFACE;
    test.skip(name === 'old' && !!from && from !== 'web', `The old bundle is the one prod's ${from} feed serves, older than the web app prod's Test step takes the journey on`);
    const d = await device(browser, `e2e-${randomUUID()}`, { ...on(name), timezoneId: timezoneWithRoom() });
    // In the page's time zone: half an hour ending an hour ago, and half an hour from 7pm on the week's last day, Sunday.
    const at = await d.page.evaluate(() => {
      const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
      const sunday = new Date();
      sunday.setDate(sunday.getDate() + ((7 - sunday.getDay()) % 7));
      sunday.setHours(19, 0, 0, 0);
      const ended = Math.floor(Date.now() / 60_000) * 60_000 - 3_600_000;
      return { tz: Intl.DateTimeFormat().resolvedOptions().timeZone, ended: [iso(ended - 1_800_000), iso(ended)], sunday: [iso(+sunday), iso(+sunday + 1_800_000)] };
    });
    const leftBlock = (id: string, title: string, [start, end]: string[]): Seed[] => [
      { type: 'task', id, fields: { kind: 'one_off', title, schedule: { type: 'once' } } },
      { type: 'time_block', id: `${id}-block`, fields: { task_id: id, start, end, tz: at.tz } },
    ];
    await seed(d.page, [
      ...[1, 2, 3].map((n) => ({ type: 'practice', id: `left-${n}`, fields: { title: `Compat check left ${n}`, target_min: 30, per: 'day', state: 'active' } })),
      ...leftBlock('left-ended', 'Compat check left ended', at.ended),
      ...[1, 2, 3, 4].flatMap((n) => leftBlock(`left-sunday-${n}`, `Compat check left Sunday ${n}`, at.sunday)),
    ]);
    await putPromptsAway(d.page);
    await clearLeftChecks(d.page);
    await expect(d.page.getByRole('button', { name: /^Compat check left Sunday \d, / })).toHaveCount(0);
    await workJourney(d.page, `Compat check ${new Date().toISOString().slice(11, 19)}`);
  });
}

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

  /** A new tab at NOW, or some days later, noting errors. */
  async function launch(context: BrowserContext, name: Bundle, errors: string[], days = 0): Promise<Page> {
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(`${name}: ${error.message}`));
    consoleErrors(page, errors, name);
    await page.clock.install({ time: NOW.getTime() + days * 86_400_000 });
    return page;
  }

  /** Quits the app once its last change is saved, and opens it on the other bundle, as an update or a rollback does. */
  async function relaunch(page: Page, name: Bundle, errors: string[], days = 0): Promise<Page> {
    // The bundle before OPFS saves 200ms after the last change, and this one copies its database to IndexedDB for that
    // bundle as late, so a tab closed sooner loses it (platform/opfs.worker.ts).
    await page.waitForTimeout(600);
    const context = page.context();
    await page.close();
    await context.addCookies([bundle(name)]);
    const next = await launch(context, name, errors, days);
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

  test('planning tasks the update saved are a block on Week in the bundle before, and never listed as work to do', async ({ context }) => {
    const errors: string[] = [];
    await context.addCookies([bundle('new')]);
    let page = await launch(context, 'new', errors);
    // As the update saves them: one scheduled, one with no time yet, and one deleted.
    const planning: Seed[] = [
      { type: 'task', id: 'planning:week:2026-11-09', fields: { kind: 'planning', title: 'Plan the week of Nov 9', plans: ['week:2026-11-09'], estimate_min: 30 } },
      { type: 'time_block', id: 'pb1', fields: { task_id: 'planning:week:2026-11-09', start: at(6, '17:00'), end: at(6, '17:30'), tz } },
      { type: 'task', id: 'planning:week:2026-11-16', fields: { kind: 'planning', title: 'Plan the week of Nov 16', plans: ['week:2026-11-16'], estimate_min: 30 } },
      // The next stretch's planning task, scheduled, and the minutes measured planning it.
      { type: 'task', id: 'planning:stretch:2027-01-01', fields: { kind: 'planning', title: 'Plan Jan 1 to Mar 31', plans: ['stretch:2027-01-01'], estimate_min: 45 } },
      { type: 'time_block', id: 'pb2', fields: { task_id: 'planning:stretch:2027-01-01', start: at(5, '17:00'), end: at(5, '17:45'), tz } },
      { type: 'settings', id: 'settings', fields: { stretch_planning: { start: '2027-01-01', started_at: at(4, '09:00'), min: 12, history: [40, 55] } } },
      // Planning begun and stopped part way, as the update measures it.
      { type: 'week_plan', id: 'week:2026-11-09', fields: { week_start: '2026-11-09', planning_min: 12, planning_started_at: at(4, '09:00') } },
      {
        type: 'task',
        id: 'planning:week:2026-10-26',
        fields: { kind: 'planning', title: 'Plan the week of Oct 26', plans: ['week:2026-10-26'], estimate_min: 30, deleted_at: at(2, '08:00') },
      },
    ];
    await openSeeded(page, [...week, ...planning]);
    await everyScreen(page);

    // It fails its trial. The bundle before shows the scheduled one on Week under its title, and lists none as work.
    page = await relaunch(page, 'old', errors);
    await everyScreen(page);
    await go(page, 'Week');
    await expect(pane(page, 'Week').getByRole('button', { name: /^Plan the week of Nov 9, Fri Nov 6, 5pm to 5:30pm/ })).toBeVisible();
    await expect(pane(page, 'Week').getByRole('button', { name: /^Plan Jan 1 to Mar 31, Thu Nov 5, 5pm to 5:45pm/ })).toBeVisible();
    for (const label of ['Inbox', 'One offs', 'Today']) {
      await go(page, label, /./);
      await expect(pane(page, label).getByText(/Plan the week of/)).toHaveCount(0);
    }

    // Updated again, nothing is lost.
    page = await relaunch(page, 'new', errors);
    await go(page, 'Week');
    await expect(pane(page, 'Week').getByRole('button', { name: /^Plan the week of Nov 9, Fri Nov 6, 5pm to 5:30pm/ })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('an Inbox item the update made a practice is a finished task in the bundle before, which can reopen it', async ({ context }) => {
    const errors: string[] = [];
    await context.addCookies([bundle('new')]);
    let page = await launch(context, 'new', errors);
    await openSeeded(page, week);
    const finished = () => pane(page, 'One offs').getByRole('region', { name: 'Finished tasks' });
    const openFinished = async () => {
      await go(page, 'One offs');
      await pane(page, 'One offs').getByRole('button', { name: 'Finished tasks' }).click();
    };

    // The update makes the item a practice from its card: it closes, with a link to the practice.
    await go(page, 'Inbox');
    await pane(page, 'Inbox').getByRole('button', { name: 'Assign Order more coffee beans' }).click();
    const card = page.getByRole('dialog', { name: 'Process Inbox' });
    await card.getByRole('button', { name: 'New practice from this item' }).click();
    await card.getByRole('form', { name: 'New practice' }).getByRole('textbox', { name: 'Name' }).fill('Brew coffee at home');
    await card.getByRole('button', { name: 'Make it a practice' }).click();
    await expect(page.locator('.toast')).toContainText('Order more coffee beans is now the practice Brew coffee at home.');
    await card.getByRole('button', { name: 'Exit' }).click();
    await openFinished();
    await expect(finished().getByRole('button', { name: 'Became the practice Brew coffee at home' })).toBeVisible();
    await everyScreen(page);

    // It fails its trial. The bundle before knows nothing of the link: the item is a finished task, out of the Inbox,
    // and unticking it there reopens it.
    page = await relaunch(page, 'old', errors);
    await everyScreen(page);
    await go(page, 'Inbox');
    await expect(pane(page, 'Inbox').getByText('Order more coffee beans')).toHaveCount(0);
    await openFinished();
    const box = finished().getByRole('checkbox', { name: 'Order more coffee beans done' });
    await expect(box).toBeChecked();
    await box.click();
    await expect(box).not.toBeChecked();

    // Updated again, the item is back in the Inbox, so neither finished nor linked, and the practice stays. One offs
    // may now show no Finished tasks at all, since it hides them when there are none.
    page = await relaunch(page, 'new', errors);
    await go(page, 'Inbox');
    await expect(pane(page, 'Inbox').getByText('Order more coffee beans')).toBeVisible();
    await go(page, 'Goals');
    await expect(pane(page, 'Goals').getByRole('button', { name: /Practices with no goal/ })).toContainText('1 practice');
    await everyScreen(page);
    expect(errors).toEqual([]);
  });

  test('something the update added to Done, with the time it took, is a finished one off in the bundle before, its block done on Week', async ({ context }) => {
    const errors: string[] = [];
    await context.addCookies([bundle('new')]);
    let page = await launch(context, 'new', errors);
    await openSeeded(page, week);
    await go(page, 'Done', 'Wednesday, Nov 4');
    const done = pane(page, 'Done');
    await done.getByRole('button', { name: 'Add something you did' }).click();
    const field = done.getByRole('textbox', { name: 'What you did' });
    await field.fill('Fixed the garden gate');
    const slider = done.getByRole('slider', { name: 'Time it took' });
    await slider.focus();
    for (let i = 0; i < 6; i++) await slider.press('ArrowRight');
    await field.press('Enter');
    await expect(page.locator('.toast')).toContainText('Added Fixed the garden gate to Done on Wednesday, Nov 4.');
    await everyScreen(page);

    // It fails its trial. The bundle before has no way to add one, and needs none to show it: an ordinary finished one
    // off, after a block that long answered Done.
    page = await relaunch(page, 'old', errors);
    await everyScreen(page);
    await go(page, 'One offs');
    await pane(page, 'One offs').getByRole('button', { name: 'Finished tasks' }).click();
    const finished = pane(page, 'One offs').getByRole('region', { name: 'Finished tasks' });
    await expect(finished.getByRole('checkbox', { name: 'Fixed the garden gate done' })).toBeChecked();
    await go(page, 'Week');
    await expect(pane(page, 'Week').getByRole('button', { name: /^Fixed the garden gate, Wed Nov 4, 9:50am to 10:20am/ })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('Inbox items the update saved as notes leave the bundle before\'s Inbox, unfinished, and its launch writes nothing to the notes', async ({ context }) => {
    const errors: string[] = [];
    await context.addCookies([bundle('new')]);
    let page = await launch(context, 'new', errors);
    await openSeeded(page, [...week, { type: 'attachment', id: 'att1', fields: { task_id: 'i1', kind: 'link', name: 'example.com', url: 'https://example.com/shops' } }]);

    // The update saves both items as notes from Process, the first on a project and shown on Today, the second on its
    // own, then deletes the second note.
    await go(page, 'Inbox');
    await pane(page, 'Inbox').getByRole('button', { name: 'Process 2 items' }).click();
    const card = page.getByRole('dialog', { name: 'Process Inbox' });
    await expect(card.getByRole('heading', { level: 1, name: 'Look up a bike repair shop' })).toBeVisible();
    await card.getByRole('button', { name: /Save as note$/ }).click();
    await card.getByRole('combobox', { name: 'Attach note to' }).fill('first draft');
    await page.keyboard.press('Enter');
    await expect(page.locator('.toast')).toContainText('Saved Look up a bike repair shop as a note on Finish the first draft.');
    await expect(card.getByRole('heading', { level: 1, name: 'Order more coffee beans' })).toBeVisible();
    await card.getByRole('button', { name: /Save as note$/ }).click();
    await card.getByRole('option', { name: 'On its own, In Notes, no home' }).click();
    await expect(page.locator('.toast')).toContainText('Saved Order more coffee beans in Notes.');
    // A one off finished now, so the bundle before has a finished task to list beside the notes' items. The week's
    // ladder, finished the day before, won't do: built for staging, both bundles keep a closed task 35 minutes
    // (config/retention.yaml), so the relaunch's expiry pass removes it, and One offs then hides Finished tasks.
    await tick(page, 'Renew the library card', errors);
    await go(page, 'Notes');
    await pane(page, 'Notes').getByRole('button', { name: /^Look up a bike repair shop/ }).click();
    await page.getByRole('dialog', { name: /^Note: / }).getByLabel(/Show it on Today on/).fill('2026-11-04');
    await page.getByRole('dialog', { name: /^Note: / }).getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('.toast')).toContainText('Saved Look up a bike repair shop.');
    await pane(page, 'Notes').getByRole('button', { name: /^Order more coffee beans/ }).click();
    await page.getByRole('dialog', { name: /^Note: / }).getByRole('button', { name: 'Delete note' }).click();
    await expect(page.locator('.toast')).toContainText('Deleted Order more coffee beans.');
    // A photo another device added to it offline, as the sweep leaves it: deleted with the note.
    const gone = (await readRecord(page, 'memo', 'note:i2'))?.deleted_at;
    await seed(page, [{ type: 'attachment', id: 'late', fields: { memo_id: 'note:i2', kind: 'photo', name: 'Beans.jpg', deleted_at: gone } }]);
    const ids = [['memo', 'note:i1'], ['memo', 'note:i2'], ['attachment', 'att1'], ['attachment', 'late'], ['task', 'i1'], ['task', 'i2']] as const;
    const before = await Promise.all(ids.map(([type, id]) => readRecord(page, type, id)));
    expect(before[0]).toMatchObject({ home: { type: 'project', id: 'p1' }, show_on: '2026-11-04' });
    expect(before[2]).toMatchObject({ memo_id: 'note:i1', task_id: null });
    expect(before[3]?.expires_at).toBeTruthy();
    await everyScreen(page);

    // It fails its trial. The bundle before shows neither item, in the Inbox or as finished, and its launch's expiry
    // pass leaves every note, attachment and item as the update wrote them, the swept photo's expiry included.
    page = await relaunch(page, 'old', errors);
    await everyScreen(page);
    await go(page, 'Inbox');
    for (const title of ['Look up a bike repair shop', 'Order more coffee beans']) await expect(pane(page, 'Inbox').getByText(title)).toHaveCount(0);
    await go(page, 'One offs');
    await pane(page, 'One offs').getByRole('button', { name: 'Finished tasks' }).click();
    const finished = pane(page, 'One offs').getByRole('region', { name: 'Finished tasks' });
    await expect(finished.getByText('Renew the library card')).toBeVisible();
    for (const title of ['Look up a bike repair shop', 'Order more coffee beans']) await expect(finished.getByText(title)).toHaveCount(0);
    expect(await Promise.all(ids.map(([type, id]) => readRecord(page, type, id)))).toEqual(before);
    expect(errors).toEqual([]);
  });

  test('a project task the update dated shows no date in the bundle before, which can edit it and keep the date', async ({ context }) => {
    const errors: string[] = [];
    await context.addCookies([bundle('new')]);
    let page = await launch(context, 'new', errors);
    const dated: Seed = {
      type: 'task',
      id: 'dated',
      fields: { kind: 'project', project_id: 'p1', milestone_id: 'm1', title: 'Order the cover proofs', estimate_min: 60, schedule: { type: 'once', from: '2026-11-27', to: null }, next_due: '2026-11-27' },
    };
    await openSeeded(page, [...week, dated]);
    // The update shows its date on the project page, warned as after its milestone.
    await openProject(page, false, 'Write a book', 'Finish the first draft');
    await expect(page.getByRole('button', { name: 'Edit task Order the cover proofs, Nov 27, 1h, due after Half the chapters (Nov 20)' })).toBeVisible();
    await everyScreen(page);

    // The bundle before reads no date on a project task, and its popup's Save keeps the one there.
    page = await relaunch(page, 'old', errors);
    await everyScreen(page);
    await openProject(page, false, 'Write a book', 'Finish the first draft');
    await page.getByRole('button', { name: /^Edit task Order the cover proofs/ }).click();
    const popup = page.locator('.sheet.taskpop');
    await popup.getByRole('button', { name: 'Rename Order the cover proofs' }).click();
    await popup.getByRole('textbox', { name: 'Name' }).fill('Order the cover proofs early');
    await popup.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Saved Order the cover proofs early.')).toBeVisible();

    page = await relaunch(page, 'new', errors);
    await openProject(page, false, 'Write a book', 'Finish the first draft');
    await expect(page.getByRole('button', { name: /^Edit task Order the cover proofs early, Nov 27, 1h/ })).toBeVisible();
    await everyScreen(page);
    expect(errors).toEqual([]);
  });

  test('practices on set days, a count and a time of their own on one day: the bundle before shows them, and its rename keeps them', async ({ context }) => {
    const errors: string[] = [];
    await context.addCookies([bundle('new')]);
    let page = await launch(context, 'new', errors);
    // As the update stores each: Monday, Tuesday, Thursday and Friday with Friday at 9:30 and this Thursday skipped,
    // and three 30-minute sessions a week.
    const irregular: Seed[] = [
      {
        type: 'practice',
        id: 'pr2',
        fields: { title: 'Morning run', target_min: 30, per: 'day', days: [0, 1, 3, 4], preferred_times: [420], day_times: [null, null, null, null, 570, null, null], state: 'active' },
      },
      { type: 'practice', id: 'pr3', fields: { title: 'Climbing', target_min: 90, per: 'week', sessions: 3, preferred_times: [1080], state: 'active' } },
      { type: 'week_plan', id: `week:${WEEK}`, fields: { skipped_sessions: ['pr2:2026-11-05'] } },
    ];
    await openSeeded(page, [...week, ...irregular]);
    const lane = () => pane(page, 'Week').getByRole('region', { name: 'To schedule' });
    const card = (title: string, line: string) => lane().getByRole('button', { name: `${title}, Practice, ${line}, to schedule` });
    // The count waits above the week. Of the set days, Thursday is skipped, and Friday's own 9:30 is its set time, so
    // the update has placed it there and nothing of the run waits.
    const expectUpdate = async () => {
      await go(page, 'Week');
      await expect(card('Climbing', '3 more this week, 30m each')).toBeVisible();
      await expect(pane(page, 'Week').getByRole('button', { name: /, Practice, 30 minutes on (Thursday|Friday)/ })).toHaveCount(0);
      expect(await readRecord(page, 'time_block', 'session:pr2:2026-11-06')).toMatchObject({ start: at(6, '09:30'), end: at(6, '10:00') });
    };
    await expectUpdate();
    await everyScreen(page);

    // It fails its trial. The bundle before plans them as it understands them, which depends on how old it is, so this
    // only asks that Week shows them with no errors. It renames the run.
    page = await relaunch(page, 'old', errors);
    await go(page, 'Week');
    await expect(pane(page, 'Week').getByText('Climbing').first()).toBeVisible();
    await expect(pane(page, 'Week').getByText('Morning run').first()).toBeVisible();
    await go(page, 'Goals');
    await pane(page, 'Goals').getByRole('button', { name: /^Practices with no goal/ }).click();
    await pane(page, 'Goals').getByRole('button', { name: /^Morning run/ }).click();
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Morning jog');
    // Editors that save on Save, once the bundle before has them.
    const save = page.getByRole('button', { name: 'Save', exact: true });
    if (await save.isVisible()) await save.click();
    await everyScreen(page);

    // Updated again, the days' own times, the count and the skip are all still there.
    page = await relaunch(page, 'new', errors);
    await expectUpdate();
    expect(await readRecord(page, 'practice', 'pr2')).toMatchObject({ title: 'Morning jog', day_times: [null, null, null, null, 570, null, null] });
    await everyScreen(page);
    expect(errors).toEqual([]);
  });

  test('the update places a practice at its set times; the bundle before shows them, takes one off and moves one, and the update leaves both', async ({ context }) => {
    const errors: string[] = [];
    await context.addCookies([bundle('new')]);
    let page = await launch(context, 'new', errors);
    // An evening run on Wednesday, Thursday and Saturday at 6pm: today's is still ahead.
    const run: Seed = { type: 'practice', id: 'run', fields: { title: 'Evening run', target_min: 30, per: 'day', days: [2, 3, 5], preferred_times: [1080], state: 'active' } };
    await openSeeded(page, [...week, run]);
    await expect(page.getByText('Placed 3 practice sessions at their set times this week.')).toBeVisible();
    const session = (date: string) => readRecord(page, 'time_block', `session:run:${date}`);
    expect(await session('2026-11-04')).toMatchObject({ start: at(4, '18:00'), end: at(4, '18:30') });

    // The bundle before shows them as placed, and takes today's off with its Skip this session.
    page = await relaunch(page, 'old', errors);
    await go(page, 'Week');
    await expect(pane(page, 'Week').getByText('Evening run').first()).toBeVisible();
    await go(page, 'Today');
    const today = pane(page, 'Today');
    await today.getByRole('button', { name: /^Evening run, 6pm to 6:30pm/ }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: /^(Skip this session|Take off calendar)$/ }).click();
    await expect.poll(async () => (await session('2026-11-04'))?.cancelled).toBe(true);
    // And moves Thursday's to Friday, keeping the day it's for in its id, as its Week does.
    await seed(page, [{ type: 'time_block', id: 'session:run:2026-11-05', fields: { start: at(6, '07:00'), end: at(6, '07:30') } }]);
    await everyScreen(page);

    // Updated again, it places nothing: today's stays off, Thursday's stays on Friday, and it says nothing.
    page = await relaunch(page, 'new', errors);
    await go(page, 'Week');
    await page.waitForTimeout(1000);
    await expect(page.getByText(/^Placed \d+ practice sessions/)).toHaveCount(0);
    expect((await session('2026-11-04'))?.cancelled).toBe(true);
    expect(await session('2026-11-05')).toMatchObject({ start: at(6, '07:00'), end: at(6, '07:30') });
    expect(await session('2026-11-06')).toBeUndefined();
    expect(await session('2026-11-07')).toMatchObject({ start: at(7, '18:00') });
    expect(errors).toEqual([]);
  });

  test("a one off's time of day: the bundle before keeps it through a change of date, and the update places it on the new day", async ({ context }) => {
    const errors: string[] = [];
    await context.addCookies([bundle('new')]);
    let page = await launch(context, 'new', errors);
    const passport: Seed = { type: 'task', id: 'pass', fields: { kind: 'one_off', title: 'Renew passport', estimate_min: 30, schedule: { type: 'once', from: '2026-11-05' }, next_due: '2026-11-05', time: 540 } };
    await openSeeded(page, [...week, passport]);
    await expect(page.getByText('Placed Renew passport at its set time, Thu 9am.')).toBeVisible();
    expect(await readRecord(page, 'time_block', 'due:pass:2026-11-05')).toMatchObject({ start: at(5, '09:00'), end: at(5, '09:30') });

    // The bundle before moves it to Friday with its own date control, which writes only the dates.
    page = await relaunch(page, 'old', errors);
    await go(page, 'One offs');
    await pane(page, 'One offs').getByRole('button', { name: 'Change date for Renew passport' }).click();
    await pane(page, 'One offs').getByLabel('Date', { exact: true }).fill('2026-11-06');
    await pane(page, 'One offs').getByRole('button', { name: 'Set date' }).click();
    await expect.poll(async () => ((await readRecord(page, 'task', 'pass'))?.schedule as { from?: string })?.from).toBe('2026-11-06');
    expect((await readRecord(page, 'task', 'pass'))?.time).toBe(540);
    await everyScreen(page);

    // Updated again, its time is still there, and it lands on Friday at it.
    page = await relaunch(page, 'new', errors);
    await go(page, 'One offs');
    await expect(pane(page, 'One offs').getByText('Nov 6, 9am, 30m')).toBeVisible();
    await expect.poll(async () => (await readRecord(page, 'time_block', 'due:pass:2026-11-06'))?.start).toBe(at(6, '09:00'));
    expect(errors).toEqual([]);
  });

  test("the weekly planning reminder's switch, off in the update, stays off when the bundle before changes another", async ({ context }) => {
    const errors: string[] = [];
    await context.addCookies([bundle('new')]);
    let page = await launch(context, 'new', errors);
    await openSeeded(page, week);
    await go(page, 'Settings');
    const weekly = () => pane(page, 'Settings').getByRole('checkbox', { name: "Remind me when next week's planning has no time" });
    await weekly().click();
    await expect(weekly()).not.toBeChecked();

    // The bundle before writes the reminders back whole when it changes one.
    page = await relaunch(page, 'old', errors);
    await go(page, 'Settings');
    await pane(page, 'Settings').getByRole('checkbox', { name: 'Ask at block end' }).click();
    await expect(pane(page, 'Settings').getByRole('checkbox', { name: 'Ask at block end' })).not.toBeChecked();

    page = await relaunch(page, 'new', errors);
    await go(page, 'Settings');
    await expect(weekly()).not.toBeChecked();
    await expect(pane(page, 'Settings').getByRole('checkbox', { name: 'Ask at block end' })).not.toBeChecked();
    expect(errors).toEqual([]);
  });

  test('planning ahead left on a step the bundle before lacks resumes there on its nearest, and the update follows a step it moved to', async ({ context }) => {
    test.skip(oldPlansToInbox(), noOlderThanInboxStep);
    const errors: string[] = [];
    await context.addCookies([bundle('new')]);
    let page = await launch(context, 'new', errors);
    await openSeeded(page, week);
    const steps = () => page.getByRole('navigation', { name: 'Planning steps' });
    const plan = async () => {
      await go(page, 'Plan');
      await pane(page, 'Plan')
        .getByRole('button', { name: /^(Continue planning|Plan now|Plan (the next|your first) stretch)$/ })
        .click();
    };
    // The update keeps planning's step on the device as a key, beside the number the bundle before reads.
    await plan();
    await steps().getByRole('button', { name: /Inbox/ }).click();
    await expect(page.getByRole('heading', { name: /Give each item a home$/ })).toBeVisible();
    await page.getByRole('button', { name: 'Save and exit' }).click();

    // The bundle before has no Inbox step, so it opens on Projects, the step before it, and moves on to Practices.
    page = await relaunch(page, 'old', errors);
    await plan();
    await expect(page.getByRole('heading', { name: /What will you reach by Dec 31\?$/ })).toBeVisible();
    await expect(steps().getByRole('button', { name: /Projects/ })).toHaveAttribute('aria-current', 'step');
    await steps().getByRole('button', { name: /Practices/ }).click();
    await expect(page.getByRole('heading', { name: /Your practices$/ })).toBeVisible();
    await page.getByRole('button', { name: 'Save and exit' }).click();

    // Updated again, it opens where the bundle before left it.
    page = await relaunch(page, 'new', errors);
    await plan();
    await expect(page.getByRole('heading', { name: /Your practices$/ })).toBeVisible();
    await expect(steps().getByRole('button', { name: /Practices/ })).toHaveAttribute('aria-current', 'step');
    expect(errors).toEqual([]);
  });

  test('a block the update paused runs on in the bundle before, which keeps the pause through a change of its own', async ({ context }) => {
    test.skip(oldPauses(), noOlderThanPausing);
    const errors: string[] = [];
    await context.addCookies([bundle('new')]);
    let page = await launch(context, 'new', errors);
    await openSeeded(page, week);
    const now = () => page.getByRole('region', { name: 'Current block' });
    await now().getByRole('button', { name: /^Pause, / }).click();
    await expect(now().getByText('Ends at 11:30am unless you resume.')).toBeVisible();

    // It fails its trial. The bundle before knows nothing of pauses, so the block reads as still running, and it
    // lengthens it from the timeline.
    page = await relaunch(page, 'old', errors);
    await expect(now().getByText('In progress, time left')).toBeVisible();
    await expect(now().getByRole('timer')).toBeVisible();
    await page.getByRole('button', { name: /^Draft chapter five, 10am to 11:30am/ }).focus();
    await page.keyboard.press('Shift+ArrowDown');
    await expect(page.getByRole('button', { name: /^Draft chapter five, 10am to 11:45am/ })).toBeVisible();

    // Updated again, the block is still paused, and ends where the old bundle put it.
    page = await relaunch(page, 'new', errors);
    await expect(now().getByRole('button', { name: /^Resume, / })).toBeVisible();
    await expect(now().getByText('Ends at 11:45am unless you resume.')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('a project one bundle finished or paused, the other restores with its tasks or resumes with its dates moved', async ({ context }) => {
    test.setTimeout(240_000);
    const errors: string[] = [];
    const { titles, records } = house('', { start: '2026-10-01', end: '2026-12-31', due: '2026-12-20' });
    await context.addCookies([bundle('old')]);
    let page = await launch(context, 'old', errors);
    await openSeeded(page, records);
    await finishFence(page, titles);
    await pauseShed(page, titles, 'Pause');

    // The fence comes back on the same day each time: a finished project is removed once the closed period has passed,
    // which on a staging build is minutes.
    page = await relaunch(page, 'new', errors);
    await restoreFence(page, titles);
    await finishFence(page, titles);
    page = await relaunch(page, 'old', errors);
    await restoreFence(page, titles);

    // Two weeks on, the update resumes the shed, moving its end by the two weeks.
    page = await relaunch(page, 'new', errors, 14);
    await pauseShed(page, titles, 'Resume', '2027-01-14');
    await pauseShed(page, titles, 'Pause');

    // It fails its trial two weeks later, and the old bundle resumes what the update paused.
    page = await relaunch(page, 'old', errors, 28);
    await pauseShed(page, titles, 'Resume', '2027-01-28');
    await pauseShed(page, titles, 'Pause');

    // Updated again two weeks on, it counts that pause from the old bundle's, not its own from before.
    page = await relaunch(page, 'new', errors, 42);
    await pauseShed(page, titles, 'Resume', '2027-02-11');
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

test('an old and a new device of one user: a block the new one paused runs on in the old, which keeps the pause through its own change', async ({
  browser,
}) => {
  test.skip(oldPauses(), noOlderThanPausing);
  const run = randomUUID().slice(0, 8);
  const title = `Fix the gate ${run}`;
  const ids = { task: `e2e-${run}-gate`, block: `e2e-${run}-gate-block` };
  // Started on the minute, so the block is today's for the run's few minutes.
  const start = Math.floor(Date.now() / 60_000) * 60_000;
  // The block runs an hour, and the bundle before can't move one that runs past the day's end.
  const midnight = new Date(start);
  midnight.setHours(24, 0, 0, 0);
  test.skip(midnight.getTime() - start < 70 * 60_000, 'needs: an hour of the day left');
  live = { run, ...ids };
  const iso = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z');
  const oldDevice = await device(browser, `e2e-${run}`, on('old'));
  const newDevice = await device(browser, `e2e-${run}`, on('new'));
  consoleErrors(oldDevice.page, oldDevice.errors, 'old');
  consoleErrors(newDevice.page, newDevice.errors, 'new');
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  await seed(oldDevice.page, [
    { type: 'task', id: ids.task, fields: { kind: 'one_off', title, schedule: { type: 'once' } } },
    { type: 'time_block', id: ids.block, fields: { task_id: ids.task, start: iso(start), end: iso(start + 60 * 60_000), tz, started_at: iso(start) } },
  ]);
  await signIn(oldDevice.page);
  await signIn(newDevice.page);
  for (const d of [oldDevice, newDevice]) await syncNow(d.page);
  const now = (d: typeof oldDevice) => d.page.getByRole('region', { name: 'Current block' });
  // Today, past the prompt to plan the week, which only this device remembers skipping.
  const today = async (d: typeof oldDevice) => {
    await go(d.page, 'Today', /^(Today|Plan your week)$/);
    const skip = pane(d.page, 'Today').getByRole('button', { name: /^Skip (for now|planning this week)$/ });
    if (await skip.count()) await skip.click();
    await expect(pane(d.page, 'Today').getByRole('heading', { name: 'Today', level: 1 })).toBeVisible();
  };

  await today(newDevice);
  await now(newDevice).getByRole('button', { name: /^Pause, / }).click();
  const ends = now(newDevice).getByText(/^Ends at .* unless you resume\.$/);
  await expect(ends).toBeVisible();
  const endedAt = await ends.textContent();
  await syncNow(newDevice.page);
  await syncNow(oldDevice.page);

  // The old device knows nothing of pauses: the block reads as still running, and it shortens it from the timeline.
  // Shortens, since the block runs an hour from now, and late in the evening it couldn't be lengthened past the day's end.
  await today(oldDevice);
  await expect(now(oldDevice).getByText('In progress, time left')).toBeVisible();
  await expect(now(oldDevice).getByRole('timer')).toBeVisible();
  // Checked by the block's times rather than a toast, which older bundles don't show for this.
  const block = oldDevice.page.getByRole('button', { name: new RegExp(`^${title}, `) });
  const before = await block.textContent();
  await block.focus();
  await oldDevice.page.keyboard.press('Shift+ArrowUp');
  await expect(block).not.toHaveText(before!);
  await syncNow(oldDevice.page);
  await syncNow(newDevice.page);

  // The new device still has it paused, ending where the old one put it.
  await today(newDevice);
  await expect(now(newDevice).getByRole('button', { name: /^Resume, / })).toBeVisible();
  await expect(ends).not.toHaveText(endedAt!);

  // Nothing stays live for a deployment's test user.
  const gone = new Date().toISOString();
  await seed(oldDevice.page, [
    { type: 'time_block', id: ids.block, fields: { deleted_at: gone } },
    { type: 'task', id: ids.task, fields: { deleted_at: gone } },
  ]);
  await syncNow(oldDevice.page);
  await expect(account(oldDevice.page).getByText('Synced', { exact: true })).toBeVisible();
  live = null;
  expect(oldDevice.errors).toEqual([]);
  expect(newDevice.errors).toEqual([]);
});

test('an old and a new device of one user restore and resume a project the other finished or paused', async ({ browser }) => {
  test.setTimeout(240_000);
  const run = ` ${randomUUID().slice(0, 8)}`;
  const dates = { start: daysAhead(-30), end: daysAhead(60), due: daysAhead(30) };
  const { titles, records } = house(run, dates);
  const oldDevice = await device(browser, `e2e-${run.trim()}`, on('old'));
  const newDevice = await device(browser, `e2e-${run.trim()}`, on('new'));
  consoleErrors(oldDevice.page, oldDevice.errors, 'old');
  consoleErrors(newDevice.page, newDevice.errors, 'new');
  await seed(oldDevice.page, records);
  await signIn(oldDevice.page);
  await signIn(newDevice.page);

  // Each closes and pauses, and the other brings both back. Both happen today, so resuming moves no dates.
  for (const [from, to] of [
    [oldDevice, newDevice],
    [newDevice, oldDevice],
  ] as const) {
    await finishFence(from.page, titles);
    await pauseShed(from.page, titles, 'Pause');
    await syncNow(from.page);
    await syncNow(to.page);
    await restoreFence(to.page, titles);
    await pauseShed(to.page, titles, 'Resume', dates.end);
    await syncNow(to.page);
    await syncNow(from.page);
  }

  // A deployment's test user keeps nothing live.
  const now = new Date().toISOString();
  await seed(oldDevice.page, records.map(({ type, id }) => ({ type, id, fields: { deleted_at: now } })));
  await syncNow(oldDevice.page);
  await expect(account(oldDevice.page).getByText('Synced', { exact: true })).toBeVisible();

  expect(oldDevice.errors).toEqual([]);
  expect(newDevice.errors).toEqual([]);
});

// The last release has no descriptions. It keeps the field all the same, and its edits to the task leave it alone,
// since each field merges on its own.
test('an old device changing a task keeps the description a new device wrote', async ({ browser }) => {
  test.setTimeout(180_000);
  const run = randomUUID().slice(0, 8);
  const id = `e2e-${run}-garage`;
  const title = `Tidy the garage ${run}`;
  const oldDevice = await device(browser, `e2e-${run}`, on('old'));
  const newDevice = await device(browser, `e2e-${run}`, on('new'));
  consoleErrors(oldDevice.page, oldDevice.errors, 'old');
  consoleErrors(newDevice.page, newDevice.errors, 'new');
  await seed(newDevice.page, [oneOff(id, title)]);
  await signIn(oldDevice.page);
  await signIn(newDevice.page);

  const describeTask = async (expectShown?: string) => {
    await go(newDevice.page, 'One offs');
    // Its name opens its popup; once described, the name also says it has details.
    await pane(newDevice.page, 'One offs').getByRole('button', { name: new RegExp(`^${title}`) }).click();
    const form = newDevice.page.getByRole('dialog', { name: title });
    if (expectShown) {
      await expect(form.getByRole('group', { name: 'Description' }).locator('strong')).toHaveText(expectShown);
      await form.getByRole('button', { name: 'Cancel' }).click();
      return;
    }
    await form.getByLabel('Description').fill('Start with the **tools**');
    await form.getByRole('button', { name: 'Save' }).click();
    await expect(form).toHaveCount(0);
  };
  await describeTask();
  await syncNow(newDevice.page);
  await syncNow(oldDevice.page);
  const date = daysAhead(10);
  await setDate(oldDevice.page, title, date);
  await syncNow(oldDevice.page);
  await syncNow(newDevice.page);
  await go(newDevice.page, 'One offs');
  await expect(dated(newDevice.page, title, date)).toBeVisible();
  await describeTask('tools');

  // A deployment's test user keeps nothing live.
  await seed(oldDevice.page, [{ type: 'task', id, fields: { deleted_at: new Date().toISOString() } }]);
  await syncNow(oldDevice.page);
  await expect(account(oldDevice.page).getByText('Synced', { exact: true })).toBeVisible();

  expect(oldDevice.errors).toEqual([]);
  expect(newDevice.errors).toEqual([]);
});

// The last release has no attachments. It keeps their records without showing them, and its edits to their task leave
// them alone.
test('an old device changing a task keeps the attachments a new device added', async ({ browser }) => {
  test.setTimeout(180_000);
  const run = randomUUID().slice(0, 8);
  const id = `e2e-${run}-shed`;
  const title = `Clear the shed ${run}`;
  const oldDevice = await device(browser, `e2e-${run}`, on('old'));
  const newDevice = await device(browser, `e2e-${run}`, on('new'));
  consoleErrors(oldDevice.page, oldDevice.errors, 'old');
  consoleErrors(newDevice.page, newDevice.errors, 'new');
  await seed(newDevice.page, [oneOff(id, title)]);
  await signIn(oldDevice.page);
  await signIn(newDevice.page);

  const openPopup = async () => {
    await go(newDevice.page, 'One offs');
    await pane(newDevice.page, 'One offs').getByRole('button', { name: title, exact: true }).click();
    return newDevice.page.locator(`.sheet.taskpop[aria-label="${title}"]`);
  };
  let popup = await openPopup();
  await popup.getByRole('button', { name: 'Add link' }).click();
  await popup.getByRole('textbox', { name: 'Address' }).fill('https://example.com/skip-hire');
  await popup.getByRole('button', { name: 'Add link' }).click();
  await expect(popup.getByRole('link', { name: 'example.com' })).toBeVisible();
  await newDevice.page.keyboard.press('Escape');
  await syncNow(newDevice.page);
  await syncNow(oldDevice.page);

  const date = daysAhead(12);
  await setDate(oldDevice.page, title, date);
  await syncNow(oldDevice.page);
  await syncNow(newDevice.page);
  await go(newDevice.page, 'One offs');
  await expect(dated(newDevice.page, title, date)).toBeVisible();
  popup = await openPopup();
  await expect(popup.getByRole('link', { name: 'example.com' })).toHaveAttribute('href', 'https://example.com/skip-hire');
  await newDevice.page.keyboard.press('Escape');

  // A deployment's test user keeps nothing live.
  await seed(oldDevice.page, [{ type: 'task', id, fields: { deleted_at: new Date().toISOString() } }]);
  await syncNow(oldDevice.page);
  await expect(account(oldDevice.page).getByText('Synced', { exact: true })).toBeVisible();

  expect(oldDevice.errors).toEqual([]);
  expect(newDevice.errors).toEqual([]);
});

test('an old and a new device of one user: planning begun on the new one is no trouble to the old, which finishes it, and the new one then has nothing to continue', async ({
  browser,
}) => {
  // On staging's shared test user, planning may be under way from a run cut short and the stretch planned already, so
  // the new device starts from Goals either way, and the old one finishes the plan again.
  const run = randomUUID().slice(0, 8);
  const oldDevice = await device(browser, `e2e-${run}`, on('old'));
  const newDevice = await device(browser, `e2e-${run}`, on('new'));
  consoleErrors(oldDevice.page, oldDevice.errors, 'old');
  consoleErrors(newDevice.page, newDevice.errors, 'new');
  await signIn(oldDevice.page);
  await signIn(newDevice.page);
  const plan = async (page: Page, name: RegExp) => {
    await go(page, 'Plan');
    await pane(page, 'Plan').getByRole('button', { name }).click();
  };

  // The new device begins planning and shares how far it got, a field the old one doesn't know.
  const cta = /^(Continue planning|Plan (now|the next stretch|your first stretch|without a cadence))$/;
  await plan(newDevice.page, cta);
  await newDevice.page.getByRole('navigation', { name: 'Planning steps' }).getByRole('button', { name: /Goals/ }).click();
  await newDevice.page.getByRole('button', { name: /^(Goals look right|Continue without goals)$/ }).click();
  await expect(newDevice.page.getByRole('heading', { name: /^Step \d of \d, Practices\./ })).toBeVisible();
  await newDevice.page.getByRole('button', { name: 'Save and exit' }).click();
  for (const d of [newDevice, oldDevice]) await syncNow(d.page);

  // The old device plans and finishes as it always has.
  await plan(oldDevice.page, cta);
  await oldDevice.page.getByRole('navigation', { name: 'Planning steps' }).getByRole('button', { name: /Finish/ }).click();
  await oldDevice.page.getByRole('button', { name: 'Finish', exact: true }).click();
  await expect(oldDevice.page.getByText(/^Your plan for .* is set\.$/)).toBeVisible();
  for (const d of [oldDevice, newDevice]) await syncNow(d.page);

  // On the new device, that plan is done: nothing to continue.
  await go(newDevice.page, 'Plan');
  await expect(pane(newDevice.page, 'Plan').getByRole('button', { name: 'Continue planning' })).toHaveCount(0);
  expect(oldDevice.errors).toEqual([]);
  expect(newDevice.errors).toEqual([]);
});

test("an old device whose account a new device deleted shows it's signed out, or erases its copy if it knows how", async ({ browser }) => {
  test.skip(!target().localApi, 'Deleting an account needs a user only the local stack can make');
  const run = randomUUID().slice(0, 8);
  const paint = { id: `e2e-${run}-paint`, title: `Paint the fence ${run}` };
  const old = await device(browser, `e2e-${run}`, on('old'));
  await seed(old.page, [oneOff(paint.id, paint.title)]);
  await signIn(old.page);
  const fresh = await device(browser, `e2e-${run}`, on('new'));
  await signIn(fresh.page);
  await deleteAccount(fresh.page);
  // At its next launch the bundle before's sync is refused, and so is its refresh, since the sign-in is gone. A launch
  // rather than Sync now, since a sync of its own may have reached that already.
  await old.page.reload();
  if (oldErasesDeletedAccounts()) {
    // A bundle from since account deletion erases its copy and starts over, saying why.
    await expect(old.page.getByText(DELETED)).toBeVisible();
    expect(await readRecord(old.page, 'task', paint.id)).toBeUndefined();
  } else {
    // One from before shows it's signed out.
    await go(old.page, 'Settings');
    await expect(account(old.page).getByText('Signed out', { exact: true })).toBeVisible();
  }
  expect(old.errors).toEqual([]);
});

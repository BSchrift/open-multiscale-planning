// Two real app instances, each with its own data folder, signed in as one user on the local stack that scripts/e2e.sh
// starts and names in LOCAL_API_URL. Sign-in takes the app's real path: the page asks the main process to open the
// system browser, and the test plays the browser, following the sign-in page's redirect and handing the app the link
// it returns, as macOS would.

import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { account, go, oneOffRow, pane, setDate, syncNow } from '../../e2e/seed';
import { addDays, formatDate, formatTimeOfDay, formatWeekday, localDate, localToInstant, localToMs, toInstant, weekStart } from '../../src/core/dates';
import { outcomeId, weekPlanId } from '../../src/core/records';
import type { ElectronBridge } from '../bridge';

declare global {
  var browserUrls: string[];
  var shownReminders: Electron.Notification[];
}

const ROOT = join(import.meta.dirname, '../..');
const KEYCHAIN = process.platform === 'linux' ? ['-r', join(import.meta.dirname, 'linux-keychain.cjs')] : [];
const API = process.env.LOCAL_API_URL ?? '';

test.skip(!API, 'needs: the local stack. make test-e2e starts one and builds the app for it.');
test.describe.configure({ timeout: 150_000 });

interface Device {
  app: ElectronApplication;
  page: Page;
  dir: string;
  errors: string[];
}

const running: Device[] = [];
const dirs: string[] = [];

test.afterEach(async () => {
  for (const d of running.splice(0)) await d.app.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Starts the app on a data folder: a new one is a first run, the same one again is a restart. */
async function launch(dir = mkdtempSync(join(tmpdir(), 'multiscale-sync-'))): Promise<Device> {
  if (!dirs.includes(dir)) dirs.push(dir);
  const app = await electron.launch({
    // The mock keychain keeps an unattended run from stopping at a keychain prompt. Linux has none, see linux-keychain.cjs.
    args: [...KEYCHAIN, ROOT, `--user-data-dir=${dir}`, '--use-mock-keychain'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
  });
  // The system browser is the one thing stood in for: signIn plays it.
  await app.evaluate(({ shell }) => {
    globalThis.browserUrls = [];
    shell.openExternal = async (url: string) => void globalThis.browserUrls.push(url);
  });
  const page = await app.firstWindow();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForFunction(() => document.getElementById('root')?.childElementCount);
  const device = { app, page, dir, errors };
  running.push(device);
  return device;
}

async function quit(d: Device) {
  running.splice(running.indexOf(d), 1);
  await d.app.close();
}

/** Opens the sign-in page the app asked the browser for, where the local stand-in signs `user` straight in, and hands the app the link it redirects to. */
async function signIn(d: Device, user: string, button: Locator) {
  await button.click();
  await expect.poll(() => d.app.evaluate(() => globalThis.browserUrls.length)).toBe(1);
  const url = await d.app.evaluate(() => globalThis.browserUrls.pop()!);
  expect(url.startsWith(`${API}/cognito/oauth2/authorize?`)).toBe(true);
  const res = await fetch(`${url}&username=${encodeURIComponent(user)}`, { redirect: 'manual' });
  const link = res.headers.get('location') ?? '';
  expect(link).toMatch(/^multiscale-local:\/\/auth\/callback\?/);
  await d.app.evaluate(({ app }, u) => void app.emit('open-url', { preventDefault: () => undefined }, u), link);
}

/** The first device: signs in on the first setup step, then finishes setup, with a first thought if given. */
async function firstRun(d: Device, user: string, thought?: string) {
  const { page } = d;
  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();
  await signIn(d, user, page.getByRole('button', { name: 'Sign in' }));
  await expect(page.getByText('Signed in', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByRole('heading', { name: 'Google Calendar' })).toBeVisible();
  await page.getByRole('button', { name: 'Skip' }).click();
  await expect(page.getByRole('heading', { name: 'Unavailable hours' })).toBeVisible();
  await page.getByRole('button', { name: 'Next' }).click();
  if (thought) {
    await page.getByRole('textbox', { name: 'A goal or a thought' }).fill(thought);
    await page.getByRole('button', { name: 'Capture' }).click();
  } else {
    await page.getByRole('button', { name: 'Skip' }).click();
  }
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
}

/** Another device, once the first has synced: signing in brings down the finished setup, so it goes into the app. */
async function joinRun(d: Device, user: string) {
  await expect(d.page.getByRole('heading', { name: 'Welcome' })).toBeVisible();
  await signIn(d, user, d.page.getByRole('button', { name: 'Sign in' }));
  await expect(d.page.getByRole('navigation', { name: 'Main' })).toBeVisible();
}

async function expectSynced(page: Page) {
  await syncNow(page);
  await expect(account(page).getByText('Synced', { exact: true })).toBeVisible();
}

/** Through the global shortcut's path: the event its callback sends, then the one-field window, which the app makes
 * hidden at startup so the shortcut shows it rather than opening one. */
async function captureByShortcut(d: Device, title: string) {
  const isCapture = (w: Page) => w.url().endsWith('capture.html');
  await expect.poll(() => d.app.windows().some(isCapture)).toBe(true);
  await d.app.evaluate(({ app }) => void app.emit('capture-shortcut'));
  const field = d.app.windows().find(isCapture)!.getByRole('textbox', { name: 'Capture' });
  await expect(field).toBeFocused();
  await field.fill(title);
  await field.press('Enter');
  await expect.poll(() => d.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.isVisible()).length)).toBe(1);
}

const record = (d: Device, id: string) =>
  d.page.evaluate(async (recordId) => {
    const rows = await (window.multiscaleElectron as ElectronBridge).db.all('SELECT data FROM records WHERE id = ?', [recordId]);
    return rows[0] ? (JSON.parse(rows[0].data as string) as Record<string, unknown>) : null;
  }, id);

const idOf = async (d: Device, title: string) =>
  d.page.evaluate(async (t) => {
    const rows = await (window.multiscaleElectron as ElectronBridge).db.all('SELECT id FROM task WHERE title = ?', [t]);
    return rows[0]?.id as string;
  }, title);

/** Writes records as a third device of the same user would, through the sync API with this device's token. */
async function push(d: Device, records: { type: string; id: string; fields: Record<string, unknown> }[]) {
  const stored = await d.page.evaluate(() => (window.multiscaleElectron as ElectronBridge).tokens.get('auth.session'));
  const { access_token } = JSON.parse(stored!) as { access_token: string };
  const clock = `${Date.now()}-000000-e2e-seed`;
  const changes = records.map(({ type, id, fields }) => ({
    type,
    id,
    fields: Object.fromEntries(Object.entries(fields).map(([name, v]) => [name, { v, c: clock }])),
  }));
  const res = await fetch(`${API}/sync`, {
    method: 'POST',
    headers: { authorization: `Bearer ${access_token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ cursor: 0, changes }),
  });
  expect(res.status).toBe(200);
}

const blockApi = (d: Device) => d.app.context().route((url) => url.href.startsWith(API), (route) => route.abort('internetdisconnected'));

async function addOneOff(page: Page, title: string) {
  await go(page, 'One offs');
  const form = pane(page, 'One offs').getByRole('form', { name: 'Add a one off' });
  await form.getByLabel('Title').fill(title);
  await form.getByRole('button', { name: 'Add one off' }).click();
  await expect(oneOffRow(page, title)).toBeVisible();
}

const zoneOf = (d: Device) => d.page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);

test('what one device enters reaches the other, offline edits converge, and a restart keeps data and sign-in', async () => {
  const run = randomUUID().slice(0, 8);
  const user = `e2e-${run}`;
  const bread = `Learn to bake bread ${run}`;
  const report = `Write the report ${run}`;
  const fence = `Paint the fence ${run}`;
  const hinges = `Oil the hinges ${run}`;
  const boards = `Sand the boards ${run}`;

  // The first device's setup capture reaches the second, whose setup is then already done.
  const a = await launch();
  await firstRun(a, user, bread);
  await expectSynced(a.page);
  const b = await launch();
  await joinRun(b, user);
  await go(b.page, 'Inbox');
  await expect(pane(b.page, 'Inbox').getByText(bread)).toBeVisible();

  // The shortcut's capture window on one lands in the other's Inbox.
  expect(await a.app.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('Shift+Command+Space'))).toBe(true);
  await captureByShortcut(a, report);
  await expectSynced(a.page);
  await expectSynced(b.page);
  await go(b.page, 'Inbox');
  await expect(pane(b.page, 'Inbox').getByText(report)).toBeVisible();

  // Both edit with the API out of reach, then converge: one field edited on both goes to the later edit, and
  // different fields of one record both stay.
  await addOneOff(a.page, fence);
  await addOneOff(a.page, hinges);
  await expectSynced(a.page);
  await expectSynced(b.page);
  for (const d of [a, b]) await blockApi(d);
  const soon = addDays(localDate(Date.now(), await zoneOf(a)), 10);
  const later = addDays(soon, 10);
  await setDate(a.page, fence, soon);
  await setDate(a.page, hinges, soon);
  await setDate(b.page, fence, later);
  await go(b.page, 'One offs');
  // Done today, it waits behind Show completed.
  await oneOffRow(b.page, hinges).getByRole('checkbox', { name: `${hinges} done` }).click();
  await expect(pane(b.page, 'One offs').getByRole('button', { name: 'Show 1 completed in One offs' })).toBeVisible();
  await syncNow(a.page);
  await expect(account(a.page).getByText('Offline', { exact: true })).toBeVisible();

  for (const d of [a, b]) await d.app.context().unrouteAll();
  for (const d of [a, b, a]) await expectSynced(d.page);
  const fenceId = await idOf(a, fence);
  const hingesId = await idOf(a, hinges);
  for (const d of [a, b]) {
    await go(d.page, 'One offs');
    await expect(oneOffRow(d.page, fence)).toContainText(`${formatDate(later)}, `);
    await pane(d.page, 'One offs').getByRole('button', { name: 'Show 1 completed in One offs' }).click();
    await expect(oneOffRow(d.page, hinges).getByRole('checkbox', { name: `${hinges} done` })).toBeChecked();
    expect((await record(d, fenceId))!.schedule).toMatchObject({ type: 'once', from: later });
    expect((await record(d, hingesId))!.schedule).toMatchObject({ type: 'once', from: soon });
    expect((await record(d, hingesId))!.done_at).toEqual(expect.any(String));
  }
  expect(await record(b, fenceId)).toEqual(await record(a, fenceId));
  expect(await record(b, hingesId)).toEqual(await record(a, hingesId));

  // A restart keeps the data, and the sign-in, whose tokens are on disk only encrypted.
  const { access_token } = JSON.parse((await a.page.evaluate(() => (window.multiscaleElectron as ElectronBridge).tokens.get('auth.session')))!) as { access_token: string };
  await quit(a);
  expect(readFileSync(join(a.dir, 'tokens.json'), 'utf8')).not.toContain(access_token);
  const again = await launch(a.dir);
  await expect(again.page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  await go(again.page, 'Inbox');
  await expect(pane(again.page, 'Inbox').getByText(report)).toBeVisible();
  await captureByShortcut(b, boards);
  await expectSynced(b.page);
  await expectSynced(again.page);
  await go(again.page, 'Inbox');
  await expect(pane(again.page, 'Inbox').getByText(boards)).toBeVisible();

  expect(a.errors).toEqual([]);
  expect(b.errors).toEqual([]);
  expect(again.errors).toEqual([]);
});

test('dragging and resizing a block on the Week grid moves it on the other device, on the 15-minute grid', async () => {
  const run = randomUUID().slice(0, 8);
  const user = `e2e-${run}`;
  const title = `Paint the fence ${run}`;
  const a = await launch();
  await firstRun(a, user);
  await expectSynced(a.page);
  const b = await launch();
  await joinRun(b, user);

  const zone = await zoneOf(a);
  const monday = weekStart(localDate(Date.now(), zone));
  const [wednesday, thursday] = [addDays(monday, 2), addDays(monday, 3)];
  const [taskId, blockId] = [`e2e-${run}-task`, `e2e-${run}-block`];
  await push(a, [
    // Planned, so Week offers Edit rather than asking to plan.
    { type: 'week_plan', id: `week:${monday}`, fields: { week_start: monday, finished_at: localToInstant(monday, 60, zone) } },
    { type: 'task', id: taskId, fields: { kind: 'one_off', title, schedule: { type: 'once' }, estimate_min: 60 } },
    { type: 'time_block', id: blockId, fields: { task_id: taskId, start: localToInstant(wednesday, 10 * 60, zone), end: localToInstant(wednesday, 11 * 60, zone), tz: zone } },
  ]);
  // The week's past is locked, so this device's clock starts the week, leaving every day free to drag on whatever day
  // the test runs. It stays behind the server's, which refuses edits from the future.
  await a.app.context().clock.install({ time: Math.min(Date.now(), localToMs(monday, 1, zone)) });
  await expectSynced(a.page);

  await go(a.page, 'Week', 'This week');
  await a.page.getByRole('button', { name: "Edit this week's plan" }).click();
  const block = a.page.getByRole('group', { name: new RegExp(`^${title}, `) });
  await block.scrollIntoViewIfNeeded();
  const box = (await block.boundingBox())!;
  const column = (await a.page.locator('.colbody').first().boundingBox())!;
  // One column right, and 47px down at 40px an hour: 70.5 minutes, which the grid makes 75.
  const [x, y] = [box.x + box.width / 2, box.y + 8];
  await a.page.mouse.move(x, y);
  await a.page.mouse.down();
  await a.page.mouse.move(x + column.width / 2, y + 20, { steps: 4 });
  await a.page.mouse.move(x + column.width + 2, y + 47, { steps: 4 });
  await a.page.mouse.up();
  const said = (date: string, start: number, end: number) => `${title}, ${formatWeekday(date)} ${formatDate(date)}, ${formatTimeOfDay(start)} to ${formatTimeOfDay(end)}, One off.`;
  await expect(a.page.getByRole('group', { name: said(thursday, 11 * 60 + 15, 12 * 60 + 15), exact: false })).toBeVisible();

  // 22px off the bottom edge is 33 minutes, which the grid makes 30.
  const edge = (await block.locator('.evh').boundingBox())!;
  await a.page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2);
  await a.page.mouse.down();
  await a.page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2 + 22, { steps: 4 });
  await a.page.mouse.up();
  await expect(a.page.getByRole('group', { name: said(thursday, 11 * 60 + 15, 12 * 60 + 45), exact: false })).toBeVisible();

  await expectSynced(a.page);
  await expectSynced(b.page);
  await go(b.page, 'Week', 'This week');
  await expect(pane(b.page, 'Week').getByRole('button', { name: said(thursday, 11 * 60 + 15, 12 * 60 + 45), exact: false })).toBeVisible();
  const moved = await record(b, blockId);
  expect(moved).toMatchObject({ start: localToInstant(thursday, 11 * 60 + 15, zone), end: localToInstant(thursday, 12 * 60 + 45, zone) });
  expect(moved).toEqual(await record(a, blockId));

  expect(a.errors).toEqual([]);
  expect(b.errors).toEqual([]);
});

test("a reminder for a block near now is scheduled, and its Not done writes what the in-app prompt's Not done writes", async () => {
  const run = randomUUID().slice(0, 8);
  const a = await launch();
  await firstRun(a, `e2e-${run}`);
  await a.app.evaluate(({ Notification }) => {
    globalThis.shownReminders = [];
    // Shared by every notification, so the main process's own are recorded too.
    const shared = (new Notification({ title: '' }) as unknown as { __proto__: Electron.Notification }).__proto__;
    const show = shared.show;
    shared.show = function (this: Electron.Notification) {
      globalThis.shownReminders.push(this);
      show.call(this);
    };
  });

  // One block ended a moment ago, which Today asks about, and one ends soon, which a notification will ask about.
  const zone = await zoneOf(a);
  const now = Date.now();
  const monday = weekStart(localDate(now, zone));
  const ended = { task: `e2e-${run}-swept`, block: `e2e-${run}-sweep` };
  const ending = { task: `e2e-${run}-watered`, block: `e2e-${run}-water` };
  const endsAt = toInstant(now + 45_000);
  const work = (ids: typeof ended, title: string, start: number, end: string) => [
    { type: 'task', id: ids.task, fields: { kind: 'one_off', title, schedule: { type: 'once' }, estimate_min: 30 } },
    { type: 'time_block', id: ids.block, fields: { task_id: ids.task, start: toInstant(start), end, tz: zone } },
  ];
  await push(a, [
    // A planned week, so Today opens on the day rather than on planning.
    { type: 'week_plan', id: weekPlanId(monday), fields: { week_start: monday, finished_at: toInstant(now) } },
    ...work(ended, `Sweep the porch ${run}`, now - 60 * 60_000, toInstant(now - 2 * 60_000)),
    ...work(ending, `Water the plants ${run}`, now - 30 * 60_000, endsAt),
  ]);
  await expectSynced(a.page);

  // Scheduled in the main process, for the block's end.
  const scheduled = () => a.page.evaluate(() => (window.multiscaleElectron as ElectronBridge).notifications.scheduled());
  await expect.poll(async () => (await scheduled()).map((r) => `${r.block_id} ${r.kind} ${r.at}`)).toContain(`${ending.block} block_end ${endsAt}`);

  await go(a.page, 'Today', /./);
  const prompt = a.page.getByRole('dialog', { name: 'Block finished' });
  await expect(prompt.getByText(`Sweep the porch ${run}`)).toBeVisible();
  await prompt.getByRole('button', { name: 'Not done', exact: true }).click();
  await expect.poll(() => record(a, outcomeId(ended.block))).toMatchObject({ result: 'not' });

  // The notification offers no Done, since a task finishes only in the app. Not done is its third button.
  await expect
    .poll(() => a.app.evaluate(() => globalThis.shownReminders.map((n) => `${n.title}: ${n.body}`)), { timeout: 90_000 })
    .toContain(`Block ended: Did you finish Water the plants ${run}?`);
  expect(await a.app.evaluate(() => globalThis.shownReminders.at(-1)!.actions.map((action) => action.text))).toEqual(['Still going', 'Partly', 'Not done']);
  await a.app.evaluate(() => void globalThis.shownReminders.at(-1)!.emit('action', {}, 2));
  await expect.poll(() => record(a, outcomeId(ending.block))).toMatchObject({ result: 'not' });

  const answer = async (ids: typeof ended) => {
    // Each answer's expiry counts from its own block's end, so only that it has one is compared.
    const { answered_at, expires_at, ...outcome } = (await record(a, outcomeId(ids.block)))!;
    expect(answered_at).toEqual(expect.any(String));
    expect(expires_at).toEqual(expect.any(String));
    const task = (await record(a, ids.task))!;
    const completions = await a.page.evaluate(
      (id) => (window.multiscaleElectron as ElectronBridge).db.all('SELECT count(*) AS n FROM task_completion WHERE task_id = ? AND deleted_at IS NULL', [id]),
      ids.task,
    );
    return { outcome, done: typeof task.done_at === 'string', completions };
  };
  expect(await answer(ending)).toEqual(await answer(ended));
  expect((await scheduled()).filter((r) => r.block_id === ending.block)).toEqual([]);
  expect(a.errors).toEqual([]);
});

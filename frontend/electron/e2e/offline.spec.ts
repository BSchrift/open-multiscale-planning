// The Mac app without a network, and with one that goes away in the middle of a sync: started offline, the answer to a
// push or a pull lost on its way back, the app killed while a sync waits, and the window sent away while one does. Real
// app instances on the local stack that scripts/e2e.sh starts and names in LOCAL_API_URL, signed in as sync.spec.ts
// signs in. In each, the work done reaches the server and the other device once, and nothing is left waiting to send.
//
// The network goes away in two ways. At launch, Chromium switches send every request to a proxy that isn't there, so
// not even the first request of the app's start gets out; the stack is on 127.0.0.1, which Chromium never proxies
// unless <-loopback> says to. A route on the app's context could only be added once the window had started loading,
// after the launch sync may have gone. In the middle of a sync, tapSync stands where the network does.

import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { account, go, oneOffRow, pane, setDate, syncNow } from '../../e2e/seed';
import { addDays, formatDate, localDate } from '../../src/core/dates';
import type { ElectronBridge } from '../bridge';

declare global {
  var browserUrls: string[];
}

const ROOT = join(import.meta.dirname, '../..');
const KEYCHAIN = process.platform === 'linux' ? ['-r', join(import.meta.dirname, 'linux-keychain.cjs')] : [];
const API = process.env.LOCAL_API_URL ?? '';
/** Nothing answers on port 9, the discard port, so every request fails as it would with no network at all. Were
 * something to, the tests would see a sync work where they expect Offline, and fail rather than pass by mistake. */
const NO_NETWORK = ['--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=<-loopback>'];
/** For what waits on a sync, which a busy machine's local stack can take longer over than an expectation's default
 * allows: the time syncNow gives one. */
const A_SYNC = { timeout: 30_000 };

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
async function launch(dir = mkdtempSync(join(tmpdir(), 'multiscale-offline-')), args: string[] = []): Promise<Device> {
  if (!dirs.includes(dir)) dirs.push(dir);
  const app = await electron.launch({
    // The mock keychain keeps an unattended run from stopping at a keychain prompt. Linux has none, see linux-keychain.cjs.
    args: [...KEYCHAIN, ROOT, `--user-data-dir=${dir}`, '--use-mock-keychain', ...args],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
  });
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

/** As Force Quit or a crash would: no quit events, nothing flushed, the data folder left as it is. */
async function kill(d: Device) {
  running.splice(running.indexOf(d), 1);
  const closed = d.app.waitForEvent('close');
  d.app.process().kill('SIGKILL');
  await closed;
}

/** Opens the sign-in page the app asked the browser for, where the local stand-in signs `user` straight in, and hands the app the link it redirects to. */
async function signIn(d: Device, user: string, button: Locator) {
  await button.click();
  await expect.poll(() => d.app.evaluate(() => globalThis.browserUrls.length)).toBe(1);
  const url = await d.app.evaluate(() => globalThis.browserUrls.pop()!);
  const res = await fetch(`${url}&username=${encodeURIComponent(user)}`, { redirect: 'manual' });
  const link = res.headers.get('location') ?? '';
  expect(link).toMatch(/^multiscale-local:\/\/auth\/callback\?/);
  await d.app.evaluate(({ app }, u) => void app.emit('open-url', { preventDefault: () => undefined }, u), link);
}

/** The first device: signs in on the first setup step, then skips the rest of setup. */
async function firstRun(d: Device, user: string) {
  const { page } = d;
  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();
  await signIn(d, user, page.getByRole('button', { name: 'Sign in' }));
  await expect(page.getByText('Signed in', { exact: true })).toBeVisible(A_SYNC);
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByRole('heading', { name: 'Google Calendar' })).toBeVisible();
  await page.getByRole('button', { name: 'Skip' }).click();
  await expect(page.getByRole('heading', { name: 'Unavailable hours' })).toBeVisible();
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('button', { name: 'Skip' }).click();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
}

/** Another device, once the first has synced: signing in brings down the finished setup, so it goes into the app. */
async function joinRun(d: Device, user: string) {
  await expect(d.page.getByRole('heading', { name: 'Welcome' })).toBeVisible();
  await signIn(d, user, d.page.getByRole('button', { name: 'Sign in' }));
  await expect(d.page.getByRole('navigation', { name: 'Main' })).toBeVisible(A_SYNC);
}

async function expectSynced(page: Page) {
  await syncNow(page);
  await expect(account(page).getByText('Synced', { exact: true })).toBeVisible();
}

/** Presses Sync now with no network, and sees it fail as offline and leave the button ready for the next try. */
async function expectOffline(page: Page) {
  await syncNow(page);
  await expect(account(page).getByText('Offline', { exact: true })).toBeVisible();
  await expect(account(page).getByText("Your changes are kept and sync when you're back online.")).toBeVisible();
  await expect(account(page).getByRole('button', { name: 'Sync now' })).toBeEnabled();
}

/** Starts a sync from Settings without waiting for it, for one the network is holding. */
async function startSync(page: Page) {
  await go(page, 'Settings');
  await account(page).getByRole('button', { name: 'Sync now' }).click();
}

/** Through the global shortcut's path: the event its callback sends, then the one-field window, which saves through the main window. */
async function captureByShortcut(d: Device, title: string) {
  const isCapture = (w: Page) => w.url().endsWith('capture.html');
  await expect.poll(() => d.app.windows().some(isCapture)).toBe(true);
  await d.app.evaluate(({ app }) => void app.emit('capture-shortcut'));
  const field = d.app.windows().find(isCapture)!.getByRole('textbox', { name: 'Capture' });
  await expect(field).toBeFocused();
  await field.fill(title);
  await field.press('Enter');
  // Hidden once the main window has saved it.
  await expect.poll(() => d.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.isVisible()).length)).toBe(1);
}

async function addOneOff(page: Page, title: string) {
  await go(page, 'One offs');
  const form = pane(page, 'One offs').getByRole('form', { name: 'Add a one off' });
  await form.getByLabel('Title').fill(title);
  await form.getByRole('button', { name: 'Add one off' }).click();
  await expect(oneOffRow(page, title)).toBeVisible();
}

const sql = (d: Device, query: string, values: (string | number)[] = []) =>
  d.page.evaluate(([q, v]) => (window.multiscaleElectron as ElectronBridge).db.all(q, v), [query, values] as const);

const record = async (d: Device, id: string) => {
  const rows = await sql(d, 'SELECT data FROM records WHERE id = ?', [id]);
  return rows[0] ? (JSON.parse(rows[0].data as string) as Record<string, unknown>) : null;
};

/** How many tasks this device has by that title: a duplicate would have an id of its own. */
const tasksTitled = async (d: Device, title: string) => (await sql(d, 'SELECT count(*) AS n FROM task WHERE title = ?', [title]))[0]!.n as number;

const idOf = async (d: Device, title: string) => (await sql(d, 'SELECT id FROM task WHERE title = ?', [title]))[0]?.id as string;

/** The records with changes still to send. */
const outbox = async (d: Device) => (await sql(d, 'SELECT DISTINCT record_id FROM outbox ORDER BY record_id')).map((r) => r.record_id as string);

const session = async (d: Device) =>
  JSON.parse((await d.page.evaluate(() => (window.multiscaleElectron as ElectronBridge).tokens.get('auth.session')))!) as { access_token: string; expires_at: number };

const zoneOf = (d: Device) => d.page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);

interface Change {
  type: string;
  id: string;
  fields: Record<string, { v: unknown; c: string }>;
}

/** Writes records as a third device of the same user would, through the sync API with this device's token. */
async function push(d: Device, records: { type: string; id: string; fields: Record<string, unknown> }[]) {
  const clock = `${Date.now()}-000000-e2e-seed`;
  const changes = records.map(({ type, id, fields }) => ({
    type,
    id,
    fields: Object.fromEntries(Object.entries(fields).map(([name, v]) => [name, { v, c: clock }])),
  }));
  const res = await fetch(`${API}/sync`, {
    method: 'POST',
    headers: { authorization: `Bearer ${(await session(d)).access_token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ cursor: 0, changes }),
  });
  expect(res.status).toBe(200);
}

/** Everything the server holds for the account, as a new device would pull it. */
async function serverRecords(d: Device): Promise<Change[]> {
  const headers = { authorization: `Bearer ${(await session(d)).access_token}`, 'content-type': 'application/json' };
  const records: Change[] = [];
  for (let cursor = 0; ; ) {
    const res = await fetch(`${API}/sync`, { method: 'POST', headers, body: JSON.stringify({ cursor, changes: [] }) });
    const page = (await res.json()) as { cursor: number; more: boolean; changes: Change[] };
    records.push(...page.changes);
    cursor = page.cursor;
    if (!page.more) return records;
  }
}

interface Exchange {
  sent: { cursor: number; changes: Change[] };
  /** What the server answered, whether or not the app got it. Absent when the request never reached it. */
  answer?: { cursor: number; more: boolean; changes: Change[] };
}

/** One request's fate: passed on, cut off before the server, or answered by the server and that answer lost. */
type Fate = 'deliver' | 'cut' | 'lose' | { answered(): void; decided: Promise<'deliver' | 'lose'> };

/**
 * Stands where the network does between the app and the API's /sync, so the test decides what reaches whom. It keeps
 * every request the app sends and every answer the server gives, passes them on while the network is up and cuts them
 * off while it's down, and gives any lined up with `next` or `hold` their own fate first.
 */
async function tapSync(d: Device) {
  const log: Exchange[] = [];
  const lined: Fate[] = [];
  let up = true;
  await d.app.context().route(`${API}/sync`, async (route) => {
    const exchange: Exchange = { sent: route.request().postDataJSON() as Exchange['sent'] };
    log.push(exchange);
    const fate = lined.shift() ?? (up ? 'deliver' : 'cut');
    if (fate === 'cut') return route.abort('internetdisconnected');
    const response = await route.fetch();
    exchange.answer = (await response.json()) as Exchange['answer'];
    let outcome: 'deliver' | 'lose';
    if (typeof fate === 'string') outcome = fate;
    else {
      fate.answered();
      outcome = await fate.decided;
    }
    if (outcome === 'lose') return route.abort('internetdisconnected');
    return route.fulfill({ response });
  });
  return {
    log,
    up: () => void (up = true),
    down: () => void (up = false),
    next: (...fates: Fate[]) => void lined.push(...fates),
    /** The next request reaches the server, and its answer waits there until the test delivers or loses it. */
    hold() {
      let answered!: () => void;
      let decide!: (outcome: 'deliver' | 'lose') => void;
      const done = new Promise<void>((resolve) => (answered = resolve));
      lined.push({ answered, decided: new Promise((resolve) => (decide = resolve)) });
      return { answered: done, deliver: () => decide('deliver'), lose: () => decide('lose') };
    },
  };
}

/** The ids of what a request carried, for comparing two requests. */
const ids = (changes: Change[]) => changes.map((c) => c.id).sort();

test('started with no network, the Mac app keeps and takes work, and sends it once when the network is back', async () => {
  const run = randomUUID().slice(0, 8);
  const user = `e2e-${run}`;
  const fence = `Paint the fence ${run}`;
  const report = `Write the report ${run}`;
  const hinges = `Oil the hinges ${run}`;

  const a = await launch();
  await firstRun(a, user);
  await addOneOff(a.page, fence);
  await expectSynced(a.page);
  const b = await launch();
  await joinRun(b, user);
  const fenceId = await idOf(a, fence);
  // The access token runs out while the app is closed, as it does overnight, so starting up has to refresh it first.
  await a.page.evaluate(async () => {
    const tokens = (window.multiscaleElectron as ElectronBridge).tokens;
    await tokens.set('auth.session', JSON.stringify({ ...JSON.parse((await tokens.get('auth.session'))!), expires_at: 0 }));
  });
  await quit(a);

  const offline = await launch(a.dir, NO_NETWORK);
  const { page } = offline;
  // Into the app, signed in, with what the last run had.
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  await go(page, 'One offs');
  await expect(oneOffRow(page, fence)).toBeVisible();
  // Every screen opens.
  for (const tab of ['Today', 'Inbox', 'Week', 'Plan', 'Goals', 'One offs', 'Analytics', 'Done', 'Settings']) await go(page, tab, /./);
  // A capture from the shortcut's window, a new one off, and an edit to one from before.
  await captureByShortcut(offline, report);
  await addOneOff(page, hinges);
  const soon = addDays(localDate(Date.now(), await zoneOf(offline)), 10);
  await setDate(page, fence, soon);
  await go(page, 'Inbox');
  await expect(pane(page, 'Inbox').getByText(report)).toBeVisible();
  // Offline, not signed out: a refresh that couldn't reach the server keeps the sign-in.
  await expectOffline(page);
  expect((await session(offline)).expires_at).toBe(0);
  const reportId = await idOf(offline, report);
  const hingesId = await idOf(offline, hinges);
  expect(await outbox(offline)).toEqual(expect.arrayContaining([fenceId, reportId, hingesId]));
  await quit(offline);

  // With the network back, starting up refreshes the sign-in and sends what waited, without being asked.
  const online = await launch(a.dir);
  const tap = await tapSync(online);
  await go(online.page, 'Settings');
  await expect(account(online.page).getByText('Synced', { exact: true })).toBeVisible(A_SYNC);
  expect((await session(online)).expires_at).toBeGreaterThan(0);
  expect(await outbox(online)).toEqual([]);
  await expectSynced(online.page);
  expect(tap.log.at(-1)!.sent.changes).toEqual([]);

  // The other device gets each once.
  await expectSynced(b.page);
  await go(b.page, 'Inbox');
  await expect(pane(b.page, 'Inbox').getByText(report)).toHaveCount(1);
  await go(b.page, 'One offs');
  await expect(oneOffRow(b.page, hinges)).toHaveCount(1);
  await expect(oneOffRow(b.page, fence)).toContainText(formatDate(soon));
  for (const title of [fence, report, hinges]) expect(await tasksTitled(b, title)).toBe(1);
  for (const id of [fenceId, reportId, hingesId]) expect(await record(b, id)).toEqual(await record(online, id));

  for (const d of [a, offline, online, b]) expect(d.errors).toEqual([]);
});

test('a push or a pull whose answer the network loses is finished by the next sync, with nothing lost or doubled', async () => {
  const run = randomUUID().slice(0, 8);
  const user = `e2e-${run}`;
  const fence = `Paint the fence ${run}`;
  const hinges = `Oil the hinges ${run}`;
  const a = await launch();
  await firstRun(a, user);
  await expectSynced(a.page);
  const b = await launch();
  await joinRun(b, user);
  const [tapA, tapB] = [await tapSync(a), await tapSync(b)];

  // A push the server takes, whose answer never arrives.
  tapA.down();
  await addOneOff(a.page, fence);
  await addOneOff(a.page, hinges);
  await setDate(a.page, fence, addDays(localDate(Date.now(), await zoneOf(a)), 10));
  // Once a sync has failed after the last edit, none still under way read the outbox before it.
  await expectOffline(a.page);
  const lost = tapA.hold();
  await startSync(a.page);
  await lost.answered;
  await expect(account(a.page).getByRole('button', { name: 'Sync now', disabled: true })).toBeVisible();
  const lostPush = tapA.log.at(-1)!.sent;
  const [fenceId, hingesId] = [await idOf(a, fence), await idOf(a, hinges)];
  expect(ids(lostPush.changes)).toEqual(expect.arrayContaining([fenceId, hingesId].sort()));
  lost.lose();
  await expect(account(a.page).getByText('Offline', { exact: true })).toBeVisible();
  await expect(account(a.page).getByRole('button', { name: 'Sync now' })).toBeEnabled();
  // The server has it, so the other device already does, but this one couldn't know and still has it to send.
  await expectSynced(b.page);
  for (const title of [fence, hinges]) expect(await tasksTitled(b, title)).toBe(1);
  expect(await outbox(a)).toEqual(expect.arrayContaining([fenceId, hingesId]));

  // The next sync sends the same changes again, which the server takes as already done.
  tapA.up();
  const resent = tapA.log.length;
  await expectSynced(a.page);
  expect(tapA.log[resent]!.sent.changes).toEqual(expect.arrayContaining(lostPush.changes));
  expect(await outbox(a)).toEqual([]);
  await expectSynced(a.page);
  expect(tapA.log.at(-1)!.sent.changes).toEqual([]);

  // A pull of more than one page, whose second page is lost on its way back. Cut off until then, so no other sync
  // pulls part of it first.
  tapB.down();
  const pulled = Array.from({ length: 520 }, (_, i) => ({ type: 'task', id: `e2e-${run}-pulled-${i}`, fields: { kind: 'inbox', title: `Pulled ${run} ${i}` } }));
  for (let i = 0; i < pulled.length; i += 99) await push(a, pulled.slice(i, i + 99));
  const firstPage = tapB.log.length;
  tapB.next('deliver', 'lose');
  await startSync(b.page);
  await expect(account(b.page).getByText('Offline', { exact: true })).toBeVisible(A_SYNC);
  await expect(account(b.page).getByRole('button', { name: 'Sync now' })).toBeEnabled();
  const [one, two] = tapB.log.slice(firstPage);
  expect(one!.answer!.more).toBe(true);
  expect(two!.sent.cursor).toBe(one!.answer!.cursor);
  expect(two!.answer!.changes.length).toBeGreaterThan(0);
  // The first page is kept.
  const pulledIds = new Set(pulled.map((r) => r.id));
  const onFirstPage = one!.answer!.changes.filter((c) => pulledIds.has(c.id)).length;
  const countPulled = async () => (await sql(b, 'SELECT count(*) AS n FROM task WHERE title LIKE ?', [`Pulled ${run} %`]))[0]!.n as number;
  expect(await countPulled()).toBe(onFirstPage);

  // The next sync carries on from the end of the first page rather than starting over.
  tapB.up();
  const resumed = tapB.log.length;
  await expectSynced(b.page);
  expect(tapB.log[resumed]!.sent.cursor).toBe(one!.answer!.cursor);
  expect(await countPulled()).toBe(pulled.length);
  expect((await sql(b, 'SELECT count(DISTINCT title) AS n FROM task WHERE title LIKE ?', [`Pulled ${run} %`]))[0]!.n).toBe(pulled.length);

  for (const id of [fenceId, hingesId]) expect(await record(b, id)).toEqual(await record(a, id));
  expect(a.errors).toEqual([]);
  expect(b.errors).toEqual([]);
});

test('killed while a sync waits for its answer, the Mac app restarts signed in with its work, and the sync finishes once', async () => {
  const run = randomUUID().slice(0, 8);
  const user = `e2e-${run}`;
  const fence = `Paint the fence ${run}`;
  const report = `Write the report ${run}`;
  const a = await launch();
  await firstRun(a, user);
  await expectSynced(a.page);
  const b = await launch();
  await joinRun(b, user);

  const tap = await tapSync(a);
  tap.down();
  await addOneOff(a.page, fence);
  await captureByShortcut(a, report);
  await expectOffline(a.page);
  const held = tap.hold();
  await startSync(a.page);
  // The server has taken the push; the app is killed before its answer arrives.
  await held.answered;
  const heldPush = tap.log.at(-1)!.sent;
  const [fenceId, reportId] = [await idOf(a, fence), await idOf(a, report)];
  expect(ids(heldPush.changes)).toEqual(expect.arrayContaining([fenceId, reportId].sort()));
  await kill(a);

  // Restarted with the network held back, to look at what the kill left before anything syncs it.
  const again = await launch(a.dir, NO_NETWORK);
  await expect(again.page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  await go(again.page, 'Inbox');
  await expect(pane(again.page, 'Inbox').getByText(report)).toBeVisible();
  await go(again.page, 'One offs');
  await expect(oneOffRow(again.page, fence)).toBeVisible();
  expect(await outbox(again)).toEqual(expect.arrayContaining([fenceId, reportId]));
  await expectOffline(again.page);

  // The network comes back while it's open.
  await again.app.evaluate(({ session: s }) => s.defaultSession.setProxy({ mode: 'direct' }));
  const tapAgain = await tapSync(again);
  await expectSynced(again.page);
  expect(tapAgain.log[0]!.sent.changes).toEqual(expect.arrayContaining(heldPush.changes));
  expect(await outbox(again)).toEqual([]);
  await expectSynced(again.page);
  expect(tapAgain.log.at(-1)!.sent.changes).toEqual([]);

  await expectSynced(b.page);
  await go(b.page, 'Inbox');
  await expect(pane(b.page, 'Inbox').getByText(report)).toHaveCount(1);
  for (const title of [fence, report]) expect(await tasksTitled(b, title)).toBe(1);
  for (const id of [fenceId, reportId]) expect(await record(b, id)).toEqual(await record(again, id));
  for (const d of [a, again, b]) expect(d.errors).toEqual([]);
});

test('closed to the menu bar while a sync waits, the Mac app finishes it, and syncs again when brought back', async () => {
  const run = randomUUID().slice(0, 8);
  const fence = `Paint the fence ${run}`;
  const a = await launch();
  await firstRun(a, `e2e-${run}`);
  await expectSynced(a.page);
  const tap = await tapSync(a);
  tap.down();
  await addOneOff(a.page, fence);
  await expectOffline(a.page);
  tap.up();
  const held = tap.hold();
  await startSync(a.page);
  await held.answered;

  // Closing the window hides it, and the page loses focus. Playwright tells the page it always has focus, and which
  // app has it on a shared Mac or under xvfb is no test's to decide, so the page gets the blur and focus the system
  // sends when the window goes and comes back.
  const win = await a.app.browserWindow(a.page);
  await win.evaluate((w) => w.close());
  await expect.poll(() => win.evaluate((w) => w.isVisible())).toBe(false);
  await a.page.evaluate(() => window.dispatchEvent(new FocusEvent('blur')));
  held.deliver();
  await expect.poll(() => outbox(a), A_SYNC).toEqual([]);
  await expect.poll(async () => (await sql(a, "SELECT count(*) AS n FROM meta WHERE key = 'last_sync_error'"))[0]!.n, A_SYNC).toBe(0);

  // Back from the Dock: it syncs by itself, with nothing left to send.
  const before = tap.log.length;
  await a.app.evaluate(({ app }) => void app.emit('activate'));
  await expect.poll(() => win.evaluate((w) => w.isVisible())).toBe(true);
  await a.page.evaluate(() => window.dispatchEvent(new FocusEvent('focus')));
  await expect.poll(() => tap.log.length).toBeGreaterThan(before);
  expect(tap.log[before]!.sent.changes).toEqual([]);
  await expect(account(a.page).getByText('Synced', { exact: true })).toBeVisible(A_SYNC);
  await expect(account(a.page).getByRole('button', { name: 'Sync now' })).toBeEnabled();

  await go(a.page, 'One offs');
  await expect(oneOffRow(a.page, fence)).toBeVisible();
  expect((await serverRecords(a)).filter((r) => r.fields.title?.v === fence)).toHaveLength(1);
  expect(a.errors).toEqual([]);
});

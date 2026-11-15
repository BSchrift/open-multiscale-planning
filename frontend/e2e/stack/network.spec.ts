import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page, Request, Route } from '@playwright/test';
import { account, go, pane, readRecord, seed, syncNow } from '../seed';
import { capture, closeDevices, deleteFromInbox, device, NETWORK, oneOff, signIn, startSignIn } from './devices';
import { target } from './target';

// The network going away and coming back while the browser build is signed in: offline, cut off mid-request, flapping,
// slow, failing, and the API changing under it. Requests are cut, held and answered with page.route, so each drop lands
// exactly where a test puts it. Every title carries the run's id, and what a test makes on a deployment it deletes, so
// a deployment's test user keeps nothing live. Tests that need the local stack's clock, its fake Google or a user of
// their own skip elsewhere.

const t = target();
test.use({ baseURL: `http://localhost:${process.env.STACK_WEB_PORT}` });
test.afterEach(closeDevices);

/** The API's sync endpoint, wherever the target serves it. */
const isSync = (url: URL) => url.pathname.endsWith('/sync');
const isSyncRequest = (r: Request) => r.method() === 'POST' && isSync(new URL(r.url()));
/** The sign-in's token endpoint: the code exchange and each refresh. */
const isToken = (url: URL) => url.pathname.endsWith('/oauth2/token');
/** Settings' sync pill, such as Synced or Offline. */
const status = (page: Page, pill: string) => account(page).getByText(pill, { exact: true });
const OFFLINE_LINE = "Your changes are kept and sync when you're back online.";
const FAILED_LINE = "Sync didn't work. It will try again.";

type Change = { type: string; id: string; fields: Record<string, { v: unknown; c: string }> };
const changesOf = (route: Route) => (route.request().postDataJSON() as { changes: Change[] }).changes;

/** Lets a request reach the server, then loses its answer on the way back. One the app gave up on meanwhile is gone. */
async function loseAnswer(route: Route) {
  await route.fetch();
  await route.abort('connectionreset').catch(() => undefined);
}

/** The next sync carries nothing: everything this device had to send has gone. */
async function expectDrained(page: Page) {
  const next = page.waitForRequest(isSyncRequest);
  await syncNow(page);
  expect((await next).postDataJSON().changes).toEqual([]);
}

/** Of these records, the ones this device doesn't have. */
const missing = (page: Page, type: string, ids: readonly string[]) =>
  page.evaluate(
    async ([type, ids]) => {
      const read = (window as unknown as { multiscaleRecord(type: string, id: string): Promise<unknown> }).multiscaleRecord;
      const gone: string[] = [];
      for (const id of ids) if (!(await read(type, id))) gone.push(id);
      return gone;
    },
    [type, ids] as const,
  );

/** Moves the local stack's clock, which tokens are checked against. An empty string puts it back. */
async function setServerClock(now: string) {
  const res = await fetch(`${t.localApi}/_local/clock`, { method: 'POST', body: JSON.stringify({ now }) });
  expect(res.status).toBe(204);
}

/** A small PNG made by the page, as a camera or photo library would hand one over. */
const png = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<number[]>((resolve) => {
        const canvas = document.createElement('canvas');
        canvas.width = 64;
        canvas.height = 48;
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = '#3a7';
        ctx.fillRect(0, 0, 64, 48);
        canvas.toBlob((blob) => void blob!.arrayBuffer().then((bytes) => resolve(Array.from(new Uint8Array(bytes)))), 'image/png');
      }),
  );

async function openTask(page: Page, title: string) {
  await go(page, 'One offs');
  await pane(page, 'One offs').getByRole('button', { name: title, exact: true }).click();
  const popup = page.locator(`.sheet.taskpop[aria-label="${title}"]`);
  await expect(popup).toBeVisible();
  return popup;
}

test('offline, Settings says so and keeps the change; back online it syncs by itself and the pill clears', async ({ browser }) => {
  const run = randomUUID().slice(0, 8);
  const title = `Return the library books ${run}`;
  const a = await device(browser, `e2e-${run}`);
  await signIn(a.page);
  const b = await device(browser, `e2e-${run}`);
  await signIn(b.page);

  await a.context.setOffline(true);
  // The sync an edit starts finds no network.
  await capture(a.page, title);
  await go(a.page, 'Settings');
  await expect(status(a.page, 'Offline')).toBeVisible(NETWORK);
  await expect(account(a.page).getByText(OFFLINE_LINE)).toBeVisible();

  // Nothing pressed: coming back online is enough.
  await a.context.setOffline(false);
  await expect(status(a.page, 'Synced')).toBeVisible(NETWORK);
  await expect(account(a.page).getByText(OFFLINE_LINE)).toHaveCount(0);
  await expectDrained(a.page);
  await syncNow(b.page);
  await go(b.page, 'Inbox');
  await expect(pane(b.page, 'Inbox').getByText(title)).toHaveCount(1);

  await deleteFromInbox(b.page, title);
  await syncNow(b.page);
  expect(a.errors).toEqual([]);
  expect(b.errors).toEqual([]);
});

test('a push whose answer never arrives is sent again, lands once, and the outbox empties', async ({ browser }) => {
  const run = randomUUID().slice(0, 8);
  const title = `Renew the passport ${run}`;
  const a = await device(browser, `e2e-${run}`);
  await signIn(a.page);
  const b = await device(browser, `e2e-${run}`);
  await signIn(b.page);

  let pushes = 0;
  await a.page.route(isSync, async (route) => {
    if (!changesOf(route).some((c) => c.fields.title?.v === title)) return route.continue();
    if (++pushes > 1) return route.continue();
    // The server takes it, and its answer is lost on the way back.
    return loseAnswer(route);
  });
  await capture(a.page, title);
  await go(a.page, 'Settings');
  await expect(status(a.page, 'Offline')).toBeVisible(NETWORK);
  await syncNow(a.page);
  await expect(status(a.page, 'Synced')).toBeVisible();
  // Sent again, since this device never heard it landed.
  expect(pushes).toBe(2);
  await expectDrained(a.page);
  await syncNow(b.page);
  await go(b.page, 'Inbox');
  await expect(pane(b.page, 'Inbox').getByText(title)).toHaveCount(1);

  await deleteFromInbox(b.page, title);
  await syncNow(b.page);
  expect(a.errors).toEqual([]);
  expect(b.errors).toEqual([]);
});

test('a push of many batches and a pull of many pages, each cut off midway, carry on from where they stopped', async ({ browser }) => {
  test.skip(!t.localApi, "needs: a user of its own, since 520 records would stay on a deployment's test user");
  test.setTimeout(180_000);
  const run = randomUUID().slice(0, 8);
  // More than five batches of 99 to send, and more than one page of 500 to bring down.
  const ids = Array.from({ length: 520 }, (_, i) => `e2e-${run}-${String(i).padStart(3, '0')}`);
  const a = await device(browser, `e2e-${run}`);
  await seed(a.page, ids.map((id, i) => oneOff(id, `Errand ${i} ${run}`)));

  // After signing in, the first batch lands and the second is cut off before it reaches the server. The sync after
  // that, whatever starts it, carries on.
  const pushes: { ids: string[]; cut: boolean }[] = [];
  await a.page.route(isSync, (route) => {
    const ours = changesOf(route)
      .map((c) => c.id)
      .filter((id) => id.startsWith(`e2e-${run}-`));
    if (ours.length === 0) return route.continue();
    const cut = pushes.length === 1;
    pushes.push({ ids: ours, cut });
    return cut ? route.abort('internetdisconnected') : route.continue();
  });
  await startSignIn(a.page);
  await expect.poll(() => pushes.length, NETWORK).toBeGreaterThan(1);
  await syncNow(a.page);
  await expect(status(a.page, 'Synced')).toBeVisible();
  const landed = pushes.filter((p) => !p.cut);
  // The batch that landed wasn't sent again, the cut one went next, and every record landed once.
  expect(pushes[2]!.ids).toEqual(pushes[1]!.ids);
  expect(landed.flatMap((p) => p.ids).toSorted()).toEqual(ids);
  await expectDrained(a.page);

  // The other device's first pull brings one page, and the request for the next is cut off. The sync after that,
  // whatever starts it, asks from the page it reached.
  const b = await device(browser, `e2e-${run}`);
  const pulls: { cursor: number; reached?: number; more?: boolean; count?: number }[] = [];
  await b.page.route(isSync, async (route) => {
    const pull: (typeof pulls)[number] = { cursor: route.request().postDataJSON().cursor };
    pulls.push(pull);
    if (pulls.length === 2) return route.abort('internetdisconnected');
    const response = await route.fetch();
    const body = (await response.json()) as { cursor: number; more: boolean; changes: Change[] };
    Object.assign(pull, { reached: body.cursor, more: body.more, count: body.changes.length });
    return route.fulfill({ response, json: body });
  });
  await startSignIn(b.page);
  await expect.poll(() => pulls.length, NETWORK).toBeGreaterThan(1);
  await syncNow(b.page);
  await expect(status(b.page, 'Synced')).toBeVisible();
  expect(pulls[0]).toMatchObject({ cursor: 0, more: true, count: 500 });
  // From the page it reached, not from the start.
  expect(pulls[1]!.cursor).toBe(pulls[0]!.reached);
  expect(pulls[2]!.cursor).toBe(pulls[0]!.reached);
  expect(await missing(b.page, 'task', ids)).toEqual([]);
  expect(await readRecord(b.page, 'task', ids[519]!)).toMatchObject({ title: `Errand 519 ${run}` });

  expect(a.errors).toEqual([]);
  expect(b.errors).toEqual([]);
});

test('a photo added offline uploads once back online, and an upload or a download cut off midway starts again, never half recorded', async ({ browser }) => {
  test.skip(!t.localApi, 'needs: photo storage, which only the local stack always has');
  test.setTimeout(180_000);
  const run = randomUUID().slice(0, 8);
  const title = `Fix the gate ${run}`;
  const id = `e2e-${run}-gate`;
  const a = await device(browser, `e2e-${run}`);
  const b = await device(browser, `e2e-${run}`);
  await seed(a.page, [oneOff(id, title)]);
  await signIn(a.page);
  await signIn(b.page);

  // One offs opens once online first: a screen first opened offline is the screen-loading test's.
  await go(a.page, 'One offs');
  await a.context.setOffline(true);
  let popup = await openTask(a.page, title);
  let section = popup.getByRole('region', { name: 'Attachments' });
  await section.getByLabel('Add photo', { exact: true }).and(a.page.locator('input')).setInputFiles({ name: 'gate.png', mimeType: 'image/png', buffer: Buffer.from(await png(a.page)) });
  await expect(section.getByRole('button', { name: 'Open gate.jpg' })).toBeVisible();
  await expect(section.getByText('Waiting to upload')).toBeVisible();
  await a.page.keyboard.press('Escape');

  // Back online, uploads are first cut off before they reach storage, then reach it with their answers lost.
  let storage: 'cut' | 'answer lost' | 'up' = 'cut';
  const puts = { cut: 0, 'answer lost': 0, up: 0 };
  await a.page.route(
    (url) => url.pathname.startsWith('/bucket/'),
    async (route) => {
      const mode = storage;
      puts[mode]++;
      if (mode === 'cut') return route.abort('connectionreset');
      if (mode === 'up') return route.continue();
      return loseAnswer(route);
    },
  );
  const grant = a.page.waitForRequest((r) => new URL(r.url()).pathname.endsWith('/files/upload'));
  await a.context.setOffline(false);
  await syncNow(a.page);
  const attachment = (await grant).postDataJSON().id as string;
  await expect.poll(() => puts.cut, NETWORK).toBeGreaterThan(0);
  // Not uploaded is what this device and every other one says, rather than a photo nobody can open.
  popup = await openTask(a.page, title);
  section = popup.getByRole('region', { name: 'Attachments' });
  await expect(section.getByText('Waiting to upload')).toBeVisible();
  await a.page.keyboard.press('Escape');
  expect(await readRecord(a.page, 'attachment', attachment)).not.toHaveProperty('uploaded_at');
  await syncNow(b.page);
  popup = await openTask(b.page, title);
  await expect(popup.getByRole('region', { name: 'Attachments' }).getByText('Not uploaded yet')).toBeVisible();
  await b.page.keyboard.press('Escape');

  storage = 'answer lost';
  await syncNow(a.page);
  await expect.poll(() => puts['answer lost'], NETWORK).toBeGreaterThan(0);
  expect(await readRecord(a.page, 'attachment', attachment)).not.toHaveProperty('uploaded_at');
  // The next try sends it whole, and only then is it marked uploaded, which the sync after carries.
  storage = 'up';
  await syncNow(a.page);
  await expect.poll(async () => (await readRecord(a.page, 'attachment', attachment))?.uploaded_at, NETWORK).toBeTruthy();
  expect(puts.up).toBe(1);
  await syncNow(a.page);

  // The other device's first download is cut off: it says so and keeps nothing, and opening it again brings it whole.
  let gets = 0;
  await b.page.route(
    (url) => url.pathname.startsWith('/edge/'),
    (route) => (++gets === 1 ? route.abort('connectionreset') : route.continue()),
  );
  await syncNow(b.page);
  popup = await openTask(b.page, title);
  section = popup.getByRole('region', { name: 'Attachments' });
  await expect(section.getByText(/^Photo · \d+ KB$/)).toBeVisible();
  await section.getByRole('button', { name: 'Open gate.jpg' }).click();
  await expect(section.getByText("Couldn't open it. Check your connection.")).toBeVisible(NETWORK);
  await expect(popup.locator('.attachicon img')).toHaveCount(0);
  await section.getByRole('button', { name: 'Open gate.jpg' }).click();
  const viewer = b.page.getByRole('dialog', { name: 'gate.jpg' });
  const image = viewer.getByRole('img', { name: 'gate.jpg' });
  await expect(image).toBeVisible(NETWORK);
  expect(await image.evaluate((img: HTMLImageElement) => [img.naturalWidth, img.naturalHeight])).toEqual([64, 48]);
  expect(gets).toBe(2);

  expect(a.errors).toEqual([]);
  expect(b.errors).toEqual([]);
});

test('a sign-in cut off midway says so and keeps local work, and signing in again works', async ({ browser }) => {
  const run = randomUUID().slice(0, 8);
  const title = `Book the dentist ${run}`;
  const a = await device(browser, `e2e-${run}`);
  await capture(a.page, title);

  // The code the sign-in page sent back can't be exchanged for tokens.
  await a.page.route(isToken, (route) => route.abort('connectionreset'), { times: 1 });
  await startSignIn(a.page);
  await expect(status(a.page, 'Signed out')).toBeVisible(NETWORK);
  await expect(account(a.page).getByText("Sign-in didn't finish. Try again.")).toBeVisible();
  await go(a.page, 'Inbox');
  await expect(pane(a.page, 'Inbox').getByText(title)).toBeVisible();

  await signIn(a.page);
  const b = await device(browser, `e2e-${run}`);
  await signIn(b.page);
  await go(b.page, 'Inbox');
  await expect(pane(b.page, 'Inbox').getByText(title)).toHaveCount(1);

  await deleteFromInbox(b.page, title);
  await syncNow(b.page);
  expect(a.errors).toEqual([]);
  expect(b.errors).toEqual([]);
});

test('a token refresh cut off keeps the sign-in, and the next sync refreshes and sends what waited', async ({ browser }) => {
  test.skip(!t.localApi, 'needs: fakeClock');
  const run = randomUUID().slice(0, 8);
  const title = `Water the ferns ${run}`;
  const a = await device(browser, `e2e-${run}`);
  await signIn(a.page);
  const b = await device(browser, `e2e-${run}`);
  await signIn(b.page);

  try {
    // Two hours on, the server refuses the access token, and the refresh that follows is cut off.
    await setServerClock(new Date(Date.now() + 2 * 3600_000).toISOString());
    await a.page.route(isToken, (route) => route.abort('connectionreset'), { times: 1 });
    await capture(a.page, title);
    await go(a.page, 'Settings');
    await expect(status(a.page, 'Offline')).toBeVisible(NETWORK);
    // A refresh that never arrived isn't a refusal: still signed in.
    await expect(account(a.page).getByRole('button', { name: 'Sign out' })).toBeVisible();
    await syncNow(a.page);
    await expect(status(a.page, 'Synced')).toBeVisible();
    await expectDrained(a.page);
    await syncNow(b.page);
    await expect(status(b.page, 'Synced')).toBeVisible();
    await go(b.page, 'Inbox');
    await expect(pane(b.page, 'Inbox').getByText(title)).toHaveCount(1);
  } finally {
    await setServerClock('');
  }
  expect(a.errors).toEqual([]);
  expect(b.errors).toEqual([]);
});

test('a sign-in that expires while offline keeps the work done meanwhile, which goes up after signing in again', async ({ browser }) => {
  test.skip(!t.localApi, 'needs: fakeClock');
  const run = randomUUID().slice(0, 8);
  const porch = `Sweep the porch ${run}`;
  const gutters = `Clear the gutters ${run}`;
  const a = await device(browser, `e2e-${run}`);
  await signIn(a.page);

  await a.context.setOffline(true);
  try {
    // A month passes offline: the server refuses the access token and the refresh token both.
    await setServerClock(new Date(Date.now() + 31 * 24 * 3600_000).toISOString());
    await capture(a.page, porch);
    await capture(a.page, gutters);
    await go(a.page, 'Settings');
    await expect(status(a.page, 'Offline')).toBeVisible(NETWORK);
    await a.context.setOffline(false);
    await expect(status(a.page, 'Signed out')).toBeVisible(NETWORK);
    await expect(account(a.page).getByText('Sign in to sync your devices. Your work here is kept.')).toBeVisible();
  } finally {
    await setServerClock('');
  }
  await go(a.page, 'Inbox');
  for (const title of [porch, gutters]) await expect(pane(a.page, 'Inbox').getByText(title)).toBeVisible();

  await signIn(a.page);
  await expectDrained(a.page);
  const b = await device(browser, `e2e-${run}`);
  await signIn(b.page);
  await go(b.page, 'Inbox');
  for (const title of [porch, gutters]) await expect(pane(b.page, 'Inbox').getByText(title)).toHaveCount(1);
  expect(a.errors).toEqual([]);
  expect(b.errors).toEqual([]);
});

test('two devices editing through repeated drops, some mid-request, converge', async ({ browser }) => {
  test.setTimeout(180_000);
  const run = randomUUID().slice(0, 8);
  const [x, y, z] = ['x', 'y', 'z'].map((k) => `e2e-${run}-${k}`) as [string, string, string];
  const a = await device(browser, `e2e-${run}`);
  await seed(a.page, [oneOff(x, `Plan the trip ${run}`), oneOff(y, `Pack the bags ${run}`), oneOff(z, `Book the hotel ${run}`)]);
  await signIn(a.page);
  const b = await device(browser, `e2e-${run}`);
  await signIn(b.page);
  await expect.poll(async () => (await readRecord(b.page, 'task', z))?.title, NETWORK).toBe(`Book the hotel ${run}`);

  // Every third sync of each device online reaches the server and loses its answer on the way back. route.fetch goes
  // from the test rather than the browser, so it would reach the server from a device that's offline: those go no
  // further.
  const offline = new Set<typeof a>();
  for (const d of [a, b]) {
    let n = 0;
    await d.page.route(isSync, async (route) => {
      if (offline.has(d)) return route.abort('internetdisconnected');
      if (++n % 3 !== 0) return route.continue();
      return loseAnswer(route);
    });
  }
  const captured: string[] = [];
  for (let round = 1; round <= 4; round++) {
    // Each round one device drops and the other stays on, and they swap.
    const [off, on] = round % 2 ? [a, b] : [b, a];
    await off.context.setOffline(true);
    offline.add(off);
    // Both rename the same task, the device online second, so its name is the later one.
    await seed(off.page, [{ type: 'task', id: x, fields: { title: `Plan the trip ${round} offline ${run}` } }]);
    await seed(on.page, [{ type: 'task', id: x, fields: { title: `Plan the trip ${round} online ${run}` } }]);
    // Different fields of the same task, one each.
    await seed(off.page, [{ type: 'task', id: y, fields: { estimate_min: round * 15 } }]);
    await seed(on.page, [{ type: 'task', id: y, fields: { notes: `Round ${round}` } }]);
    for (const d of [off, on]) {
      const title = `Flap ${round} ${d === a ? 'a' : 'b'} ${run}`;
      await capture(d.page, title);
      captured.push(title);
    }
    await syncNow(on.page);
    await syncNow(off.page);
    await expect(status(off.page, 'Offline')).toBeVisible();
    offline.delete(off);
    await off.context.setOffline(false);
  }
  // Once both are back, one deletes z.
  await seed(b.page, [{ type: 'task', id: z, fields: { deleted_at: new Date().toISOString() } }]);

  for (const d of [a, b]) await d.page.unroute(isSync);
  for (const d of [a, b, a]) await syncNow(d.page);
  for (const d of [a, b]) await expect(status(d.page, 'Synced')).toBeVisible();
  // The same on both, field by field: the later name, both fields of y, z deleted.
  for (const id of [x, y, z]) expect(await readRecord(a.page, 'task', id)).toEqual(await readRecord(b.page, 'task', id));
  expect(await readRecord(a.page, 'task', x)).toMatchObject({ title: `Plan the trip 4 online ${run}` });
  expect(await readRecord(a.page, 'task', y)).toMatchObject({ estimate_min: 60, notes: 'Round 4' });
  expect(await readRecord(a.page, 'task', z)).toHaveProperty('deleted_at');
  for (const d of [a, b]) {
    await go(d.page, 'Inbox');
    for (const title of captured) await expect(pane(d.page, 'Inbox').getByText(title)).toHaveCount(1);
  }
  for (const d of [a, b]) await expectDrained(d.page);

  // A deployment's test user keeps nothing live.
  await go(a.page, 'Inbox');
  const inbox = pane(a.page, 'Inbox');
  await inbox.getByRole('button', { name: 'Select', exact: true }).click();
  for (const title of captured) await inbox.getByRole('checkbox', { name: title }).check();
  await inbox.getByRole('button', { name: 'Delete/done' }).click();
  await inbox.getByRole('button', { name: 'Yes, delete' }).click();
  await expect(a.page.getByText(`Deleted ${captured.length} items.`)).toBeVisible();
  await seed(a.page, [x, y].map((id) => ({ type: 'task', id, fields: { deleted_at: new Date().toISOString() } })));
  await syncNow(a.page);
  expect(a.errors).toEqual([]);
  expect(b.errors).toEqual([]);
});

test('on a slow network the app stays usable while a sync waits, and what was edited meanwhile goes next', async ({ browser }) => {
  const run = randomUUID().slice(0, 8);
  const title = `Call the plumber ${run}`;
  const a = await device(browser, `e2e-${run}`);
  await signIn(a.page);
  const b = await device(browser, `e2e-${run}`);
  await signIn(b.page);

  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  let waiting = false;
  await a.page.route(
    isSync,
    async (route) => {
      waiting = true;
      await held;
      await route.continue();
    },
    { times: 1 },
  );
  const syncButton = account(a.page).getByRole('button', { name: 'Sync now' });
  await go(a.page, 'Settings');
  await syncButton.click();
  await expect.poll(() => waiting).toBe(true);
  await expect(syncButton).toBeDisabled();
  // Meanwhile everything else works.
  await capture(a.page, title);
  await go(a.page, 'Inbox');
  await expect(pane(a.page, 'Inbox').getByText(title)).toBeVisible();
  await go(a.page, 'One offs');

  release();
  await go(a.page, 'Settings');
  await expect(syncButton).toBeEnabled(NETWORK);
  await expect(status(a.page, 'Synced')).toBeVisible();
  // Nothing more pressed here: the capture goes in a sync of its own.
  await expect
    .poll(async () => {
      await syncNow(b.page);
      await go(b.page, 'Inbox');
      return pane(b.page, 'Inbox').getByText(title).count();
    }, NETWORK)
    .toBe(1);
  await expectDrained(a.page);

  await deleteFromInbox(b.page, title);
  await syncNow(b.page);
  expect(a.errors).toEqual([]);
  expect(b.errors).toEqual([]);
});

test("when the API answers 503 or 429, sends a page that isn't the API, or times out, Settings says so, work goes on, nothing retries in a loop, and it recovers", async ({ browser }) => {
  const run = randomUUID().slice(0, 8);
  const title = `Fix the bike ${run}`;
  const a = await device(browser, `e2e-${run}`);
  await signIn(a.page);
  const b = await device(browser, `e2e-${run}`);
  await signIn(b.page);

  let answer: (route: Route) => Promise<void> = (route) => route.continue();
  const asked: Change[][] = [];
  await a.page.route(isSync, (route) => {
    asked.push(changesOf(route));
    return answer(route);
  });
  const unavailable = (route: Route) => route.fulfill({ status: 503, json: { message: 'Service Unavailable' } });
  const failures = [
    { what: 'a 503', answer: unavailable, pill: 'Not synced', line: FAILED_LINE },
    { what: 'a 429', answer: (route: Route) => route.fulfill({ status: 429, headers: { 'retry-after': '30' }, json: { message: 'Too Many Requests' } }), pill: 'Not synced', line: FAILED_LINE },
    // A Wi-Fi sign-in page answering in the API's place.
    { what: 'a captive page', answer: (route: Route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Sign in to the Wi-Fi</title>' }), pill: 'Not synced', line: FAILED_LINE },
    { what: 'a timeout', answer: (route: Route) => route.abort('timedout'), pill: 'Offline', line: OFFLINE_LINE },
  ];
  for (const failure of failures) {
    answer = failure.answer;
    const before = asked.length;
    await syncNow(a.page);
    await expect(status(a.page, failure.pill), failure.what).toBeVisible();
    await expect(account(a.page).getByText(failure.line), failure.what).toBeVisible();
    expect(asked.length - before, `${failure.what} is asked once`).toBe(1);
  }

  // While it fails, work goes on. The edit's sync, 2 s on, is the only request: nothing went in the meantime.
  answer = unavailable;
  const quiet = asked.length;
  await capture(a.page, title);
  await expect.poll(() => asked.some((changes) => changes.some((c) => c.fields.title?.v === title)), NETWORK).toBe(true);
  expect(asked.length).toBe(quiet + 1);
  await go(a.page, 'Inbox');
  await expect(pane(a.page, 'Inbox').getByText(title)).toBeVisible();

  answer = (route) => route.continue();
  await syncNow(a.page);
  await expect(status(a.page, 'Synced')).toBeVisible();
  await expectDrained(a.page);
  await syncNow(b.page);
  await go(b.page, 'Inbox');
  await expect(pane(b.page, 'Inbox').getByText(title)).toHaveCount(1);

  await deleteFromInbox(b.page, title);
  await syncNow(b.page);
  expect(a.errors).toEqual([]);
  expect(b.errors).toEqual([]);
});

test('through a deploy and a rollback mid-session the API refuses for a moment, then answers as a newer or older server, and the app carries on', async ({ browser }) => {
  const run = randomUUID().slice(0, 8);
  const title = `Mend the fence ${run}`;
  const future = `e2e-${run}-future`;
  const a = await device(browser, `e2e-${run}`);
  await signIn(a.page);
  const b = await device(browser, `e2e-${run}`);
  await signIn(b.page);

  let server: 'deploying' | 'newer' | 'rolling back' | 'older' = 'deploying';
  await a.page.route(isSync, async (route) => {
    if (server === 'deploying') return route.fulfill({ status: 502, contentType: 'text/html', body: '<html><body>502 Bad Gateway</body></html>' });
    if (server === 'rolling back') return route.abort('connectionrefused');
    if (server === 'older') return route.continue();
    // A newer server: a field this app doesn't know on its answer, and a record of a type it doesn't know, from a
    // newer app on another device.
    const response = await route.fetch();
    const body = (await response.json()) as { changes: Change[] };
    const theirs: Change = { type: 'future_thing', id: future, fields: { title: { v: 'From a newer app', c: '1767225600000-000000-newer-device' } } };
    return route.fulfill({ response, json: { ...body, notice: 'from a newer server', changes: [...body.changes, theirs] } });
  });
  await capture(a.page, title);
  await go(a.page, 'Settings');
  await expect(status(a.page, 'Not synced')).toBeVisible(NETWORK);
  await expect(account(a.page).getByText(FAILED_LINE)).toBeVisible();

  server = 'newer';
  await syncNow(a.page);
  await expect(status(a.page, 'Synced')).toBeVisible();
  expect(await readRecord(a.page, 'future_thing', future)).toMatchObject({ title: 'From a newer app' });

  server = 'rolling back';
  await syncNow(a.page);
  await expect(status(a.page, 'Offline')).toBeVisible();
  server = 'older';
  await syncNow(a.page);
  await expect(status(a.page, 'Synced')).toBeVisible();
  // What the newer server brought stays, and nothing this device made waits to send.
  expect(await readRecord(a.page, 'future_thing', future)).toMatchObject({ title: 'From a newer app' });
  await expectDrained(a.page);
  await syncNow(b.page);
  await go(b.page, 'Inbox');
  await expect(pane(b.page, 'Inbox').getByText(title)).toHaveCount(1);

  await deleteFromInbox(b.page, title);
  await syncNow(b.page);
  expect(a.errors).toEqual([]);
  expect(b.errors).toEqual([]);
});

test('Google Calendar: connecting offline says so and changes nothing; online it connects, and a refresh cut off says so and works next time', async ({ browser }) => {
  test.skip(!t.localApi, 'needs: fakeGoogle');
  const run = randomUUID().slice(0, 8);
  const a = await device(browser, `e2e-${run}`);
  await signIn(a.page);
  const calendar = pane(a.page, 'Settings').getByRole('region', { name: 'Google Calendar' });
  const unreachable = a.page.getByText("Couldn't reach the server. Try again when you're online.");

  await a.context.setOffline(true);
  await calendar.getByRole('button', { name: 'Connect' }).click();
  await expect(unreachable).toBeVisible();
  await expect(calendar.getByText('Not connected.')).toBeVisible();
  await expect(calendar.getByRole('button', { name: 'Connect' })).toBeEnabled();

  await a.context.setOffline(false);
  // The stand-in for Google consents at once and returns to the API, and the connection arrives by sync.
  const consent = a.page.waitForEvent('popup');
  await calendar.getByRole('button', { name: 'Connect' }).click();
  await (await consent).waitForLoadState();
  await expect(calendar.getByText('Connected. Blocks go to your Time blocks calendar.')).toBeVisible(NETWORK);

  await a.page.route((url) => url.pathname.endsWith('/calendar/refresh'), (route) => route.abort('connectionreset'), { times: 1 });
  await calendar.getByRole('button', { name: 'Refresh' }).click();
  await expect(unreachable).toBeVisible();
  await expect(calendar.getByText('Connected. Blocks go to your Time blocks calendar.')).toBeVisible();
  const refreshed = a.page.waitForResponse((res) => new URL(res.url()).pathname.endsWith('/calendar/refresh'));
  await calendar.getByRole('button', { name: 'Refresh' }).click();
  expect((await refreshed).ok()).toBe(true);

  await calendar.getByRole('button', { name: 'Disconnect' }).click();
  await calendar.getByRole('button', { name: 'Disconnect Google Calendar' }).click();
  await expect(calendar.getByText('Not connected.')).toBeVisible(NETWORK);
  expect(a.errors).toEqual([]);
});

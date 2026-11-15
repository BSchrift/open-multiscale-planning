import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { formatDate } from '../../src/core/dates';
import { account, go, oneOffRow, pane, readRecord, seed, setDate, syncNow } from '../seed';
import { capture, closeDevices, daysAhead, deleteFromInbox, device, NETWORK, oneOff, signIn, startSignIn } from './devices';
import { target } from './target';

// Two browser contexts are two devices of one user, each with its own database and sign-in, syncing through the
// backend. Every title carries the run's id, and what a test makes it deletes, so a deployment's test user keeps
// nothing live.

const t = target();
test.use({ baseURL: `http://localhost:${process.env.STACK_WEB_PORT}` });
test.afterEach(closeDevices);

test('two devices sign in, sync, merge edits made offline, and sync deletes', async ({ browser }) => {
  const run = randomUUID().slice(0, 8);
  const paint = `Paint the fence ${run}`;
  const oil = `Oil the hinges ${run}`;
  const brushes = `Buy brushes ${run}`;
  const boards = `Sand the boards ${run}`;
  const stamps = `Buy stamps ${run}`;
  const bank = `Call the bank ${run}`;
  const ids = [`e2e-${run}-paint`, `e2e-${run}-oil`, `e2e-${run}-stamps`, `e2e-${run}-bank`];

  // Work made before signing in goes up with the first sync.
  const a = await device(browser, `e2e-${run}`);
  await seed(a.page, [oneOff(ids[0]!, paint), oneOff(ids[1]!, oil)]);
  await capture(a.page, brushes);
  await signIn(a.page);

  const b = await device(browser, `e2e-${run}`);
  await signIn(b.page);
  // A browser keeps its sign-in, like the apps do.
  await b.page.reload();
  await go(b.page, 'Settings');
  await expect(account(b.page).getByRole('button', { name: 'Sign out' })).toBeVisible();
  await go(b.page, 'One offs');
  await expect(pane(b.page, 'One offs').getByRole('checkbox', { name: `${paint} done` })).toBeVisible();
  await expect(pane(b.page, 'One offs').getByRole('checkbox', { name: `${oil} done` })).toBeVisible();
  await go(b.page, 'Inbox');
  await expect(pane(b.page, 'Inbox').getByText(brushes)).toBeVisible();

  // Both go offline. The dev build fetches each screen the first time it opens, so open them all before.
  for (const d of [a, b]) {
    await go(d.page, 'One offs');
    await d.page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: /Capture/ }).click();
    await expect(d.page.getByRole('textbox', { name: 'Capture to Inbox' })).toBeFocused();
    await d.page.keyboard.press('Escape');
    await expect(d.page.getByRole('dialog', { name: 'Capture' })).toHaveCount(0);
    await d.context.setOffline(true);
  }
  const soon = daysAhead(10);
  const later = daysAhead(20);
  await setDate(a.page, paint, soon);
  await setDate(b.page, oil, soon);
  // The same field on both: the later edit wins everywhere.
  await setDate(b.page, paint, later);
  await capture(b.page, boards);
  await syncNow(a.page);
  await expect(account(a.page).getByText('Offline', { exact: true })).toBeVisible();
  await expect(account(a.page).getByText("Your changes are kept and sync when you're back online.")).toBeVisible();

  for (const d of [a, b]) await d.context.setOffline(false);
  for (const d of [a, b, a]) await syncNow(d.page);
  for (const d of [a, b]) {
    await expect(account(d.page).getByText('Synced', { exact: true })).toBeVisible();
    await go(d.page, 'One offs');
    await expect(oneOffRow(d.page, paint).getByText(formatDate(later), { exact: true })).toBeVisible();
    await expect(oneOffRow(d.page, oil).getByText(formatDate(soon), { exact: true })).toBeVisible();
    await go(d.page, 'Inbox');
    await expect(pane(d.page, 'Inbox').getByText(brushes)).toBeVisible();
    await expect(pane(d.page, 'Inbox').getByText(boards)).toBeVisible();
  }

  // A delete on either device reaches the other.
  await deleteFromInbox(a.page, brushes);
  await deleteFromInbox(b.page, boards);
  for (const d of [a, b, a]) await syncNow(d.page);
  for (const d of [a, b]) {
    await go(d.page, 'Inbox');
    await expect(pane(d.page, 'Inbox').getByText(brushes)).toHaveCount(0);
    await expect(pane(d.page, 'Inbox').getByText(boards)).toHaveCount(0);
  }

  // Select mode's batch, one transaction, reaches the other device whole.
  await seed(a.page, [
    { type: 'task', id: ids[2]!, fields: { kind: 'inbox', title: stamps } },
    { type: 'task', id: ids[3]!, fields: { kind: 'inbox', title: bank } },
  ]);
  await go(a.page, 'Inbox');
  const inbox = pane(a.page, 'Inbox');
  await inbox.getByRole('button', { name: 'Select', exact: true }).click();
  await inbox.getByRole('checkbox', { name: stamps }).check();
  await inbox.getByRole('checkbox', { name: bank }).check();
  await inbox.getByRole('button', { name: 'Make one offs' }).click();
  await expect(a.page.getByText('Made 2 one offs.')).toBeVisible();
  for (const d of [a, b]) await syncNow(d.page);
  await go(b.page, 'One offs');
  for (const title of [stamps, bank]) await expect(pane(b.page, 'One offs').getByRole('checkbox', { name: `${title} done` })).toBeVisible();

  // Signing out keeps this device's data and offers sign-in again.
  await go(b.page, 'Settings');
  await account(b.page).getByRole('button', { name: 'Sign out' }).click();
  await expect(account(b.page).getByText('Signed out', { exact: true })).toBeVisible();
  await expect(account(b.page).getByRole('button', { name: 'Sign in' })).toBeVisible();
  await go(b.page, 'One offs');
  await expect(oneOffRow(b.page, paint).getByText(formatDate(later), { exact: true })).toBeVisible();

  // The rest goes too, so a deployment's test user keeps nothing live.
  await seed(a.page, ids.map((id) => ({ type: 'task', id, fields: { deleted_at: new Date().toISOString() } })));
  await syncNow(a.page);
  await expect(account(a.page).getByText('Synced', { exact: true })).toBeVisible();
  await go(a.page, 'One offs');
  await expect(pane(a.page, 'One offs').getByRole('checkbox', { name: `${paint} done` })).toHaveCount(0);

  expect(a.errors).toEqual([]);
  expect(b.errors).toEqual([]);
});

test("two devices change a practice's days and its days' own times at once, and both keep each change", async ({ browser }) => {
  const run = randomUUID().slice(0, 8);
  const id = `e2e-${run}-run`;
  const title = `Morning run ${run}`;
  const a = await device(browser, `e2e-${run}`);
  await seed(a.page, [{ type: 'practice', id, fields: { title, target_min: 30, per: 'day', days: [0, 1, 4], preferred_times: [420], state: 'active' } }]);
  await signIn(a.page);
  const b = await device(browser, `e2e-${run}`);
  await signIn(b.page);
  await expect.poll(async () => (await readRecord(b.page, 'practice', id))?.title, NETWORK).toBe(title);

  // Offline, one drops Friday, and the other gives Tuesday and Friday times of their own.
  for (const d of [a, b]) await d.context.setOffline(true);
  await seed(a.page, [{ type: 'practice', id, fields: { days: [0, 1] } }]);
  await seed(b.page, [{ type: 'practice', id, fields: { day_times: [null, 480, null, null, 570, null, null] } }]);
  for (const d of [a, b]) await d.context.setOffline(false);
  for (const d of [a, b, a]) await syncNow(d.page);
  // Each field merges on its own, and the days still decide which days: Friday's time waits unused.
  for (const d of [a, b]) {
    await expect(account(d.page).getByText('Synced', { exact: true })).toBeVisible();
    expect(await readRecord(d.page, 'practice', id)).toMatchObject({ title, days: [0, 1], day_times: [null, 480, null, null, 570, null, null], preferred_times: [420] });
  }

  // A deployment's test user keeps nothing live.
  await seed(a.page, [{ type: 'practice', id, fields: { deleted_at: new Date().toISOString() } }]);
  await syncNow(a.page);
  await expect(account(a.page).getByText('Synced', { exact: true })).toBeVisible();
  expect(a.errors).toEqual([]);
  expect(b.errors).toEqual([]);
});

test('two devices offline for a week, editing the same records, converge when they reconnect', async ({ browser }) => {
  test.skip(!t.localApi, 'needs: fakeClock');
  test.setTimeout(180_000);
  const setServerClock = async (now: string) => {
    const res = await fetch(`${t.localApi}/_local/clock`, { method: 'POST', body: JSON.stringify({ now }) });
    expect(res.status).toBe(204);
  };
  const run = randomUUID().slice(0, 8);
  const lease = `Renew the lease ${run}`;
  const garage = `Sort the garage ${run}`;
  const drill = `Return the drill ${run}`;
  const ids = { lease: `e2e-${run}-lease`, garage: `e2e-${run}-garage`, drill: `e2e-${run}-drill` };
  const a = await device(browser, `e2e-${run}`);
  await seed(a.page, [oneOff(ids.lease, lease), oneOff(ids.garage, garage), oneOff(ids.drill, drill)]);
  await signIn(a.page);
  const b = await device(browser, `e2e-${run}`);
  await signIn(b.page);
  await expect.poll(async () => (await readRecord(b.page, 'task', ids.drill))?.title, NETWORK).toBe(drill);
  // One offs opens once online first: a screen first opened offline is the offline screens test's.
  for (const d of [a, b]) await go(d.page, 'One offs');

  for (const d of [a, b]) await d.context.setOffline(true);
  const inbox: string[] = [];
  try {
    // A week apart. The same date on both, the later edit winning; different fields of one task, both kept; one
    // finishes a task the other deletes; and each captures a pile of things.
    await setDate(a.page, lease, '2031-03-10');
    await setDate(b.page, lease, '2031-04-20');
    await seed(a.page, [{ type: 'task', id: ids.garage, fields: { title: `${garage} and the shed` } }]);
    await seed(b.page, [{ type: 'task', id: ids.garage, fields: { estimate_min: 90 } }]);
    await pane(a.page, 'One offs').getByRole('checkbox', { name: `${drill} done` }).click();
    await expect(a.page.getByText(`Completed ${drill}.`)).toBeVisible();
    await seed(b.page, [{ type: 'task', id: ids.drill, fields: { deleted_at: new Date().toISOString() } }]);
    for (const [d, name] of [[a, 'a'] as const, [b, 'b'] as const]) {
      for (let i = 1; i <= 3; i++) {
        await capture(d.page, `Thought ${i} on ${name} ${run}`);
        inbox.push(`Thought ${i} on ${name} ${run}`);
      }
      const seeded = Array.from({ length: 12 }, (_, i) => `Note ${i + 1} on ${name} ${run}`);
      await seed(d.page, seeded.map((title) => ({ type: 'task', fields: { kind: 'inbox', title } })));
      inbox.push(...seeded);
    }
    // A week on, both access tokens have lapsed, and the refresh tokens still work.
    await setServerClock(new Date(Date.now() + 7 * 24 * 3600_000).toISOString());
    for (const d of [a, b]) await d.context.setOffline(false);
    for (const d of [a, b, a]) await syncNow(d.page);
    for (const d of [a, b]) await expect(account(d.page).getByText('Synced', { exact: true })).toBeVisible();

    for (const id of Object.values(ids)) expect(await readRecord(a.page, 'task', id), id).toEqual(await readRecord(b.page, 'task', id));
    expect(await readRecord(a.page, 'task', ids.garage)).toMatchObject({ title: `${garage} and the shed`, estimate_min: 90 });
    expect(await readRecord(a.page, 'task', ids.drill)).toHaveProperty('deleted_at');
    for (const d of [a, b]) {
      await go(d.page, 'One offs');
      await expect(oneOffRow(d.page, lease).getByText(formatDate('2031-04-20'), { exact: true })).toBeVisible();
      await expect(pane(d.page, 'One offs').getByRole('checkbox', { name: `${drill} done` })).toHaveCount(0);
      await go(d.page, 'Inbox');
      for (const title of inbox) await expect(pane(d.page, 'Inbox').getByText(title, { exact: true })).toHaveCount(1);
    }
    // Nothing either made waits to send.
    for (const d of [a, b]) {
      const next = d.page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname.endsWith('/sync'));
      await syncNow(d.page);
      expect((await next).postDataJSON().changes).toEqual([]);
    }
  } finally {
    await setServerClock('');
  }
  expect(a.errors).toEqual([]);
  expect(b.errors).toEqual([]);
});

test('an expired sign-in shows in Settings without stopping local work', async ({ browser }) => {
  test.skip(!t.localApi, 'needs: fakeClock');
  const setServerClock = async (now: string) => {
    const res = await fetch(`${t.localApi}/_local/clock`, { method: 'POST', body: JSON.stringify({ now }) });
    expect(res.status).toBe(204);
  };
  const run = randomUUID().slice(0, 8);
  const porch = `Sweep the porch ${run}`;
  const a = await device(browser, `e2e-${run}`);
  await signIn(a.page);

  try {
    // A month on, the server refuses the access token and the refresh token both.
    await setServerClock(new Date(Date.now() + 31 * 24 * 3600_000).toISOString());
    await syncNow(a.page);
    await expect(account(a.page).getByText('Signed out', { exact: true })).toBeVisible();
    await expect(account(a.page).getByText('Sign in to sync your devices. Your work here is kept.')).toBeVisible();
  } finally {
    await setServerClock('');
  }

  // Nothing blocks local work, and it syncs after signing in again.
  await capture(a.page, porch);
  await go(a.page, 'Inbox');
  await expect(pane(a.page, 'Inbox').getByText(porch)).toBeVisible();
  await signIn(a.page);
  const b = await device(browser, `e2e-${run}`);
  await signIn(b.page);
  await go(b.page, 'Inbox');
  await expect(pane(b.page, 'Inbox').getByText(porch)).toBeVisible();

  expect(a.errors).toEqual([]);
  expect(b.errors).toEqual([]);
});

test("signing in as another account asks first: Cancel keeps this device's data, Erase brings the other account's", async ({ browser }) => {
  test.skip(!t.localApi, 'needs: a second user');
  const run = randomUUID().slice(0, 8);
  const first = `e2e-${run}-a@example.com`;
  const second = `e2e-${run}-b@example.com`;
  const report = `Write the report ${run}`;
  const bread = `Learn to bake bread ${run}`;
  const fence = `Paint the fence ${run}`;

  // The second account already has its own data, from another device.
  const theirs = await device(browser, second);
  await capture(theirs.page, fence);
  await signIn(theirs.page);

  // This device's data is the first account's, with one change made after signing out.
  const d = await device(browser, first);
  await capture(d.page, report);
  await signIn(d.page);
  await account(d.page).getByRole('button', { name: 'Sign out' }).click();
  await expect(account(d.page).getByText('Signed out', { exact: true })).toBeVisible();
  await capture(d.page, bread);

  d.user = second;
  await startSignIn(d.page);
  const ask = d.page.getByRole('dialog', { name: 'Switch accounts' });
  await expect(
    ask.getByText(`This device has data from another account. Signing in as ${second} erases it from this device; it stays in the other account.`),
  ).toBeVisible(NETWORK);
  await expect(ask.getByText("1 change hasn't synced and will be lost.")).toBeVisible();
  await ask.getByRole('button', { name: 'Cancel' }).click();
  await expect(ask).toHaveCount(0);
  await expect(account(d.page).getByText('Signed out', { exact: true })).toBeVisible();
  await go(d.page, 'Inbox');
  await expect(pane(d.page, 'Inbox').getByText(report)).toBeVisible();
  await expect(pane(d.page, 'Inbox').getByText(bread)).toBeVisible();
  await expect(pane(d.page, 'Inbox').getByText(fence)).toHaveCount(0);

  await startSignIn(d.page);
  await ask.getByRole('button', { name: 'Erase and sign in' }).click();
  await expect(ask).toHaveCount(0);
  await go(d.page, 'Inbox');
  await expect(pane(d.page, 'Inbox').getByText(fence)).toBeVisible(NETWORK);
  await expect(pane(d.page, 'Inbox').getByText(report)).toHaveCount(0);
  await expect(pane(d.page, 'Inbox').getByText(bread)).toHaveCount(0);
  await syncNow(d.page);
  await expect(account(d.page).getByText('Synced', { exact: true })).toBeVisible();

  // The first account still has what it synced, and nothing from here went to the second.
  const again = await device(browser, first);
  await signIn(again.page);
  await go(again.page, 'Inbox');
  await expect(pane(again.page, 'Inbox').getByText(report)).toBeVisible();
  await expect(pane(again.page, 'Inbox').getByText(bread)).toHaveCount(0);
  await syncNow(theirs.page);
  await go(theirs.page, 'Inbox');
  await expect(pane(theirs.page, 'Inbox').getByText(fence)).toBeVisible();
  await expect(pane(theirs.page, 'Inbox').getByText(report)).toHaveCount(0);
  await expect(pane(theirs.page, 'Inbox').getByText(bread)).toHaveCount(0);

  for (const x of [theirs, d, again]) expect(x.errors).toEqual([]);
});

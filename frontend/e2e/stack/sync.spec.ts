import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { formatDate } from '../../src/core/dates';
import { account, go, oneOffRow, openSeeded, pane, seed, setDate, syncNow } from '../seed';
import { target } from './target';

// Two browser contexts are two devices of one user, each with its own database and sign-in, syncing through the
// backend. Every title carries the run's id, and what a test makes it deletes, so a deployment's test user keeps
// nothing live.

const t = target();
test.use({ baseURL: `http://localhost:${process.env.STACK_WEB_PORT}` });
// A deployment's sign-in page and sync take longer than the local stack's.
const NETWORK = { timeout: 30_000 };

// Closed after each test, so one test's devices don't keep syncing into the next.
const contexts: BrowserContext[] = [];
test.afterEach(async () => {
  for (const context of contexts.splice(0)) await context.close();
});

interface Device {
  context: BrowserContext;
  page: Page;
  errors: string[];
  /** Locally, who the next sign-in is. */
  user: string;
}

/** A device past first-run setup, signed out. */
async function device(browser: Browser, user: string): Promise<Device> {
  const context = await browser.newContext();
  contexts.push(context);
  const page = await context.newPage();
  const d: Device = { context, page, errors: [], user };
  if (t.localApi) {
    // The local sign-in lets anyone in, as the username in the query.
    await context.route(
      (url) => url.href.startsWith(`${t.localApi}/cognito/oauth2/authorize?`),
      (route) => route.continue({ url: `${route.request().url()}&username=${encodeURIComponent(d.user)}` }),
    );
  }
  page.on('pageerror', (error) => d.errors.push(error.message));
  await openSeeded(page);
  return d;
}

/** Signs in from Settings: the sign-in page opens in its own tab, which returns here and closes. */
async function startSignIn(page: Page) {
  await go(page, 'Settings');
  const opened = page.waitForEvent('popup');
  await account(page).getByRole('button', { name: 'Sign in' }).click();
  const popup = await opened;
  if (t.user) {
    // The hosted sign-in page has a wide and a narrow form, and shows one.
    await popup.locator('input[name=username]:visible').fill(t.user.username);
    await popup.locator('input[name=password]:visible').fill(t.user.password);
    await popup.locator('input[name=signInSubmitButton]:visible').click();
  }
  await expect.poll(() => popup.isClosed(), NETWORK).toBe(true);
}

/** Signs in, and a sync follows. */
async function signIn(page: Page) {
  await startSignIn(page);
  await expect(account(page).getByText('Synced', { exact: true })).toBeVisible(NETWORK);
}

async function capture(page: Page, title: string) {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: /Capture/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Capture' });
  await dialog.getByRole('textbox', { name: 'Capture to Inbox' }).fill(title);
  await dialog.getByRole('textbox', { name: 'Capture to Inbox' }).press('Enter');
  await expect(dialog).toHaveCount(0);
}

async function deleteFromInbox(page: Page, title: string) {
  await go(page, 'Inbox');
  await pane(page, 'Inbox').getByRole('button', { name: `Assign ${title}` }).click();
  const card = page.getByRole('dialog', { name: 'Process Inbox' });
  await expect(card.getByRole('heading', { name: title, level: 1 })).toBeVisible();
  await card.getByRole('button', { name: 'Delete' }).click();
  await card.getByRole('button', { name: 'Yes, delete' }).click();
  await expect(card.getByRole('heading', { name: title })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(card).toHaveCount(0);
}

/** A local date some days from now. */
function daysAhead(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const oneOff = (id: string, title: string) => ({ type: 'task', id, fields: { kind: 'one_off', title, schedule: { type: 'once' } } });

test('two devices sign in, sync, merge edits made offline, and sync deletes', async ({ browser }) => {
  const run = randomUUID().slice(0, 8);
  const paint = `Paint the fence ${run}`;
  const oil = `Oil the hinges ${run}`;
  const brushes = `Buy brushes ${run}`;
  const boards = `Sand the boards ${run}`;
  const ids = [`e2e-${run}-paint`, `e2e-${run}-oil`];

  // Work made before signing in goes up with the first sync.
  const a = await device(browser, `e2e-${run}`);
  await seed(a.page, [oneOff(ids[0]!, paint), oneOff(ids[1]!, oil)]);
  await capture(a.page, brushes);
  await signIn(a.page);

  const b = await device(browser, `e2e-${run}`);
  await signIn(b.page);
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

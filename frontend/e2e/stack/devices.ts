// Browser devices of one user, signing in to the backend target() names, and the steps the signed-in specs share.

import { expect } from '@playwright/test';
import type { Browser, BrowserContext, BrowserContextOptions, Page } from '@playwright/test';
import { account, go, openSeeded, pane } from '../seed';
import { target } from './target';

const t = target();
// A deployment's sign-in page and sync take longer than the local stack's.
export const NETWORK = { timeout: 30_000 };

const contexts: BrowserContext[] = [];
/** Closes every device opened since the last call, so one test's devices don't keep syncing into the next. */
export async function closeDevices() {
  for (const context of contexts.splice(0)) await context.close();
}

export interface Device {
  context: BrowserContext;
  page: Page;
  errors: string[];
  /** Locally, who the next sign-in is. */
  user: string;
}

/** A device past first-run setup, signed out. Each is a browser context of its own, with its own database. */
export async function device(browser: Browser, user: string, options: BrowserContextOptions = {}): Promise<Device> {
  const context = await browser.newContext(options);
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
export async function startSignIn(page: Page) {
  await go(page, 'Settings');
  const opened = page.waitForEvent('popup');
  await account(page).getByRole('button', { name: 'Sign in' }).click();
  const popup = await opened;
  // The local stand-in never asks.
  if (t.user && (await asksToSignIn(popup))) {
    // The hosted sign-in page has a wide and a narrow form, and shows one.
    await popup.locator('input[name=username]:visible').fill(t.user.username);
    await popup.locator('input[name=password]:visible').fill(t.user.password);
    await popup.locator('input[name=signInSubmitButton]:visible').click();
  }
  await expect.poll(() => popup.isClosed(), NETWORK).toBe(true);
}

/**
 * Whether the hosted sign-in page shows its form. It doesn't while this browser is still signed in to it from an earlier
 * sign-in, even one whose tokens never arrived: it returns to the app at once, and the tab closes without asking.
 */
function asksToSignIn(popup: Page): Promise<boolean> {
  // The wait for the form ends as soon as the tab closes. If the tab neither shows it nor closes, the wait for the tab
  // to close fails the test.
  return popup.locator('input[name=username]:visible').waitFor(NETWORK).then(() => true, () => false);
}

/**
 * Deletes the signed-in account from Settings, as the person does: the page that says what goes, a sign-in again, and
 * DELETE typed. Ends on first-run setup, which says the account was deleted.
 */
export async function deleteAccount(page: Page, options: { signInAgain?: boolean; screenshot?: string } = {}) {
  await account(page).getByRole('button', { name: 'Delete my account and data' }).click();
  const p = pane(page, 'Settings');
  await expect(p.getByRole('heading', { name: 'Delete my account and data', level: 1 })).toBeVisible();
  // It names the account it deletes: the one this device's data belongs to.
  await expect(p.getByText(/^This deletes the account \S+ and everything in it/)).toBeVisible(NETWORK);
  if (options.signInAgain) {
    const field = p.getByRole('textbox', { name: 'Type DELETE to confirm' });
    await expect(field).toBeDisabled();
    // The sign-in page asks again, even while the browser is still signed in to it.
    const asked = page.context().waitForEvent('request', (r) => r.url().includes('/oauth2/authorize?') && new URL(r.url()).searchParams.get('prompt') === 'login');
    const opened = page.waitForEvent('popup');
    await p.getByRole('button', { name: 'Sign in again' }).click();
    await asked;
    const popup = await opened;
    await expect.poll(() => popup.isClosed(), NETWORK).toBe(true);
  }
  await expect(p.getByText(/signed in recently enough to delete/)).toBeVisible(NETWORK);
  await p.getByRole('textbox', { name: 'Type DELETE to confirm' }).fill('DELETE');
  if (options.screenshot) await page.screenshot({ path: options.screenshot, fullPage: true });
  await p.getByRole('button', { name: 'Delete my account and data' }).click();
  await expect(page.getByText(DELETED)).toBeVisible(NETWORK);
}

/** What first-run setup says on a device whose account was deleted. */
export const DELETED = 'Your account and its data were deleted, from Multiscale and from this device.';

/** Signs in, and a sync follows. */
export async function signIn(page: Page) {
  await startSignIn(page);
  await expect(account(page).getByText('Synced', { exact: true })).toBeVisible(NETWORK);
}

export async function capture(page: Page, title: string) {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: /Capture/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Capture' });
  await dialog.getByRole('textbox', { name: 'Capture to Inbox' }).fill(title);
  await dialog.getByRole('textbox', { name: 'Capture to Inbox' }).press('Enter');
  await expect(dialog).toHaveCount(0);
}

export async function deleteFromInbox(page: Page, title: string) {
  await go(page, 'Inbox');
  await pane(page, 'Inbox').getByRole('button', { name: `Assign ${title}` }).click();
  const card = page.getByRole('dialog', { name: 'Process Inbox' });
  await expect(card.getByRole('heading', { name: title, level: 1 })).toBeVisible();
  // The last release, which the compat suite runs beside this one, calls Delete "Delete/done".
  await card.getByRole('button', { name: /^Delete(\/done)?( |$)/ }).click();
  await card.getByRole('button', { name: 'Yes, delete' }).click();
  await expect(card.getByRole('heading', { name: title })).toHaveCount(0);
  // Process closes by itself after the last item; otherwise Exit.
  if (await card.count()) await card.getByRole('button', { name: 'Exit' }).click();
  await expect(card).toHaveCount(0);
}

/** A local date some days from now. */
export function daysAhead(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export const oneOff = (id: string, title: string) => ({ type: 'task', id, fields: { kind: 'one_off', title, schedule: { type: 'once' } } });

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
  if (t.user) {
    // The hosted sign-in page has a wide and a narrow form, and shows one.
    await popup.locator('input[name=username]:visible').fill(t.user.username);
    await popup.locator('input[name=password]:visible').fill(t.user.password);
    await popup.locator('input[name=signInSubmitButton]:visible').click();
  }
  await expect.poll(() => popup.isClosed(), NETWORK).toBe(true);
}

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
  await card.getByRole('button', { name: 'Delete/done' }).click();
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

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { account, pane, readRecord, seed, syncNow } from '../seed';
import { closeDevices, DELETED, deleteAccount, device, NETWORK, oneOff, signIn } from './devices';
import { target } from './target';

// Export my data and Delete my account and data, at desktop and phone sizes, against the local stack: each test signs
// in as someone new, which only the local stand-in for sign-in can make. A deployment's test user can't be deleted, and
// the integration suite exports it.

const t = target();
test.use({ baseURL: `http://localhost:${process.env.STACK_WEB_PORT}` });
test.afterEach(closeDevices);

const sizes = {
  desktop: { viewport: { width: 1360, height: 1000 } },
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
};

async function openSettings(page: Page, phone: boolean) {
  const nav = page.getByRole('navigation', { name: 'Main' });
  if (phone) {
    await nav.getByRole('button', { name: 'More' }).click();
    await page.getByRole('button', { name: /^Settings/ }).click();
  } else {
    await nav.getByRole('button', { name: 'Settings' }).click();
  }
  await expect(pane(page, 'Settings').getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
}

/** Signs in from Settings at either size: the stand-in's page returns at once, and the tab closes. */
async function signInHere(page: Page, phone: boolean) {
  await openSettings(page, phone);
  const opened = page.waitForEvent('popup');
  await account(page).getByRole('button', { name: 'Sign in' }).click();
  const popup = await opened;
  await expect.poll(() => popup.isClosed(), NETWORK).toBe(true);
  await expect(account(page).getByText('Synced', { exact: true })).toBeVisible(NETWORK);
}

const setServerClock = async (now: string) => {
  const res = await fetch(`${t.localApi}/_local/clock`, { method: 'POST', body: JSON.stringify({ now }) });
  expect(res.status).toBe(204);
};

const unzip = (file: string, entry: string) => execFileSync('unzip', ['-p', file, entry], { encoding: 'utf8' });

for (const [size, options] of Object.entries(sizes)) {
  const phone = size === 'phone';

  test(`${size}: Export my data downloads a zip of everything the account has`, async ({ browser }) => {
    test.skip(!t.localApi, 'The account specs make their own users, which only the local stack can');
    const run = randomUUID().slice(0, 8);
    const paint = { id: `e2e-${run}-paint`, title: `Paint the fence ${run}` };
    const d = await device(browser, `e2e-${run}`, options);
    await seed(d.page, [oneOff(paint.id, paint.title)]);
    await signInHere(d.page, phone);

    const downloaded = d.page.waitForEvent('download', { timeout: 60_000 });
    await account(d.page).getByRole('button', { name: 'Export my data' }).click();
    await expect(account(d.page).getByText('Preparing your export. It can take a few minutes.')).toBeVisible();
    const download = await downloaded;
    expect(download.suggestedFilename()).toMatch(/^multiscale-export-\d{4}-\d{2}-\d{2}\.zip$/);
    const file = test.info().outputPath('export.zip');
    await download.saveAs(file);
    await expect(d.page.getByText('Your export is ready and downloading.')).toBeVisible();

    const tasks = JSON.parse(unzip(file, 'records/task.json')) as { id: string; title?: string }[];
    expect(tasks.find((task) => task.id === paint.id)?.title).toBe(paint.title);
    // Settings came with it, and the guide to all of it.
    expect(JSON.parse(unzip(file, 'records/settings.json'))).toHaveLength(1);
    expect(unzip(file, 'README.md')).toContain('records/');
    expect(d.errors).toEqual([]);
  });

  test(`${size}: Delete my account and data takes a fresh sign-in and DELETE, and a second device erases its copy`, async ({ browser }) => {
    test.skip(!t.localApi, 'The account specs make their own users, which only the local stack can');
    test.setTimeout(150_000);
    const run = randomUUID().slice(0, 8);
    const user = `e2e-${run}`;
    const paint = { id: `e2e-${run}-paint`, title: `Paint the fence ${run}` };
    // Signed in 11 minutes ago by the server's clock: too long ago to delete without signing in again.
    await setServerClock(new Date(Date.now() - 11 * 60_000).toISOString());
    try {
      const a = await device(browser, user, options);
      await seed(a.page, [oneOff(paint.id, paint.title)]);
      await signInHere(a.page, phone);
      const b = await device(browser, user);
      await signIn(b.page);
      await expect.poll(async () => (await readRecord(b.page, 'task', paint.id))?.title, NETWORK).toBe(paint.title);
      await setServerClock('');

      await deleteAccount(a.page, { signInAgain: true, screenshot: test.info().outputPath('delete-page.png') });
      // This device starts over, holding nothing of the account.
      expect(await readRecord(a.page, 'task', paint.id)).toBeUndefined();
      await a.page.screenshot({ path: test.info().outputPath('deleted.png'), fullPage: true });

      // The other device's next sync erases its copy too.
      await syncNow(b.page);
      await expect(b.page.getByText(DELETED)).toBeVisible(NETWORK);
      expect(await readRecord(b.page, 'task', paint.id)).toBeUndefined();
      expect(a.errors).toEqual([]);
      expect(b.errors).toEqual([]);
    } finally {
      await setServerClock('');
    }
  });
}

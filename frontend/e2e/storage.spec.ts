// Where the browser build keeps its data: SQLite on the origin private file system (OPFS), written as each change
// commits, with a copy of the file kept in IndexedDB for a bundle from before OPFS (platform/web.ts). WebKit has no
// OPFS in Playwright's ephemeral contexts, as Safari has none in a private window, so these specs open a profile on disk.
// Playwright's WebKit keeps OPFS outside the profile, shared by every profile, so these run one at a time, each from an
// empty OPFS.

import { expect, test } from '@playwright/test';
import type { BrowserContext, Page, PlaywrightWorkerArgs, PlaywrightWorkerOptions, TestInfo } from '@playwright/test';
import { openSeeded, pane } from './seed';
import type { Seed } from './seed';

test.describe.configure({ mode: 'default' });

const phone = (info: TestInfo) => info.project.name === 'phone';

/** A new browser profile on disk, with the project's device, and no page open. */
async function profile(playwright: PlaywrightWorkerArgs['playwright'], browserName: PlaywrightWorkerOptions['browserName'], info: TestInfo): Promise<BrowserContext> {
  const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch, baseURL } = info.project.use;
  const context = await playwright[browserName].launchPersistentContext(info.outputPath('profile'), { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch, baseURL });
  // From a file that doesn't start the app, so nothing holds OPFS.
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto('/favicon.png');
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    for await (const name of root.keys()) await root.removeEntry(name, { recursive: true });
  });
  await page.close();
  return context;
}

/** A page that acts as a browser without OPFS, or a bundle from before it: the database lives in IndexedDB. */
async function withoutOpfs(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.addInitScript(() => Object.defineProperty(navigator.storage, 'getDirectory', { value: undefined }));
  return page;
}

/** Whether the page's origin keeps a database on OPFS. False where the page can't reach OPFS. */
const onOpfs = (page: Page) =>
  page.evaluate(async () => {
    try {
      await (await navigator.storage.getDirectory()).getDirectoryHandle('.opfs-sahpool');
      return true;
    } catch {
      return false;
    }
  });

async function capture(page: Page, title: string, info: TestInfo) {
  await (phone(info) ? page.getByRole('button', { name: 'Capture a task' }) : page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: /Capture/ })).click();
  const dialog = page.getByRole('dialog', { name: 'Capture' });
  await dialog.getByRole('textbox', { name: 'Capture to Inbox' }).fill(title);
  if (phone(info)) await dialog.getByRole('button', { name: 'Save' }).click();
  else await dialog.getByRole('textbox', { name: 'Capture to Inbox' }).press('Enter');
  await expect(dialog).toHaveCount(0);
}

async function expectInInbox(page: Page, titles: string[]) {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: /^Inbox/ }).click();
  for (const title of titles) await expect(pane(page, 'Inbox').getByText(title, { exact: true })).toBeVisible();
}

/** Opens the app on a page, and waits for the database. */
async function launch(page: Page, titles: string[]) {
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  await expectInInbox(page, titles);
}

test('an edit survives a reload straight after it', async ({ playwright, browserName }, info) => {
  const context = await profile(playwright, browserName, info);
  const page = await context.newPage();
  await openSeeded(page);
  await capture(page, 'Return the books', info);
  await page.reload();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  await expectInInbox(page, ['Return the books']);
  expect(await onOpfs(page)).toBe(true);
  await context.close();
});

test('an edit saves in under 50 ms with a few thousand records', async ({ playwright, browserName }, info) => {
  const context = await profile(playwright, browserName, info);
  const page = await context.newPage();
  const many: Seed[] = Array.from({ length: 3000 }, (_, i) => ({ type: 'task', fields: { kind: 'one_off', title: `One off ${i}`, estimate_min: 30, schedule: { type: 'once' } } }));
  await openSeeded(page, many);
  // Each through the app's own write path, the one every screen's edits take. The median, on a shared machine.
  const times = await page.evaluate(async () => {
    const write = (window as unknown as { multiscaleSeed(r: readonly Seed[]): Promise<void> }).multiscaleSeed;
    const out: number[] = [];
    for (let i = 0; i < 7; i++) {
      const start = performance.now();
      await write([{ type: 'task', fields: { kind: 'inbox', title: `Timed ${i}` } }]);
      out.push(performance.now() - start);
    }
    return out;
  });
  // Saved, not only applied: a reload straight after keeps every one.
  await page.reload();
  await launch(page, ['Timed 0', 'Timed 6']);
  const median = [...times].sort((a, b) => a - b)[3]!;
  info.annotations.push({ type: 'edit times', description: `${times.map((t) => t.toFixed(1)).join(', ')} ms` });
  expect(median, `edits took ${times.map((t) => t.toFixed(1)).join(', ')} ms`).toBeLessThan(50);
  await context.close();
});

test('opens the IndexedDB file a bundle from before OPFS kept, and keeps it current for a rollback', async ({ playwright, browserName }, info) => {
  // It opens the app four times, which beside the other specs can take longer than one test's usual time.
  test.slow();
  const context = await profile(playwright, browserName, info);
  // Without OPFS, this bundle stores as the one before it did: in IndexedDB, 200ms after a change.
  let page = await withoutOpfs(context);
  await openSeeded(page, [{ type: 'task', fields: { kind: 'inbox', title: 'Ask about the boiler' } }]);
  await capture(page, 'Before the update', info);
  await page.waitForTimeout(600);
  await page.close();

  // This one moves the data to OPFS, and copies each change back to IndexedDB soon after.
  page = await context.newPage();
  await launch(page, ['Ask about the boiler', 'Before the update']);
  expect(await onOpfs(page)).toBe(true);
  await capture(page, 'After the update', info);
  await page.waitForTimeout(600);
  await page.close();

  // Rolled back, the bundle before finds that change, and makes one of its own.
  page = await withoutOpfs(context);
  await launch(page, ['Before the update', 'After the update']);
  await capture(page, 'During the rollback', info);
  await page.waitForTimeout(600);
  await page.close();

  // Updated again, this one takes the copy the bundle before changed, rather than its own older database.
  page = await context.newPage();
  await launch(page, ['Before the update', 'After the update', 'During the rollback']);
  await context.close();
});

test('without OPFS, keeps the database in IndexedDB as before', async ({ context }, info) => {
  // Phone runs WebKit, whose ephemeral contexts have no OPFS for the worker, as in a private window in Safari.
  const page = phone(info) ? await context.newPage() : await withoutOpfs(context);
  await openSeeded(page);
  await capture(page, 'Return the books', info);
  // It saves the whole file 200ms after a change, as the browser build did before OPFS.
  await page.waitForTimeout(600);
  await page.reload();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  await expectInInbox(page, ['Return the books']);
  expect(await onOpfs(page)).toBe(false);
});

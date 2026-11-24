import { expect, test } from '@playwright/test';
import { signIn, standInApi } from './api';
import { openSeeded, seed } from './seed';

test('one tab at a time: a second says so, and opens once the first is closed', async ({ page, context }) => {
  await openSeeded(page);
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  const second = await context.newPage();
  await second.goto('/');
  await expect(second.getByText('Multiscale is open in another tab.')).toBeVisible();
  await page.close();
  await second.reload();
  await expect(second.getByRole('navigation', { name: 'Main' })).toBeVisible();
});

// WebKit refuses a request started while a reload is under way, before the next page shows, and reports it as a page
// error even though the app handles it: "Fetch API cannot load ... due to access control checks."
test('signed in, starts no sync while the page reloads', async ({ page, context, baseURL }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const api = await standInApi(context, baseURL!);
  await openSeeded(page);
  // Its screen loaded, as a module of its own, so the reload cancels none.
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  await signIn(page);
  // An edit syncs 2 seconds later, and the reloaded page takes 3 to come, so that sync would start during the reload.
  await seed(page, [{ type: 'task', fields: { kind: 'inbox', title: 'Paint the fence' } }]);
  await page.route('/', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    await route.continue();
  });
  await page.reload();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  // The reloaded page syncs at launch: the sign-in held, so the old page's sync would have run.
  await expect.poll(() => api.syncs).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

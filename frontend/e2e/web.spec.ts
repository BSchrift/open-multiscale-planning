import { expect, test } from '@playwright/test';
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
  // A stand-in for the API, with nothing new for each sync.
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type' };
  let syncs = 0;
  await context.route(
    (url) => url.origin !== new URL(baseURL!).origin,
    (route) => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      if (route.request().url().endsWith('/sync')) syncs++;
      return route.fulfill({ headers: cors, contentType: 'application/json', body: JSON.stringify({ cursor: 0, more: false, changes: [] }) });
    },
  );
  await openSeeded(page);
  // Its screen loaded, as a module of its own, so the reload cancels none.
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  // Signed in, as the account the token names.
  const token = ['e30', Buffer.from(JSON.stringify({ sub: 'e2e-user' })).toString('base64url'), 'signature'].join('.');
  await page.evaluate(async (session) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open('multiscale-dev', 1);
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction('files', 'readwrite');
      tx.objectStore('files').put(session, 'token:auth.session');
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }, JSON.stringify({ access_token: token, refresh_token: null, expires_at: Date.now() + 3_600_000 }));
  // An edit syncs 2 seconds later, and the reloaded page takes 3 to come, so that sync would start during the reload.
  await seed(page, [{ type: 'task', fields: { kind: 'inbox', title: 'Paint the fence' } }]);
  await page.route('/', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    await route.continue();
  });
  await page.reload();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  // The reloaded page syncs at launch: the sign-in held, so the old page's sync would have run.
  await expect.poll(() => syncs).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

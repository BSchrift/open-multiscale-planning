// The checks a person would make by hand after a release, against the deployment itself: it serves the version
// released, behind its security policy; the test user signs in through the hosted page and stays signed in; a second
// tab is refused; and on desktop, work goes from Capture to the calendar and back. scripts/test-deployed.sh runs it.

import { expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { deployed } from './target';

const d = deployed();
const NETWORK = { timeout: 60_000 };

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let page: Page;
const problems: string[] = [];

// One signed-in page for the whole file, as a person would keep one tab.
test.beforeAll(async ({ browser }, info) => {
  const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch, baseURL } = info.project.use;
  context = await browser.newContext({ viewport, userAgent, deviceScaleFactor, isMobile, hasTouch, baseURL });
  await context.addInitScript(() =>
    document.addEventListener('securitypolicyviolation', (e) => console.error(`CSP blocked ${e.violatedDirective} ${e.blockedURI}`)),
  );
  context.on('page', (p) => {
    p.on('console', (m) => {
      // A second tab is refused on purpose, below.
      if (m.type() === 'error' && !/InAnotherTab|Startup failed/.test(m.text())) problems.push(m.text().slice(0, 200));
    });
    p.on('pageerror', (e) => problems.push(`pageerror ${e.message.slice(0, 200)}`));
  });
  page = await context.newPage();
});

test.afterAll(() => context?.close());

test('serves the version released, its pages with the security policy, and assets that cache for good', async () => {
  for (const path of ['/', '/auth/callback', '/version.json']) {
    const r = await page.request.get(path);
    expect(r.status(), path).toBe(200);
    expect(r.headers()['content-security-policy'], path).toBeTruthy();
    expect(r.headers()['cache-control'], path).toContain('no-cache');
  }
  const { version } = (await (await page.request.get('/version.json')).json()) as { version: string };
  if (d.version) expect(version).toBe(d.version);
  const asset = (await (await page.request.get('/')).text()).match(/assets\/[^"]+\.js/)?.[0];
  expect(asset).toBeTruthy();
  const a = await page.request.get(`/${asset}`);
  expect(a.status()).toBe(200);
  expect(a.headers()['cache-control']).toContain('immutable');
});

test('signs in through the hosted page as the test user, and stays signed in after a reload', async () => {
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'Main' });
  const signIn = page.getByRole('button', { name: 'Sign in' }).first();
  await expect(nav.or(signIn)).toBeVisible(NETWORK);
  if (await signIn.isVisible()) {
    // The browser build has no Skip at sign-in: it has nowhere to keep work without an account.
    expect(await page.getByRole('button', { name: 'Skip' }).count()).toBe(0);
    const opened = page.waitForEvent('popup');
    await signIn.click();
    const popup = await opened;
    // The hosted sign-in page has a wide and a narrow form, and shows one.
    await popup.locator('input[name=username]:visible').fill(d.user.username);
    await popup.locator('input[name=password]:visible').fill(d.user.password);
    await popup.locator('input[name=signInSubmitButton]:visible').click();
    await expect.poll(() => popup.isClosed(), NETWORK).toBe(true);
    // A browser new to the account goes through first-run setup: Next, Skip the calendar, Next, Skip a first goal.
    for (let i = 0; i < 8 && !(await nav.isVisible()); i++) {
      const go = page.getByRole('button', { name: /^(Next|Skip)$/ }).first();
      if (await go.isVisible()) await go.click();
      await page.waitForTimeout(1500);
    }
  }
  await expect(nav).toBeVisible(NETWORK);
  // The browser build saves 200ms after a change, and a reload sooner loses it.
  await page.waitForTimeout(1000);
  await page.reload();
  await expect(nav).toBeVisible(NETWORK);
});

test('a second tab is refused while the first holds the database', async () => {
  const second = await context.newPage();
  await second.goto('/');
  await expect(second.getByText('Multiscale is open in another tab.')).toBeVisible({ timeout: 15_000 });
  await second.close();
});

test('work goes from Capture to this week, onto the calendar by suggestion and by drag, back off, and done', async ({}, info) => {
  test.skip(info.project.name !== 'desktop', 'The mouse journey is the desktop layout; phone is covered by the local suites');
  const nav = page.getByRole('navigation', { name: 'Main' });
  const title = `Deployed check ${new Date().toISOString().slice(11, 19)}`;

  await nav.getByRole('button', { name: /Capture/ }).click();
  const field = page.getByRole('dialog', { name: 'Capture' }).getByRole('textbox', { name: 'Capture to Inbox' });
  await field.fill(title);
  await field.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Capture' })).toHaveCount(0);

  // Process: Add to this week picks it for the week, and puts nothing on the calendar.
  await nav.getByRole('button', { name: /Inbox/ }).click();
  await page.getByRole('button', { name: `Assign ${title}` }).click();
  await page.getByRole('button', { name: 'Add to this week' }).click();
  await page.getByRole('button', { name: 'One offs, add to this week' }).click();
  await expect(page.getByText('Sent to One offs and added to this week, not on the calendar yet.')).toBeVisible();
  await page.keyboard.press('Escape');

  // Week: it waits in To schedule; a suggestion places it, and Undo brings it back.
  await nav.getByRole('button', { name: 'Week' }).click();
  const lane = page.getByRole('region', { name: 'To schedule' });
  const card = lane.getByRole('button', { name: `${title}, One off, 30m, to schedule` });
  await expect(card).toBeVisible();
  await card.click();
  await page.getByRole('group', { name: title }).getByRole('group', { name: 'Suggested times' }).getByRole('button').first().click();
  await expect(card).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(card).toBeVisible();

  // Dragged by the mouse onto the last day, it's placed there.
  const day = (await page.locator('[data-drop-date]').last().boundingBox())!;
  const from = (await card.boundingBox())!;
  await page.mouse.move(from.x + 20, from.y + 10);
  await page.mouse.down();
  await page.mouse.move(day.x + day.width / 2, day.y + 26 * 13 + 2, { steps: 10 });
  await page.mouse.up();
  await expect(card).toHaveCount(0);
  const placed = page.getByRole('button', { name: new RegExp(`^${title}, .* One off\\.`) });
  await expect(placed).toBeVisible();

  // While editing, dragged back onto To schedule, it comes off the calendar.
  if (!(await page.getByRole('button', { name: "Edit this week's plan" }).count())) await page.getByRole('button', { name: 'Skip for now' }).click();
  await page.getByRole('button', { name: "Edit this week's plan" }).click();
  const block = page.getByRole('group', { name: new RegExp(`^${title}, `) });
  const box = (await block.boundingBox())!;
  const target = (await lane.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 6);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + 12, { steps: 10 });
  await page.mouse.up();
  await expect(block).toHaveCount(0);
  await expect(card).toBeVisible();
  await page.getByRole('button', { name: 'Done editing' }).click();

  // Marked done, it leaves; earlier checks left in the Inbox go too.
  await card.click();
  await page.getByRole('group', { name: title }).getByRole('button', { name: 'Mark done' }).click();
  await expect(card).toHaveCount(0);
  await nav.getByRole('button', { name: /Inbox/ }).click();
  for (let left = page.getByRole('button', { name: /^Assign (Deployed|Staging) check / }); await left.count(); ) {
    await left.first().click();
    await page.getByRole('button', { name: 'Delete/done' }).click();
    await page.getByRole('button', { name: 'Yes, delete' }).click();
    await page.keyboard.press('Escape');
  }
});

test('reports no console errors or content blocked by the security policy', () => {
  expect(problems).toEqual([]);
});

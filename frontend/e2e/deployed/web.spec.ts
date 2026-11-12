// The checks a person would make by hand after a release, against the deployment itself: it serves the version
// released, behind its security policy; the test user signs in through the hosted page and stays signed in; a second
// tab is refused; on desktop, the data is on OPFS, and work goes from Capture to the calendar and back; and stretch
// planning's steps open, each with Does it fit.
// scripts/test-deployed.sh runs it.

import { expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { syncNow } from '../seed';
import { deployed } from './target';

const d = deployed();
// The prod Test step runs this checkout's checks against the web app prod still serves, the release before, since it
// publishes only once they pass. Checks of screens new in this release skip there; release-prod runs them after publishing.
const beforePublish = process.env.DEPLOYED_BEFORE_PUBLISH === '1';
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
  // Without OPFS, as in phone's WebKit here, the browser build saves 200ms after a change, and a reload sooner loses it.
  await page.waitForTimeout(1000);
  await page.reload();
  await expect(nav).toBeVisible(NETWORK);
});

test('keeps its data on OPFS, through a worker and WebAssembly the security policy allows', async ({}, info) => {
  test.skip(info.project.name !== 'desktop', 'Phone runs WebKit, which has no OPFS in an ephemeral context, as Safari has none in a private window');
  const pool = await page.evaluate(async () => {
    try {
      return !!(await (await navigator.storage.getDirectory()).getDirectoryHandle('.opfs-sahpool'));
    } catch {
      return false;
    }
  });
  expect(pool).toBe(true);
});

test('a second tab is refused while the first holds the database', async () => {
  const second = await context.newPage();
  await second.goto('/');
  await expect(second.getByText('Multiscale is open in another tab.')).toBeVisible({ timeout: 15_000 });
  await second.close();
});

test('work goes from Capture to this week, onto the calendar by suggestion and by drag, back off, and done', async ({}, info) => {
  test.skip(info.project.name !== 'desktop', 'The mouse journey is the desktop layout; phone is covered by the local suites');
  // shortcut: suggestions stay in this week and out of the default closed hours from 10pm, so after 9:30pm on Sunday
  // there's no room for the half hour and the test skips; run it at any hour once a deployed test can move the
  // page's clock without writing future clocks to the shared test user.
  const now = new Date();
  test.skip(now.getDay() === 0 && now.getHours() * 60 + now.getMinutes() >= 21 * 60 + 30, "late on Sunday this week has no room left");
  const nav = page.getByRole('navigation', { name: 'Main' });
  const title = `Deployed check ${new Date().toISOString().slice(11, 19)}`;

  await nav.getByRole('button', { name: /Capture/ }).click();
  const field = page.getByRole('dialog', { name: 'Capture' }).getByRole('textbox', { name: 'Capture to Inbox' });
  await field.fill(title);
  await field.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Capture' })).toHaveCount(0);

  // Process: a practice made from the card takes the item with it, in one change that one Undo takes back. New in the
  // planning release, so the release before, which the prod Test step meets, opens the card without it.
  await nav.getByRole('button', { name: /Inbox/ }).click();
  await page.getByRole('button', { name: `Assign ${title}` }).click();
  if (!beforePublish) {
    await page.getByRole('button', { name: 'New practice from this item' }).click();
    await page.getByRole('button', { name: 'Make it a practice' }).click();
    await expect(page.getByText(`"${title}" is now a practice, 30m a day. It left your Inbox.`)).toBeVisible();
    await page.getByRole('button', { name: '‹ Undo and go back' }).click();
    await expect(page.getByText(`Undone: ${title} removed, "${title}" is back in your Inbox.`)).toBeVisible();
  }

  // Add to this week picks it for the week, and puts nothing on the calendar.
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
  // Skip for now is × on desktop, and is kept on the week's plan for every device.
  if (!(await page.getByRole('button', { name: "Edit this week's plan" }).count())) {
    await page.getByRole('button', { name: /^Skip (for now|planning this week)$/ }).click();
  }
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
  // Sent before the browser closes, or the deployment keeps these checks as Inbox items for the next suite to trip on.
  await syncNow(page);
});

test('stretch planning walks Goals, Practices, Projects, the Inbox and Finish, with Does it fit in view, and saves and exits', async ({}, info) => {
  test.skip(beforePublish, "needs: this release's web app, which release-prod checks once it's published");
  // Looking writes nothing to the plan: no Continue, no Finish, and Add is opened and closed.
  const phone = info.project.name === 'phone';
  const nav = page.getByRole('navigation', { name: 'Main' });
  if (phone) {
    await nav.getByRole('button', { name: 'More' }).click();
    await page.getByRole('button', { name: /^Plan/ }).click();
  } else {
    await nav.getByRole('button', { name: 'Plan' }).click();
  }
  await page.getByRole('button', { name: /^(Continue planning|Plan now|Plan (the next|your first) stretch|Plan without a cadence)$/ }).first().click();
  const steps = page.getByRole('navigation', { name: 'Planning steps' });
  const shown: [string, RegExp][] = [
    ['Goals', /^Step \d of \d, Goals\. (Are these still your goals|What are your goals)\?$/],
    ['Practices', /^Step \d of \d, Practices\. Your practices$/],
    ['Projects', /^Step \d of \d, Projects\. What will you reach by /],
    ['Inbox', /^Step \d of \d, Inbox\. Give each item a home$/],
  ];
  for (const [step, heading] of shown) {
    await steps.getByRole('button', { name: new RegExp(`^(\\d\\. )?${step}`) }).click();
    await expect(page.getByRole('heading', { name: heading })).toBeVisible(NETWORK);
    await expect(page.getByRole('region', { name: 'Does it fit?' })).toBeVisible();
  }
  const add = page.getByRole('button', phone ? { name: 'Add a goal, practice, project or Inbox task' } : { name: '+ Add', exact: true });
  await add.click();
  await expect(page.getByRole('dialog', { name: 'Add' }).getByRole('button', { name: 'Task to Inbox' })).toBeVisible();
  await page.keyboard.press('Escape');
  await steps.getByRole('button', { name: /^(\d\. )?Finish/ }).click();
  await expect(page.getByRole('heading', { name: /^Step \d of \d, Finish\. Ready for / })).toBeVisible();
  await expect(page.getByRole('region', { name: 'What changed' })).toBeVisible();
  await page.getByRole('button', { name: 'Save and exit' }).click();
  // Back on Plan. It offers Continue planning only while the stretch isn't planned yet, which the shared test user's
  // earlier runs may have done, so any of its ways in will do.
  await expect(page.getByRole('button', { name: /^(Continue planning|Plan now|Plan (the next|your first) stretch|Plan without a cadence)$/ }).first()).toBeVisible();
});

test('reports no console errors or content blocked by the security policy', () => {
  expect(problems).toEqual([]);
});

// The checks a person would make by hand after a release, against the deployment itself: it serves the version
// released, behind its security policy; the test user signs in through the hosted page and stays signed in; a second
// tab is refused; on desktop, the data is on OPFS, and work goes from Capture to the calendar and back; and stretch
// planning's steps open, each with Does it fit.
// scripts/test-deployed.sh runs it.

import { expect, test } from '@playwright/test';
import type { BrowserContext, Locator, Page } from '@playwright/test';
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
  await clearChecks(page);

  // A second check follows it in the Inbox. Process closes itself after its last card, and on a shared test user what
  // else the Inbox holds varies from run to run; with this one after it, Process is still open, on a card, once the
  // first is made a practice.
  for (const item of [title, `${title}, next`]) {
    await nav.getByRole('button', { name: /Capture/ }).click();
    const field = page.getByRole('dialog', { name: 'Capture' }).getByRole('textbox', { name: 'Capture to Inbox' });
    await field.fill(item);
    await field.press('Enter');
    await expect(page.getByRole('dialog', { name: 'Capture' })).toHaveCount(0);
  }

  // Process: a practice made from the card takes the item with it, in one change that one Undo takes back. The release
  // before, which the prod Test step meets, has had the picker since Nov 13, so both take the same steps.
  await nav.getByRole('button', { name: /Inbox/ }).click();
  await page.getByRole('button', { name: `Assign ${title}`, exact: true }).click();
  await page.getByRole('button', { name: 'New practice from this item' }).click();
  await page.getByRole('button', { name: 'Make it a practice' }).click();
  await expect(page.getByText(`${title} is now a practice.`)).toBeVisible();
  await page.getByRole('button', { name: '‹ Undo and go back' }).click();
  await expect(page.getByText(`Undone: ${title} removed. ${title} is back.`)).toBeVisible();

  // Add to this week picks it for the week, and puts nothing on the calendar.
  await page.getByRole('button', { name: 'Add to this week' }).click();
  await page.getByRole('combobox', { name: 'Add to a project or One offs' }).fill('One offs');
  await page.keyboard.press('Enter');
  await expect(page.getByText(`Added ${title} to One offs and to this week.`)).toBeVisible();
  // The second check is on the card now, for the cleanup below to delete.
  await page.getByRole('dialog', { name: 'Process Inbox' }).getByRole('button', { name: 'Exit' }).click();

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

  // Dragged by the mouse onto the last day, at 7pm, 13 hours down a 26px-an-hour day from 6am, it's placed there.
  await dragTo(page, card, (c) => ({ x: c.x + 20, y: c.y + 10 }), page.locator('[data-drop-date]').last(), (d) => ({ x: d.x + d.width / 2, y: d.y + 26 * 13 + 2 }));
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
  await dragTo(page, block, (b) => ({ x: b.x + b.width / 2, y: b.y + 6 }), lane, (l) => ({ x: l.x + l.width / 2, y: l.y + 12 }));
  await expect(block).toHaveCount(0);
  await expect(card).toBeVisible();
  await page.getByRole('button', { name: 'Done editing' }).click();

  // Marked done, it leaves.
  await card.click();
  await page.getByRole('group', { name: title }).getByRole('button', { name: 'Mark done' }).click();
  await expect(card).toHaveCount(0);
  await clearChecks(page);
});

type Box = { x: number; y: number; width: number; height: number };

/**
 * A mouse drag from a point on one element to a point on another. What waits above the week's days varies with the
 * shared test user's data: a practice left by an earlier run puts a row above every day. So the day's 7pm could be
 * below the window when measured before the drag, where the mouse lets go over nothing. The second element is
 * scrolled into the middle of the window once the drag is under way, and measured after.
 */
async function dragTo(page: Page, from: Locator, grip: (box: Box) => { x: number; y: number }, to: Locator, at: (box: Box) => { x: number; y: number }) {
  await from.scrollIntoViewIfNeeded();
  const start = grip((await from.boundingBox())!);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  // A mouse lifts what it holds once it has moved a few pixels; the drop is read from where it's let go.
  await page.mouse.move(start.x, start.y + 10, { steps: 2 });
  await to.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  const end = at((await to.boundingBox())!);
  await page.mouse.move(end.x, end.y, { steps: 10 });
  await page.mouse.up();
}

/**
 * Takes away the checks the journey leaves on the shared test user: Inbox items are deleted, and a one off still waiting
 * in this week's To schedule is marked done. It runs first as well as last, since a run that fails part way leaves its
 * checks behind, and they change what the next run meets, such as how far down the week the calendar starts. It syncs
 * before, to see what earlier runs sent, and after, or the deployment keeps them for the next suite to trip on.
 */
async function clearChecks(page: Page) {
  await syncNow(page);
  const nav = page.getByRole('navigation', { name: 'Main' });
  await nav.getByRole('button', { name: /Inbox/ }).click();
  for (let left = page.getByRole('button', { name: /^Assign (Deployed|Staging) check / }); await left.count(); ) {
    const name = (await left.first().getAttribute('aria-label'))!.replace(/^Assign /, '');
    await left.first().click();
    // Delete was "Delete/done" before, which a deployment may still be serving.
    await page.getByRole('button', { name: /^Delete(\/done)?$/ }).click();
    await page.getByRole('button', { name: 'Yes, delete' }).click();
    // The last one closes this release's Process by itself.
    const process = page.getByRole('dialog', { name: 'Process Inbox' });
    await expect(process.getByRole('heading', { name, exact: true })).toHaveCount(0);
    if (await process.count()) await process.getByRole('button', { name: 'Exit' }).click();
  }
  await nav.getByRole('button', { name: 'Week' }).click();
  const lane = page.getByRole('region', { name: 'To schedule' });
  for (let left = lane.getByRole('button', { name: /^(Deployed|Staging) check [^,]*, One off, .*, to schedule$/ }); await left.count(); ) {
    const name = (await left.first().getAttribute('aria-label'))!;
    await left.first().click();
    await page.getByRole('group', { name: name.replace(/, One off, .*$/, '') }).getByRole('button', { name: 'Mark done' }).click();
    await expect(lane.getByRole('button', { name, exact: true })).toHaveCount(0);
  }
  await syncNow(page);
}

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

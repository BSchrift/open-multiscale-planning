// The checks a person would make by hand after a release, against the deployment itself: it serves the version
// released, behind its security policy; the test user signs in through the hosted page and stays signed in; a second
// tab is refused; on desktop, the data is on OPFS, and work goes from Capture to the calendar and back; and stretch
// planning's steps open, each with Does it fit.
// scripts/test-deployed.sh runs it.

import { expect, test } from '@playwright/test';
import type { BrowserContext, Locator, Page, Request } from '@playwright/test';
import { holdMouse, syncNow } from '../seed';
import { deployed } from './target';

const d = deployed();
// The prod Test step runs this checkout's checks against the web app prod still serves, the release before, since it
// publishes only once they pass. Checks of screens new in this release skip there; release-prod runs them after publishing.
const beforePublish = process.env.DEPLOYED_BEFORE_PUBLISH === '1';
const NETWORK = { timeout: 60_000 };
// The sync a new browser runs after its first reload, which fills in expiries for what it downloaded and sends them.
// On prod's shared test user, which held tens of thousands of deleted records, it ran past 70 seconds on 15 November.
const CATCH_UP = 180_000;

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let page: Page;
const problems: string[] = [];
// Each sync request the page made, for the log of a failed test.
const syncs: string[] = [];

async function noteSync(r: Request) {
  if (r.method() !== 'POST' || !r.url().endsWith('/sync')) return;
  const sent = JSON.parse(r.postData() ?? '{}') as { cursor?: number; changes?: unknown[] };
  const res = await r.response().catch(() => null);
  const got = res?.ok() ? ((await res.json().catch(() => null)) as { cursor?: number; more?: boolean; changes?: unknown[] } | null) : null;
  const { startTime, responseEnd } = r.timing();
  const answer = got ? `pulled ${got.changes?.length} to ${got.cursor}${got.more ? ', more' : ''}` : (res?.status() ?? r.failure()?.errorText);
  syncs.push(`${new Date(startTime).toISOString().slice(11, 19)} ${Math.round(responseEnd)} ms: sent ${sent.changes?.length} at ${sent.cursor}, ${answer}`);
}

/**
 * The time zone the page runs in: the runner's own, unless it's late on Sunday there. The journey asks for a suggested
 * half hour later this week, and suggestions end at the default closed hours from 10pm, so late on Sunday the week has
 * no room left. Then the page runs in Honolulu, 10 hours behind UTC, the runner's zone on CodeBuild, where it's still
 * Sunday morning or early afternoon. A runner so far east that it's late on Sunday in Honolulu too gets Kiritimati, a
 * day ahead of Honolulu, where it's Monday. A zone rather than a page clock, since a zone moves no clock: what the page
 * writes to the shared test user carries the real time.
 */
function timezoneWithRoom(now = new Date()): string | undefined {
  // From 8pm, since the journey starts some minutes after the page opens, and needs half an hour before 10pm.
  const lateSunday = (timeZone?: string) => {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: 'numeric', hourCycle: 'h23' }).formatToParts(now);
    const part = (type: string) => parts.find((p) => p.type === type)?.value;
    return part('weekday') === 'Sun' && Number(part('hour')) >= 20;
  };
  if (!lateSunday()) return undefined;
  return lateSunday('Pacific/Honolulu') ? 'Pacific/Kiritimati' : 'Pacific/Honolulu';
}

// One signed-in page for the whole file, as a person would keep one tab.
test.beforeAll(async ({ browser }, info) => {
  const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch, baseURL } = info.project.use;
  const timezoneId = timezoneWithRoom();
  if (timezoneId) console.log(`It's late on Sunday here, so the page runs in ${timezoneId}, where this week still has room.`);
  context = await browser.newContext({ viewport, userAgent, deviceScaleFactor, isMobile, hasTouch, baseURL, timezoneId });
  await context.addInitScript(() =>
    document.addEventListener('securitypolicyviolation', (e) => console.error(`CSP blocked ${e.violatedDirective} ${e.blockedURI}`)),
  );
  context.on('page', (p) => {
    p.on('console', (m) => {
      // A second tab is refused on purpose, below. The SQLite pool also logs each try that finds another page's file
      // handles open: the second tab's refusal, and a reload that beats the page it replaces, which opfs.worker.ts tries
      // again for 3 seconds. A pool that never opens fails startup, which the tests after the reload would show.
      const refused = /InAnotherTab|Startup failed|another open Access Handle/.test(m.text());
      if (m.type() === 'error' && !refused) problems.push(m.text().slice(0, 200));
    });
    p.on('pageerror', (e) => problems.push(`pageerror ${e.message.slice(0, 200)}`));
    p.on('requestfinished', (r) => void noteSync(r));
    p.on('requestfailed', (r) => void noteSync(r));
  });
  page = await context.newPage();
});

test.afterAll(() => context?.close());

// CodeBuild keeps no trace, so a failed test logs what the page showed, and what its latest syncs carried and took.
test.afterEach(async ({}, info) => {
  if (info.status !== info.expectedStatus && page && !page.isClosed()) {
    const snapshot = await page.locator('body').ariaSnapshot().catch(() => '(no snapshot)');
    console.log(`${info.title} failed; the page showed:\n${snapshot}\nIts last syncs, of ${syncs.length}:\n${syncs.slice(-30).join('\n')}`);
  }
});

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

test('signs in through the hosted page as the test user, and stays signed in after a reload', async ({}, info) => {
  test.setTimeout(NETWORK.timeout + CATCH_UP);
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
  // Sync now joins the sync the reload started, so the tests that press it wait for that one here, where it starts.
  // Only desktop's tests press it.
  if (info.project.name === 'desktop') {
    const started = Date.now();
    await syncNow(page, CATCH_UP);
    console.log(`The sync after the reload took ${Math.round((Date.now() - started) / 1000)} s.`);
  }
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

// Checks earlier runs left on the shared test user are taken away first, in a test of their own: a run that failed part
// way can leave many, and clearing them inside the journey spent its time limit before the journey began.
test('clears the checks earlier runs left on the shared test user', async ({}, info) => {
  test.skip(info.project.name !== 'desktop', 'The journey that leaves them is desktop only');
  test.setTimeout(300_000);
  await clearChecks(page);
});

test('work goes from Capture to this week, onto the calendar by suggestion and by drag, back off, and done', async ({}, info) => {
  test.skip(info.project.name !== 'desktop', 'The mouse journey is the desktop layout; phone is covered by the local suites');
  const nav = page.getByRole('navigation', { name: 'Main' });
  const title = `Deployed check ${new Date().toISOString().slice(11, 19)}`;

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
  await page.getByRole('button', { name: 'Undo and go back' }).click();
  await expect(page.getByText(`Undone: ${title} removed. ${title} is back.`)).toBeVisible();

  // Add to this week picks it for the week, and puts nothing on the calendar.
  await page.getByRole('switch', { name: 'Add to this week' }).click();
  await page.getByRole('combobox', { name: 'Add to a project or One offs' }).fill('One offs');
  await page.keyboard.press('Enter');
  // Enter picks One offs, and Add to adds the item there. The release before, which the prod Test step meets, added it
  // on the pick, so Add to is pressed only while the toast hasn't come. On that release the next card's picker also
  // holds One offs, so both can show at once: wait for either, not exactly one.
  const added = page.getByText(`Added ${title} to One offs and to this week.`);
  const add = page.getByRole('dialog', { name: 'Process Inbox' }).getByRole('button', { name: 'Add to One offs', exact: true });
  await expect(added.or(add).first()).toBeVisible();
  if (!(await added.isVisible())) await add.click();
  await expect(added).toBeVisible();
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
});

// The checks the journey left are cleared after it in a test of their own too, so a slow clear-up on prod can't spend
// the journey's time limit.
test('clears the checks this run left on the shared test user', async ({}, info) => {
  test.skip(info.project.name !== 'desktop', 'The journey that leaves them is desktop only');
  test.setTimeout(300_000);
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
  await holdMouse(page, { x: start.x, y: start.y });
  // Held, it has lifted, and follows once moved past a click's wobble; the drop is read from where it's let go.
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
    // Delete was "Delete/done" before, which a deployment may still be serving. Process can open with its delete question
    // already showing, so answer it if it's there.
    const del = page.getByRole('button', { name: /^Delete(\/done)?$/ });
    const yes = page.getByRole('button', { name: 'Yes, delete' });
    // The sync just before can take the item away as the click lands (prod's Test saw the Inbox empty, no Process open),
    // so an item that's gone needs nothing more.
    const asking = () => del.or(yes).first().isVisible();
    const gone = async () => !(await page.getByRole('button', { name: `Assign ${name}`, exact: true }).count());
    await expect.poll(async () => (await asking()) || (await gone()), { timeout: 15_000 }).toBe(true);
    if (!(await asking())) continue;
    if (await del.isVisible()) await del.click();
    await yes.click();
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
  // Plan opens on its page, and the steps only from a way in. Which way in depends on the shared test user: prod's first
  // stretch was begun and is never planned there, so it offers Continue planning, while staging's compat suite finishes a
  // plan on every run, so staging offers the next stretch's.
  const wayIn = page.getByRole('button', { name: /^(Continue planning|Plan now|Plan (the next|your first) stretch|Plan without a cadence)$/ }).first();
  const steps = page.getByRole('navigation', { name: 'Planning steps' });
  await expect(wayIn).toBeVisible(NETWORK);
  await wayIn.click();
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
  // Save and exit leaves the steps for the Plan page and its way back in. On 14 and 15 November prod's release step
  // found the steps still open: on prod's large history, Save and exit's writes outlasted the 5 seconds checks waited
  // then, as they take 3.6 to 5.2 seconds locally with 60,000 deleted records on desktop.
  await expect(steps).toHaveCount(0);
  await expect(wayIn).toBeVisible();
});

test('reports no console errors or content blocked by the security policy', () => {
  expect(problems).toEqual([]);
});

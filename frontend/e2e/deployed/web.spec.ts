// The checks a person would make by hand after a release, against the deployment itself: it serves the version
// released, behind its security policy; the test user signs in through the hosted page and stays signed in; a second
// tab is refused; on desktop, the data is on OPFS, and work goes from Capture to the calendar and back; and stretch
// planning's steps open, each with Does it fit. On staging, its history project does the same for a desktop browser of a
// five-year account: a long first sync, a reload in the middle of one, OPFS, the journey, planning and the console.
// scripts/test-deployed.sh runs it.

import { expect, test } from '@playwright/test';
import type { BrowserContext, Page, Request } from '@playwright/test';
import { syncNow } from '../seed';
import { clearChecks, timezoneWithRoom, workJourney } from './journey';
import { deployed } from './target';

const d = deployed();
// The prod Test step runs this checkout's checks against the web app prod still serves, the release before, since it
// publishes only once they pass. Checks of screens new in this release skip there; release-prod runs them after publishing.
const beforePublish = process.env.DEPLOYED_BEFORE_PUBLISH === '1';
const NETWORK = { timeout: 60_000 };
// The sync a new browser runs after its first reload, which fills in expiries for what it downloaded and sends them.
// On prod's shared test user, which held tens of thousands of deleted records, it ran past 70 seconds on 15 November.
const CATCH_UP = 180_000;
// The history project (playwright.config.ts) signs in as staging's history user, whose five-year account
// (history-seed.setup.ts) is about 33,000 records: some 67 pages of 500 for a new browser. Fewer means it isn't seeded.
const HISTORY_PAGES = 50;
const HISTORY_ONLY = 'The history project checks only what a long history changes: sign-in, a reload, OPFS, the journey, planning and the console';

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

/** Signs a page in from the app's Sign in, through the hosted sign-in page. */
async function signInAs(p: Page, user: { username: string; password: string }) {
  const opened = p.waitForEvent('popup');
  await p.getByRole('button', { name: 'Sign in' }).first().click();
  const popup = await opened;
  // The hosted sign-in page has a wide and a narrow form, and shows one.
  await popup.locator('input[name=username]:visible').fill(user.username);
  await popup.locator('input[name=password]:visible').fill(user.password);
  await popup.locator('input[name=signInSubmitButton]:visible').click();
  await expect.poll(() => popup.isClosed(), NETWORK).toBe(true);
}

/** Counts the pages of records a page's syncs pull, as they arrive. */
function pullsOf(p: Page) {
  const pulled = { pages: 0 };
  p.on('response', (res) => {
    if (res.request().method() !== 'POST' || !res.url().endsWith('/sync') || !res.ok()) return;
    res.json().then(
      (body: { changes?: unknown[] }) => void (body.changes?.length && pulled.pages++),
      () => undefined,
    );
  });
  return pulled;
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

test.afterAll(async ({}, info) => {
  // A journey that failed part way leaves its checks, which the serial tests after it don't clear. On the history user
  // they'd change the Inbox count the history-scale test waits for, so they go here.
  if (info.project.name === 'history' && page && !page.isClosed()) {
    test.setTimeout(300_000);
    await clearChecks(page).catch((e: Error) => console.log(`Clearing the history user's checks failed: ${e.message}`));
  }
  await context?.close();
});

// CodeBuild keeps no trace, so a failed test logs what the page showed, and what its latest syncs carried and took.
test.afterEach(async ({}, info) => {
  if (info.status !== info.expectedStatus && page && !page.isClosed()) {
    const snapshot = await page.locator('body').ariaSnapshot().catch(() => '(no snapshot)');
    console.log(`${info.title} failed; the page showed:\n${snapshot}\nIts last syncs, of ${syncs.length}:\n${syncs.slice(-30).join('\n')}`);
  }
});

test('serves the version released, its pages with the security policy, and assets that cache for good', async ({}, info) => {
  test.skip(info.project.name === 'history', HISTORY_ONLY);
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
  test.skip(info.project.name === 'history', 'The history user signs in below');
  test.setTimeout(NETWORK.timeout + CATCH_UP);
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'Main' });
  const signIn = page.getByRole('button', { name: 'Sign in' }).first();
  await expect(nav.or(signIn)).toBeVisible(NETWORK);
  if (await signIn.isVisible()) {
    // The browser build has no Skip at sign-in: it has nowhere to keep work without an account.
    expect(await page.getByRole('button', { name: 'Skip' }).count()).toBe(0);
    await signInAs(page, d.user);
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

// The history user's records carry no expiry, as records from before retention don't, which keeps its five years on
// staging. A page that reloads holding them fills in their expiries and sends them, and staging's periods of minutes
// would then remove most of the account. So its page here is never reloaded, and the reload is a browser of its own,
// which before it reloads lets through only the web app's own pages and files, and is closed that way.
test('a new browser of a five-year account pulls the whole history in its first sync, then opens the app', async ({}, info) => {
  test.skip(info.project.name !== 'history', 'Staging only: the history project');
  test.setTimeout(NETWORK.timeout + CATCH_UP);
  if (!d.history) throw new Error('MULTISCALE_HISTORY_TARGET has no history user. Run scripts/test-deployed.sh.');
  const pulled = pullsOf(page);
  await page.goto('/');
  const started = Date.now();
  await signInAs(page, d.history.test_user!);
  // Its settings, with setup done, come last, so the app opens once the whole history is in.
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible({ timeout: CATCH_UP });
  console.log(`The history user's first sync pulled ${pulled.pages} pages in ${Math.round((Date.now() - started) / 1000)} s.`);
  const unseeded = `fewer than ${HISTORY_PAGES} pages means its five-year account isn't seeded on staging: make test-history ENV=staging seeds it`;
  await expect.poll(() => pulled.pages, { message: unseeded }).toBeGreaterThanOrEqual(HISTORY_PAGES);
});

test('a reload in the middle of that first sync opens the database again, once the page it replaces lets go', async ({ browser }, info) => {
  test.skip(info.project.name !== 'history', 'Staging only: the history project');
  test.setTimeout(3 * NETWORK.timeout);
  const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch, baseURL } = info.project.use;
  const other = await browser.newContext({ viewport, userAgent, deviceScaleFactor, isMobile, hasTouch, baseURL });
  try {
    const p = await other.newPage();
    const held: string[] = [];
    p.on('console', (m) => void (/another open Access Handle/.test(m.text()) && held.push(m.text())));
    const pulled = pullsOf(p);
    await p.goto('/');
    await signInAs(p, d.history!.test_user!);
    // Ten pages in, the database worker is writing what it pulled, as it was on prod's reloads that found the SQLite
    // pool still held. From here only GETs to the web app's own host go out, so the page reloads and nothing is sent.
    await expect.poll(() => pulled.pages, NETWORK).toBeGreaterThanOrEqual(10);
    const own = new URL(baseURL!).origin;
    await other.route('**/*', (route) => {
      const r = route.request();
      return r.method() === 'GET' && new URL(r.url()).origin === own ? route.continue() : route.abort();
    });
    await p.reload();
    // Signed in, with its settings not pulled yet, it opens on setup. A pool that never opened shows "Couldn't open your
    // data." instead.
    await expect(p.locator('.setup')).toBeVisible(NETWORK);
    await expect(p.getByText("Couldn't open your data.", { exact: false })).toHaveCount(0);
    console.log(`The reload's tries at the SQLite pool that found it still held: ${held.length}.`);
  } finally {
    await other.close();
  }
});

test('keeps its data on OPFS, through a worker and WebAssembly the security policy allows', async ({}, info) => {
  test.skip(info.project.name === 'phone', 'Phone runs WebKit, which has no OPFS in an ephemeral context, as Safari has none in a private window');
  const pool = await page.evaluate(async () => {
    try {
      return !!(await (await navigator.storage.getDirectory()).getDirectoryHandle('.opfs-sahpool'));
    } catch {
      return false;
    }
  });
  expect(pool).toBe(true);
});

test('a second tab is refused while the first holds the database', async ({}, info) => {
  test.skip(info.project.name === 'history', HISTORY_ONLY);
  const second = await context.newPage();
  await second.goto('/');
  await expect(second.getByText('Multiscale is open in another tab.')).toBeVisible({ timeout: 15_000 });
  await second.close();
});

// Checks earlier runs left on the shared test user are taken away first, in a test of their own: a run that failed part
// way can leave many, and clearing them inside the journey spent its time limit before the journey began.
test('clears the checks earlier runs left on the shared test user', async ({}, info) => {
  test.skip(info.project.name === 'phone', 'The journey that leaves them is desktop only');
  test.setTimeout(300_000);
  await clearChecks(page);
});

// The cross-version suite takes the same journey on the release before, as this step does on prod: see journey.ts.
test('work goes from Capture to this week, onto the calendar by suggestion and by drag, back off, and done', async ({}, info) => {
  // The history project takes it on a long history, where each change takes seconds to read back, as on prod's shared
  // test user.
  test.skip(info.project.name === 'phone', 'The mouse journey is the desktop layout; phone is covered by the local suites');
  await workJourney(page, `Deployed check ${new Date().toISOString().slice(11, 19)}`);
});

// The checks the journey left are cleared after it in a test of their own too, so a slow clear-up on prod can't spend
// the journey's time limit.
test('clears the checks this run left on the shared test user', async ({}, info) => {
  test.skip(info.project.name === 'phone', 'The journey that leaves them is desktop only');
  test.setTimeout(300_000);
  await clearChecks(page);
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

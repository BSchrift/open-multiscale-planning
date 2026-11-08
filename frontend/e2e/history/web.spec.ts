// The web app, built as it ships and served from this Mac, as a new browser of the history user: how long its first
// sync takes to a usable app, how long an edit takes to save, and how long Today and Week take to read.

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { historyFacts } from '../../src/core/history-testing';
import { account, go, pane } from '../seed';
import { historyTarget, keptChanges, NETWORK, record, timeQueries, usableAt } from './history';

const t = historyTarget();

/**
 * Before the app loads: notes each click, and keeps the app's database worker (src/platform/web.ts) for page.ts, noting
 * how many of the page's requests to it are waiting, when one last went or came back, and each COMMIT's round trip.
 */
function watchDatabase() {
  const marks: Marks = { clicks: [], waiting: 0, active: 0, commits: [] };
  Object.assign(window, { historyMarks: marks });
  addEventListener('click', () => marks.clicks.push(performance.now()), true);
  window.Worker = class extends window.Worker {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      Object.assign(window, { historyWorker: this });
      const commits = new Map<number, { sent: number; answered?: number }>();
      const post = this.postMessage.bind(this) as (message: unknown) => void;
      // page.ts's own requests have ids below 0, and aren't the app's.
      this.postMessage = ((message: { id: number; op: string; sql?: string }) => {
        if (message.id >= 0) {
          marks.waiting++;
          marks.active = performance.now();
          if (message.op === 'exec' && message.sql === 'COMMIT') {
            const commit = { sent: marks.active };
            commits.set(message.id, commit);
            marks.commits.push(commit);
          }
        }
        post(message);
      }) as Worker['postMessage'];
      this.addEventListener('message', ({ data }: MessageEvent<{ id: number }>) => {
        if (data.id < 0) return;
        marks.waiting--;
        marks.active = performance.now();
        const commit = commits.get(data.id);
        if (commit) commit.answered = marks.active;
        commits.delete(data.id);
      });
    }
  };
}

type Marks = { clicks: number[]; waiting: number; active: number; commits: { sent: number; answered?: number }[] };
const marks = (page: Page) => page.evaluate(() => (window as unknown as { historyMarks: Marks }).historyMarks);

/** Until the database has nothing waiting, and the sync an edit sets off 2 seconds later has written too. */
async function quiet(page: Page) {
  await page.waitForFunction(
    () => {
      const m = (window as unknown as { historyMarks: Marks }).historyMarks;
      return m.waiting === 0 && performance.now() - Math.max(m.active, m.clicks.at(-1) ?? 0) > 3000;
    },
    null,
    { polling: 100, ...NETWORK },
  );
}

/** One edit, from its click until its transaction has committed, which on OPFS is when it's on disk. */
async function timeEdit(page: Page, control: () => Promise<void>) {
  const before = (await marks(page)).clicks.length;
  await control();
  await page.waitForFunction(
    (n) => {
      const m = (window as unknown as { historyMarks: Marks }).historyMarks;
      const click = m.clicks[n];
      return click !== undefined && m.commits.some((c) => c.sent > click && c.answered !== undefined);
    },
    before,
    NETWORK,
  );
  const m = await marks(page);
  const click = m.clicks[before]!;
  const saved = m.commits.find((c) => c.sent > click)!.answered! - click;
  console.log(`web edit: ${saved.toFixed(1)} ms from the click to its transaction committed`);
  return saved;
}

test('a new browser of the five-year account: first sync, Today and Week, and saving an edit', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(watchDatabase);
  const { openInbox } = historyFacts(keptChanges());

  // The shipped web app has no Skip: a new browser signs in first.
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();
  const opened = page.waitForEvent('popup');
  let started = Date.now();
  await page.getByRole('button', { name: 'Sign in' }).click();
  const popup = await opened;
  if (t.test_user) {
    // The hosted sign-in page has a wide and a narrow form, and shows one.
    await popup.locator('input[name=username]:visible').fill(t.test_user.username, NETWORK);
    await popup.locator('input[name=password]:visible').fill(t.test_user.password);
    started = Date.now();
    await popup.locator('input[name=signInSubmitButton]:visible').click();
  }
  const firstSync = (await usableAt(page, openInbox)) - started;
  console.log(`web: usable ${(firstSync / 1000).toFixed(1)} s after the sign-in was sent`);

  // The rest is timed once the first sync has finished and its last save has landed.
  await go(page, 'Settings');
  await expect(account(page).getByText('Synced', { exact: true })).toBeVisible(NETWORK);
  await quiet(page);
  const queries = await timeQueries(page, 'web');
  expect(queries.records).toBeGreaterThanOrEqual(historyFacts(keptChanges()).records);

  // A setting turned off and on twice, so the account ends as it began.
  const toggle = pane(page, 'Settings').getByRole('checkbox', { name: 'Notify at block start' });
  const edits: number[] = [];
  for (let i = 0; i < 4; i++) {
    edits.push(await timeEdit(page, () => toggle.click()));
    await quiet(page);
  }
  await expect(toggle).toBeChecked();
  edits.sort((a, b) => a - b);
  const editSave = Math.round(((edits[1]! + edits[2]!) / 2) * 10) / 10;

  record('web', { first_sync_ms: firstSync, edit_save_ms: editSave, ...queries });
  expect(errors).toEqual([]);
});

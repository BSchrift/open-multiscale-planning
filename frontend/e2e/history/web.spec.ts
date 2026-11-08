// The web app, built as it ships and served from this Mac, as a new browser of the history user: how long its first
// sync takes to a usable app, how long an edit takes to save, and how long Today and Week take to read.

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { historyFacts } from '../../src/core/history-testing';
import { account, go, pane } from '../seed';
import { historyTarget, NETWORK, record, timeQueries, usableAt } from './history';

const t = historyTarget();

/**
 * Before the app loads: notes each click, each arming and firing of a 200 ms timer (the web app's wait for more edits
 * before saving, src/platform/web.ts), and each write of the database file to IndexedDB and when it finished.
 */
function watchSaves() {
  const marks = { clicks: [] as number[], timers: [] as { armed: number; fired?: number }[], saves: [] as { put: number; done?: number; bytes: number }[] };
  Object.assign(window, { historyMarks: marks });
  addEventListener('click', () => marks.clicks.push(performance.now()), true);
  const setTimer = window.setTimeout;
  window.setTimeout = ((fn: TimerHandler, ms?: number, ...args: unknown[]) => {
    if (ms !== 200 || typeof fn !== 'function') return setTimer(fn, ms, ...args);
    const timer: { armed: number; fired?: number } = { armed: performance.now() };
    marks.timers.push(timer);
    return setTimer(() => {
      timer.fired = performance.now();
      (fn as (...a: unknown[]) => void)(...args);
    }, ms);
  }) as typeof window.setTimeout;
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
    const request = put.call(this, value, key);
    if (key === 'multiscale.sqlite') {
      const save: { put: number; done?: number; bytes: number } = { put: performance.now(), bytes: (value as Uint8Array).byteLength };
      marks.saves.push(save);
      this.transaction.addEventListener('complete', () => (save.done = performance.now()));
    }
    return request;
  };
}

type Marks = { clicks: number[]; timers: { armed: number; fired?: number }[]; saves: { put: number; done?: number; bytes: number }[] };
const marks = (page: Page) => page.evaluate(() => (window as unknown as { historyMarks: Marks }).historyMarks);

/** Until no save is armed or under way, and the sync an edit sets off 2 seconds later has saved too. */
async function quiet(page: Page) {
  await page.waitForFunction(
    () => {
      const m = (window as unknown as { historyMarks: Marks }).historyMarks;
      const last = m.timers.at(-1);
      const save = m.saves.at(-1);
      const busy = (last && !last.fired) || (save && !save.done);
      return !busy && performance.now() - Math.max(last?.armed ?? 0, m.clicks.at(-1) ?? 0) > 3000;
    },
    null,
    { polling: 100, ...NETWORK },
  );
}

/**
 * One edit, from its click to its database file written: the edit itself up to the save being armed, then the save's
 * own work from its timer firing. The 200 ms wait between is the app's choice, not work, so it's left out.
 */
async function timeEdit(page: Page, control: () => Promise<void>) {
  const before = (await marks(page)).clicks.length;
  await control();
  await page.waitForFunction(
    (n) => {
      const m = (window as unknown as { historyMarks: Marks }).historyMarks;
      const click = m.clicks[n];
      return click !== undefined && m.saves.some((s) => s.put > click && s.done !== undefined);
    },
    before,
    NETWORK,
  );
  const m = await marks(page);
  const click = m.clicks[before]!;
  const save = m.saves.find((s) => s.put > click)!;
  const timer = m.timers.filter((x) => x.fired !== undefined && x.fired <= save.put).at(-1)!;
  const edit = { armed: timer.armed - click, saved: save.done! - timer.fired! };
  console.log(`web edit: ${edit.armed.toFixed(1)} ms to commit and arm the save, ${edit.saved.toFixed(1)} ms to export and write the ${(save.bytes / 1e6).toFixed(1)} MB file`);
  return edit.armed + edit.saved;
}

test('a new browser of the five-year account: first sync, Today and Week, and saving an edit', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(watchSaves);
  const { openInbox } = historyFacts();

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
  expect(queries.records).toBeGreaterThanOrEqual(historyFacts().records);

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

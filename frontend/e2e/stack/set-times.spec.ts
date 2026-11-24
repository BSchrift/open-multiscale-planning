import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { addDays, today, weekStart } from '../../src/core/dates';
import { go, pane, readRecord, seed, syncNow } from '../seed';
import { closeDevices, device, signIn } from './devices';
import { target } from './target';

// Practices at their set times, through the backend: two devices that both place a practice's sessions before either
// has the other's make one session a day, with the same times, and a take-off on one wins on the other, which never
// places that day again.

const t = target();
test.use({ baseURL: `http://localhost:${process.env.STACK_WEB_PORT}` });
test.afterEach(closeDevices);

/** Comes back to the foreground, which syncs and places set times, as returning to the app does. */
const foreground = (page: Page) => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));

/** Each of the next ten days' session of a practice that this device has, by id, with its times and whether it's off. */
async function sessions(page: Page, practice: string) {
  const zone = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const on = today({ now: () => Date.now(), zone: () => zone });
  const found: Record<string, unknown> = {};
  for (let i = 0; i <= 10; i++) {
    const id = `session:${practice}:${addDays(on, i)}`;
    const r = await readRecord(page, 'time_block', id);
    if (r) found[id] = { start: r.start, end: r.end, cancelled: r.cancelled ?? null, deleted_at: r.deleted_at ?? null };
  }
  return found;
}

test('two devices placing the same practice offline make one session a day, and a take-off on one wins', async ({ browser }) => {
  // A fresh user, so nothing another run placed is in the way.
  test.skip(!t.localApi, 'needs: a fresh user each run');
  const run = randomUUID().slice(0, 8);
  const practice = `e2e-${run}-run`;
  const title = `Morning run ${run}`;
  const a = await device(browser, `e2e-${run}`);
  const b = await device(browser, `e2e-${run}`);
  // Every day at noon: tomorrow is always among the days placed, this week's or, from Friday, next week's.
  await seed(a.page, [{ type: 'practice', id: practice, fields: { title, target_min: 30, per: 'day', preferred_times: [12 * 60], state: 'active' } }]);
  await signIn(a.page);
  await syncNow(a.page);
  await signIn(b.page);
  await syncNow(b.page);
  await go(b.page, 'Goals');
  await pane(b.page, 'Goals').getByRole('button', { name: /^Practices with no goal/ }).click();
  await expect(pane(b.page, 'Goals').getByRole('button', { name: new RegExp(`^${title}`) })).toBeVisible();

  // Offline, each places on its own, and says so.
  for (const d of [a, b]) {
    await d.context.setOffline(true);
    await foreground(d.page);
    await expect(d.page.getByText(/^Placed (\d+ practice sessions at their set times|.* at its set time)/)).toBeVisible();
  }
  const placed = await sessions(a.page, practice);
  expect(Object.keys(placed).length).toBeGreaterThan(0);
  expect(await sessions(b.page, practice)).toEqual(placed);

  // Back online, both end with the same records: one a day.
  for (const d of [a, b]) await d.context.setOffline(false);
  for (const d of [a, b, a]) await syncNow(d.page);
  expect(await sessions(a.page, practice)).toEqual(placed);
  expect(await sessions(b.page, practice)).toEqual(placed);
  // And no session of it under any other id: Week draws as many of its blocks this week as there are records.
  const zone = await a.page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const sunday = addDays(weekStart(today({ now: () => Date.now(), zone: () => zone })), 6);
  const thisWeek = Object.keys(placed).filter((id) => id.slice(-10) <= sunday).length;
  await go(a.page, 'Week', /./);
  await expect(pane(a.page, 'Week').getByRole('button', { name: new RegExp(`^${title}, \\w{3} \\w{3} \\d+, 12pm to 12:30pm`) })).toHaveCount(thisWeek);

  // b takes the first one off; a gets that, and placing again there changes nothing.
  const [first] = Object.keys(placed).sort();
  await seed(b.page, [{ type: 'time_block', id: first!, fields: { cancelled: true } }]);
  for (const d of [b, a]) await syncNow(d.page);
  await foreground(a.page);
  await expect.poll(async () => ((await sessions(a.page, practice))[first!] as { cancelled: unknown }).cancelled).toBe(true);
  expect(Object.keys(await sessions(a.page, practice))).toEqual(Object.keys(placed));

  // Tidy up: the practice goes, and its sessions with it.
  const gone = new Date().toISOString();
  await seed(a.page, [{ type: 'practice', id: practice, fields: { deleted_at: gone } }, ...Object.keys(placed).map((id) => ({ type: 'time_block', id, fields: { deleted_at: gone } }))]);
  await syncNow(a.page);
  expect([...a.errors, ...b.errors]).toEqual([]);
});

test('two devices placing the same one off at its time of day make one block', async ({ browser }) => {
  test.skip(!t.localApi, 'needs: a fresh user each run');
  const run = randomUUID().slice(0, 8);
  const id = `e2e-${run}-pass`;
  const title = `Renew passport ${run}`;
  const a = await device(browser, `e2e-${run}`);
  const b = await device(browser, `e2e-${run}`);
  // Tomorrow at noon, which is always among the days placed.
  const zone = await a.page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const tomorrow = addDays(today({ now: () => Date.now(), zone: () => zone }), 1);
  await seed(a.page, [{ type: 'task', id, fields: { kind: 'one_off', title, estimate_min: 30, schedule: { type: 'once', from: tomorrow }, next_due: tomorrow, time: 12 * 60 } }]);
  await signIn(a.page);
  await syncNow(a.page);
  await signIn(b.page);
  await syncNow(b.page);
  await go(b.page, 'One offs');
  await expect(pane(b.page, 'One offs').getByText(title)).toBeVisible();

  for (const d of [a, b]) {
    await d.context.setOffline(true);
    await foreground(d.page);
    await expect(d.page.getByText(new RegExp(`^Placed ${title} at its set time`))).toBeVisible();
  }
  const block = (d: typeof a) => readRecord(d.page, 'time_block', `due:${id}:${tomorrow}`);
  const placed = await block(a);
  expect(placed).toMatchObject({ task_id: id });
  expect(await block(b)).toEqual(placed);
  for (const d of [a, b]) await d.context.setOffline(false);
  for (const d of [a, b, a]) await syncNow(d.page);
  expect(await block(a)).toEqual(placed);
  expect(await block(b)).toEqual(placed);

  const gone = new Date().toISOString();
  await seed(a.page, [{ type: 'task', id, fields: { deleted_at: gone } }, { type: 'time_block', id: `due:${id}:${tomorrow}`, fields: { deleted_at: gone } }]);
  await syncNow(a.page);
  expect([...a.errors, ...b.errors]).toEqual([]);
});

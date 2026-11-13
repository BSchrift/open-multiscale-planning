import { beforeAll, describe, expect, it } from 'vitest';
import { fixedClock } from '../core/clock';
import { addDays, localDate, weekStart } from '../core/dates';
import type { Db, Sql } from '../core/db';
import { historyChanges, historyFacts, HISTORY } from '../core/history-testing';
import { applyRemote } from '../core/records';
import { loadDoneDay } from '../ui/screens/done/data';
import { loadToday } from '../ui/screens/today/data';
import { loadWeek } from '../ui/screens/week/data';
import { timeHistoryQueries } from './history-checks';
import { openTestDb } from './node-sqlite';

describe('the history on a device', () => {
  let db: Db;
  const clock = fixedClock(HISTORY.now, HISTORY.zone);

  beforeAll(async () => {
    db = await openTestDb();
    // As a first sync lands it: pages of 500, oldest first.
    const changes = historyChanges();
    for (let i = 0; i < changes.length; i += 500) await applyRemote(db, changes.slice(i, i + 500));
  }, 120_000);

  it('opens on Today and Week with its last week in place', async () => {
    const today = await loadToday(db, clock);
    expect(today.inbox).toBe(historyFacts().openInbox);
    expect(today.planned).toBe(true);
    expect(today.blocks.length).toBeGreaterThan(0);
    expect(today.settings.setup_done_at).toEqual(expect.any(String));
    const week = await loadWeek(db, clock, weekStart(localDate(clock.now(), HISTORY.zone)));
    expect(week.blocks.length).toBeGreaterThan(5);
    expect(week.picks.length).toBeGreaterThan(4000);
  }, 60_000);

  it('opens Done on its last whole day reading only that day’s records, not the five years', async () => {
    let rows = 0;
    const counted: Sql = {
      all: async (query, params) => {
        const found = await db.all(query, params);
        rows += found.length;
        return found as never;
      },
      get: async (query, params) => {
        const found = await db.get(query, params);
        if (found) rows++;
        return found as never;
      },
      run: (query, params) => db.run(query, params),
    };
    const done = await loadDoneDay(counted, clock, addDays(localDate(clock.now(), HISTORY.zone), -1));
    expect(done.total.finished).toBeGreaterThan(0);
    expect(done.total.worked_min).toBeGreaterThan(0);
    expect(rows).toBeLessThan(300);
  }, 60_000);

  it('times Today, Week and Done as of the history end, the median of five runs each, and counts what arrived', async () => {
    const { today_query_ms, week_query_ms, done_query_ms, records } = await timeHistoryQueries(db);
    expect(today_query_ms).toBeGreaterThan(0);
    expect(week_query_ms).toBeGreaterThan(0);
    expect(done_query_ms).toBeGreaterThan(0);
    expect(records).toBe(historyFacts().records);
  }, 60_000);
});

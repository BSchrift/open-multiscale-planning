import { beforeAll, describe, expect, it } from 'vitest';
import { fixedClock } from '../core/clock';
import { localDate, weekStart } from '../core/dates';
import type { Db } from '../core/db';
import { historyChanges, historyFacts, HISTORY } from '../core/history-testing';
import { applyRemote } from '../core/records';
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

  it('times Today and Week as of the history end, the median of five runs each, and counts what arrived', async () => {
    const { today_query_ms, week_query_ms, records } = await timeHistoryQueries(db);
    expect(today_query_ms).toBeGreaterThan(0);
    expect(week_query_ms).toBeGreaterThan(0);
    expect(records).toBe(historyFacts().records);
  }, 60_000);
});

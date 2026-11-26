import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fixedClock } from '../core/clock';
import { addDays, localDate, weekStart } from '../core/dates';
import { refreshStatistics } from '../core/db';
import type { Db, Sql } from '../core/db';
import { historyChanges, historyFacts, HISTORY, keptHistory } from '../core/history-testing';
import { parsePeriod } from '../../../config/retention';
import { needsNewTime, SQL } from '../core/queries';
import { applyRemote } from '../core/records';
import { loadDoneDay } from '../ui/screens/done/data';
import { loadToday } from '../ui/screens/today/data';
import { loadWeek, weekModel } from '../ui/screens/week/data';
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

  it("works out Week's figures from the weeks they show, not from five years of blocks", async () => {
    const data = await loadWeek(db, clock, weekStart(localDate(clock.now(), HISTORY.zone)));
    // A local date is a formatter call, the costly part of Week's figures, which Week works out again on every change.
    // One for each block of the history took the slowed-down page in the history journey (e2e/stack) past 15 seconds
    // to take a block off after it was dragged away.
    const toLocal = vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts');
    try {
      weekModel(data, clock);
      expect(toLocal.mock.calls.length).toBeLessThan(data.records.blocks.length);
    } finally {
      toLocal.mockRestore();
    }
  }, 60_000);

  it("times Today, Week, Week's figures, Done and Notes as of the history end, the median of five runs each, and counts the live and deleted records that arrived", async () => {
    const { today_query_ms, week_query_ms, week_figures_ms, done_query_ms, notes_list_ms, notes_search_ms, records, deleted_records } = await timeHistoryQueries(db);
    expect(today_query_ms).toBeGreaterThan(0);
    expect(week_query_ms).toBeGreaterThan(0);
    expect(week_figures_ms).toBeGreaterThan(0);
    expect(done_query_ms).toBeGreaterThan(0);
    expect(notes_list_ms).toBeGreaterThan(0);
    expect(notes_search_ms).toBeGreaterThan(0);
    expect(records).toBe(historyFacts().live);
    expect(deleted_records).toBe(historyFacts().deleted);
  }, 60_000);
});

describe('the history as a server with retention keeps it, on a device that has opened since its first sync', () => {
  it("finds Today's queue through indexes, with the statistics every launch after the first makes", async () => {
    const db = await openTestDb();
    const changes = keptHistory(parsePeriod('P30D'), Date.parse(HISTORY.now));
    for (let i = 0; i < changes.length; i += 500) await applyRemote(db, changes.slice(i, i + 500));
    // In no order: queueItems puts them in order.
    const queue = async () => (await needsNewTime(db)).sort((a, b) => a.block_id.localeCompare(b.block_id));
    const before = await queue();
    await refreshStatistics(db);
    const plan = (await db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${SQL.queue}`)).map((p) => p.detail);
    // Every answer of a type read again for each candidate row took 4 seconds in Node and 6 in the browser.
    expect(plan.slice(1).filter((d) => d.includes('records_by_type'))).toEqual([]);
    expect(await queue()).toEqual(before);
  }, 120_000);
});

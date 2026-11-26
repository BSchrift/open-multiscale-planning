import { beforeAll, describe, expect, it, vi } from 'vitest';
import { loadAnalyticsData } from '../core/analytics';
import { fixedClock } from '../core/clock';
import { addDays, addWeeks, localDate, thisWeek, weekStart } from '../core/dates';
import { refreshStatistics } from '../core/db';
import type { Db, Sql } from '../core/db';
import { historyChanges, historyFacts, HISTORY, keptHistory } from '../core/history-testing';
import { parsePeriod } from '../../../config/retention';
import { gatherPlans, oneOffCandidates, plannable, projectCandidates, taskDue } from '../core/plan';
import { needsNewTime, SQL } from '../core/queries';
import { queueItems, welcomeOptions } from '../core/queue';
import { applyRemote, listRecords } from '../core/records';
import { oneOffRows } from '../core/schedule';
import type { Task } from '../core/types';
import { findable } from '../ui/screens/capture/existing';
import { loadDoneDay } from '../ui/screens/done/data';
import { loadToday } from '../ui/screens/today/data';
import type { TodayData } from '../ui/screens/today/data';
import { loadWeek, weekModel } from '../ui/screens/week/data';
import type { WeekData } from '../ui/screens/week/data';
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
    expect(week.picks.filter((p) => p.week_start === week.week).length).toBeGreaterThan(4);
  }, 60_000);

  /** A Sql over the history that counts the rows each read brings back, as rows crossing the iPhone's bridge. */
  function counting() {
    const counted = { rows: 0, sql: null as unknown as Sql };
    counted.sql = {
      all: async (query, params) => {
        const found = await db.all(query, params);
        counted.rows += found.length;
        return found as never;
      },
      get: async (query, params) => {
        const found = await db.get(query, params);
        if (found) counted.rows++;
        return found as never;
      },
      run: (query, params) => db.run(query, params),
    };
    return counted;
  }

  it('opens Today reading open tasks and those it shows, and shows what every task would show', async () => {
    const counted = counting();
    const today = await loadToday(counted.sql, clock);
    const all = await listRecords(db, 'task');
    const whole: TodayData = { ...today, tasks: all, milestones: await listRecords(db, 'milestone') };
    expect(today.tasks.length).toBeLessThan(all.length / 3);
    expect(today.milestones.length).toBeLessThan(whole.milestones.length / 3);
    expect(counted.rows).toBeLessThan(6000);

    // What Today draws from its tasks: the One offs list, Pick one thing and Next up, the timeline's blocks, the queue's
    // rows, and the line under the prompt to plan (gateLine in Views.tsx).
    const byId = (data: TodayData) => new Map(data.tasks.map((t) => [t.id, t]));
    expect(oneOffRows(today.tasks, today.completions, clock)).toEqual(oneOffRows(all, today.completions, clock));
    expect(welcomeOptions(today.tasks, today.milestones, today.projects, clock)).toEqual(welcomeOptions(all, whole.milestones, whole.projects, clock));
    for (const b of today.blocks) expect(byId(today).get(b.task_id ?? '')).toEqual(byId(whole).get(b.task_id ?? ''));
    for (const q of today.queue) expect(byId(today).get(q.id)).toEqual(byId(whole).get(q.id));
    const gate = (data: TodayData) => {
      const ctx = { settings: data.settings, clock, away: data.away };
      const week = { weekStart: thisWeek(clock), picks: [], blocks: [] };
      return {
        due: oneOffCandidates(data.tasks, week, ctx).filter((c) => taskDue(c.task, null, week.weekStart, ctx).dueDay != null).map((c) => c.task.id),
        waiting: plannable(gatherPlans(data.projects, data.milestones, data.tasks), ctx).map((p) => projectCandidates(p, week, ctx).map((c) => c.task.id)),
      };
    };
    expect(gate(today)).toEqual(gate(whole));
    expect(today.queue.length).toBeGreaterThan(0);
    // The weeks of plans and picks it reads are the ones the queue looks at.
    const plans = await listRecords(db, 'week_plan');
    expect(today.queue).toEqual(queueItems(await needsNewTime(db), plans, await listRecords(db, 'week_pick'), clock));
    expect(today.planned).toBe(plans.some((p) => p.week_start === thisWeek(clock) && !!p.finished_at));
  }, 60_000);

  it('opens Week reading the weeks it shows, and works out what every record would', async () => {
    const current = weekStart(localDate(clock.now(), HISTORY.zone));
    for (const week of [current, addWeeks(current, 1), addWeeks(current, -1)]) {
      const counted = counting();
      const data = await loadWeek(counted.sql, clock, week);
      const records = await loadAnalyticsData(db);
      const whole: WeekData = { ...data, picks: await listRecords(db, 'week_pick'), records };
      expect(data.records.tasks.length).toBeLessThan(records.tasks.length / 3);
      expect(data.records.milestones.length).toBeLessThan(records.milestones.length / 3);
      expect(data.records.blocks.length).toBeLessThan(records.blocks.length / 10);
      expect(counted.rows).toBeLessThan(6000);

      const { itemFor, canChoose, ...model } = weekModel(data, clock);
      const { itemFor: wholeItemFor, canChoose: wholeCanChoose, ...wholeModel } = weekModel(whole, clock);
      expect(model).toEqual(wholeModel);
      const open = records.tasks.filter((t: Task) => !t.done_at && !t.cancelled_at);
      for (const t of open) {
        expect(canChoose(t.id)).toBe(wholeCanChoose(t.id));
        expect(itemFor(t)).toEqual(wholeItemFor(t));
      }
      // Capture's list of tasks to put in a free slot, which reads Week's tasks.
      const slot = { date: addDays(week, 2), start: 9 * 60, end: 11 * 60 };
      expect(findable(data, weekModel(data, clock), slot, 11 * 60)).toEqual(findable(whole, weekModel(whole, clock), slot, 11 * 60));
    }
  }, 120_000);

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
    const blocks = (await listRecords(db, 'time_block')).length;
    const toLocal = vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts');
    try {
      weekModel(data, clock);
      expect(toLocal.mock.calls.length).toBeLessThan(blocks);
    } finally {
      toLocal.mockRestore();
    }
  }, 60_000);

  it("times Today, Week, Week's figures, Done and Notes as of the history end, the median of five runs each, and counts what arrived", async () => {
    const { today_query_ms, week_query_ms, week_figures_ms, done_query_ms, notes_list_ms, notes_search_ms, records } = await timeHistoryQueries(db);
    expect(today_query_ms).toBeGreaterThan(0);
    expect(week_query_ms).toBeGreaterThan(0);
    expect(week_figures_ms).toBeGreaterThan(0);
    expect(done_query_ms).toBeGreaterThan(0);
    expect(notes_list_ms).toBeGreaterThan(0);
    expect(notes_search_ms).toBeGreaterThan(0);
    expect(records).toBe(historyFacts().records);
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

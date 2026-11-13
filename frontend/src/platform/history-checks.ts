// Times what Today, Week and Done read on a device's own database, after the history-scale test's first sync. The iPhone
// check page and the browser and Mac specs (frontend/e2e/history) run it in the app's page, so it goes through the same
// driver the app does. Never shipped in the app.

import { fixedClock } from '../core/clock';
import { localDate, weekStart } from '../core/dates';
import type { Sql } from '../core/db';
import { HISTORY } from '../core/history-testing';
import { loadDoneDay } from '../ui/screens/done/data';
import { loadToday } from '../ui/screens/today/data';
import { loadWeek } from '../ui/screens/week/data';

const RUNS = 5;

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
};

/**
 * Each query's median over five runs, in milliseconds, as of the history's end, which is when its last week is current,
 * and how many records the device holds, to show the whole history arrived.
 */
export async function timeHistoryQueries(sql: Sql, now: () => number = () => performance.now()) {
  const clock = fixedClock(HISTORY.now, HISTORY.zone);
  const week = weekStart(localDate(clock.now(), HISTORY.zone));
  const time = async (query: () => Promise<unknown>) => {
    const runs: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      const started = now();
      await query();
      runs.push(now() - started);
    }
    return Math.round(median(runs) * 10) / 10;
  };
  return {
    today_query_ms: await time(() => loadToday(sql, clock)),
    week_query_ms: await time(() => loadWeek(sql, clock, week)),
    done_query_ms: await time(() => loadDoneDay(sql, clock, localDate(clock.now(), HISTORY.zone))),
    records: (await sql.get<{ n: number }>('SELECT COUNT(*) AS n FROM records'))!.n,
  };
}

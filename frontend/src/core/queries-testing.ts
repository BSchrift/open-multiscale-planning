// About two years of made-up records and the query plan check, shared by the unit tests and the iOS check page, so
// both judge the planner on the same data by the same rules. The app never imports this file.

import { addDays, toInstant } from './dates';
import type { Db, Params, Sql } from './db';
import { QUERY_INDEX, SQL } from './queries';
import { outcomeId, weekPickId } from './records';

const stamp = '0000000000001-000000-seed';

/**
 * Direct inserts: seeding bypasses the outbox on purpose, since this data never syncs. A replace, since the iOS check
 * seeds the same database file each time it runs.
 */
export async function addRecord(sql: Sql, id: string, type: string, data: Record<string, unknown>, clock = stamp) {
  await sql.run('INSERT OR REPLACE INTO records (id, type, data, clocks) VALUES (:id, :type, :data, :clocks)', {
    id,
    type,
    data: JSON.stringify(data),
    clocks: JSON.stringify(Object.fromEntries(Object.keys(data).map((k) => [k, clock]))),
  });
}

/** Enough records for statistics to make the planner choose as it will in real use. */
export async function seedLarge(db: Db) {
  const add = addRecord;
  const start = Date.parse('2024-11-04T00:00:00Z');
  await db.transaction(async (tx) => {
    for (let p = 0; p < 40; p++) {
      const project = `project-${p}`;
      await add(tx, project, 'project', { title: `Project ${p}`, state: p < 6 ? 'active' : 'finished', start: '2024-11-01', end: '2027-01-01' });
      for (let m = 0; m < 6; m++) {
        await add(tx, `ms-${p}-${m}`, 'milestone', { project_id: project, title: `Milestone ${m}`, due: addDays('2024-12-01', p * 15 + m * 20) });
      }
      for (let t = 0; t < 50; t++) {
        await add(tx, `task-${p}-${t}`, 'task', {
          kind: 'project',
          project_id: project,
          milestone_id: `ms-${p}-${t % 6}`,
          title: `Task ${t}`,
          estimate_min: 60,
          remaining_min: 60,
          order: t,
          done_at: t < 40 ? '2025-01-01T00:00:00Z' : null,
        });
      }
    }
    for (let i = 0; i < 300; i++) await add(tx, `one-off-${i}`, 'task', { kind: 'one_off', title: `One off ${i}`, order: i });
    for (let i = 0; i < 20; i++) await add(tx, `inbox-${i}`, 'task', { kind: 'inbox', title: `Item ${i}`, order: i });
    for (let d = 0; d < 730; d++) {
      for (let n = 0; n < 6; n++) {
        const id = `block-${d}-${n}`;
        const startMs = start + d * 86_400_000 + n * 3_600_000;
        await add(tx, id, 'time_block', { task_id: `task-${d % 40}-${(d + n) % 50}`, start: toInstant(startMs), end: toInstant(startMs + 3_600_000), tz: 'UTC' });
        await add(tx, outcomeId(id), 'block_outcome', { result: n % 5 === 0 ? 'partly' : 'done', remaining_min: 30 });
      }
    }
    for (let w = 0; w < 104; w++) {
      const weekStart = addDays('2024-11-04', w * 7);
      for (let t = 0; t < 12; t++) {
        const task = `task-${w % 40}-${t}`;
        await add(tx, weekPickId(weekStart, task), 'week_pick', { week_start: weekStart, task_id: task, minutes: 60 });
      }
    }
  });
}

const PLAN_PARAMS: Params = {
  from_utc: '2026-11-02T05:00:00Z',
  to_utc: '2026-11-09T05:00:00Z',
  week_start: '2026-11-02',
  search: '',
  offset: 0,
  since: '2026-11-02T05:00:00Z',
  task_id: 'task-3-45',
  now: '2026-11-02T05:00:00Z',
};

const planParams = (sql: string): Params => Object.fromEntries(Object.entries(PLAN_PARAMS).filter(([k]) => new RegExp(`:${k}\\b`).test(sql)));

/** On seeded data: each index a query should use and doesn't, each scan, and each query that fails to run. */
export async function planProblems(db: Db): Promise<string[]> {
  const problems: string[] = [];
  for (const [name, indexes] of Object.entries(QUERY_INDEX)) {
    const sql = SQL[name as keyof typeof QUERY_INDEX];
    const details = (await db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, planParams(sql))).map((p) => p.detail);
    for (const index of indexes) {
      if (!details.some((d) => new RegExp(`USING (COVERING )?INDEX ${index}\\b`).test(d))) problems.push(`${name} misses ${index}: ${details.join(' | ')}`);
    }
    for (const d of details) if (/^SCAN\b|AUTOMATIC/.test(d)) problems.push(`${name} scans: ${d}`);
  }
  for (const [name, sql] of Object.entries(SQL)) {
    await db.all(sql, planParams(sql)).catch((err: unknown) => problems.push(`${name} fails: ${String(err)}`));
  }
  return problems;
}

// The read queries behind key screens, as typed functions. They only load rows; core modules apply anything a
// filter can't express, such as repeating schedules, statuses and slot offers. For whole records, use listRecords.
//
// A reworded query can silently fall back to a scan. queries.test.ts runs EXPLAIN QUERY PLAN on each one in
// QUERY_INDEX and fails if an index it lists is no longer used, or if it scans a whole table.

import { parseClock } from './clock';
import type { Sql } from './db';
import type { Attachment, BlockResult, Instant, LocalDate, Minutes, Task, TaskCompletion, TaskKind, TimeBlock, WeekPick } from './types';
import type { UtcRange } from './dates';

export const SQL = {
  inbox: `
    SELECT id, title, estimate_min, notes IS NOT NULL AND notes != '' AS has_notes
    FROM task
    WHERE kind = 'inbox'
      AND done_at IS NULL AND cancelled_at IS NULL AND deleted_at IS NULL
    ORDER BY sort_order, id`,

  inboxCount: `
    SELECT COUNT(*) AS n
    FROM task
    WHERE kind = 'inbox'
      AND done_at IS NULL AND cancelled_at IS NULL AND deleted_at IS NULL`,

  blocks: `
    SELECT b.id, b.start, b.end, b.tz, b.task_id, b.practice_id, b.started_at, b.ended_at, b.paused_at, b.paused_min,
           COALESCE(t.title, p.title) AS title,
           t.kind AS task_kind,
           o.result
    FROM time_block b
    LEFT JOIN task t ON t.id = b.task_id
    LEFT JOIN practice p ON p.id = b.practice_id
    LEFT JOIN block_outcome o ON o.id = 'outcome:' || b.id AND o.deleted_at IS NULL
    WHERE b.start >= :from_utc AND b.start < :to_utc
      AND b.cancelled IS NOT 1 AND b.deleted_at IS NULL
    ORDER BY b.start`,

  placed: `
    SELECT ROUND(COALESCE(SUM(
             (julianday(b.end) - MAX(julianday(b.start), julianday(:now))) * 1440), 0)) AS placed_min
    FROM time_block b
    WHERE b.start >= :from_utc AND b.start < :to_utc
      AND julianday(b.end) > julianday(:now)
      AND b.cancelled IS NOT 1 AND b.deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM week_pick k
        WHERE k.week_start = :week_start AND k.task_id = b.task_id
          AND k.deleted_at IS NULL)`,

  queue: `
    SELECT t.id, t.title, t.kind, t.project_id, b.id AS block_id, b.start AS block_start, b.end AS block_end,
           o.answered_at, o.result, o.remaining_min
    FROM block_outcome o
    JOIN time_block b ON b.id = o.block_id
    JOIN task t ON t.id = b.task_id
    WHERE o.result IN ('partly', 'not')
      AND o.deleted_at IS NULL AND o.dropped_at IS NULL
      AND t.done_at IS NULL AND t.cancelled_at IS NULL AND t.deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM time_block later
        WHERE later.task_id = t.id AND later.start > b.start
          AND later.cancelled IS NOT 1 AND later.deleted_at IS NULL)
      AND NOT EXISTS (
        SELECT 1 FROM task_completion c
        WHERE c.task_id = t.id AND c.deleted_at IS NULL
          AND julianday(c.done_at) >= julianday(b.start))`,

  finished: `
    SELECT c.id, c.task_id, t.title, c.done_at
    FROM task_completion c
    JOIN task t ON t.id = c.task_id
    WHERE c.deleted_at IS NULL
      AND t.title LIKE '%' || :search || '%'
    ORDER BY c.done_at DESC
    LIMIT 10 OFFSET :offset`,

  finishedCount: `
    SELECT COUNT(*) AS n
    FROM task_completion c
    JOIN task t ON t.id = c.task_id
    WHERE c.deleted_at IS NULL
      AND t.title LIKE '%' || :search || '%'`,

  taskAttachments: `
    SELECT id, task_id, kind, name, url, size, type, sha256, uploaded_at, deleted_at
    FROM attachment
    WHERE task_id = :task_id AND deleted_at IS NULL
    ORDER BY id`,

  oneOffs: `
    SELECT id, data
    FROM records
    WHERE type = 'task' AND json_extract(data, '$.kind') = 'one_off'
      AND json_extract(data, '$.deleted_at') IS NULL AND json_extract(data, '$.cancelled_at') IS NULL
      AND (json_extract(data, '$.done_at') IS NULL OR json_extract(data, '$.done_at') >= :since)
    ORDER BY id`,

  completionsSince: `
    SELECT id, task_id, done_at, previous_next, deleted_at
    FROM task_completion
    WHERE done_at >= :since AND deleted_at IS NULL`,

  projectTasks: `
    SELECT id, data
    FROM records
    WHERE type = 'task'
      AND json_extract(data, '$.project_id') IN (
        SELECT id FROM project WHERE state IN ('active', 'paused') AND deleted_at IS NULL)
      AND json_extract(data, '$.deleted_at') IS NULL
    ORDER BY id`,

  futureBlocks: `
    SELECT id, task_id, practice_id, start, end, tz, started_at, ended_at, cancelled, deleted_at
    FROM time_block
    WHERE task_id = :task_id AND start > :now
      AND started_at IS NULL AND cancelled IS NOT 1 AND deleted_at IS NULL`,

  futurePicks: `
    SELECT id, week_start, task_id, minutes, deleted_at
    FROM week_pick
    WHERE task_id = :task_id AND week_start >= :week_start AND deleted_at IS NULL`,

  weekPractices: `
    SELECT id, task_id, practice_id, start, end, tz, started_at, ended_at, cancelled, deleted_at
    FROM time_block
    WHERE start >= :from_utc AND start < :to_utc
      AND practice_id IS NOT NULL AND deleted_at IS NULL`,

  // Each goal with every record under it, deleted ones too: the goal, its projects with their milestones, tasks and
  // completions, its practices, and the blocks of those tasks and practices with their answers.
  goalClocks: `
    SELECT id AS goal, 1 AS own, clocks FROM records WHERE type = 'objective'
    UNION ALL SELECT json_extract(data, '$.objective_id'), 0, clocks FROM records WHERE type IN ('project', 'practice')
    UNION ALL SELECT p.objective_id, 0, r.clocks FROM records r JOIN project p ON p.id = json_extract(r.data, '$.project_id')
      WHERE r.type IN ('milestone', 'task')
    UNION ALL SELECT p.objective_id, 0, r.clocks FROM records r JOIN task t ON t.id = json_extract(r.data, '$.task_id')
      JOIN project p ON p.id = t.project_id WHERE r.type = 'task_completion'
    UNION ALL SELECT COALESCE(p.objective_id, pr.objective_id), 0, r.clocks FROM records r
      LEFT JOIN task t ON t.id = json_extract(r.data, '$.task_id') LEFT JOIN project p ON p.id = t.project_id
      LEFT JOIN practice pr ON pr.id = json_extract(r.data, '$.practice_id') WHERE r.type = 'time_block'
    UNION ALL SELECT COALESCE(p.objective_id, pr.objective_id), 0, r.clocks FROM records r JOIN time_block b ON b.id = substr(r.id, 9)
      LEFT JOIN task t ON t.id = b.task_id LEFT JOIN project p ON p.id = t.project_id
      LEFT JOIN practice pr ON pr.id = b.practice_id WHERE r.type = 'block_outcome'`,
} as const;

/**
 * Every index each query must use. Lookups by record type or id need no entry, because the test also fails on any
 * full scan. Finished has no index of its own: it stays fast through the type index alone.
 */
export const QUERY_INDEX = {
  inbox: ['task_kind'],
  inboxCount: ['task_kind'],
  blocks: ['block_start'],
  placed: ['block_start', 'pick_week'],
  queue: ['outcome_result', 'block_task'],
  finished: [],
  finishedCount: [],
  taskAttachments: [],
  oneOffs: ['task_kind'],
  completionsSince: [],
  projectTasks: ['task_project'],
  futureBlocks: ['block_task'],
  futurePicks: ['pick_week'],
  weekPractices: ['block_start'],
  goalClocks: [],
} as const satisfies Record<keyof typeof SQL, readonly string[]>;

export interface InboxRow {
  id: string;
  title: string;
  estimate_min: Minutes | null;
  /** 1 when it has a description. */
  has_notes: number;
}

/** A task's attachments, in the order they were added. */
export function taskAttachments(sql: Sql, taskId: string): Promise<Attachment[]> {
  return sql.all<Attachment>(SQL.taskAttachments, { task_id: taskId });
}

export function inboxTasks(sql: Sql): Promise<InboxRow[]> {
  return sql.all<InboxRow>(SQL.inbox);
}

export async function inboxCount(sql: Sql): Promise<number> {
  return (await sql.get<{ n: number }>(SQL.inboxCount))?.n ?? 0;
}

export interface BlockRow {
  id: string;
  start: Instant;
  end: Instant;
  tz: string | null;
  task_id: string | null;
  practice_id: string | null;
  started_at: Instant | null;
  ended_at: Instant | null;
  paused_at?: Instant | null;
  paused_min?: Minutes | null;
  title: string | null;
  task_kind: TaskKind | null;
  result: BlockResult | null;
}

/** Today and Week: turn the local day or week into a range with dayRange or weekRange. */
export function blocksInRange(sql: Sql, range: UtcRange): Promise<BlockRow[]> {
  return sql.all<BlockRow>(SQL.blocks, { from_utc: range.from_utc, to_utc: range.to_utc });
}

/** Time placed this week that wasn't picked, from now on: practices and repeating work. Add picks and divide by open time. */
export async function placedMinutes(sql: Sql, params: UtcRange & { week_start: LocalDate; now: Instant }): Promise<Minutes> {
  const row = await sql.get<{ placed_min: Minutes }>(SQL.placed, {
    from_utc: params.from_utc,
    to_utc: params.to_utc,
    week_start: params.week_start,
    now: params.now,
  });
  return row?.placed_min ?? 0;
}

export interface QueueRow {
  id: string;
  title: string;
  kind: TaskKind;
  project_id: string | null;
  block_id: string;
  block_start: Instant;
  block_end: Instant;
  answered_at: Instant;
  result: 'partly' | 'not';
  remaining_min: Minutes | null;
}

/** Needs a new time: work answered Partly or Not done, still open, not dropped, with no later block and no finish since. */
export function needsNewTime(sql: Sql): Promise<QueueRow[]> {
  return sql.all<QueueRow>(SQL.queue);
}

export interface FinishedRow {
  id: string;
  task_id: string;
  title: string;
  done_at: Instant;
}

/** Completions newest first, ten at a time. */
export function finishedTasks(sql: Sql, params: { search?: string; offset?: number } = {}): Promise<FinishedRow[]> {
  return sql.all<FinishedRow>(SQL.finished, { search: params.search ?? '', offset: params.offset ?? 0 });
}

export async function finishedCount(sql: Sql, params: { search?: string } = {}): Promise<number> {
  return (await sql.get<{ n: number }>(SQL.finishedCount, { search: params.search ?? '' }))?.n ?? 0;
}

/** One offs still open, or finished since the start of today, as whole records for schedule.oneOffRows. */
export async function oneOffTasks(sql: Sql, params: { since: Instant }): Promise<Task[]> {
  const rows = await sql.all<{ id: string; data: string }>(SQL.oneOffs, { since: params.since });
  return rows.map(({ id, data }) => ({ ...(JSON.parse(data) as Omit<Task, 'id'>), id }));
}

/** Finishes since a time, such as the start of today, for the ticks a list shows. */
export function completionsSince(sql: Sql, params: { since: Instant }): Promise<TaskCompletion[]> {
  return sql.all<TaskCompletion>(SQL.completionsSince, { since: params.since });
}

/** Tasks of active and paused projects, done and cancelled ones too, as whole records for plan.gatherPlans. */
export async function projectTasks(sql: Sql): Promise<Task[]> {
  const rows = await sql.all<{ id: string; data: string }>(SQL.projectTasks);
  return rows.map(({ id, data }) => ({ ...(JSON.parse(data) as Omit<Task, 'id'>), id }));
}

/** A task's blocks not yet started. A closed task gives these up. */
export function futureBlocks(sql: Sql, params: { task_id: string; now: Instant }): Promise<TimeBlock[]> {
  return sql.all<TimeBlock>(SQL.futureBlocks, { task_id: params.task_id, now: params.now });
}

/** A task's picks from a week on. A closed task gives these up. */
export function futurePicks(sql: Sql, params: { task_id: string; week_start: LocalDate }): Promise<WeekPick[]> {
  return sql.all<WeekPick>(SQL.futurePicks, { task_id: params.task_id, week_start: params.week_start });
}

/** A week's practice sessions, removed ones too, so a practice is placed only once a week. */
export function weekPractices(sql: Sql, range: UtcRange): Promise<TimeBlock[]> {
  return sql.all<TimeBlock>(SQL.weekPractices, { from_utc: range.from_utc, to_utc: range.to_utc });
}

/**
 * When each goal last changed, in epoch ms: its newest field write, from any device, to it or anything under it.
 * Answering Still a goal? (or undoing that) only writes the goal's own state, so those fields don't count.
 */
export async function goalChanges(sql: Sql): Promise<Record<string, number>> {
  const changed: Record<string, number> = {};
  for (const { goal, own, clocks } of await sql.all<{ goal: string | null; own: number; clocks: string }>(SQL.goalClocks)) {
    if (!goal) continue;
    for (const [field, clock] of Object.entries(JSON.parse(clocks) as Record<string, string>)) {
      if (own && (field === 'state' || field === 'not_now_until')) continue;
      changed[goal] = Math.max(changed[goal] ?? 0, parseClock(clock).wall);
    }
  }
  return changed;
}

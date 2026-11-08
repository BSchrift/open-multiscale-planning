import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import initSqlJs from 'sql.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { nodeSqliteDriver } from '../platform/node-sqlite';
import { sqliteWasmDriver } from '../platform/sqlite-wasm-driver';
import { sqlJsDriver } from '../platform/sqljs-driver';
import { openDb, refreshStatistics } from './db';
import type { Db } from './db';
import {
  blocksInRange,
  completionsSince,
  finishedCount,
  finishedTasks,
  goalChanges,
  inboxCount,
  inboxTasks,
  needsNewTime,
  oneOffTasks,
  placedMinutes,
  projectTasks,
} from './queries';
import { addRecord, planProblems, seedLarge } from './queries-testing';
import { outcomeId } from './records';

const add = addRecord;

async function seedSmall(db: Db) {
  await db.transaction(async (tx) => {
    await add(tx, 'p1', 'project', { title: 'Write the report', state: 'active', start: '2026-10-01', end: '2026-12-15' });
    await add(tx, 'p2', 'project', { title: 'Learn to bake bread', state: 'active', start: '2026-10-01', end: '2027-02-01' });
    await add(tx, 'p3', 'project', { title: 'Build a shed', state: 'active', start: '2026-10-01', end: '2026-11-20' });
    await add(tx, 'p4', 'project', { title: 'Plant a hedge', state: 'paused', start: '2026-10-01', end: '2026-12-01' });
    await add(tx, 'm1', 'milestone', { project_id: 'p1', title: 'Gather sources', due: '2026-10-18' });
    await add(tx, 'm2', 'milestone', { project_id: 'p1', title: 'First draft', due: '2026-11-09', stretch: '2026-11-01' });
    await add(tx, 'm3', 'milestone', { project_id: 'p2', title: 'Done early', due: '2026-09-01', met_at: '2026-09-01T10:00:00Z' });
    await add(tx, 'm4', 'milestone', { project_id: 'p2', title: 'First loaf', due: '2026-11-21' });
    await add(tx, 'm5', 'milestone', { project_id: 'p1', title: 'Undated in plan', stretch: '2026-11-01' });
    await add(tx, 't1', 'task', { kind: 'project', project_id: 'p1', milestone_id: 'm1', title: 'Read papers', estimate_min: 120, remaining_min: 120, order: 1 });
    await add(tx, 't2', 'task', { kind: 'project', project_id: 'p1', milestone_id: 'm2', title: 'Outline', estimate_min: 240, remaining_min: 240, order: 1 });
    await add(tx, 't3', 'task', { kind: 'project', project_id: 'p1', title: 'No milestone', estimate_min: 60, remaining_min: 60, order: 1 });
    await add(tx, 't4', 'task', { kind: 'one_off', title: 'Paint the fence', estimate_min: 60, remaining_min: 60, order: 1 });
    await add(tx, 't5', 'task', { kind: 'inbox', title: 'Water the plants', order: 1 });
    await add(tx, 't6', 'task', { kind: 'project', project_id: 'p1', milestone_id: 'm1', title: 'Old', done_at: '2026-10-01T10:00:00Z' });
    await add(tx, 't7', 'task', { kind: 'one_off', title: 'Clean the windows', estimate_min: 60, order: 2 });
    await add(tx, 't8', 'task', { kind: 'one_off', title: 'Done last month', done_at: '2026-10-01T10:00:00Z' });
    await add(tx, 'w1', 'week_pick', { week_start: '2026-11-02', task_id: 't1', minutes: 120 });
    await add(tx, 'w2', 'week_pick', { week_start: '2026-11-02', task_id: 't4', minutes: 60 });
    await add(tx, 'w3', 'week_pick', { week_start: '2026-11-02', task_id: 't2', minutes: 60, deleted_at: '2026-11-01T00:00:00Z' });
    await add(tx, 'w4', 'week_pick', { week_start: '2026-10-26', task_id: 't2', minutes: 60 });
    await add(tx, 'pr1', 'practice', { title: 'Piano practice', target_min: 30, per: 'day', state: 'active' });
    await add(tx, 'b1', 'time_block', { task_id: 't1', start: '2026-11-02T17:00:00Z', end: '2026-11-02T19:00:00Z' });
    await add(tx, 'b2', 'time_block', { practice_id: 'pr1', start: '2026-11-02T20:00:00Z', end: '2026-11-02T20:30:00Z' });
    await add(tx, 'b3', 'time_block', { task_id: 't2', start: '2026-10-29T17:00:00Z', end: '2026-10-29T18:00:00Z' });
    await add(tx, outcomeId('b3'), 'block_outcome', { result: 'partly', remaining_min: 30, logged_min: 30 });
    await add(tx, 'b4', 'time_block', { task_id: 't4', start: '2026-11-03T17:00:00Z', end: '2026-11-03T18:00:00Z', cancelled: true });
    await add(tx, 'b5', 'time_block', { task_id: 't7', start: '2026-11-04T17:00:00Z', end: '2026-11-04T18:00:00Z' });
    await add(tx, 'c1', 'task_completion', { task_id: 't7', done_at: '2026-10-20T10:00:00Z' });
    await add(tx, 'c2', 'task_completion', { task_id: 't7', done_at: '2026-09-20T10:00:00Z', deleted_at: '2026-09-21T10:00:00Z' });
  });
}

const week = { from_utc: '2026-11-02T05:00:00Z', to_utc: '2026-11-09T05:00:00Z' };

function answers(open: () => Promise<Db>) {
  let db: Db;
  beforeAll(async () => {
    db = await open();
    await seedSmall(db);
  });

  it('inbox and its count share one filter', async () => {
    expect((await inboxTasks(db)).map((r) => r.title)).toEqual(['Water the plants']);
    expect(await inboxCount(db)).toBe(1);
  });

  it('blocks in a range, with outcome and kind, skipping cancelled', async () => {
    const rows = await blocksInRange(db, week);
    expect(rows.map((r) => r.title)).toEqual(['Read papers', 'Piano practice', 'Clean the windows']);
    expect(rows.map((r) => r.task_kind)).toEqual(['project', null, 'one_off']);
    const last = await blocksInRange(db, { from_utc: '2026-10-26T05:00:00Z', to_utc: '2026-11-02T05:00:00Z' });
    expect(last[0]!.result).toBe('partly');
  });

  it('placed time counts only what wasn’t picked, and only what is still to come', async () => {
    expect(await placedMinutes(db, { ...week, week_start: '2026-11-02', now: week.from_utc })).toBe(90);
    // Halfway through the 30 minute practice session.
    expect(await placedMinutes(db, { ...week, week_start: '2026-11-02', now: '2026-11-02T20:15:00Z' })).toBe(75);
  });

  it('queue is work answered partly or not, open, with no later block', async () => {
    const rows = await needsNewTime(db);
    expect(rows.map((r) => [r.title, r.result, r.remaining_min, r.block_id])).toEqual([['Outline', 'partly', 30, 'b3']]);
  });

  it('finished tasks, with search', async () => {
    expect((await finishedTasks(db)).map((r) => r.id)).toEqual(['c1']);
    expect(await finishedTasks(db, { search: 'zzz' })).toEqual([]);
    expect((await finishedTasks(db, { search: 'window' })).map((r) => r.id)).toEqual(['c1']);
    expect(await finishedCount(db)).toBe(1);
    expect(await finishedCount(db, { search: 'zzz' })).toBe(0);
  });

  it('one offs to list today, as whole records, and completions since a time', async () => {
    const tasks = await oneOffTasks(db, { since: '2026-10-02T05:00:00Z' });
    expect(tasks.map((t) => t.title)).toEqual(['Paint the fence', 'Clean the windows']);
    expect(tasks[0]).toMatchObject({ id: 't4', kind: 'one_off', estimate_min: 60 });
    expect((await oneOffTasks(db, { since: '2026-09-30T05:00:00Z' })).map((t) => t.id)).toContain('t8');
    expect((await completionsSince(db, { since: '2026-10-01T00:00:00Z' })).map((c) => c.id)).toEqual(['c1']);
    expect(await completionsSince(db, { since: '2026-10-21T00:00:00Z' })).toEqual([]);
  });

  it('tasks of active and paused projects, done ones too, as whole records', async () => {
    const tasks = await projectTasks(db);
    expect(tasks.map((t) => t.id)).toEqual(['t1', 't2', 't3', 't6']);
    expect(tasks[0]).toMatchObject({ project_id: 'p1', milestone_id: 'm1', title: 'Read papers', estimate_min: 120 });
  });
}

describe('when each goal last changed', () => {
  it('is the newest field write to the goal or anything under it, on any device, but not an answer to Still a goal?', async () => {
    const db = await openDb(nodeSqliteDriver());
    const at = (day: number) => `${String(Date.parse(`2026-10-${String(day).padStart(2, '0')}T12:00:00Z`))}-000000-dev`;
    await db.transaction(async (tx) => {
      await add(tx, 'g1', 'objective', { title: 'Learn to bake bread', state: 'active' }, at(1));
      await add(tx, 'p1', 'project', { objective_id: 'g1', title: 'Bake a sourdough loaf', state: 'dropped' }, at(2));
      await add(tx, 'm1', 'milestone', { project_id: 'p1', title: 'Make a starter' }, at(3));
      await add(tx, 't1', 'task', { kind: 'project', project_id: 'p1', title: 'Buy flour' }, at(4));
      await add(tx, 'b1', 'time_block', { task_id: 't1', start: '2026-10-05T15:00:00Z', end: '2026-10-05T16:00:00Z' }, at(5));
      await add(tx, outcomeId('b1'), 'block_outcome', { result: 'done' }, at(9));
      await add(tx, 'g2', 'objective', { title: 'Run a 10k', state: 'active' }, at(1));
      await add(tx, 'pr1', 'practice', { objective_id: 'g2', title: 'Stretch', state: 'active' }, at(2));
      await add(tx, 'b2', 'time_block', { practice_id: 'pr1', start: '2026-10-06T15:00:00Z', end: '2026-10-06T16:00:00Z' }, at(7));
      await add(tx, 'g3', 'objective', { title: 'Write a novel', state: 'active' }, at(3));
      await add(tx, 'c1', 'task_completion', { task_id: 't1', done_at: '2026-10-08T10:00:00Z' }, at(8));
      await add(tx, 't2', 'task', { kind: 'one_off', title: 'Paint the fence' }, at(20));
    });
    // Answering Still a goal? writes the goal's state, which isn't a change to the goal.
    await db.run('UPDATE records SET clocks = json_set(clocks, \'$.state\', :c, \'$.not_now_until\', :c) WHERE id = \'g3\'', { c: at(25) });
    expect(await goalChanges(db)).toEqual({ g1: Date.parse('2026-10-09T12:00:00Z'), g2: Date.parse('2026-10-07T12:00:00Z'), g3: Date.parse('2026-10-03T12:00:00Z') });
  });
});

describe('query answers on node:sqlite', () => {
  answers(() => openDb(nodeSqliteDriver()));
});

describe('the queue and repeating one offs', () => {
  it('leaves out an occurrence finished since its block began, and brings it back if unticked', async () => {
    const db = await openDb(nodeSqliteDriver());
    const weekly = { type: 'recurring', every: 1, unit: 'week', anchor: '2026-10-05' };
    await db.transaction(async (tx) => {
      await add(tx, 'r', 'task', { kind: 'one_off', title: 'Water the plants', schedule: weekly, next_due: '2026-11-02' });
      await add(tx, 'b', 'time_block', { task_id: 'r', start: '2026-11-02T08:00:00Z', end: '2026-11-02T08:30:00Z' });
      await add(tx, outcomeId('b'), 'block_outcome', { result: 'not' });
      await add(tx, 'before', 'task_completion', { task_id: 'r', done_at: '2026-10-26T18:00:00Z' });
    });
    expect((await needsNewTime(db)).map((r) => r.block_id)).toEqual(['b']);

    await db.transaction((tx) => add(tx, 'ticked', 'task_completion', { task_id: 'r', done_at: '2026-11-02T18:00:00Z' }));
    expect(await needsNewTime(db)).toEqual([]);

    await db.run(`UPDATE records SET data = json_set(data, '$.deleted_at', '2026-11-02T18:05:00Z') WHERE id = 'ticked'`);
    expect((await needsNewTime(db)).map((r) => r.block_id)).toEqual(['b']);
  });

  it('leaves out an occurrence whose row was dropped, and brings it back once that is undone', async () => {
    const db = await openDb(nodeSqliteDriver());
    const weekly = { type: 'recurring', every: 1, unit: 'week', anchor: '2026-10-05' };
    await db.transaction(async (tx) => {
      await add(tx, 'r', 'task', { kind: 'one_off', title: 'Water the plants', schedule: weekly, next_due: '2026-11-09' });
      await add(tx, 'b', 'time_block', { task_id: 'r', start: '2026-11-02T08:00:00Z', end: '2026-11-02T08:30:00Z' });
      await add(tx, outcomeId('b'), 'block_outcome', { result: 'not', dropped_at: '2026-11-02T18:00:00Z' });
    });
    expect(await needsNewTime(db)).toEqual([]);

    await db.run(`UPDATE records SET data = json_set(data, '$.dropped_at', NULL) WHERE id = :id`, { id: outcomeId('b') });
    expect((await needsNewTime(db)).map((r) => r.block_id)).toEqual(['b']);
  });
});

describe('query answers on sql.js', () => {
  answers(async () => openDb(sqlJsDriver(new (await initSqlJs()).Database())));
});

describe('query answers on SQLite Wasm', () => {
  answers(async () => openDb(sqliteWasmDriver(new (await sqlite3InitModule()).oo1.DB(':memory:'))));
});

function plans(open: () => Promise<Db>) {
  let db: Db;
  beforeAll(async () => {
    db = await open();
    await seedLarge(db);
    await refreshStatistics(db);
  }, 120_000);

  it('every query uses its indexes, never scans, and runs on large data', async () => {
    expect(await planProblems(db)).toEqual([]);
  });
}

describe('query plans on node:sqlite', () => {
  plans(() => openDb(nodeSqliteDriver()));
});

describe('query plans on sql.js', () => {
  plans(async () => openDb(sqlJsDriver(new (await initSqlJs()).Database())));
});

describe('query plans on SQLite Wasm', () => {
  plans(async () => openDb(sqliteWasmDriver(new (await sqlite3InitModule()).oo1.DB(':memory:'))));
});

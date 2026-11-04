import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { clockWins, fixedClock, formatClock, nextClock, observeClock, parseClock } from './clock';
import {
  addDays,
  addMonths,
  dayRange,
  diffDays,
  formatMinutes,
  formatTimeOfDay,
  formatWeekRange,
  isDay,
  localDate,
  localMinutes,
  localToInstant,
  monthEnd,
  quarterEnd,
  quarterStart,
  thisWeek,
  toInstant,
  weekday,
  weekRange,
  weekStart,
} from './dates';
import { createDb, getMeta, META, MIGRATIONS, openDb, RECORD_FIELDS, setMeta, toPositional } from './db';
import { QUERY_INDEX } from './queries';
import type { DbChange, Migration } from './db';
import {
  applyRemote,
  getRecord,
  getSettings,
  listRecords,
  newId,
  occurrenceId,
  outcomeId,
  removeWeekPick,
  setWeekPick,
  transact,
  updateSettings,
  weekPickId,
} from './records';
import { RECORD_TYPES } from './types';
import type { RecordChange } from './types';
import { nodeSqliteDriver, openTestDb } from '../platform/node-sqlite';

const clock = fixedClock('2026-11-02T15:00:00Z', 'America/Chicago');

describe('hybrid clock', () => {
  it('round trips and sorts as text', () => {
    const a = formatClock({ wall: 1000, counter: 2, device: 'aa' });
    expect(a).toBe('0000000001000-000002-aa');
    expect(parseClock(a)).toEqual({ wall: 1000, counter: 2, device: 'aa' });
    expect(() => parseClock('nonsense')).toThrow();
    expect(a < formatClock({ wall: 1000, counter: 2, device: 'ab' })).toBe(true);
    expect(formatClock({ wall: 999, counter: 9, device: 'zz' }) < a).toBe(true);
  });

  it('never goes backward, even when the wall clock does', () => {
    const c1 = nextClock(null, 5000, 'd');
    const c2 = nextClock(c1, 5000, 'd');
    const c3 = nextClock(c2, 4000, 'd');
    const c4 = nextClock(c3, 6000, 'd');
    expect([c1, c2, c3, c4]).toEqual([c1, c2, c3, c4].slice().sort());
    expect(new Set([c1, c2, c3, c4]).size).toBe(4);
    expect(parseClock(c3)).toMatchObject({ wall: 5000, counter: 2 });
    expect(parseClock(c4)).toMatchObject({ wall: 6000, counter: 0 });
  });

  it('rolls over to the next millisecond when the counter is full', () => {
    expect(parseClock(nextClock(formatClock({ wall: 5, counter: 999999, device: 'd' }), 5, 'd'))).toMatchObject({ wall: 6, counter: 0 });
  });

  it('issues clocks after a remote clock it has seen', () => {
    const remote = formatClock({ wall: 9000, counter: 3, device: 'other' });
    const seen = observeClock(nextClock(null, 5000, 'd'), remote);
    expect(seen).toBe(remote);
    expect(nextClock(seen, 5000, 'd') > remote).toBe(true);
    expect(observeClock(remote, nextClock(null, 1, 'd'))).toBe(remote);
  });

  it('treats equal clocks as the same write', () => {
    expect(clockWins('b', 'a')).toBe(true);
    expect(clockWins('a', 'a')).toBe(false);
    expect(clockWins('a', undefined)).toBe(true);
  });
});

describe('dates', () => {
  it('tells a real local date from anything else', () => {
    expect(isDay('2026-11-02')).toBe(true);
    expect(isDay('2026-13-02')).toBe(false);
    expect(isDay('2026-11-2')).toBe(false);
    expect(isDay('')).toBe(false);
    expect(isDay(undefined)).toBe(false);
  });

  it('starts weeks on Monday', () => {
    expect(weekday('2026-11-02')).toBe(0);
    expect(weekday('2026-11-08')).toBe(6);
    expect(weekStart('2026-11-08')).toBe('2026-11-02');
    expect(weekStart('2026-11-02')).toBe('2026-11-02');
    expect(weekStart('1969-12-31')).toBe('1969-12-29');
  });

  it('uses the injected clock and zone', () => {
    const late = fixedClock('2026-11-02T03:00:00Z', 'America/Chicago');
    expect(localDate(late.now(), late.zone())).toBe('2026-11-01');
    expect(thisWeek(late)).toBe('2026-10-26');
    expect(localDate(late.now(), 'Asia/Tokyo')).toBe('2026-11-02');
  });

  it('keeps wall-clock hours across daylight saving', () => {
    const zone = 'America/New_York';
    expect(localToInstant('2026-11-01', 20 * 60, zone)).toBe('2026-11-02T01:00:00Z');
    expect(localToInstant('2026-10-31', 20 * 60, zone)).toBe('2026-11-01T00:00:00Z');
    expect(localToInstant('2026-03-08', 20 * 60, zone)).toBe('2026-03-09T00:00:00Z');
    expect(localMinutes('2026-11-02T01:00:00Z', zone)).toBe(20 * 60);
  });

  it('handles times that happen twice or never', () => {
    const zone = 'America/New_York';
    expect(localToInstant('2026-11-01', 90, zone)).toBe('2026-11-01T05:30:00Z');
    expect(localToInstant('2026-03-08', 150, zone)).toBe('2026-03-08T07:30:00Z');
  });

  it('gives day and week ranges that follow the zone, including short and long days', () => {
    const zone = 'America/New_York';
    expect(dayRange('2026-11-01', zone)).toEqual({ from_utc: '2026-11-01T04:00:00Z', to_utc: '2026-11-02T05:00:00Z' });
    expect(weekRange('2026-11-02', zone)).toEqual({ from_utc: '2026-11-02T05:00:00Z', to_utc: '2026-11-09T05:00:00Z' });
    expect(weekRange('2026-11-02', 'Asia/Kolkata').from_utc).toBe('2026-11-01T18:30:00Z');
  });

  it('does date arithmetic with month ends and quarters', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(diffDays('2026-11-01', '2027-01-31')).toBe(91);
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2026-11-15', 3)).toBe('2027-02-15');
    expect(addMonths('2026-02-15', -3)).toBe('2025-11-15');
    expect(monthEnd('2028-02-03')).toBe('2028-02-29');
    expect(quarterStart('2026-11-15')).toBe('2026-10-01');
    expect(quarterEnd('2026-11-15')).toBe('2026-12-31');
    expect(quarterEnd('2026-01-01')).toBe('2026-03-31');
  });

  it('formats', () => {
    expect(toInstant(Date.parse('2026-11-02T15:00:00.456Z'))).toBe('2026-11-02T15:00:00Z');
    expect(formatMinutes(45)).toBe('45m');
    expect(formatMinutes(120)).toBe('2h');
    expect(formatMinutes(90)).toBe('1h 30m');
    expect(formatTimeOfDay(0)).toBe('12am');
    expect(formatTimeOfDay(12 * 60)).toBe('12pm');
    expect(formatTimeOfDay(20 * 60 + 30)).toBe('8:30pm');
    expect(formatWeekRange('2026-11-02')).toBe('Nov 2 to 8');
    expect(formatWeekRange('2026-10-26')).toBe('Oct 26 to Nov 1');
  });
});

describe('db', () => {
  it('converts named parameters, leaving strings and comments alone', () => {
    expect(toPositional("SELECT 'outcome:' || :a, ':no', 'it''s :no' -- :no\n, :a, :b", { a: 1, b: true })).toEqual({
      sql: "SELECT 'outcome:' || ?, ':no', 'it''s :no' -- :no\n, ?, ?",
      values: [1, 1, 1],
    });
    expect(() => toPositional('SELECT :missing')).toThrow(/missing/);
  });

  it('creates the schema, with untyped ids and a view for each record type', async () => {
    const driver = nodeSqliteDriver();
    const db = await openDb(driver);
    expect(await getMeta(db, META.schemaVersion)).toBe(String(MIGRATIONS.length));
    expect(await getMeta(db, META.deviceId)).toMatch(/^[0-9a-f]{16}$/);
    const columns = await db.all<{ name: string; type: string }>('PRAGMA table_info(records)');
    expect(columns.find((c) => c.name === 'id')?.type).toBe('');
    const views = await db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'view'");
    expect(views.map((v) => v.name).sort()).toEqual([...RECORD_TYPES].sort());
    for (const type of RECORD_TYPES) await db.all(`SELECT * FROM ${type}`);
    expect(Object.keys(RECORD_FIELDS).sort()).toEqual([...RECORD_TYPES].sort());
  });

  it('keeps only the indexes a query uses, dropping one from an older install', async () => {
    const driver = nodeSqliteDriver();
    await openDb(driver, MIGRATIONS.slice(0, 1));
    const db = await openDb(driver);
    const indexes = await db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'");
    const used = new Set([...Object.values(QUERY_INDEX).flat(), 'records_by_type']);
    expect(indexes.map((i) => i.name).filter((name) => !used.has(name))).toEqual([]);
  });

  it('rebuilds the views for an install made before projects remembered raised estimates', async () => {
    const driver = nodeSqliteDriver();
    await openDb(driver, MIGRATIONS.slice(0, 1));
    const db = await openDb(driver);
    expect(await db.all('SELECT estimates_raised_at FROM project')).toEqual([]);
  });

  it('applies only new migrations, keeps the device id, and rolls back a failed one', async () => {
    const driver = nodeSqliteDriver();
    const db = await openDb(driver);
    const device = await getMeta(db, META.deviceId);
    const top = MIGRATIONS.length;
    const next: Migration[] = [...MIGRATIONS, { version: top + 1, statements: ['CREATE TABLE extra (x)'] }];
    const db2 = await openDb(driver, next);
    expect(await getMeta(db2, META.schemaVersion)).toBe(String(top + 1));
    expect(await getMeta(db2, META.deviceId)).toBe(device);
    await openDb(driver, next);

    const bad: Migration[] = [...next, { version: top + 2, statements: ['CREATE TABLE half (x)', 'NOT SQL'] }];
    await expect(openDb(driver, bad)).rejects.toThrow();
    expect(await getMeta(db2, META.schemaVersion)).toBe(String(top + 1));
    expect(await db2.all("SELECT 1 FROM sqlite_master WHERE name = 'half'")).toEqual([]);

    await expect(openDb(driver, MIGRATIONS)).rejects.toThrow(/newer/);
  });

  it('rolls a transaction back on error and keeps working', async () => {
    const db = await openTestDb();
    await expect(
      db.transaction(async (tx) => {
        await setMeta(tx, 'k', 'v');
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await getMeta(db, 'k')).toBeNull();
    await setMeta(db, 'k', 'after');
    expect(await getMeta(db, 'k')).toBe('after');
  });

  it('reports the original error when the rollback fails too', async () => {
    const inner = nodeSqliteDriver();
    const db = createDb({
      ...inner,
      exec: async (sql) => {
        if (sql === 'ROLLBACK') throw new Error('no transaction is active');
        return inner.exec(sql);
      },
    });
    await expect(
      db.transaction(async () => {
        throw new Error('disk full');
      }),
    ).rejects.toThrow('disk full');
  });

  it('a throwing listener neither fails the committed write nor starves other listeners', async () => {
    const db = await openTestDb();
    const seen: DbChange[] = [];
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    db.subscribe(() => {
      throw new Error('listener bug');
    });
    db.subscribe((c) => seen.push(c));
    await expect(transact(db, clock, (w) => w.create('task', { kind: 'inbox', title: 'Paint the fence' }))).resolves.toBeTruthy();
    expect(seen).toHaveLength(1);
    quiet.mockRestore();
  });

  it("doesn't let other work interleave with a transaction on an async driver", async () => {
    const inner = nodeSqliteDriver();
    const log: string[] = [];
    const slow = {
      ...inner,
      exec: async (sql: string) => {
        log.push(sql);
        await new Promise((r) => setTimeout(r, 1));
        return inner.exec(sql);
      },
      run: async (sql: string, values: Parameters<typeof inner.run>[1]) => {
        log.push(sql);
        await new Promise((r) => setTimeout(r, 1));
        return inner.run(sql, values);
      },
    };
    const db = createDb(slow);
    await db.run('CREATE TABLE t (x)');
    log.length = 0;
    await Promise.all([
      db.transaction(async (tx) => {
        await tx.run('INSERT INTO t VALUES (1)');
        await tx.run('INSERT INTO t VALUES (2)');
      }),
      db.run('INSERT INTO t VALUES (3)'),
      db.transaction(async (tx) => {
        await tx.run('INSERT INTO t VALUES (4)');
      }),
    ]);
    expect(log).toEqual([
      'BEGIN IMMEDIATE',
      'INSERT INTO t VALUES (1)',
      'INSERT INTO t VALUES (2)',
      'COMMIT',
      'INSERT INTO t VALUES (3)',
      'BEGIN IMMEDIATE',
      'INSERT INTO t VALUES (4)',
      'COMMIT',
    ]);
  });
});

describe('records', () => {
  const outbox = (db: Awaited<ReturnType<typeof openTestDb>>) =>
    db.all<{ record_id: string; type: string; field: string; clock: string }>('SELECT * FROM outbox ORDER BY record_id, field');

  it('makes ids that sort by creation time', () => {
    const c = fixedClock(1000);
    const first = newId(c);
    c.set(2000);
    const second = newId(c);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(first < second).toBe(true);
  });

  it('keeps added order for ids made in the same millisecond, and when the wall clock steps back', () => {
    const c = fixedClock('2031-01-01T00:00:00Z');
    const ids = Array.from({ length: 5000 }, () => newId(c));
    c.set('2030-01-01T00:00:00Z');
    ids.push(newId(c));
    expect(ids).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids.slice(-2)) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('writes the record, a clock per field, and the outbox together', async () => {
    const db = await openTestDb();
    const id = await transact(db, clock, (w) => w.create('task', { kind: 'inbox', title: 'Paint the fence' }));
    const row = (await db.get<{ type: string; data: string; clocks: string }>('SELECT * FROM records'))!;
    expect(row.type).toBe('task');
    expect(JSON.parse(row.data)).toEqual({ kind: 'inbox', title: 'Paint the fence' });
    const clocks = JSON.parse(row.clocks);
    expect(Object.keys(clocks).sort()).toEqual(['kind', 'title']);
    const out = await outbox(db);
    expect(out.map((o) => [o.record_id, o.type, o.field, o.clock])).toEqual([
      [id, 'task', 'kind', clocks.kind],
      [id, 'task', 'title', clocks.title],
    ]);
    expect(await getMeta(db, META.clock)).toBe(clocks.title);
  });

  it('an automatic write creates with the lowest clock, so any device’s write wins, but changes a record already here like any edit', async () => {
    const db = await openTestDb();
    const device = (await getMeta(db, META.deviceId))!;
    await transact(db, clock, (w) => w.automatic.create('task', { kind: 'inbox', title: 'Paint the fence' }, 'auto'));
    const lowest = formatClock({ wall: 0, counter: 0, device });
    expect(JSON.parse((await db.get<{ clocks: string }>("SELECT clocks FROM records WHERE id = 'auto'"))!.clocks)).toEqual({ kind: lowest, title: lowest });
    expect(await getMeta(db, META.clock)).toBeNull();
    await applyRemote(db, [{ type: 'task', id: 'auto', fields: { title: { v: 'Fix the gate', c: formatClock({ wall: 1, counter: 0, device: 'other' }) } } }]);
    expect((await getRecord(db, 'task', 'auto'))?.title).toBe('Fix the gate');

    await transact(db, clock, (w) => w.automatic.create('task', { title: 'Write the report' }, 'auto'));
    const clocks = JSON.parse((await db.get<{ clocks: string }>("SELECT clocks FROM records WHERE id = 'auto'"))!.clocks);
    expect(clocks.title).toBe(await getMeta(db, META.clock));
    expect(parseClock(clocks.title).wall).toBe(clock.now());
  });

  it('commits nothing when any part of a transaction fails', async () => {
    const db = await openTestDb();
    const events: DbChange[] = [];
    db.subscribe((c) => events.push(c));
    await expect(
      transact(db, clock, async (w) => {
        await w.create('task', { kind: 'inbox', title: 'Paint the fence' });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await db.all('SELECT * FROM records')).toEqual([]);
    expect(await outbox(db)).toEqual([]);
    expect(await getMeta(db, META.clock)).toBeNull();
    expect(events).toEqual([]);
  });

  it('replaces the outbox row on re-edit, and returns old values for undo', async () => {
    const db = await openTestDb();
    const id = await transact(db, clock, (w) => w.create('task', { kind: 'inbox', title: 'One' }));
    const before = await outbox(db);
    const prev = await transact(db, clock, (w) => w.set('task', id, { title: 'Two', estimate_min: 30 }));
    expect(prev).toEqual({ title: 'One', estimate_min: null });
    const after = await outbox(db);
    expect(after.map((o) => o.field)).toEqual(['estimate_min', 'kind', 'title']);
    expect(after.find((o) => o.field === 'title')!.clock > before.find((o) => o.field === 'title')!.clock).toBe(true);
    await transact(db, clock, (w) => w.set('task', id, prev));
    const task = await getRecord(db, 'task', id);
    expect(task).toMatchObject({ title: 'One', estimate_min: null });
  });

  it('skips writes that change nothing', async () => {
    const db = await openTestDb();
    const id = await transact(db, clock, (w) => w.create('task', { kind: 'inbox', title: 'One' }));
    const clocksBefore = await getMeta(db, META.clock);
    const events: DbChange[] = [];
    db.subscribe((c) => events.push(c));
    await transact(db, clock, (w) => w.set('task', id, { title: 'One', link: undefined }));
    expect(await getMeta(db, META.clock)).toBe(clocksBefore);
    expect(events).toEqual([]);
  });

  it('refuses to set a missing record, to change an id, or to reuse an id across types', async () => {
    const db = await openTestDb();
    await expect(transact(db, clock, (w) => w.set('task', 'nope', { title: 'x' }))).rejects.toThrow(/No task/);
    const id = await transact(db, clock, (w) => w.create('task', { kind: 'inbox', title: 'x' }));
    await expect(transact(db, clock, (w) => w.set('project', id, { title: 'x' }))).rejects.toThrow(/is a task/);
    await expect(transact(db, clock, (w) => w.create('project', { title: 'x' }, id))).rejects.toThrow(/is a task/);
    await expect(transact(db, clock, (w) => w.set('task', id, { id: 'other' } as never))).rejects.toThrow(/cannot be changed/);
    await expect(transact(db, clock, (w) => w.create('task', { title: 'x' }, 'has space'))).rejects.toThrow(/Invalid/);
  });

  it('soft deletes, and hides deleted records unless asked', async () => {
    const db = await openTestDb();
    const id = await transact(db, clock, (w) => w.create('task', { kind: 'inbox', title: 'x' }));
    await transact(db, clock, (w) => w.delete('task', id));
    expect(await listRecords(db, 'task')).toEqual([]);
    const [kept] = await listRecords(db, 'task', { includeDeleted: true });
    expect(kept!.deleted_at).toBe('2026-11-02T15:00:00Z');
    expect((await outbox(db)).map((o) => o.field)).toContain('deleted_at');
    await transact(db, clock, (w) => w.set('task', id, { deleted_at: null }));
    expect(await listRecords(db, 'task')).toHaveLength(1);
  });

  it('keeps unknown fields from a newer app version when editing', async () => {
    const db = await openTestDb();
    await applyRemote(db, [{ type: 'task', id: 't', fields: { title: { v: 'x', c: formatClock({ wall: 1, counter: 0, device: 'o' }) }, future_field: { v: 1, c: formatClock({ wall: 1, counter: 0, device: 'o' }) } } }]);
    await transact(db, clock, (w) => w.set('task', 't', { title: 'y' }));
    expect(await getRecord(db, 'task', 't')).toMatchObject({ title: 'y', future_field: 1 });
  });

  it('merges a repeated deterministic id into one record', async () => {
    const db = await openTestDb();
    await transact(db, clock, (w) => setWeekPick(w, '2026-11-02', 't1', 60));
    await transact(db, clock, (w) => setWeekPick(w, '2026-11-02', 't1', 30));
    await transact(db, clock, (w) => removeWeekPick(w, '2026-11-02', 't1'));
    expect(await listRecords(db, 'week_pick')).toEqual([]);
    await transact(db, clock, (w) => setWeekPick(w, '2026-11-02', 't1', 45));
    const picks = await listRecords(db, 'week_pick');
    expect(picks).toHaveLength(1);
    expect(picks[0]).toMatchObject({ id: weekPickId('2026-11-02', 't1'), minutes: 45, deleted_at: null });
    expect(occurrenceId('time_block', 't1', '2026-11-02')).toBe(occurrenceId('time_block', 't1', '2026-11-02'));
    expect(occurrenceId('time_block', 't1', '2026-11-02')).not.toBe(occurrenceId('task_completion', 't1', '2026-11-02'));
  });

  it('exposes outcomes by block id through the view', async () => {
    const db = await openTestDb();
    await transact(db, clock, (w) => w.create('block_outcome', { result: 'done', answered_at: '2026-11-02T15:00:00Z' }, outcomeId('b1')));
    expect(await db.get('SELECT block_id, result FROM block_outcome')).toEqual({ block_id: 'b1', result: 'done' });
  });

  it('fills settings defaults and merges writes into one record', async () => {
    const db = await openTestDb();
    const fresh = await getSettings(db);
    expect(fresh.availability).toEqual([{ days: 'all', from: 1320, to: 420, projects: true, one_offs: true }]);
    expect(fresh.plan_cadence?.unit).toBe('quarters');
    await transact(db, clock, (w) => updateSettings(w, { one_offs_weekly_aim: 180 }));
    await transact(db, clock, (w) => updateSettings(w, { plan_cadence: null }));
    const saved = await getSettings(db);
    expect(saved).toMatchObject({ one_offs_weekly_aim: 180, plan_cadence: null, reminders: { check_in_delay_min: 5 } });
    expect(await listRecords(db, 'settings')).toHaveLength(1);
  });

  it('announces local changes after commit, with the types touched', async () => {
    const db = await openTestDb();
    const events: DbChange[] = [];
    db.subscribe(async (c) => {
      events.push(c);
    });
    await transact(db, clock, async (w) => {
      await w.create('task', { kind: 'inbox', title: 'x' });
      await w.create('objective', { title: 'y', state: 'active' });
      expect(events).toEqual([]);
    });
    expect(events).toEqual([{ types: ['task', 'objective'], source: 'local' }]);
  });
});

describe('applyRemote', () => {
  const c = (wall: number, device = 'remote') => formatClock({ wall, counter: 0, device });

  it('keeps the higher clock per field, so edits to different fields both survive', async () => {
    const db = await openTestDb();
    const local = fixedClock(1000);
    const id = await transact(db, local, (w) => w.create('task', { kind: 'one_off', title: 'Local' }));
    local.set(5000);
    await transact(db, local, (w) => w.set('task', id, { title: 'Local later' }));
    const applied = await applyRemote(db, [
      { type: 'task', id, fields: { title: { v: 'Remote older', c: c(3000) }, done_at: { v: '2026-11-02T10:00:00Z', c: c(3000) } } },
    ]);
    expect(applied).toBe(1);
    expect(await getRecord(db, 'task', id)).toMatchObject({ title: 'Local later', done_at: '2026-11-02T10:00:00Z' });
  });

  it('converges in any delivery order, and repeats change nothing', async () => {
    const changes: RecordChange[] = [
      { type: 'task', id: 't', fields: { title: { v: 'A', c: c(1000, 'a') }, link: { v: 'x', c: c(5000, 'a') } } },
      { type: 'task', id: 't', fields: { title: { v: 'B', c: c(2000, 'b') }, link: { v: 'y', c: c(5000, 'b') } } },
      { type: 'task', id: 't', fields: { deleted_at: { v: '2026-01-01T00:00:00Z', c: c(1500, 'c') }, title: { v: 'C', c: c(1500, 'c') } } },
    ];
    const orders = [[0, 1, 2], [2, 1, 0], [1, 2, 0], [1, 0, 2], [0, 0, 2, 1, 1]];
    const results = [];
    for (const order of orders) {
      const db = await openTestDb();
      for (const i of order) await applyRemote(db, [changes[i]!]);
      const row = await db.get<{ data: string; clocks: string }>('SELECT data, clocks FROM records');
      const sorted = (json: string) => JSON.stringify(Object.entries(JSON.parse(json)).sort());
      results.push([sorted(row!.data), sorted(row!.clocks)].join());
    }
    expect(new Set(results).size).toBe(1);
    expect(results[0]).toContain('"B"');
    expect(results[0]).toContain('"y"');
  });

  it('removes a pending outbox row only for the field that lost, and writes after sort above', async () => {
    const db = await openTestDb();
    const local = fixedClock(1000);
    const id = await transact(db, local, (w) => w.create('task', { kind: 'one_off', title: 'Local' }));
    await applyRemote(db, [{ type: 'task', id, fields: { title: { v: 'Newer', c: c(9000) } } }]);
    const rows = await db.all<{ field: string }>('SELECT field FROM outbox');
    expect(rows.map((r) => r.field)).toEqual(['kind']);
    await transact(db, local, (w) => w.set('task', id, { title: 'Mine' }));
    const clocks = JSON.parse((await db.get<{ clocks: string }>('SELECT clocks FROM records'))!.clocks);
    expect(clocks.title > c(9000)).toBe(true);
  });

  it('ignores malformed clocks, and keeps unknown types for a newer app', async () => {
    const db = await openTestDb();
    const n = await applyRemote(db, [
      { type: 'task', id: 't', fields: { title: { v: 'x', c: 'garbage' } } },
      { type: 'future_type', id: 'f', fields: { a: { v: 1, c: c(1) } } },
    ]);
    expect(n).toBe(1);
    expect(await db.all('SELECT id, type FROM records')).toEqual([{ id: 'f', type: 'future_type' }]);
    await transact(db, clock, (w) => w.create('task', { kind: 'inbox', title: 'still works' }));
  });

  it('keeps a pending outbox row when the remote field loses, or is its own echo', async () => {
    const db = await openTestDb();
    const local = fixedClock(5000);
    const id = await transact(db, local, (w) => w.create('task', { kind: 'one_off', title: 'Local' }));
    const row = (await db.get<{ clock: string }>("SELECT clock FROM outbox WHERE field = 'title'"))!;
    expect(await applyRemote(db, [{ type: 'task', id, fields: { title: { v: 'Older', c: c(3000) } } }])).toBe(0);
    expect(await applyRemote(db, [{ type: 'task', id, fields: { title: { v: 'Local', c: row.clock } } }])).toBe(0);
    expect(await db.get("SELECT clock FROM outbox WHERE field = 'title'")).toEqual(row);
    expect(await getRecord(db, 'task', id)).toMatchObject({ title: 'Local' });
  });

  it('merges a delete as a field: a later edit elsewhere survives, and a later undelete wins', async () => {
    const db = await openTestDb();
    const deleted = '2026-01-01T00:00:00Z';
    await applyRemote(db, [{ type: 'task', id: 't', fields: { title: { v: 'x', c: c(1000) }, deleted_at: { v: deleted, c: c(2000) } } }]);
    expect(await listRecords(db, 'task')).toEqual([]);
    await applyRemote(db, [{ type: 'task', id: 't', fields: { title: { v: 'y', c: c(3000) } } }]);
    expect((await listRecords(db, 'task', { includeDeleted: true }))[0]).toMatchObject({ title: 'y', deleted_at: deleted });
    await applyRemote(db, [{ type: 'task', id: 't', fields: { deleted_at: { v: null, c: c(4000) } } }]);
    expect(await listRecords(db, 'task')).toHaveLength(1);
  });

  it('skips a malformed change instead of failing the whole batch, which would block sync for good', async () => {
    const db = await openTestDb();
    const bad = [
      { type: 'task', id: 'has space', fields: { title: { v: 'x', c: c(1) } } },
      { type: 'task', id: 'no-fields' },
      { id: 'no-type', fields: { title: { v: 'x', c: c(1) } } },
      { type: 'task', id: 'null-field', fields: { title: null, link: { v: 'kept', c: c(1) } } },
    ] as unknown as RecordChange[];
    expect(await applyRemote(db, bad)).toBe(1);
    expect(await db.all('SELECT id FROM records')).toEqual([{ id: 'null-field' }]);
  });

  it('announces remote changes as remote, and nothing when nothing changed', async () => {
    const db = await openTestDb();
    const events: DbChange[] = [];
    db.subscribe((e) => events.push(e));
    const change = { type: 'task', id: 't', fields: { title: { v: 'x', c: c(1) } } };
    await applyRemote(db, [change]);
    await applyRemote(db, [change]);
    expect(events).toEqual([{ types: ['task'], source: 'remote' }]);
  });
});

describe('boundaries', () => {
  it('core imports nothing from the UI or platform layers, outside tests', () => {
    for (const file of readdirSync(__dirname)) {
      if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
      const source = readFileSync(join(__dirname, file), 'utf8');
      expect(source, file).not.toMatch(/from '\.\.\//);
      expect(source, file).not.toMatch(/from 'react/);
    }
  });
});

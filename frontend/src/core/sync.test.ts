import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { fixedClock, formatClock } from './clock';
import { getMeta, META, setMeta } from './db';
import type { Db } from './db';
import { applyRemote, getRecord, transact } from './records';
import { createHttpSend, runSync, SyncError, syncStatus } from './sync';
import { fakeSyncServer } from './sync-testing';
import type { FieldChange, RecordChange } from './types';
import { openTestDb } from '../platform/node-sqlite';

const NOW = Date.parse('2026-11-02T15:00:00Z');
const clock = fixedClock(NOW);

const outbox = (db: Db) => db.all<{ record_id: string; field: string; clock: string }>('SELECT record_id, field, clock FROM outbox ORDER BY record_id, field');
const cursorOf = (db: Db) => getMeta(db, META.cursor);
const server = (options: { pageSize?: number } = {}) => fakeSyncServer({ now: () => clock.now(), ...options });

describe('runSync pushing', () => {
  it('sends each changed field with its value and clock, then clears the outbox and stores the cursor', async () => {
    const db = await openTestDb();
    const s = server();
    const id = await transact(db, clock, (w) => w.create('task', { kind: 'inbox', title: 'Write the report' }));
    const [row] = await outbox(db);

    await runSync(db, s.send);

    expect(s.requests).toHaveLength(1);
    expect(s.requests[0]).toEqual({
      cursor: 0,
      changes: [{ type: 'task', id, fields: { kind: { v: 'inbox', c: row!.clock }, title: { v: 'Write the report', c: row!.clock } } }],
      expiry_reset: true,
    });
    expect(await outbox(db)).toEqual([]);
    expect(await cursorOf(db)).toBe('1');
  });

  it('sends only the latest value of a field edited twice', async () => {
    const db = await openTestDb();
    const s = server();
    const id = await transact(db, clock, (w) => w.create('task', { kind: 'inbox', title: 'First' }));
    await transact(db, clock, (w) => w.set('task', id, { title: 'Second' }));

    await runSync(db, s.send);

    expect(s.requests).toHaveLength(1);
    expect(s.requests[0]!.changes[0]!.fields.title!.v).toBe('Second');
  });

  it('sends a field set to null as null', async () => {
    const db = await openTestDb();
    const s = server();
    const id = await transact(db, clock, (w) => w.create('task', { kind: 'one_off', title: 'Paint the fence', done_at: '2026-11-01T00:00:00Z' }));
    await runSync(db, s.send);
    await transact(db, clock, (w) => w.set('task', id, { done_at: null }));
    await runSync(db, s.send);
    expect(s.requests[1]!.changes[0]!.fields).toEqual({ done_at: { v: null, c: expect.any(String) } });
  });

  it('keeps an outbox row edited during the sync, because its clock no longer matches', async () => {
    const db = await openTestDb();
    const s = server();
    const id = await transact(db, clock, (w) => w.create('task', { kind: 'inbox', title: 'Before' }));
    s.beforeHandle = async () => {
      s.beforeHandle = undefined;
      await transact(db, clock, (w) => w.set('task', id, { title: 'During' }));
    };

    await runSync(db, s.send);

    expect((await outbox(db)).map((r) => r.field)).toEqual(['title']);
    expect((await getRecord(db, 'task', id))!.title).toBe('During');
    expect(s.record(id)!.title!.v).toBe('Before');

    await runSync(db, s.send);
    expect(await outbox(db)).toEqual([]);
    expect(s.record(id)!.title!.v).toBe('During');
  });

  it('sends up to 99 records per request, however many fields they have', async () => {
    const db = await openTestDb();
    const s = server();
    await transact(db, clock, async (w) => {
      for (let i = 0; i < 250; i++) await w.create('task', { kind: 'inbox', title: `Task ${i}`, order: i });
    });

    await runSync(db, s.send);

    expect(s.requests.map((r) => r.changes.length)).toEqual([99, 99, 52]);
    expect(await outbox(db)).toEqual([]);
    expect(Object.keys(s.values())).toHaveLength(250);
    // Each request carries what the one before it returned.
    expect(s.requests.map((r) => r.cursor)).toEqual([0, 99, 198]);
  });

  it('stops after an exact multiple of 99 with one empty request at most', async () => {
    const db = await openTestDb();
    const s = server();
    await transact(db, clock, async (w) => {
      for (let i = 0; i < 99; i++) await w.create('task', { kind: 'inbox', title: `Task ${i}` });
    });
    await runSync(db, s.send);
    expect(s.requests.map((r) => r.changes.length)).toEqual([99, 0]);
  });

  it('sends every field of a record in one change even when other records fill the batch', async () => {
    const db = await openTestDb();
    const s = server();
    await transact(db, clock, async (w) => {
      for (let i = 0; i < 100; i++) await w.create('task', { kind: 'inbox', title: `Task ${i}`, estimate_min: 30, remaining_min: 20 }, `r${String(i).padStart(3, '0')}`);
    });
    await runSync(db, s.send);
    for (const change of s.requests[0]!.changes) expect(Object.keys(change.fields).sort()).toEqual(['estimate_min', 'kind', 'remaining_min', 'title']);
  });
});

describe('runSync pulling', () => {
  it('a new device at cursor 0 pulls everything, following more across pages', async () => {
    const a = await openTestDb();
    const b = await openTestDb();
    const s = server({ pageSize: 2 });
    await transact(a, clock, async (w) => {
      for (let i = 0; i < 5; i++) await w.create('task', { kind: 'inbox', title: `Task ${i}` }, `t${i}`);
    });
    await runSync(a, s.send);
    s.requests.length = 0;

    await runSync(b, s.send);

    expect(s.requests.map((r) => r.cursor)).toEqual([0, 2, 4]);
    expect(await cursorOf(b)).toBe('5');
    for (let i = 0; i < 5; i++) expect((await getRecord(b, 'task', `t${i}`))!.title).toBe(`Task ${i}`);
    expect(await outbox(b)).toEqual([]);
  });

  it('pages and pushes together until both are done', async () => {
    const a = await openTestDb();
    const s = server({ pageSize: 10 });
    await transact(a, clock, async (w) => {
      for (let i = 0; i < 120; i++) await w.create('task', { kind: 'inbox', title: `Task ${i}` });
    });
    await runSync(a, s.send);
    expect(await outbox(a)).toEqual([]);
    expect(await cursorOf(a)).toBe('120');
  });

  it('merges a tombstone like any other field, and keeps unknown fields', async () => {
    const a = await openTestDb();
    const b = await openTestDb();
    const s = server();
    const id = await transact(a, clock, (w) => w.create('task', { kind: 'inbox', title: 'Paint the fence' }));
    await runSync(a, s.send);
    await runSync(b, s.send);

    await applyRemote(b, [{ type: 'task', id, fields: { from_a_newer_app: { v: 7, c: formatClock({ wall: NOW, counter: 0, device: 'zz' }) } } }]);
    await transact(a, clock, (w) => w.delete('task', id));
    await runSync(a, s.send);
    await runSync(b, s.send);

    expect(await getRecord(b, 'task', id)).toMatchObject({ deleted_at: expect.any(String), from_a_newer_app: 7, title: 'Paint the fence' });
  });

  it('refuses a response that claims more without moving the cursor, rather than looping', async () => {
    const db = await openTestDb();
    const send = vi.fn(async () => ({ cursor: 0, more: true, changes: [] }));
    await expect(runSync(db, send)).rejects.toThrow();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a missing cursor', { more: false, changes: [] }],
    ['a fractional cursor', { cursor: 1.5, more: false, changes: [] }],
    ['a negative cursor', { cursor: -1, more: false, changes: [] }],
    ['a non-boolean more', { cursor: 1, more: 'no', changes: [] }],
    ['changes that are not a list', { cursor: 1, more: false, changes: {} }],
    ['a null change', { cursor: 1, more: false, changes: [null] }],
    ['a generation that is not text', { cursor: 0, more: false, changes: [], generation: 7 }],
    ['nothing at all', null],
  ])('treats %s as a failed sync, keeping the outbox and cursor', async (_name, response) => {
    const db = await openTestDb();
    await transact(db, clock, (w) => w.create('task', { kind: 'inbox', title: 'Keep me' }));
    await setMeta(db, META.cursor, '0');
    await expect(runSync(db, async () => response as never)).rejects.toThrow();
    expect(await outbox(db)).toHaveLength(2);
    expect(await cursorOf(db)).toBe('0');
  });
});

describe('runSync failures', () => {
  it('keeps the outbox and cursor when the clock is refused, and sends again once it is fixed', async () => {
    const db = await openTestDb();
    const s = server();
    const ahead = fixedClock(NOW + 25 * 3_600_000);
    const id = await transact(db, ahead, (w) => w.create('task', { kind: 'inbox', title: 'From the future' }));

    await expect(runSync(db, s.send)).rejects.toMatchObject({ code: 'clock_ahead' });

    expect(await outbox(db)).toHaveLength(2);
    expect(await cursorOf(db)).toBeNull();
    expect(s.record(id)).toBeUndefined();

    clock.set(NOW + 2 * 3_600_000);
    await runSync(db, s.send);
    clock.set(NOW);
    expect(await outbox(db)).toEqual([]);
    expect(s.record(id)!.title!.v).toBe('From the future');
  });

  // Like the server: a request carrying a record over 100 KB, or over 6 MB in all, is refused whole.
  const sizeLimits = (s: ReturnType<typeof server>) => (req: Parameters<typeof s.send>[0]) =>
    req.changes.some((c) => new TextEncoder().encode(JSON.stringify(c.fields)).length > 100 * 1024) ||
    new TextEncoder().encode(JSON.stringify(req)).length > 6 * 1024 * 1024
      ? Promise.reject(new SyncError('error'))
      : s.send(req);

  it('sets aside a record too large for the server: the rest push, the pull carries on, and the error says so', async () => {
    const db = await openTestDb();
    const s = server();
    const theirs = formatClock({ wall: NOW, counter: 0, device: 'other' });
    await s.send({ cursor: 0, changes: [{ type: 'task', id: 'theirs', fields: { kind: { v: 'inbox', c: theirs }, title: { v: 'Paint the fence', c: theirs } } }] });
    const big = await transact(db, clock, (w) => w.create('task', { kind: 'inbox', title: 'x'.repeat(101 * 1024) }, 'a-big'));
    const small = await transact(db, clock, (w) => w.create('task', { kind: 'inbox', title: 'Write the report' }, 'b-small'));

    await expect(runSync(db, sizeLimits(s))).rejects.toMatchObject({ code: 'too_large' });
    expect(s.record(small)!.title!.v).toBe('Write the report');
    expect(s.record(big)).toBeUndefined();
    expect((await getRecord(db, 'task', 'theirs'))?.title).toBe('Paint the fence');
    expect((await outbox(db)).map((r) => r.record_id)).toEqual([big, big]);

    await transact(db, clock, (w) => w.set('task', big, { title: 'Shorter now' }));
    await runSync(db, sizeLimits(s));
    expect(s.record(big)!.title!.v).toBe('Shorter now');
  });

  it('sends the delete of a record just under the limit, since the server leaves room for deleted_at', async () => {
    const db = await openTestDb();
    const s = server();
    const id = await transact(db, clock, (w) => w.create('task', { kind: 'inbox', title: '' }));
    const [row] = await outbox(db);
    const empty = new TextEncoder().encode(JSON.stringify({ kind: { v: 'inbox', c: row!.clock }, title: { v: '', c: row!.clock } })).length;
    await transact(db, clock, (w) => w.set('task', id, { title: 'x'.repeat(100 * 1024 - empty - 10) }));
    await runSync(db, sizeLimits(s));
    expect(await outbox(db)).toEqual([]);

    await transact(db, clock, (w) => w.delete('task', id));
    await runSync(db, sizeLimits(s));
    expect(await outbox(db)).toEqual([]);
    expect(s.record(id)!.deleted_at!.v).toBe('2026-11-02T15:00:00Z');
  });

  it('still sends the delete of a record grown too large, so other devices drop it, and the edit it held stops counting', async () => {
    const [a, b] = [await openTestDb(), await openTestDb()];
    const s = server();
    const id = await transact(a, clock, (w) => w.create('task', { kind: 'inbox', title: 'Write the report' }));
    await runSync(a, sizeLimits(s));
    await runSync(b, sizeLimits(s));
    await transact(a, fixedClock(NOW + 60_000), (w) => w.set('task', id, { title: 'x'.repeat(120 * 1024) }));
    await expect(runSync(a, sizeLimits(s))).rejects.toMatchObject({ code: 'too_large' });

    await transact(a, fixedClock(NOW + 120_000), (w) => w.delete('task', id));
    await runSync(a, sizeLimits(s));
    await runSync(b, sizeLimits(s));
    expect((await getRecord(b, 'task', id))?.deleted_at).toBe('2026-11-02T15:02:00Z');
    expect(s.record(id)!.title!.v).toBe('Write the report');
    // The long title waits in case the task comes back, and then it is held again.
    expect((await outbox(a)).map((r) => r.field)).toEqual(['title']);
    await transact(a, fixedClock(NOW + 180_000), (w) => w.set('task', id, { deleted_at: null }));
    await expect(runSync(a, sizeLimits(s))).rejects.toMatchObject({ code: 'too_large' });
  });

  it('still sets aside a new record over the limit, since the server refuses any change over it', async () => {
    const db = await openTestDb();
    const s = server();
    const big = await transact(db, clock, (w) => w.create('task', { kind: 'inbox', title: 'x'.repeat(100 * 1024 + 200) }));
    await expect(runSync(db, sizeLimits(s))).rejects.toMatchObject({ code: 'too_large' });
    expect(s.record(big)).toBeUndefined();
  });

  it('splits a batch by size as well as count, so each request stays under the limit', async () => {
    const db = await openTestDb();
    const s = server();
    await transact(db, clock, async (w) => {
      for (let i = 0; i < 99; i++) await w.create('task', { kind: 'inbox', title: 'x'.repeat(80 * 1024) });
    });
    await runSync(db, sizeLimits(s));
    expect(await outbox(db)).toEqual([]);
    expect(Object.keys(s.values())).toHaveLength(99);
  });

  it('accepts a clock just under 24 hours ahead', async () => {
    const db = await openTestDb();
    const s = server();
    await transact(db, fixedClock(NOW + 23 * 3_600_000), (w) => w.create('task', { kind: 'inbox', title: 'Soon' }));
    await runSync(db, s.send);
    expect(await outbox(db)).toEqual([]);
  });

  it('resends after a response is lost, and the server changes nothing the second time', async () => {
    const db = await openTestDb();
    const s = server();
    const id = await transact(db, clock, (w) => w.create('task', { kind: 'inbox', title: 'Once' }));
    let lose = true;
    const lossy: typeof s.send = async (req) => {
      const res = await s.send(req);
      if (lose) {
        lose = false;
        throw new SyncError('offline');
      }
      return res;
    };

    await expect(runSync(db, lossy)).rejects.toMatchObject({ code: 'offline' });
    expect(await outbox(db)).toHaveLength(2);
    expect(s.counter).toBe(1);

    await runSync(db, lossy);
    expect(await outbox(db)).toEqual([]);
    expect(s.counter).toBe(1);
    expect(s.record(id)!.title!.v).toBe('Once');
  });

  it('a cursor above the counter resets to 0 and re-sends every local record', async () => {
    const a = await openTestDb();
    const s = server();
    await transact(a, clock, (w) => w.create('task', { kind: 'inbox', title: 'Survives the backup' }, 't1'));
    await runSync(a, s.send);
    const restoredAt = s.counter;
    await transact(a, clock, (w) => w.create('task', { kind: 'inbox', title: 'Lost in the backup' }, 't2'));
    await transact(a, clock, (w) => w.create('task', { kind: 'inbox', title: 'Lost too' }, 't3'));
    await runSync(a, s.send);
    s.restoreTo(restoredAt);
    expect(s.record('t2')).toBeUndefined();
    s.requests.length = 0;

    await runSync(a, s.send);

    expect(s.requests.at(-1)!.cursor).toBeLessThan(3);
    expect(s.values()).toMatchObject({ t1: { title: 'Survives the backup' }, t2: { title: 'Lost in the backup' }, t3: { title: 'Lost too' } });
    expect(await outbox(a)).toEqual([]);
    expect(Number(await cursorOf(a))).toBe(s.counter);

    // A device that only ever saw the restored table gets the re-sent records too.
    const b = await openTestDb();
    await runSync(b, s.send);
    expect((await getRecord(b, 'task', 't2'))!.title).toBe('Lost in the backup');
  });

  it('a new generation resets even after another device moved the counter past this cursor', async () => {
    const phone = await openTestDb();
    const desktop = await openTestDb();
    const s = server();
    await transact(desktop, clock, (w) => w.create('task', { kind: 'inbox', title: 'Survives the backup' }, 't1'));
    await runSync(desktop, s.send);
    await runSync(phone, s.send);
    const backedUpAt = s.counter;
    await transact(phone, clock, (w) => w.create('task', { kind: 'inbox', title: 'Lost in the backup' }, 't2'));
    await runSync(phone, s.send);
    s.restoreTo(backedUpAt, 'after-restore');

    // The desktop syncs first, so the counter passes the phone's cursor before the phone is back.
    await transact(desktop, clock, (w) => w.create('task', { kind: 'inbox', title: 'Paint the fence' }, 't3'));
    await transact(desktop, clock, (w) => w.create('task', { kind: 'inbox', title: 'Learn to bake bread' }, 't4'));
    await runSync(desktop, s.send);
    expect(s.counter).toBeGreaterThan(Number(await cursorOf(phone)));

    await runSync(phone, s.send);

    expect(s.values()).toMatchObject({ t2: { title: 'Lost in the backup' } });
    expect(await getRecord(phone, 'task', 't3')).toMatchObject({ title: 'Paint the fence' });
    expect(await getRecord(phone, 'task', 't4')).toMatchObject({ title: 'Learn to bake bread' });
    expect(await outbox(phone)).toEqual([]);
    expect(Number(await cursorOf(phone))).toBe(s.counter);

    // Once caught up, the same generation doesn't start over again.
    s.requests.length = 0;
    await runSync(phone, s.send);
    expect(s.requests).toEqual([{ cursor: s.counter, changes: [], expiry_reset: true }]);
  });

  it('the reset keeps pending edits and sends more than one batch', async () => {
    const a = await openTestDb();
    const s = server();
    await transact(a, clock, async (w) => {
      for (let i = 0; i < 120; i++) await w.create('task', { kind: 'inbox', title: `Task ${i}` }, `t${i}`);
    });
    await runSync(a, s.send);
    await transact(a, clock, (w) => w.set('task', 't0', { title: 'Edited offline' }));
    s.restoreTo(0);

    await runSync(a, s.send);

    expect(Object.keys(s.values())).toHaveLength(120);
    expect(s.record('t0')!.title!.v).toBe('Edited offline');
    expect(await outbox(a)).toEqual([]);
  });
});

/** Puts two replicas through the same edits under every order of syncs. */
async function convergeUnder(schedule: readonly ('a' | 'b')[]) {
  const a = await openTestDb();
  const b = await openTestDb();
  const s = server();
  const ca = fixedClock(NOW);
  const cb = fixedClock(NOW + 10);
  const shared = 'shared-task';
  await transact(a, ca, (w) => w.create('task', { kind: 'inbox', title: 'Start' }, shared));
  await runSync(a, s.send);
  await runSync(b, s.send);

  ca.set(NOW + 1000);
  cb.set(NOW + 2000);
  await transact(a, ca, (w) => w.set('task', shared, { title: 'A wrote this', remaining_min: 20 }));
  await transact(b, cb, (w) => w.set('task', shared, { title: 'B wrote this later', estimate_min: 30 }));
  await transact(a, ca, (w) => w.create('task', { kind: 'one_off', title: 'Only on A' }, 'only-a'));
  await transact(b, cb, (w) => w.create('task', { kind: 'one_off', title: 'Only on B' }, 'only-b'));
  await transact(a, ca, (w) => w.delete('task', 'only-a'));

  const dbs = { a, b };
  for (const who of schedule) await runSync(dbs[who], s.send);
  // Whatever the order, one more round for each settles anything still unseen.
  await runSync(a, s.send);
  await runSync(b, s.send);
  await runSync(a, s.send);

  const snapshot = async (db: Db) => {
    const rows = await db.all<{ id: string; data: string; clocks: string }>('SELECT id, data, clocks FROM records ORDER BY id');
    return rows.map((r) => ({ id: r.id, data: JSON.parse(r.data) as object, clocks: JSON.parse(r.clocks) as object }));
  };
  return { a: await snapshot(a), b: await snapshot(b), server: s.values(), outboxes: [await outbox(a), await outbox(b)] };
}

describe('two replicas', () => {
  const schedules: ('a' | 'b')[][] = [
    ['a', 'b'],
    ['b', 'a'],
    ['a', 'a', 'b'],
    ['b', 'b', 'a'],
    ['a', 'b', 'a', 'b'],
    ['b', 'a', 'b', 'a'],
  ];

  it('converge under every order of syncs, keeping edits to different fields', async () => {
    const results = [];
    for (const schedule of schedules) {
      const r = await convergeUnder(schedule);
      expect(r.a).toEqual(r.b);
      expect(r.outboxes).toEqual([[], []]);
      // Device ids are random per run, so only values compare across runs.
      results.push(r.a.map(({ id, data }) => ({ id, data })));
    }
    for (const r of results) expect(r).toEqual(results[0]);
    expect(results[0]!.find((r) => r.id === 'shared-task')!.data).toMatchObject({ title: 'B wrote this later', remaining_min: 20, estimate_min: 30 });
    expect(results[0]!.find((r) => r.id === 'only-a')!.data).toMatchObject({ deleted_at: expect.any(String) });
    expect(results[0]!.find((r) => r.id === 'only-b')).toBeDefined();
  });

  it('converge when server pages arrive in any order, with repeats', async () => {
    const c = (wall: number, device: string) => formatClock({ wall, counter: 0, device });
    const pages: RecordChange[] = [
      { type: 'task', id: 't', fields: { title: { v: 'A', c: c(1000, 'a') }, estimate_min: { v: 30, c: c(5000, 'a') } } },
      { type: 'task', id: 't', fields: { title: { v: 'B', c: c(2000, 'b') }, estimate_min: { v: 45, c: c(5000, 'b') } } },
      { type: 'task', id: 't', fields: { deleted_at: { v: '2026-11-01T00:00:00Z', c: c(1500, 'c') } } },
    ];
    const orders = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0], [1, 1, 0, 2, 0]];
    const seen = new Set<string>();
    for (const order of orders) {
      const db = await openTestDb();
      for (const i of order) await applyRemote(db, [pages[i]!]);
      const record = await getRecord(db, 'task', 't');
      seen.add(JSON.stringify([record!.title, record!.estimate_min, record!.deleted_at]));
    }
    expect([...seen]).toEqual([JSON.stringify(['B', 45, '2026-11-01T00:00:00Z'])]);
  });
});

// The same cases the server's merge runs, so the two can't drift.
const MERGE_DIR = join(import.meta.dirname, '../../../backend/testdata/merge');

interface MergeCase {
  name: string;
  current: Record<string, FieldChange>;
  incoming: Record<string, FieldChange>[];
  applied: number[];
  expected: Record<string, FieldChange>;
}

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]));
}

describe('shared merge cases', () => {
  const cases = readdirSync(MERGE_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => JSON.parse(readFileSync(join(MERGE_DIR, file), 'utf8')) as MergeCase);

  const merged = async (current: MergeCase['current'], incoming: MergeCase['incoming'], onStep?: (changed: number, i: number) => void) => {
    const db = await openTestDb();
    if (Object.keys(current).length > 0) await applyRemote(db, [{ type: 'task', id: 't', fields: current }]);
    for (const [i, fields] of incoming.entries()) {
      const changed = await applyRemote(db, [{ type: 'task', id: 't', fields }]);
      onStep?.(changed, i);
    }
    const row = await db.get<{ data: string; clocks: string }>('SELECT data, clocks FROM records WHERE id = :id', { id: 't' });
    const data = JSON.parse(row?.data ?? '{}') as Record<string, unknown>;
    const clocks = JSON.parse(row?.clocks ?? '{}') as Record<string, string>;
    return Object.fromEntries(Object.keys(clocks).map((field) => [field, { v: data[field], c: clocks[field] }]));
  };

  it('exist', () => expect(cases.length).toBeGreaterThan(0));

  it.each(cases.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
    const applied: number[] = [];
    expect(await merged(c.current, c.incoming, (changed) => applied.push(changed))).toEqual(c.expected);
    expect(applied).toEqual(c.applied);
    for (const order of permutations(c.incoming)) expect(await merged(c.current, order)).toEqual(c.expected);
  });
});

describe('createHttpSend', () => {
  const body = { cursor: 0, more: false, changes: [] };
  const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status });
  const auth = () => ({
    accessToken: vi.fn(async (_options?: { refresh?: boolean }) => 'token-1'),
    expire: vi.fn(async () => undefined),
  });

  it('posts the request as JSON with a bearer token', async () => {
    const a = auth();
    const fetchFn = vi.fn(async (_url: string, _init: RequestInit) => json(200, body));
    const send = createHttpSend({ apiUrl: 'https://api.example.test', auth: a, fetch: fetchFn });
    expect(await send({ cursor: 3, changes: [] })).toEqual(body);
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe('https://api.example.test/sync');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ authorization: 'Bearer token-1', 'content-type': 'application/json' });
    expect(JSON.parse(init.body as string)).toEqual({ cursor: 3, changes: [] });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('on a 401 refreshes once and retries', async () => {
    const a = auth();
    a.accessToken.mockImplementation(async (options) => (options?.refresh ? 'token-2' : 'token-1'));
    const fetchFn = vi.fn(async (_url: string, init: RequestInit) =>
      (init.headers as Record<string, string>).authorization === 'Bearer token-2' ? json(200, body) : json(401, {}),
    );
    const send = createHttpSend({ apiUrl: 'https://api.example.test', auth: a, fetch: fetchFn });
    expect(await send({ cursor: 0, changes: [] })).toEqual(body);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(a.expire).not.toHaveBeenCalled();
  });

  it('a second 401 means the sign-in has expired', async () => {
    const a = auth();
    const fetchFn = vi.fn(async () => json(401, {}));
    const send = createHttpSend({ apiUrl: 'https://api.example.test', auth: a, fetch: fetchFn });
    await expect(send({ cursor: 0, changes: [] })).rejects.toMatchObject({ code: 'sign_in_expired' });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(a.expire).toHaveBeenCalledTimes(1);
  });

  it('reports a network failure as offline', async () => {
    const send = createHttpSend({
      apiUrl: 'https://api.example.test',
      auth: auth(),
      fetch: async () => {
        throw new TypeError('fetch failed');
      },
    });
    await expect(send({ cursor: 0, changes: [] })).rejects.toMatchObject({ code: 'offline' });
  });

  it('reports the clock refusal by its code, and any other failure as a server error', async () => {
    const respond = (response: Response) =>
      createHttpSend({ apiUrl: 'https://api.example.test', auth: auth(), fetch: async () => response })({ cursor: 0, changes: [] });
    await expect(respond(json(400, { error: 'clock_ahead' }))).rejects.toMatchObject({ code: 'clock_ahead' });
    await expect(respond(json(500, { error: 'anything' }))).rejects.toMatchObject({ code: 'error' });
    // A conflict keeps the outbox for the next sync to resend.
    await expect(respond(json(409, { error: 'conflict' }))).rejects.toMatchObject({ code: 'error' });
    await expect(respond(new Response('<html>', { status: 503 }))).rejects.toMatchObject({ code: 'error' });
  });
});

describe('syncStatus', () => {
  it('reads the last sync time and error', async () => {
    const db = await openTestDb();
    expect(await syncStatus(db)).toEqual({ lastSyncAt: null, lastError: null });
    await setMeta(db, META.lastSyncAt, '2026-11-02T15:00:00Z');
    await setMeta(db, META.lastSyncError, 'clock_ahead');
    expect(await syncStatus(db)).toEqual({ lastSyncAt: '2026-11-02T15:00:00Z', lastError: 'clock_ahead' });
  });
});

describe('runSync after records expire', () => {
  const time = fixedClock(NOW);
  const expiring = (s: ReturnType<typeof fakeSyncServer>) => s;
  const at = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z');
  const theirs = (fields: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(fields).map(([f, v]) => [f, { v, c: formatClock({ wall: time.now(), counter: 0, device: 'other' }) }]));
  const ids = async (db: Db) => (await db.all<{ id: string }>('SELECT id FROM records ORDER BY id')).map((r) => r.id);

  /** Two records this device synced, then an edit to each made offline and a record made offline. */
  async function deviceWithOldCopies() {
    time.set(NOW);
    const s = expiring(fakeSyncServer({ now: () => time.now() }));
    const db = await openTestDb();
    await transact(db, time, async (w) => {
      await w.create('task', { kind: 'inbox', title: 'Oil the hinges' }, 'gone');
      await w.create('task', { kind: 'inbox', title: 'Paint the fence' }, 'kept');
    });
    await runSync(db, s.send);
    await transact(db, time, async (w) => {
      await w.set('task', 'gone', { title: 'Oil the gate hinges' });
      await w.set('task', 'kept', { title: 'Paint the whole fence' });
      await w.create('task', { kind: 'inbox', title: 'Buy brushes' }, 'made');
    });
    // Meanwhile another device deletes one, with an expiry an hour on.
    await s.send({ cursor: s.counter, changes: [{ type: 'task', id: 'gone', fields: theirs({ deleted_at: at(time.now()), expires_at: at(time.now() + 3_600_000) }) }] });
    s.requests.length = 0;
    return { s, db };
  }

  it('resets a device behind the mark: drops its old copy and that edit, keeps the rest, then sends', async () => {
    const { s, db } = await deviceWithOldCopies();
    time.set(NOW + 2 * 3_600_000);
    s.remove('gone');

    await runSync(db, s.send);

    expect(s.requests.map((r) => [r.cursor, r.changes.length, r.expiry_reset ?? false])).toEqual([
      [2, 3, true],
      [0, 0, false],
      // The pull from 0 ends at the counter, past the removed record.
      [3, 2, true],
    ]);
    expect(await ids(db)).toEqual(['kept', 'made']);
    expect(await outbox(db)).toEqual([]);
    expect(s.values()).toMatchObject({ kept: { title: 'Paint the whole fence' }, made: { title: 'Buy brushes' } });
    expect(s.values().gone).toBeUndefined();
  });

  it('resets a device whose pull left out an expired record it had only an old copy of', async () => {
    const { s, db } = await deviceWithOldCopies();
    // Expired, and not yet removed: the server leaves it out.
    time.set(NOW + 2 * 3_600_000);

    await runSync(db, s.send);

    expect(s.requests.map((r) => r.expiry_reset ?? false)).toEqual([true, false, true]);
    expect(await ids(db)).toEqual(['kept', 'made']);
    expect(s.values().gone).toMatchObject({ title: 'Oil the hinges', deleted_at: expect.any(String) });
  });

  it("carries on from where a first pull is when a reset comes, since nothing here is an old copy", async () => {
    time.set(NOW);
    const s = fakeSyncServer({ now: () => time.now(), pageSize: 2 });
    for (let i = 0; i < 5; i++) await s.send({ cursor: s.counter, changes: [{ type: 'task', id: `t${i}`, fields: theirs({ kind: 'inbox', title: `Task ${i}` }) }] });
    await s.send({ cursor: s.counter, changes: [{ type: 'task', id: 't3', fields: theirs({ expires_at: at(time.now() + 1000) }) }] });
    time.set(NOW + 3_600_000);
    s.requests.length = 0;
    const db = await openTestDb();

    await runSync(db, s.send);

    expect(s.requests.map((r) => [r.cursor, r.expiry_reset ?? false])).toEqual([
      [0, true],
      [2, true],
      // The page that left out the expired record was answered with a reset, and the pull carried on from there.
      [5, true],
      [5, false],
      [6, true],
    ]);
    expect(await ids(db)).toEqual(['t0', 't1', 't2', 't4']);
    expect(await cursorOf(db)).toBe('6');
  });

  it("keeps its cursor until a reset's pull has finished, so a failure starts it again", async () => {
    const { s, db } = await deviceWithOldCopies();
    time.set(NOW + 2 * 3_600_000);
    s.remove('gone');
    let calls = 0;
    const failing = async (request: Parameters<typeof s.send>[0]) => {
      if (++calls === 2) throw new SyncError('offline');
      return s.send(request);
    };
    await expect(runSync(db, failing)).rejects.toMatchObject({ code: 'offline' });
    expect(await cursorOf(db)).toBe('2');
    expect(await ids(db)).toEqual(['gone', 'kept', 'made']);
    await runSync(db, s.send);
    expect(await ids(db)).toEqual(['kept', 'made']);
  });

  it('treats a reset answering a pull sent without expiry_reset as a failure', async () => {
    const { s, db } = await deviceWithOldCopies();
    s.remove('gone');
    const send = vi.fn(async () => ({ cursor: 0, more: false, changes: [], reset: 'expired' }));
    await expect(runSync(db, send)).rejects.toMatchObject({ code: 'error' });
    expect(send).toHaveBeenCalledTimes(2);
    expect(await cursorOf(db)).toBe('2');
  });

  it("sends a record's expiry with any change to it, as it stands", async () => {
    time.set(NOW);
    const s = fakeSyncServer({ now: () => time.now() });
    const db = await openTestDb();
    const id = await transact(db, time, (w) => w.create('task', { kind: 'one_off', title: 'x' }));
    await applyRemote(db, [{ type: 'task', id, fields: theirs({ expires_at: '2031-01-01T00:00:00Z' }) }]);
    await runSync(db, s.send);
    expect(s.requests[0]!.changes[0]!.fields.expires_at).toEqual({ v: '2031-01-01T00:00:00Z', c: expect.stringContaining('-other') });
  });
});

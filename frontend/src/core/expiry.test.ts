import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parsePeriod } from '../../../config/retention';
import { fixedClock, formatClock } from './clock';
import { META, setMeta } from './db';
import type { Db } from './db';
import { backfillExpiry, expireLocal } from './expiry';
import { applyRemote, getRecord, outcomeId, transact } from './records';
import { configureRetention } from './retention';
import type { Retention } from './retention';
import { openTestDb } from '../platform/node-sqlite';

const NOW = '2026-11-02T15:00:00Z';
const policy: Retention = { scheduling: parsePeriod('P2Y'), closed: parsePeriod('P5Y'), deleted: parsePeriod('P30D') };
const clock = fixedClock(NOW);
const other = (iso: string) => formatClock({ wall: Date.parse(iso), counter: 0, device: 'other' });

let db: Db;
const data = async (id: string) => JSON.parse((await db.get<{ data: string }>('SELECT data FROM records WHERE id = :id', { id }))?.data ?? 'null') as Record<string, unknown> | null;
const outbox = (id: string) => db.all<{ field: string; clock: string }>('SELECT field, clock FROM outbox WHERE record_id = :id ORDER BY field', { id });

beforeEach(async () => {
  db = await openTestDb();
  clock.set(NOW);
  configureRetention(policy);
});
afterEach(() => configureRetention(null));

/** Records held from before retention: written with no policy, as an older app did. */
async function before<T>(fn: () => Promise<T>): Promise<T> {
  configureRetention(null);
  try {
    return await fn();
  } finally {
    configureRetention(policy);
  }
}

describe('backfillExpiry', () => {
  it('fills in what lacks an expiry with the lowest clock, and writes nothing for what never expires', async () => {
    const { done, open, block } = await before(async () => ({
      done: await transact(db, clock, (w) => w.create('task', { kind: 'one_off', title: 'Paint the fence', done_at: NOW })),
      open: await transact(db, clock, (w) => w.create('task', { kind: 'inbox', title: 'Buy brushes' })),
      block: await transact(db, clock, (w) => w.create('time_block', { task_id: 't', start: '2026-11-02T14:00:00Z', end: NOW, tz: 'UTC' })),
    }));
    await transact(db, clock, (w) => w.create('block_outcome', { result: 'done', answered_at: NOW }, outcomeId(block)));
    await db.run('DELETE FROM outbox');

    // The answer, written now, has its expiry already.
    expect(await backfillExpiry(db, clock)).toBe(2);
    expect((await data(done))!.expires_at).toBe('2031-11-02T15:00:00Z');
    expect((await data(block))!.expires_at).toBe('2028-11-02T15:00:00Z');
    expect(await outbox(done)).toEqual([{ field: 'expires_at', clock: expect.stringMatching(/^0000000000000-000000-/) }]);
    expect((await data(open))!.expires_at).toBeUndefined();
    expect(await outbox(open)).toEqual([]);

    // Once filled, the next launch writes nothing.
    await db.run('DELETE FROM outbox');
    expect(await backfillExpiry(db, clock)).toBe(0);
    expect(await db.all('SELECT * FROM outbox')).toEqual([]);
  });

  it('puts right what an app from before changed since', async () => {
    const id = await transact(db, clock, (w) => w.create('task', { kind: 'one_off', title: 'x', done_at: NOW }));
    // Another device on an older app reopens it, leaving its expiry as it was.
    await applyRemote(db, [{ type: 'task', id, fields: { done_at: { v: null, c: other('2026-11-03T00:00:00Z') } } }]);
    clock.set('2026-11-03T01:00:00Z');
    await backfillExpiry(db, clock);
    expect((await data(id))!.expires_at).toBeNull();
    // A real clock, since the expiry it replaces has one.
    expect((await outbox(id)).find((r) => r.field === 'expires_at')!.clock).not.toMatch(/^0000000000000-/);
  });

  it('does nothing without a policy', async () => {
    configureRetention(null);
    await transact(db, clock, (w) => w.create('task', { kind: 'one_off', title: 'x', done_at: NOW }));
    expect(await backfillExpiry(db, clock)).toBe(0);
  });
});

describe('expireLocal', () => {
  it('removes what has expired, with its outbox rows, and keeps the rest', async () => {
    const gone = await transact(db, clock, (w) => w.create('task', { kind: 'inbox', title: 'Oil the hinges' }));
    await transact(db, clock, (w) => w.delete('task', gone));
    const kept = await transact(db, clock, (w) => w.create('task', { kind: 'inbox', title: 'Buy brushes' }));
    expect(await expireLocal(db, clock)).toBe(0);

    clock.set('2026-12-02T15:00:01Z');
    let changes = 0;
    db.subscribe(() => changes++);
    expect(await expireLocal(db, clock)).toBe(1);
    expect(await getRecord(db, 'task', gone)).toBeUndefined();
    expect(await outbox(gone)).toEqual([]);
    expect(await getRecord(db, 'task', kept)).toBeDefined();
    expect(changes).toBe(1);
  });

  it("keeps an expiry it filled in for the server's copy until it has gone up, once this device has synced", async () => {
    await before(() => transact(db, clock, (w) => w.create('task', { kind: 'inbox', title: 'x', deleted_at: '2026-09-01T00:00:00Z' })));
    await db.run('DELETE FROM outbox');
    await setMeta(db, META.cursor, '12');
    await backfillExpiry(db, clock);
    expect(await expireLocal(db, clock)).toBe(0);
    // Sent: the sync cleared its row.
    await db.run('DELETE FROM outbox');
    expect(await expireLocal(db, clock)).toBe(1);
  });

  it("removes at once on a device that has never synced, which has no server copy to tell", async () => {
    await before(() => transact(db, clock, (w) => w.create('task', { kind: 'inbox', title: 'x', deleted_at: '2026-09-01T00:00:00Z' })));
    await backfillExpiry(db, clock);
    expect(await expireLocal(db, clock)).toBe(1);
  });

  it('ignores an expiry that is not an instant', async () => {
    await applyRemote(db, [{ type: 'task', id: 'odd', fields: { title: { v: 'x', c: other(NOW) }, expires_at: { v: 5, c: other(NOW) } } }]);
    expect(await expireLocal(db, clock)).toBe(0);
  });
});

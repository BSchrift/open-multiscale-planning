// The real client against the real local backend: sign-in through the Cognito stand-in, then sync.ts talking to
// cmd/local over HTTP. Runs from scripts/integration.sh, which starts the stack and sets INTEGRATION_API_URL.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuth } from './auth';
import type { Clock } from './clock';
import { fixedClock } from './clock';
import type { Db } from './db';
import { getRecord, transact } from './records';
import { createHttpSend, runSync, SyncError } from './sync';
import type { SyncSend } from './sync';
import type { FieldChange } from './types';
import { openTestDb } from '../platform/node-sqlite';
import { memoryTokens } from '../platform/memory';

const API = process.env.INTEGRATION_API_URL;
const REDIRECT = 'multiscale-local://auth/callback';
const MERGE_DIR = join(import.meta.dirname, '../../../backend/testdata/merge');

async function setServerClock(now: string) {
  const res = await fetch(`${API}/_local/clock`, { method: 'POST', body: JSON.stringify({ now }) });
  expect(res.status).toBe(204);
}

/** Signs in as `username` the way an app does, following the browser's redirect by hand. */
async function signIn(username: string, clock: Clock) {
  let opened = '';
  const auth = createAuth({
    authUrl: `${API}/cognito`,
    clientId: 'local-client',
    redirectUri: REDIRECT,
    clock,
    tokens: memoryTokens(),
    openExternal: async (url) => void (opened = url),
    fetch: (url, init) => fetch(url, init),
  });
  await auth.signIn();
  const res = await fetch(`${opened}&username=${encodeURIComponent(username)}`, { redirect: 'manual' });
  expect(await auth.handleRedirect(res.headers.get('location') ?? '')).toBe(true);
  return auth;
}

const device = async (clock: Clock, send: SyncSend) => ({ db: await openTestDb(), clock, sync: (db: Db) => runSync(db, send) });

const fieldsOf = async (db: Db, id: string) => {
  const row = await db.get<{ data: string; clocks: string }>('SELECT data, clocks FROM records WHERE id = :id', { id });
  const data = JSON.parse(row?.data ?? '{}') as Record<string, unknown>;
  const clocks = JSON.parse(row?.clocks ?? '{}') as Record<string, string>;
  return Object.fromEntries(Object.keys(clocks).map((field) => [field, { v: data[field], c: clocks[field] }]));
};

const outboxSize = async (db: Db) => (await db.get<{ n: number }>('SELECT count(*) AS n FROM outbox'))!.n;

describe.skipIf(!API)('sync.ts against cmd/local', () => {
  const clock = fixedClock(Date.now());
  let send: SyncSend;

  beforeAll(async () => {
    await setServerClock('');
    const auth = await signIn(`ts-client-${crypto.randomUUID()}`, clock);
    send = createHttpSend({ apiUrl: API!, auth, fetch: (url, init) => fetch(url, init) });
  });

  it('two devices of one user exchange records, edits and deletes, and converge', async () => {
    const a = await device(clock, send);
    const b = await device(clock, send);
    const id = await transact(a.db, clock, (w) => w.create('task', { kind: 'inbox', title: 'Write the report', estimate_min: 30 }));
    await a.sync(a.db);
    await b.sync(b.db);
    expect(await getRecord(b.db, 'task', id)).toMatchObject({ title: 'Write the report', estimate_min: 30 });

    // Offline on both: different fields merge, and the same field goes to the later write.
    await transact(a.db, clock, (w) => w.set('task', id, { title: 'Write the short report' }));
    clock.set(clock.now() + 1);
    await transact(b.db, clock, (w) => w.set('task', id, { estimate_min: 45, title: 'Write the final report' }));
    await a.sync(a.db);
    await b.sync(b.db);
    await a.sync(a.db);
    expect(await fieldsOf(a.db, id)).toEqual(await fieldsOf(b.db, id));
    expect(await getRecord(a.db, 'task', id)).toMatchObject({ title: 'Write the final report', estimate_min: 45 });

    await transact(b.db, clock, (w) => w.delete('task', id));
    await b.sync(b.db);
    await a.sync(a.db);
    expect((await getRecord(a.db, 'task', id))?.deleted_at).toBeTruthy();
    expect(await outboxSize(a.db)).toBe(0);
    expect(await outboxSize(b.db)).toBe(0);
  });

  it('pushes in batches and pulls in pages', async () => {
    const a = await device(clock, send);
    const ids = [];
    for (let i = 0; i < 600; i++) ids.push(await transact(a.db, clock, (w) => w.create('task', { kind: 'one_off', title: `Paint fence board ${i}` })));
    await a.sync(a.db);
    expect(await outboxSize(a.db)).toBe(0);
    const b = await device(clock, send);
    await b.sync(b.db);
    for (const id of [ids[0]!, ids[350]!, ids[599]!]) expect(await fieldsOf(b.db, id)).toEqual(await fieldsOf(a.db, id));
  });

  it('a record just under the limit can still be deleted, and the delete reaches the other device', async () => {
    const a = await device(clock, send);
    const id = await transact(a.db, clock, (w) => w.create('task', { kind: 'inbox', title: '' }));
    const empty = new TextEncoder().encode(JSON.stringify(await fieldsOf(a.db, id))).length;
    await transact(a.db, clock, (w) => w.set('task', id, { title: 'x'.repeat(100 * 1024 - empty - 10) }));
    await a.sync(a.db);
    await transact(a.db, clock, (w) => w.delete('task', id));
    await a.sync(a.db);
    expect(await outboxSize(a.db)).toBe(0);
    const b = await device(clock, send);
    await b.sync(b.db);
    expect((await getRecord(b.db, 'task', id))?.deleted_at).toBeTruthy();
  });

  it('a device clock a day ahead is refused and keeps its outbox', async () => {
    const ahead = fixedClock(Date.now() + 25 * 3600_000);
    const a = await device(ahead, send);
    await transact(a.db, ahead, (w) => w.create('task', { kind: 'inbox', title: 'Learn to bake bread' }));
    await expect(a.sync(a.db)).rejects.toEqual(new SyncError('clock_ahead'));
    expect(await outboxSize(a.db)).toBeGreaterThan(0);
  });
});

interface MergeCase {
  name: string;
  current: Record<string, FieldChange>;
  incoming: Record<string, FieldChange>[];
  expected: Record<string, FieldChange>;
}

describe.skipIf(!API)('shared merge cases through cmd/local', () => {
  const cases = readdirSync(MERGE_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => JSON.parse(readFileSync(join(MERGE_DIR, file), 'utf8')) as MergeCase);
  let send: SyncSend;

  beforeAll(async () => {
    // The cases' clocks are fixed instants, so the server's clock must be past them to accept them.
    const latest = Math.max(...cases.flatMap((c) => [c.current, ...c.incoming].flatMap((f) => Object.values(f).map((x) => Number(x.c.slice(0, 13))))));
    const now = new Date(latest + 3600_000).toISOString();
    await setServerClock(now);
    const auth = await signIn(`ts-merge-${crypto.randomUUID()}`, fixedClock(now));
    send = createHttpSend({ apiUrl: API!, auth, fetch: (url, init) => fetch(url, init) });
  });
  afterAll(() => setServerClock(''));

  it('exist', () => expect(cases.length).toBeGreaterThan(0));

  it.each(cases.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
    const id = crypto.randomUUID();
    for (const fields of [c.current, ...c.incoming]) {
      if (Object.keys(fields).length > 0) await send({ cursor: 0, changes: [{ type: 'task', id, fields }] });
    }
    const fresh = await openTestDb();
    await runSync(fresh, send);
    expect(await fieldsOf(fresh, id)).toEqual(c.expected);
  });
});

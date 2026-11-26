// The real client against the real local backend: sign-in through the Cognito stand-in, then sync.ts talking to
// cmd/local over HTTP. Runs from scripts/integration.sh, which starts the stack and sets INTEGRATION_API_URL.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { protocol } from '@multiscale/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuth } from './auth';
import type { Clock } from './clock';
import { fixedClock } from './clock';
import type { Db } from './db';
import { editNote, noteId, saveAsNote } from './memos';
import { notesForDay } from './queries';
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

  it("a note's home and its day on Today reach the other device, and so does moving it back to its own", async () => {
    const a = await device(clock, send);
    const b = await device(clock, send);
    const goal = await transact(a.db, clock, (w) => w.create('objective', { title: 'Home', state: 'active' }));
    const project = await transact(a.db, clock, (w) => w.create('project', { objective_id: goal, title: 'Kitchen redo', state: 'active', start: '2026-11-01', end: '2026-12-31' }));
    const item = await transact(a.db, clock, (w) => w.create('task', { kind: 'inbox', title: 'Tiles: 10x10 white' }));
    await transact(a.db, clock, (w) => saveAsNote(w, item, clock, { type: 'project', id: project }));
    await transact(a.db, clock, (w) => editNote(w, noteId(item), { show_on: '2026-11-20' }));
    await a.sync(a.db);
    await b.sync(b.db);
    expect((await notesForDay(b.db, '2026-11-20')).map((n) => [n.id, n.home])).toEqual([[noteId(item), { type: 'project', id: project }]]);

    clock.set(clock.now() + 1);
    await transact(b.db, clock, (w) => editNote(w, noteId(item), { home: null, show_on: null }));
    await b.sync(b.db);
    await a.sync(a.db);
    expect(await getRecord(a.db, 'memo', noteId(item))).toMatchObject({ home: null, show_on: null });
    expect(await fieldsOf(a.db, noteId(item))).toEqual(await fieldsOf(b.db, noteId(item)));
  });

  it('pushes in batches and pulls in pages', async () => {
    const a = await device(clock, send);
    const ids = [];
    // More than a page of 2,000, so the pull takes two.
    for (let i = 0; i < 2100; i++) ids.push(await transact(a.db, clock, (w) => w.create('task', { kind: 'one_off', title: `Paint fence board ${i}` })));
    await a.sync(a.db);
    expect(await outboxSize(a.db)).toBe(0);
    const b = await device(clock, send);
    const events: string[] = [];
    b.db.subscribe(() => events.push('applied'));
    await runSync(b.db, async (request) => {
      events.push('sent');
      return send(request);
    });
    // The second page is asked for before the first is applied.
    expect(events.slice(0, 3)).toEqual(['sent', 'sent', 'applied']);
    for (const id of [ids[0]!, ids[1050]!, ids[2099]!]) expect(await fieldsOf(b.db, id)).toEqual(await fieldsOf(a.db, id));
  }, 60_000);

  it('a record just under the limit can still be deleted, and the delete reaches the other device', async () => {
    const a = await device(clock, send);
    const id = await transact(a.db, clock, (w) => w.create('task', { kind: 'inbox', title: '' }));
    const empty = new TextEncoder().encode(JSON.stringify(await fieldsOf(a.db, id))).length;
    await transact(a.db, clock, (w) => w.set('task', id, { title: 'x'.repeat(protocol.sync.maxRecordBytes - empty - 10) }));
    await a.sync(a.db);
    // The other device holds it first: a new one's first sync leaves out what was deleted before it began.
    const b = await device(clock, send);
    await b.sync(b.db);
    await transact(a.db, clock, (w) => w.delete('task', id));
    await a.sync(a.db);
    expect(await outboxSize(a.db)).toBe(0);
    await b.sync(b.db);
    expect((await getRecord(b.db, 'task', id))?.deleted_at).toBeTruthy();
  });

  it("a first sync's snapshot leaves out what was deleted by then, and nothing deleted or restored since", async () => {
    // A user of its own, so its counter starts at 0 and the sequence numbers below are known.
    const auth = await signIn(`ts-snapshot-${crypto.randomUUID()}`, clock);
    const own = createHttpSend({ apiUrl: API!, auth, fetch: (url, init) => fetch(url, init) });
    const a = await device(clock, own);
    for (const id of ['s1', 's2', 's3']) await transact(a.db, clock, (w) => w.create('task', { kind: 'inbox', title: `Task ${id}` }, id));
    await a.sync(a.db);
    await transact(a.db, clock, (w) => w.delete('task', 's2'));
    await a.sync(a.db);

    const first = await own({ cursor: 0, changes: [] });
    expect(first.snapshot).toBe(4);
    const later = await own({ cursor: 1, changes: [], snapshot: first.snapshot });
    expect(later.changes.map((c) => c.id)).toEqual(['s3']);
    expect(later.cursor).toBe(4);
    // An app from before sends no snapshot, and gets the delete.
    expect((await own({ cursor: 1, changes: [] })).changes.map((c) => c.id)).toEqual(['s3', 's2']);

    await transact(a.db, clock, (w) => w.delete('task', 's3'));
    await a.sync(a.db);
    const since = await own({ cursor: 1, changes: [], snapshot: first.snapshot });
    expect(since.changes.map((c) => c.id)).toEqual(['s3']);
    expect(since.changes[0]!.fields.deleted_at?.v).toBeTruthy();
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

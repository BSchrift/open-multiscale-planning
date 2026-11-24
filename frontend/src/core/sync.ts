// The sync client. One sync pushes the outbox in batches and pulls what this device hasn't seen, repeating until
// both are done. Merging is idempotent, so anything lost or repeated along the way is safe to send again. That's
// why applying a response, clearing the outbox and storing the cursor can be separate steps: a crash between them
// only means the next sync repeats some work.
//
// When this device may hold an older copy of something that has expired, which pulls leave out, the server answers
// with a reset for expired records instead (docs/retention.md). The device then pulls everything without sending,
// drops what didn't come back unless it made it since it last synced, and sends its outbox after.

import { protocol } from '@multiscale/config';
import { getMeta, META, setMeta } from './db';
import { perf } from './perf';
import type { Db, Sql } from './db';
import { applyRemote } from './records';
import { tokenSubject } from './tokenClaims';
import type { Instant, RecordChange } from './types';

// The server's limits, from config/protocol.yaml.
const BATCH_RECORDS = protocol.sync.maxChanges;
/** The server refuses a change over this, measured as its fields' values and clocks in JSON. */
const RECORD_BYTES = protocol.sync.maxRecordBytes;
/** How far the server lets a merged record pass RECORD_BYTES, so one at the limit can still take deleted_at. */
const MERGED_ROOM = protocol.sync.mergedRoomBytes;
/** Well under the 6 MB a request can carry, leaving room for the rest of the request. */
const BATCH_BYTES = protocol.sync.clientBatchBytes;
const REQUEST_TIMEOUT_MS = 30_000;

export type SyncErrorCode =
  | 'offline'
  | 'sign_in_expired'
  | 'sign_in_failed'
  | 'clock_ahead'
  | 'other_account'
  | 'too_large'
  /** The account was deleted, here or on another device: this device's copy is erased and it's signed out. */
  | 'account_deleted'
  | 'error';

/** A failed sync, by what the user can be told about it. Stored as last_sync_error. */
export class SyncError extends Error {
  constructor(
    readonly code: SyncErrorCode,
    /** For account_deleted, the account that was deleted, from the token that found it, when the token said. */
    readonly account: string | null = null,
  ) {
    super(code);
    this.name = 'SyncError';
  }
}

export interface SyncRequest {
  cursor: number;
  changes: RecordChange[];
  /** This app takes a reset for expired records. Left off while it pulls everything after one. */
  expiry_reset?: boolean;
}

export interface SyncResponse {
  cursor: number;
  more: boolean;
  changes: RecordChange[];
  /** Absent until the server's table is first restored from a backup, and new after each restore. */
  generation?: string;
  /** 'expired' when this device may hold an older copy of an expired record. Nothing it sent was kept. */
  reset?: string;
}

export type SyncSend = (request: SyncRequest) => Promise<SyncResponse>;

interface OutboxRow {
  record_id: string;
  type: string;
  field: string;
  clock: string;
}

const byteLength = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

/**
 * The next records to send, in id order, up to 99 or BATCH_BYTES. A record too large for the server, or one it has
 * refused this sync, stays in the outbox, set aside and counted in `held`, so it can't hold up the rest. Each record
 * up to `oneByOne` goes alone, to find the one the server refused in a batch. One transaction, so a record and its
 * outbox rows can't be read mid-edit.
 */
function readBatch(db: Db, refused: ReadonlySet<string>, oneByOne: string) {
  return db.transaction(async (tx) => {
    const rows: OutboxRow[] = [];
    const changes: RecordChange[] = [];
    let bytes = 0;
    let held = 0;
    let after = '';
    for (;;) {
      const ids = await tx.all<{ record_id: string }>(
        `SELECT DISTINCT record_id FROM outbox WHERE record_id > :after ORDER BY record_id LIMIT ${BATCH_RECORDS}`,
        { after },
      );
      if (ids.length === 0) return { rows, changes, held, more: false };
      for (const { record_id } of ids) {
        after = record_id;
        let own = await tx.all<OutboxRow>('SELECT record_id, type, field, clock FROM outbox WHERE record_id = :id', { id: record_id });
        const record = await tx.get<{ data: string; clocks: string }>('SELECT data, clocks FROM records WHERE id = :id', { id: record_id });
        const data = record ? (JSON.parse(record.data) as Record<string, unknown>) : {};
        const clocks = record ? (JSON.parse(record.clocks) as Record<string, unknown>) : {};
        // The latest value, so a field edited twice goes once.
        const change: RecordChange = { type: own[0]!.type, id: record_id, fields: Object.fromEntries(own.map((r) => [r.field, { v: data[r.field] ?? null, c: r.clock }])) };
        // Its expiry goes with every change, as it stands, so the server can tell a change to a record that has expired
        // even when it doesn't hold the record any more.
        if (typeof data.expires_at === 'string' && !change.fields.expires_at && typeof clocks.expires_at === 'string') {
          change.fields.expires_at = { v: data.expires_at, c: clocks.expires_at };
        }
        // The server merges into what it holds, which is all of this, so the whole record has to fit, with its room.
        const whole = byteLength(Object.fromEntries(Object.keys(data).map((f) => [f, { v: data[f], c: clocks[f] }])));
        if (refused.has(record_id) || byteLength(change.fields) > RECORD_BYTES || whole > RECORD_BYTES + MERGED_ROOM) {
          // A deleted record can't be shortened, so its delete goes alone, which the server has room for on what it
          // holds. The rest waits without counting, and is held again if the record comes back.
          const deleted = own.filter((r) => r.field === 'deleted_at');
          if (!data.deleted_at) held++;
          if (!data.deleted_at || deleted.length === 0) continue;
          own = deleted;
          change.fields = { deleted_at: change.fields.deleted_at! };
        }
        const size = byteLength(change);
        if (changes.length > 0 && bytes + size > BATCH_BYTES) return { rows, changes, held, more: true };
        changes.push(change);
        rows.push(...own);
        bytes += size;
        if (changes.length === BATCH_RECORDS || record_id <= oneByOne) return { rows, changes, held, more: true };
      }
    }
  });
}

/** Removes only rows whose clock still matches what was sent, so an edit made during the sync goes next time. */
function clearSent(db: Db, rows: readonly OutboxRow[]) {
  return db.transaction(async (tx) => {
    for (const { record_id, field, clock } of rows) {
      await tx.run('DELETE FROM outbox WHERE record_id = :record_id AND field = :field AND clock = :clock', { record_id, field, clock });
    }
  });
}

/** After the server's table was restored from a backup: start over from 0 and queue every field of every record. */
function resetForRestoredServer(db: Db, generation: string) {
  return db.transaction(async (tx) => {
    await tx.run(
      `INSERT INTO outbox (record_id, type, field, clock)
       SELECT r.id, r.type, j.key, j.value FROM records r, json_each(r.clocks) j WHERE true
       ON CONFLICT (record_id, field) DO NOTHING`,
    );
    await setMeta(tx, META.cursor, '0');
    await setMeta(tx, META.generation, generation);
  });
}

/**
 * After a pull of everything that followed a reset for expired records: drops what the server didn't send, with its
 * outbox rows, unless every field of it is still to send, which means this device made it since it last synced. Then
 * stores the cursor. The screens never show an empty app, as they would if it emptied first.
 */
function finishExpiryReset(db: Db, pulled: ReadonlySet<string>, cursor: number) {
  return db.transaction(async (tx) => {
    const pending = new Map<string, Set<string>>();
    for (const { record_id, field } of await tx.all<{ record_id: string; field: string }>('SELECT record_id, field FROM outbox')) {
      pending.set(record_id, (pending.get(record_id) ?? new Set()).add(field));
    }
    const records = await tx.all<{ id: string; clocks: string }>('SELECT id, clocks FROM records');
    const stale = records
      .filter(({ id, clocks }) => !pulled.has(id) && !Object.keys(JSON.parse(clocks) as object).every((field) => pending.get(id)?.has(field)))
      .map(({ id }) => id);
    for (let i = 0; i < stale.length; i += BATCH_RECORDS) {
      const ids = stale.slice(i, i + BATCH_RECORDS);
      const list = ids.map((_, n) => `:id${n}`).join(', ');
      const params = Object.fromEntries(ids.map((id, n) => [`id${n}`, id]));
      await tx.run(`DELETE FROM outbox WHERE record_id IN (${list})`, params);
      await tx.run(`DELETE FROM records WHERE id IN (${list})`, params);
    }
    await setMeta(tx, META.cursor, String(cursor));
  });
}

function assertResponse(res: SyncResponse): void {
  const ok =
    res !== null &&
    typeof res === 'object' &&
    Number.isSafeInteger(res.cursor) &&
    res.cursor >= 0 &&
    typeof res.more === 'boolean' &&
    Array.isArray(res.changes) &&
    res.changes.every((change) => change !== null && typeof change === 'object') &&
    (res.generation === undefined || typeof res.generation === 'string') &&
    (res.reset === undefined || res.reset === 'expired');
  if (!ok) throw new SyncError('error');
}

/**
 * One full sync. Throws on failure, leaving the outbox and cursor as they were before the failed request. A record too
 * large to send waits in the outbox while the rest syncs, and then the sync throws too_large. So does one the server
 * refuses as too long, which send reports as too_large: its batch goes again one record at a time to find it. Resolves
 * to how many changes it brought down.
 * shortcut: a batch the server refuses for any other reason fails whole every time until edited; send its records one
 * by one on a refusal if that ever happens in practice.
 * shortcut: what the server refused isn't kept between syncs, so each sync finds a held record again with a refused
 * request and its batch one by one. Keep the refused records' clocks if that ever costs too much.
 */
export async function runSync(db: Db, send: SyncSend): Promise<number> {
  const refused = new Set<string>();
  let oneByOne = '';
  let cursor = Number((await getMeta(db, META.cursor)) ?? 0);
  let seen = (await getMeta(db, META.generation)) ?? '';
  // Starting from 0, nothing here can be an older copy of the server's: every id it sends goes in here, and a reset
  // carries on from where the pull is rather than starting over.
  let received: Set<string> | null = cursor === 0 ? new Set() : null;
  // Set while pulling everything after a reset: the ids that came back.
  let pulled: Set<string> | null = null;
  let resets = 0;
  let applied = 0;
  for (;;) {
    const { rows, changes, held, more } = pulled ? { rows: [], changes: [], held: 0, more: false } : await readBatch(db, refused, oneByOne);
    let res: SyncResponse;
    try {
      res = await timedSend(send, pulled ? { cursor, changes } : { cursor, changes, expiry_reset: true });
    } catch (err) {
      // The server refuses a whole request for one record too long, without saying which, so the batch goes again one
      // record at a time, and the one it refuses alone is held. Refused again once held, it can't be held any further.
      const alone = changes.length === 1 ? changes[0]!.id : null;
      if (!(err instanceof SyncError && err.code === 'too_large') || changes.length === 0 || (alone && refused.has(alone))) throw err;
      if (alone) refused.add(alone);
      else oneByOne = changes.at(-1)!.id;
      continue;
    }
    assertResponse(res);
    // A restore shows as a new generation. The cursor check also catches one whose generation was never written, but
    // only until other devices move the counter past this cursor.
    const generation = res.generation ?? '';
    if ((res.cursor < cursor && !res.reset) || generation !== seen) {
      await resetForRestoredServer(db, generation);
      cursor = 0;
      seen = generation;
      received = pulled = null;
      continue;
    }
    if (res.reset) {
      // A pull sent without expiry_reset is never answered with one, and one reset leaves nothing to reset again.
      if (pulled || resets++ > 0) throw new SyncError('error');
      pulled = received ?? new Set();
      if (!received) cursor = 0;
      continue;
    }
    // A server that claims more without moving the cursor would otherwise loop forever.
    if (res.more && res.cursor === cursor) throw new SyncError('error');
    await applyRemote(db, res.changes);
    applied += res.changes.length;
    for (const change of res.changes) {
      received?.add(change.id);
      pulled?.add(change.id);
    }
    if (pulled) {
      cursor = res.cursor;
      if (res.more) continue;
      await finishExpiryReset(db, pulled, cursor);
      db.notifyChanged({ source: 'remote' });
      received = pulled = null;
      continue;
    }
    await clearSent(db, rows);
    await setMeta(db, META.cursor, String(res.cursor));
    cursor = res.cursor;
    if (res.more || more) continue;
    if (held > 0) throw new SyncError('too_large');
    return applied;
  }
}

/**
 * A request, with the sync KPIs of a push (docs/performance.md): sync.send, the request alone, and sync.push, from the
 * first change it carries, which syncRunner starts on that change's commit. A failed push leaves sync.push to the next.
 */
async function timedSend(send: SyncSend, request: SyncRequest): Promise<SyncResponse> {
  if (request.changes.length === 0) return send(request);
  const since = perf.pending('sync.push');
  perf.cancel('sync.push');
  const sent = performance.now();
  try {
    const res = await send(request);
    perf.measure('sync.send', sent);
    if (since !== undefined) perf.measure('sync.push', since);
    return res;
  } catch (err) {
    if (since !== undefined) perf.start('sync.push', Math.min(since, perf.pending('sync.push') ?? since));
    throw err;
  }
}

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export interface SyncAuth {
  accessToken(options?: { refresh?: boolean }): Promise<string>;
  expire(): Promise<void>;
}

export interface ApiDeps {
  apiUrl: string;
  auth: SyncAuth;
  fetch: FetchFn;
}

/** Whether the API refused a request because the account was deleted, which no refresh can mend. */
const accountDeleted = async (res: Response) =>
  res.status === 401 && ((await res.clone().json().catch(() => null)) as { error?: unknown } | null)?.error === 'account_deleted';

/** POSTs to the API signed in, refreshing the token once on a 401. Throws SyncError: offline, sign_in_expired or account_deleted. */
export function apiPost(deps: ApiDeps, path: string, body?: unknown): Promise<Response> {
  return apiRequest(deps, 'POST', path, body);
}

/** A request to the API signed in, as apiPost makes. */
export async function apiRequest(deps: ApiDeps, method: 'GET' | 'POST', path: string, body?: unknown): Promise<Response> {
  const post = async (token: string) => {
    try {
      return await deps.fetch(`${deps.apiUrl}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new SyncError('offline');
    }
  };
  let token = await deps.auth.accessToken();
  let res = await post(token);
  if (await accountDeleted(res)) throw new SyncError('account_deleted', tokenSubject(token));
  if (res.status === 401) {
    token = await deps.auth.accessToken({ refresh: true });
    res = await post(token);
    if (await accountDeleted(res)) throw new SyncError('account_deleted', tokenSubject(token));
    if (res.status === 401) {
      await deps.auth.expire();
      throw new SyncError('sign_in_expired');
    }
  }
  return res;
}

/**
 * The server's codes for a request refused because one record is too long: its text, or the whole record once merged
 * with what other devices sent, which this one may not have pulled yet. And for one too large as a whole, which no app
 * fills, but whose records each fit alone, so it goes again one record at a time like the rest.
 */
const TOO_LONG: unknown[] = ['notes_too_long', 'memo_too_long', 'record_too_large', 'request_too_large'];

/** The real network behind runSync. A record refused as too long is reported as too_large, which runSync holds. */
export function createHttpSend(deps: ApiDeps): SyncSend {
  return async (request) => {
    const res = await apiPost(deps, '/sync', request);
    if (res.ok) return (await res.json()) as SyncResponse;
    const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
    throw new SyncError(body?.error === 'clock_ahead' ? 'clock_ahead' : TOO_LONG.includes(body?.error) ? 'too_large' : 'error');
  };
}

export interface SyncStatus {
  lastSyncAt: Instant | null;
  lastError: SyncErrorCode | null;
}

/** Whether the last sync found no one signed in: a sign-in that lapsed or failed, or an account deleted. */
export const isSignedOut = (status: SyncStatus): boolean =>
  status.lastError === 'sign_in_expired' || status.lastError === 'sign_in_failed' || status.lastError === 'account_deleted';

/** Signed in once it has synced, or tried to, and the last try wasn't refused for sign-in. */
export function isSignedIn(status: SyncStatus): boolean {
  const signedOut = isSignedOut(status);
  return !signedOut && !!(status.lastSyncAt || status.lastError);
}

/** How many records have changes this device hasn't sent yet. */
export async function unsyncedChanges(sql: Sql): Promise<number> {
  return (await sql.get<{ n: number }>('SELECT COUNT(DISTINCT record_id) AS n FROM outbox'))?.n ?? 0;
}

/** What Settings shows. Re-read through useQuery: a finished sync announces a change. */
export async function syncStatus(sql: Sql): Promise<SyncStatus> {
  return {
    lastSyncAt: await getMeta(sql, META.lastSyncAt),
    lastError: (await getMeta(sql, META.lastSyncError)) as SyncErrorCode | null,
  };
}

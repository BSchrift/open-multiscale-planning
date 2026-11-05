// The sync client. One sync pushes the outbox in batches and pulls what this device hasn't seen, repeating until
// both are done. Merging is idempotent, so anything lost or repeated along the way is safe to send again. That's
// why applying a response, clearing the outbox and storing the cursor can be separate steps: a crash between them
// only means the next sync repeats some work.

import { getMeta, META, setMeta } from './db';
import type { Db, Sql } from './db';
import { applyRemote } from './records';
import type { Instant, RecordChange } from './types';

const BATCH_RECORDS = 99;
/** The server refuses a change over this, measured as its fields' values and clocks in JSON. */
const RECORD_BYTES = 100 * 1024;
/** How far the server lets a merged record pass RECORD_BYTES, so one at the limit can still take deleted_at. */
const MERGED_ROOM = 1024;
/** Well under the 6 MB a request can carry, leaving room for the rest of the request. */
const BATCH_BYTES = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

export type SyncErrorCode = 'offline' | 'sign_in_expired' | 'sign_in_failed' | 'clock_ahead' | 'other_account' | 'too_large' | 'error';

/** A failed sync, by what the user can be told about it. Stored as last_sync_error. */
export class SyncError extends Error {
  constructor(readonly code: SyncErrorCode) {
    super(code);
    this.name = 'SyncError';
  }
}

export interface SyncRequest {
  cursor: number;
  changes: RecordChange[];
}

export interface SyncResponse {
  cursor: number;
  more: boolean;
  changes: RecordChange[];
  /** Absent until the server's table is first restored from a backup, and new after each restore. */
  generation?: string;
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
 * The next records to send, in id order, up to 99 or BATCH_BYTES. A record too large for the server stays in the
 * outbox, set aside and counted in `held`, so it can't hold up the rest. One transaction, so a record and its outbox
 * rows can't be read mid-edit.
 */
function readBatch(db: Db) {
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
        // The server merges into what it holds, which is all of this, so the whole record has to fit, with its room.
        const whole = byteLength(Object.fromEntries(Object.keys(data).map((f) => [f, { v: data[f], c: clocks[f] }])));
        if (byteLength(change.fields) > RECORD_BYTES || whole > RECORD_BYTES + MERGED_ROOM) {
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
        if (changes.length === BATCH_RECORDS) return { rows, changes, held, more: true };
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

function assertResponse(res: SyncResponse): void {
  const ok =
    res !== null &&
    typeof res === 'object' &&
    Number.isSafeInteger(res.cursor) &&
    res.cursor >= 0 &&
    typeof res.more === 'boolean' &&
    Array.isArray(res.changes) &&
    res.changes.every((change) => change !== null && typeof change === 'object') &&
    (res.generation === undefined || typeof res.generation === 'string');
  if (!ok) throw new SyncError('error');
}

/**
 * One full sync. Throws on failure, leaving the outbox and cursor as they were before the failed request. A record too
 * large to send waits in the outbox while the rest syncs, and then the sync throws too_large.
 * shortcut: a batch the server refuses for any other reason fails whole every time until edited; send its records one
 * by one on a refusal if that ever happens in practice.
 */
export async function runSync(db: Db, send: SyncSend): Promise<void> {
  let cursor = Number((await getMeta(db, META.cursor)) ?? 0);
  let seen = (await getMeta(db, META.generation)) ?? '';
  for (;;) {
    const { rows, changes, held, more } = await readBatch(db);
    const res = await send({ cursor, changes });
    assertResponse(res);
    // A restore shows as a new generation. The cursor check also catches one whose generation was never written, but
    // only until other devices move the counter past this cursor.
    const generation = res.generation ?? '';
    if (res.cursor < cursor || generation !== seen) {
      await resetForRestoredServer(db, generation);
      cursor = 0;
      seen = generation;
      continue;
    }
    // A server that claims more without moving the cursor would otherwise loop forever.
    if (res.more && res.cursor === cursor) throw new SyncError('error');
    await applyRemote(db, res.changes);
    await clearSent(db, rows);
    await setMeta(db, META.cursor, String(res.cursor));
    cursor = res.cursor;
    if (res.more || more) continue;
    if (held > 0) throw new SyncError('too_large');
    return;
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

/** POSTs to the API signed in, refreshing the token once on a 401. Throws SyncError: offline or sign_in_expired. */
export async function apiPost(deps: ApiDeps, path: string, body?: unknown): Promise<Response> {
  const post = async (token: string) => {
    try {
      return await deps.fetch(`${deps.apiUrl}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new SyncError('offline');
    }
  };
  let res = await post(await deps.auth.accessToken());
  if (res.status === 401) {
    res = await post(await deps.auth.accessToken({ refresh: true }));
    if (res.status === 401) {
      await deps.auth.expire();
      throw new SyncError('sign_in_expired');
    }
  }
  return res;
}

/** The real network behind runSync. */
export function createHttpSend(deps: ApiDeps): SyncSend {
  return async (request) => {
    const res = await apiPost(deps, '/sync', request);
    if (res.ok) return (await res.json()) as SyncResponse;
    const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
    throw new SyncError(body?.error === 'clock_ahead' ? 'clock_ahead' : 'error');
  };
}

export interface SyncStatus {
  lastSyncAt: Instant | null;
  lastError: SyncErrorCode | null;
}

/** Signed in once it has synced, or tried to, and the last try wasn't refused for sign-in. */
export function isSignedIn(status: SyncStatus): boolean {
  const signedOut = status.lastError === 'sign_in_expired' || status.lastError === 'sign_in_failed';
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

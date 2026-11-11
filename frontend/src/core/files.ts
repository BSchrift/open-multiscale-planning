// Attachments' files: up to private storage once their record has synced, and down again the first time they're
// opened on a device. The API checks each upload against the record the server has, so an upload waits for its
// record's sync, and runs after each one. Its state on each row is this device's alone, kept here, not synced.
//
//   const files = createFiles({ db, clock, store, api });
//   files.run();                 // after a sync: uploads what's waiting
//   files.state(id);             // { kind: 'uploading', sent } and so on, for the row
//   await files.open(id);        // the bytes, downloaded once and kept

import type { Clock } from './clock';
import { nowInstant } from './dates';
import type { Db } from './db';
import { transact } from './records';
import type { Instant } from './types';

/** Where a photo's or file's bytes are kept on this device. */
export interface FileBytes {
  get(id: string): Promise<Blob | null>;
  put(id: string, file: Blob): Promise<void>;
}

/** The API's /files routes, and the plain requests to storage its links are for. Each throws when offline. */
export interface FilesApi {
  usage(): Promise<Response>;
  grantUpload(id: string): Promise<Response>;
  grantDownloads(ids: readonly string[]): Promise<Response>;
  /** PUTs the bytes to a granted link, reporting bytes sent, and resolves to the HTTP status. */
  put(url: string, headers: Record<string, string>, body: Blob, progress: (sent: number) => void): Promise<number>;
  get(url: string): Promise<Blob>;
}

export type UploadState =
  /** Its record hasn't reached the server yet, the device is offline, or a link expired: it goes with the next sync. */
  | { kind: 'waiting' }
  | { kind: 'uploading'; sent: number }
  /** The server found storage full. It waits for Retry. */
  | { kind: 'full' }
  /** Past this hour's uploads: it goes by itself from then. */
  | { kind: 'limit'; from: Instant }
  /** Refused for good, as a type or size no app sends. */
  | { kind: 'refused' };

export interface Usage {
  used: number;
  quota: number;
}

/** Why a file can't be opened. */
export class OpenError extends Error {
  constructor(
    readonly reason: 'offline' | 'gone' | 'limit',
    readonly from?: Instant,
  ) {
    super(reason);
  }
}

interface Pending {
  id: string;
}

const body = async (res: Response) => (await res.json().catch(() => null)) as Record<string, unknown> | null;

export function createFiles(deps: { db: Db; clock: Clock; store: FileBytes; api: FilesApi }) {
  const { db, clock, store, api } = deps;
  const states = new Map<string, UploadState>();
  const listeners = new Set<() => void>();
  const set = (id: string, state: UploadState | null) => {
    if (state) states.set(id, state);
    else states.delete(id);
    listeners.forEach((l) => l());
  };
  let running: Promise<void> | null = null;
  let again = false;
  // Past this hour's uploads, until then: every row waits for it.
  let limitedUntil: Instant | null = null;

  /** Photos and files added on this device that haven't gone up, whose records the server already has. */
  const pending = () =>
    db.all<Pending>(
      `SELECT a.id FROM attachment a
       WHERE a.kind IN ('photo', 'file') AND a.uploaded_at IS NULL AND a.deleted_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.record_id = a.id)
       ORDER BY a.id`,
    );

  async function uploadOne(id: string): Promise<'next' | 'stop' | 'limit'> {
    const state = states.get(id);
    if (state?.kind === 'full' || state?.kind === 'refused') return 'next';
    const bytes = await store.get(id);
    // Added on another device, which uploads it.
    if (!bytes) return 'next';
    const res = await api.grantUpload(id);
    const answer = await body(res);
    if (res.status === 403 && answer?.error === 'quota_exceeded') return set(id, { kind: 'full' }), 'next';
    if (res.status === 429 && typeof answer?.retry_at === 'string') {
      limitedUntil = answer.retry_at;
      return 'limit';
    }
    if (res.status === 404) return set(id, { kind: 'waiting' }), 'next';
    if ([400, 413, 415].includes(res.status)) return set(id, { kind: 'refused' }), 'next';
    if (!res.ok || typeof answer?.url !== 'string' || !answer.headers || typeof answer.headers !== 'object') {
      set(id, { kind: 'waiting' });
      return 'stop';
    }
    set(id, { kind: 'uploading', sent: 0 });
    const status = await api.put(answer.url, answer.headers as Record<string, string>, bytes, (sent) => set(id, { kind: 'uploading', sent }));
    if (status !== 200) {
      // An expired link or a refused PUT: the next run asks again.
      set(id, { kind: 'waiting' });
      return 'stop';
    }
    await transact(db, clock, (w) => w.set('attachment', id, { uploaded_at: nowInstant(clock) }));
    set(id, null);
    return 'next';
  }

  async function runOnce(): Promise<void> {
    const waiting = await pending();
    for (const { id } of waiting) {
      if (limitedUntil && Date.parse(limitedUntil) > clock.now()) {
        const from = limitedUntil;
        for (const row of waiting) if (states.get(row.id)?.kind !== 'full') set(row.id, { kind: 'limit', from });
        return;
      }
      try {
        const next = await uploadOne(id);
        if (next === 'stop') return;
        // Asked again with the hour known, every row waits for it.
        if (next === 'limit') return runOnce();
      } catch {
        // Offline: everything waits for the next sync.
        set(id, { kind: 'waiting' });
        return;
      }
    }
  }

  /** Uploads what's waiting, one at a time. Called after each sync, so each record is on the server first. */
  function run(): Promise<void> {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      do {
        again = false;
        await runOnce();
      } while (again);
    })().finally(() => (running = null));
    return running;
  }

  return {
    run,
    /** This device's upload state for a row, or null when there's nothing to say. */
    state: (id: string): UploadState | null => states.get(id) ?? null,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Tries an upload storage refused again. */
    retry(id: string): Promise<void> {
      set(id, { kind: 'waiting' });
      return run();
    },
    /** The storage used and allowed, or null where the server has no attachments. */
    async usage(): Promise<Usage | null> {
      const res = await api.usage();
      const answer = await body(res);
      if (!res.ok || typeof answer?.used_bytes !== 'number' || typeof answer.quota_bytes !== 'number') return null;
      return { used: answer.used_bytes, quota: answer.quota_bytes };
    },
    /** A photo's or file's bytes, from this device, or downloaded the first time and kept. Throws OpenError. */
    async open(id: string): Promise<Blob> {
      const kept = await store.get(id);
      if (kept) return kept;
      let res: Response;
      try {
        res = await api.grantDownloads([id]);
      } catch {
        throw new OpenError('offline');
      }
      const answer = await body(res);
      if (res.status === 429) throw new OpenError('limit', typeof answer?.retry_at === 'string' ? answer.retry_at : undefined);
      const granted = Array.isArray(answer?.files) ? (answer.files as { id?: unknown; url?: unknown }[]).find((f) => f.id === id) : undefined;
      if (!res.ok || typeof granted?.url !== 'string') throw new OpenError(res.ok ? 'gone' : 'offline');
      let file: Blob;
      try {
        file = await api.get(granted.url);
      } catch {
        throw new OpenError('offline');
      }
      await store.put(id, file);
      return file;
    },
  };
}

export type Files = ReturnType<typeof createFiles>;

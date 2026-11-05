// An in-memory stand-in for the sync API, for tests. Tests import this file; the app never does.

import { clockWins, parseClock } from './clock';
import { SyncError } from './sync';
import type { SyncRequest, SyncResponse } from './sync';
import type { FieldChange, RecordChange } from './types';

const DAY_MS = 86_400_000;

interface Stored {
  type: string;
  id: string;
  fields: Record<string, FieldChange>;
  seq: number;
}

export function fakeSyncServer(options: { pageSize?: number; now?: () => number } = {}) {
  const { pageSize = 500, now = () => Date.now() } = options;
  let records = new Map<string, Stored>();
  let counter = 0;
  // Absent until a restore writes one, as on the real table.
  let generation: string | undefined;
  const echo = () => (generation === undefined ? {} : { generation });

  const server = {
    requests: [] as SyncRequest[],
    /** Runs before a request is handled, so a test can act in the middle of a sync. */
    beforeHandle: undefined as (() => Promise<void>) | undefined,
    get counter() {
      return counter;
    },
    record: (id: string) => records.get(id)?.fields,
    /** Everything the server holds, for comparing with a replica. */
    values() {
      return Object.fromEntries([...records.values()].map((r) => [r.id, Object.fromEntries(Object.entries(r.fields).map(([f, e]) => [f, e.v]))]));
    },
    /** The table comes back from an old backup: everything after this sequence is gone. A restore's last step writes a new generation. */
    restoreTo(seq: number, newGeneration?: string) {
      records = new Map([...records].filter(([, r]) => r.seq <= seq));
      counter = seq;
      generation = newGeneration ?? generation;
    },
    async send(request: SyncRequest): Promise<SyncResponse> {
      // Copied at the boundary, as JSON over HTTP would.
      const req = JSON.parse(JSON.stringify(request)) as SyncRequest;
      server.requests.push(req);
      await server.beforeHandle?.();
      if (req.changes.length > 99) throw new SyncError('error');
      for (const change of req.changes) {
        for (const { c } of Object.values(change.fields)) {
          if (parseClock(c).wall > now() + DAY_MS) throw new SyncError('clock_ahead');
        }
      }
      // A cursor the counter hasn't reached means the table went back in time: write nothing and say so.
      if (req.cursor > counter) return { cursor: counter, more: false, changes: [], ...echo() };
      for (const change of req.changes) merge(change);
      const pending = [...records.values()].filter((r) => r.seq > req.cursor).sort((a, b) => a.seq - b.seq);
      const page = pending.slice(0, pageSize);
      return {
        cursor: page.at(-1)?.seq ?? req.cursor,
        more: pending.length > page.length,
        changes: page.map(({ type, id, fields }) => ({ type, id, fields })),
        ...echo(),
      };
    },
  };

  function merge(change: RecordChange) {
    const current = records.get(change.id);
    const fields = { ...current?.fields };
    let changed = false;
    for (const [field, entry] of Object.entries(change.fields)) {
      if (clockWins(entry.c, fields[field]?.c)) {
        fields[field] = entry;
        changed = true;
      }
    }
    if (changed) records.set(change.id, { type: change.type, id: change.id, fields, seq: ++counter });
  }

  return server;
}

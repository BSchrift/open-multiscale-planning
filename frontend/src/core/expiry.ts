// Expiry on the device. At launch, backfillExpiry gives expires_at to what lacks it, and after each sync and at launch
// expireLocal removes what has expired here. The server does the same on its side; docs/retention.md has both.

import type { Clock } from './clock';
import { nowInstant } from './dates';
import { getMeta, META } from './db';
import type { Db } from './db';
import { transact } from './records';
import { activeRetention, expiryDiffers, expiryFor } from './retention';

/**
 * The fields an expiry counts from. One written after expires_at was means an app from before changed it. The server
 * keeps the same list (clearOvertakenExpiry in backend/internal/sync/store.go).
 */
const SOURCES = ['deleted_at', 'done_at', 'cancelled_at', 'state', 'end', 'week_start', 'answered_at', 'project_id'];
const BATCH = 100;
const LOWEST = '0000000000000-';

const placeholders = (ids: readonly string[]) => ({
  list: ids.map((_, i) => `:id${i}`).join(', '),
  params: Object.fromEntries(ids.map((id, i) => [`id${i}`, id])),
});

/**
 * Works out expires_at where it's missing, as on records held from before retention, or where an app from before has
 * changed what it counts from since, and writes it through the automatic writer: a field filled for the first time gets
 * the lowest clock, so any real edit from any device wins. In small transactions, so screens aren't held up. Returns
 * how many records it wrote.
 */
export async function backfillExpiry(db: Db, clock: Clock): Promise<number> {
  const policy = activeRetention();
  if (!policy) return 0;
  const sources = SOURCES.map((f) => `'${f}'`).join(', ');
  const rows = await db.all<{ id: string; type: string; data: string; clocks: string }>(
    `SELECT id, type, data, clocks FROM records r WHERE json_extract(data, '$.expires_at') IS NULL OR EXISTS (
       SELECT 1 FROM json_each(r.clocks) j WHERE j.key IN (${sources}) AND j.value > json_extract(r.clocks, '$.expires_at'))`,
  );
  // Most never expire, so only those whose expiry changes are written. A milestone's and an answer's depend on another
  // record, which the write path reads.
  const due = rows
    .filter((row) => {
      if (row.type === 'milestone' || row.type === 'block_outcome') return true;
      const data = JSON.parse(row.data) as Record<string, unknown>;
      return expiryDiffers(data.expires_at, expiryFor(row.type, { data, clocks: JSON.parse(row.clocks) as Record<string, unknown> }, policy));
    })
    .map((row) => row.id);
  for (let i = 0; i < due.length; i += BATCH) {
    await transact(db, clock, async (w) => {
      for (const id of due.slice(i, i + BATCH)) await w.automatic.refresh(id);
    });
  }
  return due.length;
}

/**
 * Removes records whose expires_at has passed, with their outbox rows. An expiry this device filled in that the server
 * hasn't had yet waits for the next sync, so the server's copy gets it and goes too. Returns how many it removed.
 */
export async function expireLocal(db: Db, clock: Clock): Promise<number> {
  if (!activeRetention()) return 0;
  const synced = Number((await getMeta(db, META.cursor)) ?? 0) > 0;
  const waits = synced
    ? `AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.record_id = r.id AND o.field = 'expires_at' AND substr(o.clock, 1, 14) = '${LOWEST}')`
    : '';
  let removed = 0;
  await db.transaction(async (tx) => {
    const ids = (
      await tx.all<{ id: string }>(
        `SELECT id FROM records r WHERE json_type(data, '$.expires_at') = 'text' AND json_extract(data, '$.expires_at') < :now ${waits}`,
        { now: nowInstant(clock) },
      )
    ).map((r) => r.id);
    for (let i = 0; i < ids.length; i += BATCH) {
      const { list, params } = placeholders(ids.slice(i, i + BATCH));
      await tx.run(`DELETE FROM outbox WHERE record_id IN (${list})`, params);
      await tx.run(`DELETE FROM records WHERE id IN (${list})`, params);
    }
    removed = ids.length;
  });
  if (removed > 0) db.notifyChanged({ source: 'remote' });
  return removed;
}

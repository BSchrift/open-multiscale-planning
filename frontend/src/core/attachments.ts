// What attachments say about themselves: sizes, the storage used, and the reasons a file can't go up. And the sweep for
// those left on a note that's gone.

import type { Clock } from './clock';
import { nowInstant } from './dates';
import type { Db } from './db';
import { transact } from './records';

const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;

/** One decimal under 10, whole numbers above, in the unit that fits from 1,000 of the one below: 240 KB, 1.2 MB, 1 GB. */
export function formatBytes(bytes: number): string {
  const [size, unit] = bytes >= 1000 * MB ? [bytes / GB, 'GB'] : bytes >= 1000 * KB ? [bytes / MB, 'MB'] : [Math.ceil(bytes / KB), 'KB'];
  const shown = size < 10 && unit !== 'KB' ? Math.round(size * 10) / 10 : Math.round(size);
  return `${shown} ${unit}`;
}

export const usageLine = (used: number, quota: number) => `${formatBytes(used)} of ${formatBytes(quota)} used`;

export const storageFull = (used: number, quota: number) => `Storage full: ${usageLine(used, quota)}. Remove attachments to make room.`;

export const tooLarge = (size: number, max: number) => `This file is ${formatBytes(size)}. Files can be up to ${formatBytes(max)}.`;

/** The longest address a link can have. */
export const MAX_LINK = 2000;

/** A link with no name of its own goes by its site. */
export function linkName(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '') || url;
  } catch {
    return url;
  }
}

/** How long a note's own record may trail an attachment put on it, as when one device's push is split across requests. */
const NOTE_ARRIVES_MS = 86_400_000;

/**
 * Deletes the attachments left on a note that's gone: a photo another device added offline to a note this one deleted or
 * made a task, or one that arrives after its note was purged. Every app would otherwise keep it, and its file, for good,
 * with nothing on screen to remove it from, since an attachment's expiry follows only a task. Each gets the note's
 * deleted_at, or now once the note has gone, as an ordinary write, so released apps work out the same expiry.
 *
 * Run only after a sync that pulled to the end: part way through a pull, a note can still be on its way. Even then, a
 * note's attachment can come ahead of the note, from a push split across requests, so one put on a note lately waits.
 * One brought back since its note was deleted is the note's restore, still on its way, and stays too. Returns how many
 * it deleted.
 */
export async function sweepOrphans(db: Db, clock: Clock): Promise<number> {
  const settled = String(clock.now() - NOTE_ARRIVES_MS).padStart(13, '0');
  const rows = await db.all<{ id: string; at: string | null }>(
    `SELECT a.id, json_extract(m.data, '$.deleted_at') AS at
     FROM records a LEFT JOIN records m ON m.id = json_extract(a.data, '$.memo_id') AND m.type = 'memo'
     WHERE a.type = 'attachment' AND json_extract(a.data, '$.memo_id') IS NOT NULL
       AND json_extract(a.data, '$.task_id') IS NULL AND json_extract(a.data, '$.deleted_at') IS NULL
       AND (
         (json_type(m.data, '$.deleted_at') = 'text'
           AND COALESCE(json_extract(a.clocks, '$.deleted_at'), '') < json_extract(m.clocks, '$.deleted_at'))
         OR (m.id IS NULL AND json_extract(a.clocks, '$.memo_id') < :settled)
       )`,
    { settled },
  );
  if (rows.length === 0) return 0;
  await transact(db, clock, async (w) => {
    for (const { id, at } of rows) await w.set('attachment', id, { deleted_at: at ?? nowInstant(clock) });
  });
  return rows.length;
}

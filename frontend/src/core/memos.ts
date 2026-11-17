// Notes: things to look up or remember, never to do. `memo` in code, since a task's notes field is its description. A
// note comes only from an Inbox item, saved as one in Process, and goes back to the Inbox to become a task. Each action
// here is one change that returns its exact reverse, for Undo, and cuts what it writes to what the server takes.
//
// An Inbox item saved as a note is deleted, not finished: released apps name what an item became from a fixed list, and
// list a finished one as work done. They store the note and its attachments and show neither.

import type { Clock } from './clock';
import { nowInstant, today } from './dates';
import { MAX_TITLE } from './captureTitle';
import { MAX_NOTES } from './notes';
import { applyPlanChange } from './plan';
import type { PlanChange, RecordWrite } from './plan';
import { getRecord, noteId } from './records';
import type { Writer } from './records';
import { closeTask } from './tasks';
import type { Fields, Memo } from './types';

export { noteId };

/** The text cut to max UTF-16 units, at the last space or line break that fits, else at max, never between a pair. */
export function clampText(text: string, max: number): string {
  if (text.length <= max) return text;
  // From the character just past the limit, so a space there still ends the last word that fits.
  const space = Math.max(text.lastIndexOf(' ', max), text.lastIndexOf('\n', max));
  if (space > 0) return text.slice(0, space);
  const high = text.charCodeAt(max - 1);
  return text.slice(0, high >= 0xd800 && high <= 0xdbff ? max - 1 : max);
}

const clampBody = (body: string | null | undefined) => (body ? clampText(body, MAX_NOTES) : null);

/** A note's title and body, cut to what the server takes. */
function clamped(fields: { title?: string; body?: string | null }): Fields<'memo'> {
  return {
    ...(fields.title !== undefined ? { title: clampText(fields.title, MAX_TITLE) } : {}),
    ...(fields.body !== undefined ? { body: clampBody(fields.body) } : {}),
  };
}

/** Writes a note that may be here already, and returns the write that puts it back: deleted if it's new. */
async function put(w: Writer, id: string, fields: Fields<'memo'>, clock: Clock): Promise<RecordWrite> {
  if (await getRecord(w.sql, 'memo', id)) return { type: 'memo', id, fields: await w.set('memo', id, fields) };
  await w.create('memo', fields, id);
  return { type: 'memo', id, fields: { deleted_at: nowInstant(clock) } };
}

/** Moves the live attachments on a task or a note to the other, as writes for applyPlanChange. */
async function moveAttachments(w: Writer, from: { task_id: string } | { memo_id: string }, to: Fields<'attachment'>): Promise<RecordWrite[]> {
  const [field, owner] = 'task_id' in from ? ['task_id', from.task_id] : ['memo_id', from.memo_id];
  const rows = await w.sql.all<{ id: string }>(`SELECT id FROM attachment WHERE ${field} = :owner AND deleted_at IS NULL ORDER BY id`, { owner });
  return rows.map(({ id }) => ({ type: 'attachment', id, fields: to }));
}

/**
 * Saves an Inbox item as a note, in one change: a note with its title and description, its attachments moved onto the
 * note, and the item deleted as Delete does. Every block it holds that wasn't started comes off the calendar, earlier
 * today's too, since a note is never timed; one worked on stays as time worked. Returns the exact reverse.
 */
export async function saveAsNote(w: Writer, taskId: string, clock: Clock): Promise<PlanChange> {
  const task = await getRecord(w.sql, 'task', taskId);
  if (!task) throw new Error(`No task ${taskId}`);
  const id = noteId(taskId);
  // The attachments first, so the item's delete has none left to pass its expiry on to.
  const moved = await applyPlanChange(w, { writes: await moveAttachments(w, { task_id: taskId }, { memo_id: id, task_id: null }) });
  const closed = await closeTask(w, taskId, 'deleted', clock);
  const past = await w.sql.all<{ id: string }>(
    'SELECT id FROM time_block WHERE task_id = :id AND started_at IS NULL AND cancelled IS NOT 1 AND deleted_at IS NULL',
    { id: taskId },
  );
  const freed = await applyPlanChange(w, { writes: past.map((b): RecordWrite => ({ type: 'time_block', id: b.id, fields: { cancelled: true } })) });
  const made = await put(w, id, { ...clamped({ title: task.title, body: task.notes ?? null }), saved_on: today(clock), deleted_at: null }, clock);
  return { writes: [made, ...freed.writes, ...closed.writes, ...moved.writes] };
}

/** Saves a note's title and description as edited, cut to what the server takes. Returns the exact reverse. */
export async function editNote(w: Writer, id: string, fields: { title?: string; body?: string | null }): Promise<PlanChange> {
  return applyPlanChange(w, { writes: [{ type: 'memo', id, fields: clamped(fields) }] });
}

/**
 * Makes a note an Inbox item again, with its title and description as edited and its attachments, in one change that
 * deletes the note. Returns the new item and the exact reverse.
 */
export async function toTask(w: Writer, id: string, fields: { title: string; body: string | null }, clock: Clock): Promise<{ taskId: string; reverse: PlanChange }> {
  const taskId = await w.create('task', { kind: 'inbox', title: clampText(fields.title, MAX_TITLE), notes: clampBody(fields.body) });
  const reverse = await applyPlanChange(w, {
    writes: [...(await moveAttachments(w, { memo_id: id }, { task_id: taskId, memo_id: null })), { type: 'memo', id, fields: { deleted_at: nowInstant(clock) } }],
  });
  return { taskId, reverse: { writes: [...reverse.writes, { type: 'task', id: taskId, fields: { deleted_at: nowInstant(clock) } }] } };
}

/**
 * Deletes a note and its attachments in one change, with one time, so a restore knows which went with it. They expire
 * on their own deletes, which every app counts alike. Returns the exact reverse.
 */
export async function deleteNote(w: Writer, id: string, clock: Clock): Promise<PlanChange> {
  const deleted_at = nowInstant(clock);
  return applyPlanChange(w, { writes: [...(await moveAttachments(w, { memo_id: id }, { deleted_at })), { type: 'memo', id, fields: { deleted_at } }] });
}

/** Brings back a deleted note, with the attachments deleted with it. Returns the exact reverse. */
export async function restore(w: Writer, id: string): Promise<PlanChange> {
  const memo = await getRecord(w.sql, 'memo', id);
  if (!memo?.deleted_at) return { writes: [] };
  const rows = await w.sql.all<{ id: string }>('SELECT id FROM attachment WHERE memo_id = :id AND deleted_at = :at ORDER BY id', { id, at: memo.deleted_at });
  return applyPlanChange(w, {
    writes: [...rows.map(({ id: a }): RecordWrite => ({ type: 'attachment', id: a, fields: { deleted_at: null } })), { type: 'memo', id, fields: { deleted_at: null } }],
  });
}

/**
 * Text as search compares it, with where each of its characters came from in the text as written: decomposed, marks
 * dropped and lower-cased, so "emile" finds "Émile". In JavaScript, since none of the apps' SQLite builds can do this,
 * and LIKE ignores case only from A to Z.
 */
function fold(text: string): { folded: string; starts: number[]; ends: number[] } {
  let folded = '';
  const starts: number[] = [];
  const ends: number[] = [];
  let i = 0;
  for (const char of text) {
    const f = char.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    // A mark on its own belongs to the character before it.
    if (!f && ends.length) ends[ends.length - 1] = i + char.length;
    for (const c of f) {
      folded += c;
      for (let k = 0; k < c.length; k++) {
        starts.push(i);
        ends.push(i + char.length);
      }
    }
    i += char.length;
  }
  return { folded, starts, ends };
}

const folded = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** The notes whose title or description has the words searched for, ignoring case and accents. Nothing typed is all. */
export function searchNotes<T extends Pick<Memo, 'title' | 'body'>>(notes: readonly T[], query: string): T[] {
  const q = folded(query.trim());
  if (!q) return [...notes];
  return notes.filter((n) => folded(n.title).includes(q) || (!!n.body && folded(n.body).includes(q)));
}

/** Where a search matched in text as written, as [start, end) pairs, for the underline. */
export function foldMatches(text: string, query: string): [number, number][] {
  const q = folded(query.trim());
  if (!q) return [];
  const { folded: f, starts, ends } = fold(text);
  const out: [number, number][] = [];
  for (let at = f.indexOf(q); at >= 0; at = f.indexOf(q, at + q.length)) out.push([starts[at]!, ends[at + q.length - 1]!]);
  return out;
}

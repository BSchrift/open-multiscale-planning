import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { protocol } from '@multiscale/config';
import { parsePeriod } from '../../../config/retention';
import { sweepOrphans } from './attachments';
import { MAX_TITLE } from './captureTitle';
import { fixedClock, formatClock } from './clock';
import type { Db } from './db';
import { backfillExpiry } from './expiry';
import { clampText, deleteNote, editNote, foldMatches, homeOf, noteId, restore, saveAsNote, searchNotes, toTask } from './memos';
import { MAX_NOTES } from './notes';
import { applyPlanChange } from './plan';
import { applyRemote, getRecord, transact } from './records';
import { deletedNotes, memoAttachments, notesForDay, notesList, taskAttachments } from './queries';
import { configureRetention } from './retention';
import type { Retention } from './retention';
import { openTestDb } from '../platform/node-sqlite';

const NOW = '2026-11-17T15:00:00Z';
const policy: Retention = { scheduling: parsePeriod('P2Y'), closed: parsePeriod('P5Y'), deleted: parsePeriod('P30D') };
const clock = fixedClock(NOW);
const other = (iso: string) => formatClock({ wall: Date.parse(iso), counter: 0, device: 'other' });

let db: Db;
const row = async (id: string) => {
  const r = await db.get<{ data: string }>('SELECT data FROM records WHERE id = :id', { id });
  return r ? (JSON.parse(r.data) as Record<string, unknown>) : undefined;
};
const outbox = () => db.all<{ record_id: string; field: string }>('SELECT record_id, field FROM outbox ORDER BY record_id, field');
/** How many transactions an action took: each commit announces itself once. */
async function commits(fn: () => Promise<unknown>): Promise<number> {
  let n = 0;
  const stop = db.subscribe(() => n++);
  await fn();
  stop();
  return n;
}

beforeEach(async () => {
  db = await openTestDb();
  clock.set(NOW);
  configureRetention(policy);
  await transact(db, clock, async (w) => {
    await w.create('task', { kind: 'inbox', title: 'Paint for the hall: Pale Oat, eggshell', notes: 'From the tin in the garage.\n\nTwo coats.' }, 'paint');
    await w.create('attachment', { task_id: 'paint', kind: 'photo', name: 'Tin.jpg', size: 1000, type: 'image/jpeg', sha256: 'x' }, 'photo');
    await w.create('attachment', { task_id: 'paint', kind: 'link', name: 'example.com', url: 'https://example.com/oat' }, 'link');
    await w.create('task', { kind: 'inbox', title: 'Book the boiler service' }, 'boiler');
  });
});
afterEach(() => configureRetention(null));

describe('a note', () => {
  it("is an Inbox item's title, description and attachments, saved in one change that deletes the item", async () => {
    const before = { task: await row('paint'), photo: await row('photo'), link: await row('link') };
    let reverse = { writes: [] } as Awaited<ReturnType<typeof saveAsNote>>;
    expect(await commits(async () => (reverse = await transact(db, clock, (w) => saveAsNote(w, 'paint', clock))))).toBe(1);

    const id = noteId('paint');
    expect(await getRecord(db, 'memo', id)).toMatchObject({ title: 'Paint for the hall: Pale Oat, eggshell', body: 'From the tin in the garage.\n\nTwo coats.', saved_on: '2026-11-17', deleted_at: null });
    // Deleted, not finished: released apps name what an item became from a fixed list, and list finished ones as work done.
    expect(await getRecord(db, 'task', 'paint')).toMatchObject({ deleted_at: NOW });
    expect((await getRecord(db, 'task', 'paint'))!.done_at ?? null).toBeNull();
    expect(await memoAttachments(db, id)).toEqual([expect.objectContaining({ id: 'link', memo_id: id }), expect.objectContaining({ id: 'photo', memo_id: id })]);
    expect(await taskAttachments(db, 'paint')).toEqual([]);
    // Kept while the note lives, though the item they came from goes in 30 days.
    for (const a of ['photo', 'link']) expect((await row(a))!.expires_at ?? null).toBeNull();

    // Undo puts back exactly what was there, in one change, and leaves the note deleted.
    expect(await commits(() => transact(db, clock, (w) => applyPlanChange(w, reverse)))).toBe(1);
    const { expires_at: _t, ...task } = (await row('paint'))!;
    expect({ ...task, deleted_at: task.deleted_at ?? undefined }).toEqual({ ...before.task, deleted_at: undefined });
    expect(await taskAttachments(db, 'paint')).toHaveLength(2);
    for (const a of ['photo', 'link'] as const) expect({ ...(await row(a)), memo_id: undefined }).toEqual({ ...before[a], memo_id: undefined, task_id: 'paint' });
    expect((await getRecord(db, 'memo', id))?.deleted_at).toBe(NOW);
  });

  it("takes the item's blocks off the calendar in the same change, past and future, and its one Undo puts them back", async () => {
    await transact(db, clock, async (w) => {
      // Held for later today, held for earlier today and never started, and one worked on, which stays as time worked.
      await w.create('time_block', { task_id: 'boiler', start: '2026-11-17T17:00:00Z', end: '2026-11-17T17:30:00Z', tz: 'UTC' }, 'later');
      await w.create('time_block', { task_id: 'boiler', start: '2026-11-17T09:00:00Z', end: '2026-11-17T09:30:00Z', tz: 'UTC' }, 'missed');
      await w.create('time_block', { task_id: 'boiler', start: '2026-11-16T09:00:00Z', end: '2026-11-16T09:30:00Z', tz: 'UTC', started_at: '2026-11-16T09:00:00Z', ended_at: '2026-11-16T09:30:00Z' }, 'worked');
    });
    let reverse = { writes: [] } as Awaited<ReturnType<typeof saveAsNote>>;
    expect(await commits(async () => (reverse = await transact(db, clock, (w) => saveAsNote(w, 'boiler', clock))))).toBe(1);
    expect([(await row('later'))!.cancelled, (await row('missed'))!.cancelled, (await row('worked'))!.cancelled ?? null]).toEqual([true, true, null]);
    await transact(db, clock, (w) => applyPlanChange(w, reverse));
    expect([(await row('later'))!.cancelled, (await row('missed'))!.cancelled]).toEqual([null, null]);
  });

  it('is one note for one item, however often it is saved and undone, here or on another device', async () => {
    const first = await transact(db, clock, (w) => saveAsNote(w, 'paint', clock));
    await transact(db, clock, (w) => applyPlanChange(w, first));
    await transact(db, clock, (w) => saveAsNote(w, 'paint', clock));
    expect((await notesList(db)).map((n) => n.id)).toEqual([noteId('paint')]);
    expect(await deletedNotes(db)).toEqual([]);
  });

  it('takes what fits on the server, cut at a word', async () => {
    const long = `${'word '.repeat(MAX_NOTES / 5)}tail`;
    await transact(db, clock, (w) => w.set('task', 'boiler', { title: 'x'.repeat(MAX_TITLE + 10), notes: long }));
    await transact(db, clock, (w) => saveAsNote(w, 'boiler', clock));
    const note = (await getRecord(db, 'memo', noteId('boiler')))!;
    expect(note.title).toHaveLength(MAX_TITLE);
    expect(note.body!.length).toBeLessThanOrEqual(MAX_NOTES);
    expect(note.body!.endsWith('word')).toBe(true);
    // An edit is cut the same way.
    await transact(db, clock, (w) => editNote(w, noteId('boiler'), { title: 'Boiler', body: `${'é'.repeat(MAX_NOTES)}more` }));
    expect((await getRecord(db, 'memo', noteId('boiler')))!.body).toHaveLength(MAX_NOTES);
  });

  it("cuts on a word, never inside a character's two halves", () => {
    expect(clampText('one two three', 9)).toBe('one two');
    expect(clampText('abcdefghij', 5)).toBe('abcde');
    expect(clampText(`abcd${'🌲'}`, 5)).toBe('abcd');
    expect(clampText('short', 9)).toBe('short');
  });

  it("caps its title where the server does, the apps' own title cap", () => {
    expect(MAX_TITLE).toBe(protocol.records.maxTitleChars);
  });

  it('is deleted with its attachments in one change, and restored with them', async () => {
    await transact(db, clock, (w) => saveAsNote(w, 'paint', clock));
    const id = noteId('paint');
    // One removed on its own earlier stays removed after a restore.
    clock.set('2026-11-17T15:01:00Z');
    await transact(db, clock, (w) => w.delete('attachment', 'link'));
    clock.set('2026-11-17T15:02:00Z');
    let reverse = { writes: [] } as Awaited<ReturnType<typeof deleteNote>>;
    expect(await commits(async () => (reverse = await transact(db, clock, (w) => deleteNote(w, id, clock))))).toBe(1);
    expect((await row(id))!.expires_at).toBe('2026-12-17T15:02:00Z');
    expect((await row('photo'))!).toMatchObject({ deleted_at: '2026-11-17T15:02:00Z', expires_at: '2026-12-17T15:02:00Z' });
    expect(await notesList(db)).toEqual([]);
    expect((await deletedNotes(db)).map((n) => n.id)).toEqual([id]);

    // The toast's Undo.
    await transact(db, clock, (w) => applyPlanChange(w, reverse));
    expect((await notesList(db)).map((n) => n.id)).toEqual([id]);
    expect((await row('photo'))!.deleted_at).toBeNull();

    // Recently deleted's Restore, days later.
    await transact(db, clock, (w) => deleteNote(w, id, clock));
    clock.set('2026-11-20T09:00:00Z');
    await transact(db, clock, (w) => restore(w, id));
    expect(await notesList(db)).toEqual([expect.objectContaining({ id, photos: 1, links: 0, files: 0 })]);
    expect((await row('photo'))!).toMatchObject({ deleted_at: null, expires_at: null });
    expect((await row('link'))!.deleted_at).toBe('2026-11-17T15:01:00Z');
  });

  it('becomes an Inbox item with what was edited and its attachments, in one change, with one Undo', async () => {
    await transact(db, clock, (w) => saveAsNote(w, 'paint', clock));
    const id = noteId('paint');
    let made = { taskId: '', reverse: { writes: [] } } as Awaited<ReturnType<typeof toTask>>;
    expect(await commits(async () => (made = await transact(db, clock, (w) => toTask(w, id, { title: 'Buy Pale Oat paint', body: 'Two coats' }, clock))))).toBe(1);
    expect(made.taskId).not.toBe('paint');
    expect(await getRecord(db, 'task', made.taskId)).toMatchObject({ kind: 'inbox', title: 'Buy Pale Oat paint', notes: 'Two coats' });
    expect((await getRecord(db, 'task', made.taskId))!.deleted_at ?? null).toBeNull();
    expect((await taskAttachments(db, made.taskId)).map((a) => a.id)).toEqual(['link', 'photo']);
    for (const a of ['photo', 'link']) expect([(await row(a))!.memo_id, (await row(a))!.expires_at ?? null]).toEqual([null, null]);
    expect((await getRecord(db, 'memo', id))!.deleted_at).toBe(NOW);
    // It went through Process as a note, so Recently deleted can bring the note back.
    expect((await deletedNotes(db)).map((n) => n.id)).toEqual([id]);

    await transact(db, clock, (w) => applyPlanChange(w, made.reverse));
    expect((await getRecord(db, 'task', made.taskId))!.deleted_at).toBe(NOW);
    expect((await memoAttachments(db, id)).map((a) => a.id)).toEqual(['link', 'photo']);
    expect((await getRecord(db, 'memo', id))!).toMatchObject({ title: 'Paint for the hall: Pale Oat, eggshell', deleted_at: null });
  });

  it('keeps an edit that landed on it after another device made it a task, for Recently deleted to bring back', async () => {
    await transact(db, clock, (w) => saveAsNote(w, 'paint', clock));
    const id = noteId('paint');
    // This device makes it a task; another, offline, renames the note.
    await transact(db, clock, (w) => toTask(w, id, { title: 'Paint for the hall: Pale Oat, eggshell', body: null }, clock));
    await applyRemote(db, [{ type: 'memo', id, fields: { title: { v: 'Hall paint: Pale Oat', c: other('2026-11-17T16:00:00Z') } } }]);
    expect(await notesList(db)).toEqual([]);
    clock.set('2026-11-18T09:00:00Z');
    await transact(db, clock, (w) => restore(w, id));
    expect((await notesList(db)).map((n) => n.title)).toEqual(['Hall paint: Pale Oat']);
  });
});

describe("a note's home and day", () => {
  beforeEach(async () => {
    await transact(db, clock, async (w) => {
      await w.create('objective', { title: 'Home', state: 'active' }, 'g1');
      await w.create('project', { objective_id: 'g1', title: 'Kitchen redo', state: 'active', start: '2026-11-01', end: '2026-12-31' }, 'p1');
    });
  });

  it('is saved with its home in the one change, and Undo takes both back', async () => {
    const reverse = await transact(db, clock, (w) => saveAsNote(w, 'paint', clock, { type: 'project', id: 'p1' }));
    expect((await getRecord(db, 'memo', noteId('paint')))?.home).toEqual({ type: 'project', id: 'p1' });
    await transact(db, clock, (w) => applyPlanChange(w, reverse));
    expect((await getRecord(db, 'memo', noteId('paint')))?.deleted_at).toBe(NOW);
    // Saved again on its own, it has no home.
    await transact(db, clock, (w) => saveAsNote(w, 'paint', clock, null));
    expect((await getRecord(db, 'memo', noteId('paint')))?.home).toBeNull();
  });

  it('moves to another home, and takes a day to show on Today, only as edited', async () => {
    await transact(db, clock, (w) => saveAsNote(w, 'paint', clock));
    const reverse = await transact(db, clock, (w) => editNote(w, noteId('paint'), { home: { type: 'objective', id: 'g1' }, show_on: '2026-11-20' }));
    expect(await getRecord(db, 'memo', noteId('paint'))).toMatchObject({ home: { type: 'objective', id: 'g1' }, show_on: '2026-11-20' });
    expect((await notesForDay(db, '2026-11-20')).map((n) => n.id)).toEqual([noteId('paint')]);
    expect(await notesForDay(db, '2026-11-21')).toEqual([]);
    await transact(db, clock, (w) => applyPlanChange(w, reverse));
    expect(await getRecord(db, 'memo', noteId('paint'))).toMatchObject({ home: null, show_on: null });
  });

  it('reads a home of another type, or one that has gone, as no home', async () => {
    const homes = { objective: new Set(['g1']), project: new Set(['p1']), practice: new Set<string>() };
    expect(homeOf({ home: { type: 'project', id: 'p1' } }, homes)).toEqual({ type: 'project', id: 'p1' });
    expect(homeOf({ home: { type: 'project', id: 'gone' } }, homes)).toBeNull();
    expect(homeOf({ home: { type: 'person', id: 'p1' } as never }, homes)).toBeNull();
    expect(homeOf({ home: 'p1' as never }, homes)).toBeNull();
    expect(homeOf({}, homes)).toBeNull();
  });
});

describe('the notes list', () => {
  it('lists live notes newest first with what each holds, and Recently deleted apart, leaving out a save that was undone', async () => {
    await transact(db, clock, (w) => saveAsNote(w, 'paint', clock));
    clock.set('2026-11-18T09:00:00Z');
    const undone = await transact(db, clock, (w) => saveAsNote(w, 'boiler', clock));
    expect((await notesList(db)).map((n) => [n.id, n.saved_on, n.photos, n.links])).toEqual([
      [noteId('boiler'), '2026-11-18', 0, 0],
      [noteId('paint'), '2026-11-17', 1, 1],
    ]);
    await transact(db, clock, (w) => applyPlanChange(w, undone));
    expect((await notesList(db)).map((n) => n.id)).toEqual([noteId('paint')]);
    expect(await deletedNotes(db)).toEqual([]);
  });

  it('finds words in titles and descriptions, ignoring case and accents', () => {
    const notes = [
      { id: 'a', title: 'Émile’s café', body: null },
      { id: 'b', title: 'Bike tyres', body: '700x28c, 85 psi' },
      { id: 'c', title: 'Gate code', body: 'Ask EMILE for the new one' },
    ];
    expect(searchNotes(notes, 'emile').map((n) => n.id)).toEqual(['a', 'c']);
    expect(searchNotes(notes, 'CAFE').map((n) => n.id)).toEqual(['a']);
    expect(searchNotes(notes, '85 PSI').map((n) => n.id)).toEqual(['b']);
    expect(searchNotes(notes, '  ').map((n) => n.id)).toEqual(['a', 'b', 'c']);
    expect(searchNotes(notes, 'nothing')).toEqual([]);
  });

  it('says where a search matched in the text as written, for the underline', () => {
    expect(foldMatches('Émile’s café', 'emile')).toEqual([[0, 5]]);
    expect(foldMatches('Cafe or CAFÉ', 'café')).toEqual([[0, 4], [8, 12]]);
    // Accents typed as separate marks, as NFD text has them.
    expect(foldMatches('E\u0301mile', 'emile')).toEqual([[0, 6]]);
    expect(foldMatches('Bike', '')).toEqual([]);
  });
});

describe('orphaned attachments', () => {
  const settled = '2026-11-15T15:00:00Z';

  it("deletes a photo another device added to a note this one deleted, with the note's delete, so every app expires it alike", async () => {
    await transact(db, clock, (w) => saveAsNote(w, 'paint', clock));
    const id = noteId('paint');
    await transact(db, clock, (w) => deleteNote(w, id, clock));
    // The other device, offline, added a photo before it heard of the delete.
    await applyRemote(db, [{ type: 'attachment', id: 'late', fields: { memo_id: { v: id, c: other('2026-11-17T16:00:00Z') }, kind: { v: 'photo', c: other('2026-11-17T16:00:00Z') }, name: { v: 'Lid.jpg', c: other('2026-11-17T16:00:00Z') } } }]);
    expect((await row('late'))!.deleted_at).toBeUndefined();

    expect(await sweepOrphans(db, clock)).toBe(1);
    expect((await row('late'))!).toMatchObject({ deleted_at: NOW, expires_at: '2026-12-17T15:00:00Z' });
    expect((await outbox()).filter((o) => o.record_id === 'late').map((o) => o.field)).toEqual(['deleted_at', 'expires_at']);
    // Restoring the note brings it back with the rest.
    await transact(db, clock, (w) => restore(w, id));
    expect((await row('late'))!.deleted_at).toBeNull();
    expect(await sweepOrphans(db, clock)).toBe(0);
  });

  it("leaves a photo restored on another device whose note's restore hasn't arrived yet", async () => {
    await transact(db, clock, (w) => saveAsNote(w, 'paint', clock));
    const id = noteId('paint');
    await transact(db, clock, (w) => deleteNote(w, id, clock));
    await applyRemote(db, [{ type: 'attachment', id: 'photo', fields: { deleted_at: { v: null, c: other('2026-11-17T16:00:00Z') } } }]);
    expect(await sweepOrphans(db, clock)).toBe(0);
  });

  it("deletes one naming a note that's gone, once it was put there long enough ago for the note to have arrived", async () => {
    await applyRemote(db, [
      { type: 'attachment', id: 'old', fields: { memo_id: { v: 'note:gone', c: other('2026-11-01T00:00:00Z') }, kind: { v: 'link', c: other('2026-11-01T00:00:00Z') } } },
      // Just put on a note whose own record may still be on its way, as when one push splits.
      { type: 'attachment', id: 'new', fields: { memo_id: { v: 'note:coming', c: other(NOW) }, kind: { v: 'link', c: other(NOW) } } },
      // On a task, whatever note it names.
      { type: 'attachment', id: 'task', fields: { task_id: { v: 'boiler', c: other(settled) }, memo_id: { v: 'note:gone', c: other('2026-11-01T00:00:00Z') } } },
    ]);
    expect(await sweepOrphans(db, clock)).toBe(1);
    expect((await row('old'))!.deleted_at).toBe(NOW);
    expect((await row('new'))!.deleted_at).toBeUndefined();
    expect((await row('task'))!.deleted_at).toBeUndefined();
    expect(await sweepOrphans(db, clock)).toBe(0);
  });

  it("gives a released app's launch nothing to write for notes, their attachments or a swept photo", async () => {
    await transact(db, clock, (w) => saveAsNote(w, 'paint', clock));
    await transact(db, clock, (w) => saveAsNote(w, 'boiler', clock));
    await transact(db, clock, (w) => deleteNote(w, noteId('boiler'), clock));
    await applyRemote(db, [{ type: 'attachment', id: 'late', fields: { memo_id: { v: noteId('boiler'), c: other('2026-11-17T16:00:00Z') } } }]);
    await sweepOrphans(db, clock);
    await db.run('DELETE FROM outbox');
    expect(await backfillExpiry(db, clock)).toBe(0);
    expect(await outbox()).toEqual([]);
  });
});

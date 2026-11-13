import { describe, expect, it } from 'vitest';
import { answerBlocks } from './blocks';
import { fixedClock } from './clock';
import { toInstant } from './dates';
import { doneOn, loadDone } from './done';
import type { DoneDay, DoneRecords } from './done';
import { openDb } from './db';
import type { BlockRow } from './queries';
import { outcomeId, transact } from './records';
import { tickOneOff } from './tasks';
import type { Milestone, Project, Task, TaskCompletion } from './types';
import { nodeSqliteDriver } from '../platform/node-sqlite';

const ZONE = 'America/Chicago';
// Thursday, Nov 12, at 5:40pm in Chicago, as the mockups have it.
const clock = fixedClock('2026-11-12T23:40:00Z', ZONE);
/** A Chicago wall time in November, six hours behind UTC, as an instant. */
const at = (day: number, time: string) => {
  const [h, m] = time.split(':').map(Number);
  return toInstant(Date.UTC(2026, 10, day, h! + 6, m!));
};

const project = (id: string, title: string): Project => ({ id, title, state: 'active', start: '2026-10-01', end: '2026-12-31' });
const task = (id: string, title: string, fields: Partial<Task> = {}): Task => ({ id, kind: 'project', title, ...fields });
const completion = (id: string, task_id: string, done_at: string, fields: Partial<TaskCompletion> = {}): TaskCompletion => ({ id, task_id, done_at, ...fields });
function block(id: string, day: number, from: string, to: string, fields: Partial<BlockRow> = {}): BlockRow {
  return {
    id,
    start: at(day, from),
    end: at(day, to),
    tz: ZONE,
    task_id: null,
    practice_id: null,
    started_at: null,
    ended_at: null,
    paused_at: null,
    paused_min: null,
    title: null,
    task_kind: null,
    result: null,
    remaining_min: null,
    logged_min: null,
    ...fields,
  };
}

/** The mockups' sample day, Thursday Nov 12, with a little of the days around it. */
function sample(): DoneRecords {
  const weekly = { type: 'recurring' as const, every: 1, unit: 'week' as const, anchor: '2026-10-05' };
  return {
    projects: [project('p1', 'Write the report'), project('p2', 'Website refresh')],
    milestones: [{ id: 'm1', project_id: 'p1', title: 'Draft chapters' } satisfies Milestone],
    tasks: [
      task('review', 'Review chapter 2 notes', { project_id: 'p1', milestone_id: 'm1', done_at: at(11, '15:00') }),
      task('summary', 'Draft the summary', { project_id: 'p1', milestone_id: 'm1', done_at: at(12, '10:30') }),
      task('outline', 'Outline chapter 3', { project_id: 'p1', estimate_min: 240, remaining_min: 60 }),
      task('water', 'Pay the water bill', { kind: 'one_off', done_at: at(12, '13:30') }),
      task('plants', 'Water the plants', { kind: 'one_off', schedule: weekly, next_due: '2026-11-19' }),
      task('plan', 'Plan next week', { kind: 'planning', done_at: at(12, '14:30') }),
      task('login', 'Fix the login redirect', { project_id: 'p2' }),
      task('insurer', 'Call the insurer', { kind: 'one_off' }),
      task('kitchen', 'Kitchen refit', { kind: 'inbox', done_at: at(12, '08:45'), became: { type: 'project', id: 'p9' } }),
    ],
    completions: [
      completion('c-water', 'water', at(12, '13:30')),
      completion('c-plants', 'plants', at(12, '16:52')),
      completion('c-plants-tue', 'plants', at(10, '09:00')),
      completion('c-plants-undone', 'plants', at(12, '07:00'), { deleted_at: at(12, '07:01') }),
      completion('c-kitchen', 'kitchen', at(12, '08:45')),
    ],
    blocks: [
      block('piano', 12, '08:30', '09:00', { practice_id: 'pr', title: 'Piano practice', result: 'done', logged_min: 30 }),
      block('b-summary', 12, '09:00', '10:30', { task_id: 'summary', title: 'Draft the summary', task_kind: 'project', result: 'done' }),
      block('b-outline', 12, '11:00', '12:30', { task_id: 'outline', title: 'Outline chapter 3', task_kind: 'project', result: 'partly', remaining_min: 60 }),
      block('b-water', 12, '13:00', '13:30', { task_id: 'water', title: 'Pay the water bill', task_kind: 'one_off', result: 'done' }),
      block('b-plan', 12, '14:00', '14:30', { task_id: 'plan', title: 'Plan next week', task_kind: 'planning', result: 'done' }),
      block('b-login', 12, '15:30', '16:30', { task_id: 'login', title: 'Fix the login redirect', task_kind: 'project' }),
      block('b-insurer', 12, '16:30', '17:00', { task_id: 'insurer', title: 'Call the insurer', task_kind: 'one_off', result: 'not' }),
      block('running', 12, '18:00', '18:30', { practice_id: 'run', title: 'Running' }),
    ],
  };
}

const finished = (day: DoneDay) => day.finished.map((f) => f.title);
const worked = (day: DoneDay) => day.worked.map((w) => w.block.title);

describe('a day’s done list', () => {
  it('reads the mockups’ sample day: what was finished, time worked, and what is waiting for an answer', () => {
    const day = doneOn('2026-11-12', sample(), clock);
    expect(finished(day)).toEqual(['Draft the summary', 'Draft chapters', 'Pay the water bill', 'Water the plants']);
    expect(worked(day)).toEqual(['Piano practice', 'Outline chapter 3', 'Plan next week']);
    expect(day.unmarked.map((u) => u.block.title)).toEqual(['Fix the login redirect']);
    expect(day.total).toEqual({ finished: 4, worked_min: 270, by_kind: { project: 180, practice: 30, one_off: 30, planning: 30 } });
  });

  it('lists a project task’s finish with its project and milestone, and the block it came from under it rather than twice', () => {
    const summary = doneOn('2026-11-12', sample(), clock).finished[0]!;
    expect(summary).toMatchObject({ type: 'task', task_id: 'summary', kind: 'project', project: 'Write the report', milestone: 'Draft chapters', at: at(12, '10:30'), deleted: false });
    expect(summary.work.map((w) => [w.block.id, w.minutes])).toEqual([['b-summary', 90]]);
  });

  it('lists a one-time one off once, from its completion, though the task keeps its finish too', () => {
    const day = doneOn('2026-11-12', sample(), clock);
    const water = day.finished.filter((f) => f.task_id === 'water');
    expect(water).toHaveLength(1);
    expect(water[0]).toMatchObject({ id: 'c-water', kind: 'one_off', project: null, at: at(12, '13:30') });
    expect(water[0]!.work.map((w) => w.block.id)).toEqual(['b-water']);
  });

  it('lists a task finished without any block, with no time worked', () => {
    const plants = doneOn('2026-11-12', sample(), clock).finished.find((f) => f.task_id === 'plants')!;
    expect(plants.work).toEqual([]);
  });

  it('gives a repeating one off an entry on each day it was finished, and none for a finish taken back', () => {
    expect(doneOn('2026-11-10', sample(), clock).finished.map((f) => [f.id, f.at])).toEqual([['c-plants-tue', at(10, '09:00')]]);
    expect(doneOn('2026-11-12', sample(), clock).finished.map((f) => f.id)).not.toContain('c-plants-undone');
  });

  it('counts a block answered Partly as time worked, with the time still left', () => {
    const outline = doneOn('2026-11-12', sample(), clock).worked.find((w) => w.block.id === 'b-outline')!;
    expect(outline).toMatchObject({ kind: 'project', project: 'Write the report', minutes: 90, left: 60 });
  });

  it('counts a practice’s logged minutes, and leaves out a practice logged as 0', () => {
    const records = sample();
    records.blocks.push(block('piano-skipped', 12, '07:00', '07:30', { practice_id: 'pr', title: 'Piano practice', result: 'not', logged_min: 0 }));
    records.blocks[0] = { ...records.blocks[0]!, logged_min: 20 };
    const day = doneOn('2026-11-12', records, clock);
    expect(day.worked.filter((w) => w.kind === 'practice').map((w) => [w.block.id, w.minutes])).toEqual([['piano', 20]]);
  });

  it('counts a planning block’s time, but not planning as something finished', () => {
    const day = doneOn('2026-11-12', sample(), clock);
    expect(day.worked.find((w) => w.block.id === 'b-plan')).toMatchObject({ kind: 'planning', minutes: 30 });
    expect(day.finished.map((f) => f.task_id)).not.toContain('plan');
  });

  it('reaches a milestone when the last of its tasks is finished, or when it was marked met', () => {
    const records = sample();
    const day = doneOn('2026-11-12', records, clock);
    expect(day.finished[1]).toMatchObject({ type: 'milestone', id: 'm1', title: 'Draft chapters', project: 'Write the report', at: at(12, '10:30') });
    // Marked met with no tasks of its own.
    records.milestones.push({ id: 'm2', project_id: 'p2', title: 'Launch beta', met_at: at(12, '12:00') });
    // All its tasks done but dropped: not reached.
    records.milestones.push({ id: 'm3', project_id: 'p1', title: 'Dropped one', dropped_at: at(12, '09:00') });
    records.tasks.push(task('in-m3', 'Done under a dropped milestone', { project_id: 'p1', milestone_id: 'm3', done_at: at(12, '08:00') }));
    expect(doneOn('2026-11-12', records, clock).finished.filter((f) => f.type === 'milestone').map((f) => f.title)).toEqual(['Draft chapters', 'Launch beta']);
  });

  it('leaves out blocks answered Not done, Inbox items sorted into something else, and blocks not over yet', () => {
    const day = doneOn('2026-11-12', sample(), clock);
    const titles = [...finished(day), ...worked(day), ...day.unmarked.map((u) => u.block.title)];
    expect(titles).not.toContain('Call the insurer');
    expect(titles).not.toContain('Kitchen refit');
    expect(titles).not.toContain('Running');
  });

  it('lists a block that ended with no answer apart, until it is answered', () => {
    const records = sample();
    expect(doneOn('2026-11-12', records, clock).unmarked[0]).toMatchObject({ kind: 'project', project: 'Website refresh' });
    // A planning block asks nothing, and a practice from an earlier day just passes.
    records.blocks.push(block('plan-open', 12, '07:00', '07:30', { task_id: 'plan', title: 'Plan next week', task_kind: 'planning' }));
    records.blocks.push(block('piano-wed', 11, '08:30', '09:00', { practice_id: 'pr', title: 'Piano practice' }));
    records.blocks.push(block('piano-thu', 12, '07:30', '08:00', { practice_id: 'pr', title: 'Piano practice' }));
    expect(doneOn('2026-11-12', records, clock).unmarked.map((u) => u.block.id)).toEqual(['piano-thu', 'b-login']);
    expect(doneOn('2026-11-11', records, clock).unmarked).toEqual([]);
    records.blocks = records.blocks.map((b) => (b.id === 'b-login' ? { ...b, result: 'partly', remaining_min: 30 } : b));
    const answered = doneOn('2026-11-12', records, clock);
    expect(answered.unmarked.map((u) => u.block.id)).toEqual(['piano-thu']);
    expect(worked(answered)).toContain('Fix the login redirect');
  });

  it('puts a block answered late on the day it happened', () => {
    const records = sample();
    records.tasks.push(task('late', 'Fix the date picker', { project_id: 'p2', done_at: at(11, '11:30') }));
    records.blocks.push(block('b-late', 11, '10:00', '11:30', { task_id: 'late', title: 'Fix the date picker', task_kind: 'project', result: 'done' }));
    const wed = doneOn('2026-11-11', records, clock);
    expect(wed.finished.find((f) => f.task_id === 'late')!.work.map((w) => w.block.id)).toEqual(['b-late']);
    expect(doneOn('2026-11-12', records, clock).finished.map((f) => f.task_id)).not.toContain('late');
  });

  it('takes a block’s zone for a finish that came from it, either side of midnight there', () => {
    const records = sample();
    // 11:50pm on Thursday in Los Angeles, 1:50am on Friday in Chicago.
    records.tasks.push(task('la', 'Draft the keynote', { project_id: 'p1', done_at: '2026-11-13T07:50:00Z' }));
    records.blocks.push({ ...block('b-la', 12, '00:00', '00:00', { task_id: 'la', title: 'Draft the keynote', task_kind: 'project', result: 'done' }), start: '2026-11-13T06:50:00Z', end: '2026-11-13T07:50:00Z', tz: 'America/Los_Angeles' });
    // 12:10am on Friday in Tokyo, 9:10am on Thursday in Chicago.
    records.tasks.push(task('tokyo', 'Rehearse the demo', { project_id: 'p1', done_at: '2026-11-12T15:10:00Z' }));
    records.blocks.push({ ...block('b-tokyo', 12, '00:00', '00:00', { task_id: 'tokyo', title: 'Rehearse the demo', task_kind: 'project', result: 'done' }), start: '2026-11-12T14:30:00Z', end: '2026-11-12T15:10:00Z', tz: 'Asia/Tokyo' });
    const thu = doneOn('2026-11-12', records, clock);
    const fri = doneOn('2026-11-13', records, clock);
    expect(thu.finished.find((f) => f.task_id === 'la')).toMatchObject({ zone: 'America/Los_Angeles' });
    expect(thu.finished.map((f) => f.task_id)).not.toContain('tokyo');
    expect(fri.finished.find((f) => f.task_id === 'tokyo')).toMatchObject({ zone: 'Asia/Tokyo' });
    expect(fri.finished.map((f) => f.task_id)).not.toContain('la');
    // Each block's time counts on the day it started, in its own zone.
    expect(thu.worked.map((w) => w.block.id)).toContain('b-tokyo');
  });

  it('puts every other finish on its day in this device’s zone, either side of midnight', () => {
    const records = sample();
    records.tasks.push(task('late-night', 'Book the train', { kind: 'one_off', done_at: at(12, '23:59') }));
    records.completions.push(completion('c-late-night', 'late-night', at(12, '23:59')));
    records.tasks.push(task('early', 'Renew the domain', { kind: 'one_off', done_at: at(13, '00:01') }));
    records.completions.push(completion('c-early', 'early', at(13, '00:01')));
    expect(doneOn('2026-11-12', records, clock).finished.map((f) => f.task_id)).toContain('late-night');
    expect(doneOn('2026-11-12', records, clock).finished.map((f) => f.task_id)).not.toContain('early');
    expect(doneOn('2026-11-13', records, clock).finished.map((f) => f.task_id)).toEqual(['early']);
  });

  it('marks a task deleted since while its tombstone lasts, and leaves it out with its blocks once that has gone', () => {
    const records = sample();
    records.tasks.push(task('landlord', 'Email the landlord', { kind: 'one_off', done_at: at(11, '18:10'), deleted_at: at(12, '09:00') }));
    records.completions.push(completion('c-landlord', 'landlord', at(11, '18:10')));
    records.tasks.push(task('staging', 'Set up the staging build', { project_id: 'p2', deleted_at: at(12, '09:00') }));
    records.blocks.push(block('b-staging', 11, '16:30', '17:30', { task_id: 'staging', title: 'Set up the staging build', task_kind: 'project', result: 'partly', remaining_min: 45 }));
    const wed = doneOn('2026-11-11', records, clock);
    expect(wed.finished.find((f) => f.task_id === 'landlord')).toMatchObject({ deleted: true });
    expect(wed.worked.find((w) => w.block.id === 'b-staging')).toMatchObject({ deleted: true, left: 45 });

    // 30 days on, the tombstones have expired: their completion and block stay a while, but name nothing.
    records.tasks = records.tasks.filter((t) => t.id !== 'landlord' && t.id !== 'staging');
    const later = doneOn('2026-11-11', records, clock);
    expect(later.finished.map((f) => f.task_id)).not.toContain('landlord');
    expect(later.worked.map((w) => w.block.id)).not.toContain('b-staging');
  });

  it('takes a finish back off the list when it is unfinished or undone', () => {
    const records = sample();
    records.tasks = records.tasks.map((t) => (t.id === 'summary' ? { ...t, done_at: null } : t));
    records.completions = records.completions.map((c) => (c.id === 'c-water' ? { ...c, deleted_at: at(12, '13:31') } : c));
    records.tasks = records.tasks.map((t) => (t.id === 'water' ? { ...t, done_at: null } : t));
    const day = doneOn('2026-11-12', records, clock);
    expect(finished(day)).toEqual(['Water the plants']);
    // Their blocks' time still counts.
    expect(worked(day)).toEqual(['Piano practice', 'Draft the summary', 'Outline chapter 3', 'Pay the water bill', 'Plan next week']);
  });

  it('opens an empty day as an empty list', () => {
    expect(doneOn('2026-11-08', sample(), clock)).toEqual({
      date: '2026-11-08',
      finished: [],
      worked: [],
      unmarked: [],
      total: { finished: 0, worked_min: 0, by_kind: { project: 0, practice: 0, one_off: 0, planning: 0 } },
    });
  });
});

describe('loading what a day’s list reads', () => {
  async function seeded() {
    const db = await openDb(nodeSqliteDriver());
    await transact(db, clock, async (w) => {
      await w.create('project', { title: 'Write the report', state: 'active', start: '2026-10-01', end: '2026-12-31' }, 'p1');
      await w.create('milestone', { project_id: 'p1', title: 'Draft chapters' }, 'm1');
      await w.create('task', { kind: 'project', project_id: 'p1', milestone_id: 'm1', title: 'Review chapter 2 notes', done_at: at(5, '15:00') }, 'review');
      await w.create('task', { kind: 'project', project_id: 'p1', milestone_id: 'm1', title: 'Draft the summary', estimate_min: 90 }, 'summary');
      await w.create('task', { kind: 'project', project_id: 'p1', title: 'Finished last week', done_at: at(5, '10:00') }, 'old');
      await w.create('task', { kind: 'one_off', title: 'Email the landlord', deleted_at: at(12, '09:00') }, 'landlord');
      await w.create('task_completion', { task_id: 'landlord', done_at: at(12, '08:00') }, 'c-landlord');
      await w.create('time_block', { task_id: 'summary', start: at(12, '09:00'), end: at(12, '10:30'), tz: ZONE }, 'b-summary');
      await w.create('time_block', { task_id: 'summary', start: at(5, '09:00'), end: at(5, '10:00'), tz: ZONE }, 'b-old');
      await w.create('time_block', { task_id: 'summary', start: at(12, '11:00'), end: at(12, '12:00'), tz: ZONE, cancelled: true }, 'b-cancelled');
    });
    return db;
  }

  it('reads the day’s blocks, finishes and milestones, with the tasks and projects they name, deleted ones too', async () => {
    const db = await seeded();
    await transact(db, clock, (w) => answerBlocks(w, [{ blockId: 'b-summary', answer: { result: 'done' } }], clock));
    const records = await loadDone(db, clock, '2026-11-12');
    expect(records.blocks.map((b) => b.id)).toEqual(['b-summary']);
    expect(records.completions.map((c) => c.id)).toEqual(['c-landlord']);
    // The day's finishes, those its blocks and completions name, and the rest of a milestone's tasks.
    expect(records.tasks.map((t) => t.id).sort()).toEqual(['landlord', 'old', 'review', 'summary']);
    expect(records.projects.map((p) => p.id)).toEqual(['p1']);
    expect(records.milestones.map((m) => m.id)).toEqual(['m1']);

    const day = doneOn('2026-11-12', records, clock);
    expect(day.finished.map((f) => [f.title, f.at, f.deleted])).toEqual([
      ['Email the landlord', at(12, '08:00'), true],
      ['Draft the summary', at(12, '10:30'), false],
      ['Draft chapters', at(12, '10:30'), false],
    ]);
    expect(day.total.worked_min).toBe(90);
  });

  it('reads nothing from a day with nothing on it', async () => {
    const db = await seeded();
    expect(await loadDone(db, clock, '2026-11-08')).toEqual({ blocks: [], tasks: [], completions: [], milestones: [], projects: [] });
  });

  it('reads a week at once, which gives each day its list', async () => {
    const db = await seeded();
    const records = await loadDone(db, clock, '2026-11-02', '2026-11-08');
    expect(doneOn('2026-11-05', records, clock).finished.map((f) => f.title)).toEqual(['Finished last week', 'Review chapter 2 notes']);
    expect(doneOn('2026-11-05', records, clock).worked.map((w) => w.block.id)).toEqual([]);
    expect(doneOn('2026-11-05', records, clock).unmarked.map((u) => u.block.id)).toEqual(['b-old']);
  });

  it('puts a repeating one off finished from a block in a zone it was travelling in on that zone’s day', async () => {
    const db = await openDb(nodeSqliteDriver());
    const weekly = { type: 'recurring', every: 1, unit: 'week', anchor: '2026-10-05' } as const;
    await transact(db, clock, async (w) => {
      await w.create('task', { kind: 'one_off', title: 'Water the plants', schedule: weekly, next_due: '2026-11-12' }, 'plants');
      // 11:30pm Thursday to 12:10am Friday in Tokyo: Thursday morning in Chicago.
      await w.create('time_block', { task_id: 'plants', start: '2026-11-12T14:30:00Z', end: '2026-11-12T15:10:00Z', tz: 'Asia/Tokyo' }, 'b');
    });
    await transact(db, clock, (w) => answerBlocks(w, [{ blockId: 'b', answer: { result: 'done' } }], clock));
    const records = await loadDone(db, clock, '2026-11-12', '2026-11-13');
    expect(doneOn('2026-11-13', records, clock).finished.map((f) => [f.title, f.zone])).toEqual([['Water the plants', 'Asia/Tokyo']]);
    expect(doneOn('2026-11-12', records, clock).finished).toEqual([]);
    // Ticked by hand afterwards, back in Chicago, on Thursday evening there.
    await transact(db, clock, (w) => tickOneOff(w, 'plants', clock, at(12, '17:00')));
    expect(doneOn('2026-11-12', await loadDone(db, clock, '2026-11-12'), clock).finished.map((f) => [f.title, f.zone])).toEqual([['Water the plants', ZONE]]);
    expect(await db.get('SELECT result FROM block_outcome WHERE id = :id', { id: outcomeId('b') })).toEqual({ result: 'done' });
  });
});

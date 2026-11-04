import { describe, expect, it } from 'vitest';
import { openTestDb } from '../platform/node-sqlite';
import { answerBlock } from './blocks';
import { fixedClock } from './clock';
import { applyPlanChange, oneOffCandidates } from './plan';
import { needsNewTime } from './queries';
import type { BlockRow, QueueRow } from './queries';
import {
  applyShift,
  blockConflicts,
  busyEvents,
  deleteWork,
  isAway,
  keepWork,
  queueItems,
  returnMissedBlocks,
  shiftRestOfToday,
  welcomeBack,
  welcomeOptions,
} from './queue';
import { DEFAULT_SETTINGS, getRecord, listRecords, outcomeId, transact } from './records';
import type { Writer } from './records';
import type { AwayPeriod, CalendarEvent, CalendarSource, CalendarState, Milestone, Project, Task, WeekPick, WeekPlan } from './types';

const row = (over: Partial<QueueRow> = {}): QueueRow => ({
  id: 't1',
  title: 'Write the report',
  kind: 'project',
  project_id: 'p1',
  block_id: 'b1',
  block_start: '2026-11-02T17:00:00Z',
  block_end: '2026-11-02T18:00:00Z',
  answered_at: '2026-11-02T18:00:00Z',
  result: 'not',
  remaining_min: null,
  ...over,
});

const plan = (week_start: string, finished_at: string | null): WeekPlan => ({ id: `week:${week_start}`, week_start, finished_at });
const pick = (week_start: string, task_id: string, over: Partial<WeekPick> = {}): WeekPick => ({
  id: `pick:${week_start}:${task_id}`,
  week_start,
  task_id,
  minutes: 60,
  ...over,
});

describe('Needs a new time', () => {
  const clock = fixedClock('2026-11-02T20:00:00Z');

  it('comes from records, carrying what the row needs, and stops once another block is placed', async () => {
    const db = await openTestDb();
    await transact(db, clock, async (w) => {
      await w.create('task', { kind: 'one_off', title: 'Paint the fence' }, 't1');
      await w.create('time_block', { task_id: 't1', start: '2026-11-02T17:00:00Z', end: '2026-11-02T18:00:00Z', tz: 'UTC' }, 'b1');
      await w.create('block_outcome', { result: 'partly', remaining_min: 30, answered_at: '2026-11-02T18:00:00Z' }, outcomeId('b1'));
    });
    const rows = await needsNewTime(db);
    expect(rows[0]).toMatchObject({ block_start: '2026-11-02T17:00:00Z', block_end: '2026-11-02T18:00:00Z', answered_at: '2026-11-02T18:00:00Z' });
    expect(queueItems(rows, [], [], clock)).toMatchObject([{ id: 't1', minutes: 30, stale: false, bucket: 'one_offs' }]);

    await transact(db, clock, (w) => w.create('time_block', { task_id: 't1', start: '2026-11-03T17:00:00Z', end: '2026-11-03T18:00:00Z', tz: 'UTC' }, 'b2'));
    expect(await needsNewTime(db)).toEqual([]);
  });

  it('asks for the time left on Partly, and the block length on Not done', () => {
    const [partly, not] = queueItems(
      [row({ result: 'partly', remaining_min: 45 }), row({ id: 't2', block_start: '2026-11-02T19:00:00Z', block_end: '2026-11-02T20:30:00Z' })],
      [],
      [],
      clock,
    );
    expect(partly!.minutes).toBe(45);
    expect(not!.minutes).toBe(90);
  });

  it('says why, in the words of the day it happened', () => {
    const reason = (over: Partial<QueueRow>) => queueItems([row(over)], [], [], clock)[0]!.reason;
    expect(reason({})).toBe('Not done today');
    expect(reason({ result: 'partly', remaining_min: 60 })).toBe('Partly done today, 1h left');
    expect(reason({ block_start: '2026-10-30T17:00:00Z', block_end: '2026-10-30T18:00:00Z' })).toBe('Not done Oct 30');
    expect(reason({ result: 'partly', remaining_min: 30, block_start: '2026-10-30T17:00:00Z' })).toBe('Partly done Oct 30, 30m left');
  });

  it('judges today in the local zone', () => {
    const chicago = fixedClock('2026-11-03T03:00:00Z', 'America/Chicago');
    expect(queueItems([row()], [], [], chicago)[0]!.reason).toBe('Not done today');
  });

  it('lists oldest first, with no ranking', () => {
    const items = queueItems([row({ id: 'late', block_start: '2026-11-02T19:00:00Z' }), row({ id: 'early' })], [], [], clock);
    expect(items.map((i) => i.id)).toEqual(['early', 'late']);
  });
});

describe('Still want this?', () => {
  const clock = fixedClock('2026-11-10T12:00:00Z');
  const stale = (plans: WeekPlan[], picks: WeekPick[], over: Partial<QueueRow> = {}) => queueItems([row(over)], plans, picks, clock)[0]!;

  it('stays fresh until a plan is finished after it', () => {
    expect(stale([], []).stale).toBe(false);
    expect(stale([plan('2026-11-02', '2026-11-01T20:00:00Z')], []).stale).toBe(false);
    expect(stale([plan('2026-11-09', null)], []).stale).toBe(false);
  });

  it('asks once a plan was finished without adding it', () => {
    const item = stale([plan('2026-11-09', '2026-11-08T20:00:00Z')], []);
    expect(item.stale).toBe(true);
    expect(item.reason).toBe('Ignored at last planning');
  });

  it('stays fresh when that plan added it', () => {
    expect(stale([plan('2026-11-09', '2026-11-08T20:00:00Z')], [pick('2026-11-09', 't1')]).stale).toBe(false);
  });

  it('a removed or skipped pick, or a pick in another week, does not count as added', () => {
    const plans = [plan('2026-11-09', '2026-11-08T20:00:00Z')];
    expect(stale(plans, [pick('2026-11-09', 't1', { deleted_at: '2026-11-08T19:00:00Z' })]).stale).toBe(true);
    expect(stale(plans, [pick('2026-11-09', 't1', { skipped: true })]).stale).toBe(true);
    expect(stale(plans, [pick('2026-11-02', 't1')]).stale).toBe(true);
  });

  it('goes by the plan finished last, even when several weeks are planned', () => {
    const plans = [plan('2026-11-09', '2026-11-08T20:00:00Z'), plan('2026-11-02', '2026-11-01T20:00:00Z')];
    expect(stale(plans, [pick('2026-11-02', 't1')]).stale).toBe(true);
  });

  it('a deleted plan is not a plan', () => {
    expect(stale([{ ...plan('2026-11-09', '2026-11-08T20:00:00Z'), deleted_at: '2026-11-08T21:00:00Z' }], []).stale).toBe(false);
  });

  it('Keep answers the question and the work stays in the queue', async () => {
    const db = await openTestDb();
    await transact(db, clock, async (w) => {
      await w.create('task', { kind: 'project', project_id: 'p1', title: 'Write the report' }, 't1');
      await w.create('time_block', { task_id: 't1', start: '2026-11-02T17:00:00Z', end: '2026-11-02T18:00:00Z', tz: 'UTC' }, 'b1');
      await w.create('block_outcome', { result: 'not', answered_at: '2026-11-02T18:00:00Z' }, outcomeId('b1'));
    });
    const plans = [plan('2026-11-09', '2026-11-08T20:00:00Z')];
    const before = queueItems(await needsNewTime(db), plans, [], clock)[0]!;
    expect(before.stale).toBe(true);

    await transact(db, clock, (w) => keepWork(w, before, clock));
    const after = queueItems(await needsNewTime(db), plans, [], clock);
    expect(after).toMatchObject([{ id: 't1', stale: false, minutes: 60 }]);
  });
});

describe('Delete', () => {
  const clock = fixedClock('2026-11-10T12:00:00Z');
  const weekly = { type: 'recurring', every: 1, unit: 'week', anchor: '2026-10-05' } as const;
  const missed = async (w: Writer, blockId: string, start: string, end: string) => {
    await w.create('time_block', { task_id: 'r', start, end, tz: 'UTC' }, blockId);
    await w.create('block_outcome', { result: 'not', answered_at: end }, outcomeId(blockId));
  };

  it('on a repeating one off drops just that row: the task, its schedule, the block and its answer stay, and Undo brings it back', async () => {
    const db = await openTestDb();
    await transact(db, clock, async (w) => {
      await w.create('task', { kind: 'one_off', title: 'Water the plants', schedule: weekly, next_due: '2026-11-16' }, 'r');
      await missed(w, 'b1', '2026-11-09T17:00:00Z', '2026-11-09T18:00:00Z');
    });
    const before = { task: await getRecord(db, 'task', 'r'), block: await getRecord(db, 'time_block', 'b1'), outcome: await getRecord(db, 'block_outcome', outcomeId('b1')) };
    const item = queueItems(await needsNewTime(db), [], [], clock)[0]!;

    const reverse = await transact(db, clock, (w) => deleteWork(w, item, clock));
    expect(await needsNewTime(db)).toEqual([]);
    expect(await getRecord(db, 'task', 'r')).toEqual(before.task);
    expect(await getRecord(db, 'time_block', 'b1')).toEqual(before.block);
    expect(await getRecord(db, 'block_outcome', outcomeId('b1'))).toMatchObject(before.outcome!);

    await transact(db, clock, (w) => applyPlanChange(w, reverse));
    expect((await needsNewTime(db)).map((r) => r.block_id)).toEqual(['b1']);
  });

  it('on a repeating one off leaves its next missed occurrence to come back', async () => {
    const db = await openTestDb();
    await transact(db, clock, async (w) => {
      await w.create('task', { kind: 'one_off', title: 'Water the plants', schedule: weekly, next_due: '2026-11-16' }, 'r');
      await missed(w, 'b1', '2026-11-02T17:00:00Z', '2026-11-02T18:00:00Z');
    });
    await transact(db, clock, async (w) => deleteWork(w, queueItems(await needsNewTime(w.sql), [], [], clock)[0]!, clock));
    await transact(db, clock, (w) => missed(w, 'b2', '2026-11-09T17:00:00Z', '2026-11-09T18:00:00Z'));
    expect((await needsNewTime(db)).map((r) => r.block_id)).toEqual(['b2']);
  });

  it('on a repeating one off answered Partly gives up that time left, so the next occurrence is its estimate again, with Undo', async () => {
    const db = await openTestDb();
    await transact(db, clock, async (w) => {
      await w.create('task', { kind: 'one_off', title: 'Learn to bake bread', estimate_min: 60, schedule: weekly, next_due: '2026-11-16' }, 'r');
      await w.create('time_block', { task_id: 'r', start: '2026-11-09T17:00:00Z', end: '2026-11-09T18:00:00Z', tz: 'UTC' }, 'b1');
    });
    await transact(db, clock, (w) => answerBlock(w, 'b1', { result: 'partly', remaining_min: 15 }, clock));
    const item = queueItems(await needsNewTime(db), [], [], clock)[0]!;
    const nextWeek = async () => oneOffCandidates(await listRecords(db, 'task'), { weekStart: '2026-11-16', picks: [], blocks: [] }, { settings: DEFAULT_SETTINGS, clock });

    const reverse = await transact(db, clock, (w) => deleteWork(w, item, clock));
    expect((await nextWeek()).map((c) => c.left)).toEqual([60]);

    await transact(db, clock, (w) => applyPlanChange(w, reverse));
    expect((await getRecord(db, 'task', 'r'))?.remaining_min).toBe(15);
    expect((await needsNewTime(db)).map((r) => r.block_id)).toEqual(['b1']);
  });

  it('on one-time work deletes the task, with Undo', async () => {
    const db = await openTestDb();
    await transact(db, clock, async (w) => {
      await w.create('task', { kind: 'one_off', title: 'Paint the fence' }, 'r');
      await missed(w, 'b1', '2026-11-09T17:00:00Z', '2026-11-09T18:00:00Z');
    });
    const item = queueItems(await needsNewTime(db), [], [], clock)[0]!;
    const reverse = await transact(db, clock, (w) => deleteWork(w, item, clock));
    expect((await getRecord(db, 'task', 'r'))?.deleted_at).toBe('2026-11-10T12:00:00Z');
    await transact(db, clock, (w) => applyPlanChange(w, reverse));
    expect((await getRecord(db, 'task', 'r'))?.deleted_at).toBeNull();
  });
});

describe('carried work', () => {
  it('sits inside its project or One offs, and is never a place of its own', () => {
    const clock = fixedClock('2026-11-02T20:00:00Z');
    const items = queueItems(
      [row(), row({ id: 't2', project_id: 'p2' }), row({ id: 't3', project_id: null, kind: 'one_off' }), row({ id: 't4', block_start: '2026-11-02T17:30:00Z' })],
      [],
      [],
      clock,
    );
    expect(items.map((i) => [i.id, i.bucket])).toEqual([
      ['t1', 'p1'],
      ['t2', 'p2'],
      ['t3', 'one_offs'],
      ['t4', 'p1'],
    ]);
  });
});

describe('away dates', () => {
  const away: AwayPeriod[] = [{ id: 'a1', start: '2026-12-20', end: '2026-12-27' }];

  it('include both ends', () => {
    expect(isAway('2026-12-19', away)).toBe(false);
    expect(isAway('2026-12-20', away)).toBe(true);
    expect(isAway('2026-12-27', away)).toBe(true);
    expect(isAway('2026-12-28', away)).toBe(false);
  });

  it('ignore a removed period', () => {
    expect(isAway('2026-12-20', [{ ...away[0]!, deleted_at: '2026-12-01T00:00:00Z' }])).toBe(false);
  });
});

const block = (id: string, start: string, end: string, over: Partial<BlockRow> = {}): BlockRow => ({
  id,
  start,
  end,
  tz: 'UTC',
  task_id: `task-${id}`,
  practice_id: null,
  started_at: null,
  ended_at: null,
  title: `Work ${id}`,
  task_kind: 'project',
  result: null,
  ...over,
});

const day = (time: string) => `2026-11-02T${time}:00Z`;
const event = (id: string, from: string, to: string, over: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id,
  calendar: 'cal1',
  title: id,
  start: day(from),
  end: day(to),
  ...over,
});

describe('conflicts', () => {
  const calendar = (events: CalendarEvent[]): CalendarState => ({ id: 'calendar', connected: true, events });
  const source = (google_id: string, mode: CalendarSource['mode']): CalendarSource => ({ id: `s-${google_id}`, google_id, name: google_id, mode });

  it('only count events on calendars that block time, and a new calendar blocks until told otherwise', () => {
    const state = calendar([event('blocks', '10:00', '11:00'), event('info', '10:00', '11:00', { calendar: 'c2' }), event('ignored', '10:00', '11:00', { calendar: 'c3' }), event('fresh', '10:00', '11:00', { calendar: 'c4' })]);
    const sources = [source('cal1', 'block'), source('c2', 'info'), source('c3', 'ignore')];
    expect(busyEvents(state, sources).map((e) => e.id)).toEqual(['blocks', 'fresh']);
  });

  it('leave out all-day events, which would block the whole day', () => {
    expect(busyEvents(calendar([event('trip', '00:00', '23:59', { all_day: true })]), [])).toEqual([]);
  });

  it('need a calendar', () => {
    expect(busyEvents(undefined, [])).toEqual([]);
    expect(busyEvents({ id: 'calendar', connected: false }, [])).toEqual([]);
  });

  it('name the first event a block overlaps, and touching is not overlapping', () => {
    const blocks = [block('a', day('10:00'), day('11:00')), block('b', day('11:00'), day('12:00')), block('c', day('13:00'), day('14:00'))];
    const events = [event('late', '10:30', '10:45'), event('early', '10:15', '10:30'), event('after', '12:00', '13:00')];
    expect(blockConflicts(blocks, events).map(({ block: b, event: e }) => [b.id, e.id])).toEqual([['a', 'early']]);
  });
});

describe('Shift rest of today', () => {
  const availability = DEFAULT_SETTINGS.availability;
  const at = (time: string) => fixedClock(day(time));
  const shifted = (r: ReturnType<typeof shiftRestOfToday>) => r!.moves.map((m) => [m.block.id, m.start, m.end]);

  it('offers nothing with no conflict ahead', () => {
    const blocks = [block('a', day('20:00'), day('21:00'))];
    expect(shiftRestOfToday(blocks, [event('dinner', '18:00', '19:00')], availability, at('17:00'))).toBeNull();
  });

  it('cascades: later blocks keep their order and length, clear of the event', () => {
    const blocks = [block('a', day('20:00'), day('21:00')), block('b', day('21:00'), day('21:30'))];
    const result = shiftRestOfToday(blocks, [event('dinner', '19:00', '20:30')], availability, at('19:30'));
    expect(result!.conflict.block.id).toBe('a');
    expect(result!.conflict.event.id).toBe('dinner');
    expect(shifted(result)).toEqual([
      ['a', day('20:30'), day('21:30')],
      ['b', day('21:30'), day('22:00')],
    ]);
    expect(result!.runs_past).toBeNull();
  });

  it('lists only blocks that move, leaving a later one with room alone', () => {
    const blocks = [block('a', day('10:00'), day('11:00')), block('b', day('15:00'), day('16:00'))];
    const result = shiftRestOfToday(blocks, [event('call', '10:00', '10:30')], availability, at('09:00'));
    expect(shifted(result)).toEqual([['a', day('10:30'), day('11:30')]]);
  });

  it('jumps over events in the way, including one that a move lands on', () => {
    const blocks = [block('a', day('10:00'), day('11:00'))];
    const result = shiftRestOfToday(blocks, [event('one', '10:30', '11:00'), event('two', '11:30', '12:00')], availability, at('09:00'));
    expect(shifted(result)).toEqual([['a', day('12:00'), day('13:00')]]);
  });

  it('keeps clear of a block in progress, which itself stays', () => {
    const blocks = [block('now', day('09:00'), day('10:15')), block('a', day('10:00'), day('11:00'))];
    const result = shiftRestOfToday(blocks, [event('call', '10:00', '10:30')], availability, at('09:30'));
    expect(shifted(result)).toEqual([['a', day('10:30'), day('11:30')]]);
  });

  it('a block in progress that conflicts offers no shift on its own', () => {
    const blocks = [block('now', day('09:00'), day('10:00'))];
    expect(shiftRestOfToday(blocks, [event('call', '09:30', '09:45')], availability, at('09:15'))).toBeNull();
  });

  it('counts a block started early as in progress', () => {
    const blocks = [block('early', day('10:00'), day('11:00'), { started_at: day('09:30') }), block('b', day('11:00'), day('12:00'))];
    const result = shiftRestOfToday(blocks, [event('call', '11:00', '11:30')], availability, at('09:45'));
    expect(shifted(result)).toEqual([['b', day('11:30'), day('12:30')]]);
  });

  it('leaves answered, ended and past blocks out', () => {
    const blocks = [
      block('past', day('08:00'), day('09:00')),
      block('answered', day('10:00'), day('11:00'), { result: 'done' }),
      block('ended', day('10:00'), day('11:00'), { ended_at: day('09:30') }),
    ];
    expect(shiftRestOfToday(blocks, [event('call', '08:00', '11:00')], availability, at('09:45'))).toBeNull();
  });

  it('notes when the result runs into closed hours', () => {
    const blocks = [block('a', day('21:00'), day('21:45'))];
    const result = shiftRestOfToday(blocks, [event('call', '21:00', '21:30')], availability, at('20:00'));
    expect(result!.runs_past).toBe(22 * 60);
  });

  it('ignores closed hours for other days of the week', () => {
    const weekends = [{ days: 'weekends' as const, from: 18 * 60, to: 23 * 60, projects: true, one_offs: true }];
    const result = shiftRestOfToday([block('a', day('19:00'), day('20:00'))], [event('call', '19:00', '19:30')], weekends, at('18:00'));
    expect(result!.runs_past).toBeNull();
  });

  it('applying moves the blocks and marks a moved practice session as this week only', async () => {
    const db = await openTestDb();
    const clock = at('09:00');
    await transact(db, clock, async (w) => {
      await w.create('time_block', { task_id: 't1', start: day('10:00'), end: day('11:00'), tz: 'UTC' }, 'a');
      await w.create('time_block', { practice_id: 'pr1', start: day('11:00'), end: day('11:30'), tz: 'UTC' }, 'b');
    });
    const blocks = [block('a', day('10:00'), day('11:00')), block('b', day('11:00'), day('11:30'), { task_id: null, practice_id: 'pr1' })];
    const result = shiftRestOfToday(blocks, [event('call', '10:00', '10:30')], availability, clock)!;
    const undo = await transact(db, clock, (w) => applyShift(w, result.moves));

    expect(await getRecord(db, 'time_block', 'a')).toMatchObject({ start: day('10:30'), end: day('11:30') });
    expect((await getRecord(db, 'time_block', 'a'))!.edited).toBeUndefined();
    expect(await getRecord(db, 'time_block', 'b')).toMatchObject({ start: day('11:30'), end: day('12:00'), edited: true });

    await transact(db, clock, (w) => applyPlanChange(w, undo));
    expect(await getRecord(db, 'time_block', 'b')).toMatchObject({ start: day('11:00'), end: day('11:30'), edited: null });
  });
});

describe('Welcome back', () => {
  const weekAgo = (n: number) => `2026-11-${String(n).padStart(2, '0')}T10:00:00Z`;
  const missed = (n: number, over: Partial<BlockRow> = {}) => block(`d${n}`, weekAgo(n), weekAgo(n).replace('T10', 'T11'), over);
  const now = fixedClock('2026-11-16T09:00:00Z');

  it('greets you when your plan has passed with nothing answered for a week', () => {
    const result = welcomeBack([missed(2), missed(5), missed(14)], [], now);
    expect(result!.blocks.map((b) => b.id)).toEqual(['d2', 'd5', 'd14']);
  });

  it('stays quiet when the oldest missed block is under a week old', () => {
    expect(welcomeBack([missed(10), missed(14)], [], now)).toBeNull();
  });

  it('stays quiet with nothing missed, even after a long gap', () => {
    expect(welcomeBack([], [], now)).toBeNull();
    expect(welcomeBack([missed(2, { result: 'done' })], [], now)).toBeNull();
  });

  it('counts only what passed since you last answered or started something', () => {
    expect(welcomeBack([missed(2), missed(9, { result: 'partly' }), missed(14)], [], now)).toBeNull();
    expect(welcomeBack([missed(2), missed(9, { started_at: weekAgo(9) }), missed(14)], [], now)).toBeNull();
    expect(welcomeBack([missed(2), missed(3, { result: 'done' }), missed(5), missed(14)], [], now)!.blocks.map((b) => b.id)).toEqual(['d2', 'd5', 'd14']);
  });

  it('leaves practices alone, since a missed session just passes', () => {
    expect(welcomeBack([missed(2, { task_id: null, practice_id: 'pr1' })], [], now)).toBeNull();
  });

  it('ignores blocks still to come', () => {
    expect(welcomeBack([block('next', '2026-11-20T10:00:00Z', '2026-11-20T11:00:00Z')], [], now)).toBeNull();
  });

  it('waits until you are back from away dates, then covers them', () => {
    const away: AwayPeriod[] = [{ id: 'a1', start: '2026-11-02', end: '2026-11-16' }];
    expect(welcomeBack([missed(2)], away, now)).toBeNull();
    const back: AwayPeriod[] = [{ id: 'a1', start: '2026-11-02', end: '2026-11-15' }];
    expect(welcomeBack([missed(2)], back, now)!.blocks.map((b) => b.id)).toEqual(['d2']);
  });

  it('returning cancels the blocks, so they leave analytics and do not ask again', async () => {
    const db = await openTestDb();
    await transact(db, now, async (w) => {
      await w.create('time_block', { task_id: 't1', start: weekAgo(2), end: weekAgo(2).replace('T10', 'T11'), tz: 'UTC' }, 'd2');
      await returnMissedBlocks(w, [missed(2)]);
    });
    expect((await getRecord(db, 'time_block', 'd2'))!.cancelled).toBe(true);
  });
});

describe('Pick one thing for today', () => {
  const clock = fixedClock('2026-11-16T09:00:00Z');
  const projects: Project[] = [
    { id: 'p1', title: 'Write the report', state: 'active', start: '2026-10-01', end: '2026-12-01' },
    { id: 'p2', title: 'Learn to bake bread', state: 'active', start: '2026-10-01', end: '2027-02-01' },
    { id: 'old', title: 'Plant a hedge', state: 'paused', start: '2026-10-01', end: '2027-02-01' },
    { id: 'soon', title: 'Build a shed', state: 'active', start: '2027-01-01', end: '2027-02-01' },
  ];
  const milestones: Milestone[] = [
    { id: 'm1', project_id: 'p1', title: 'First draft', due: '2026-11-20' },
    { id: 'm2', project_id: 'p2', title: 'First loaf', due: '2026-11-30' },
  ];
  const task = (id: string, over: Partial<Task>): Task => ({ id, kind: 'project', title: id, ...over });
  const ids = (tasks: Task[]) => welcomeOptions(tasks, milestones, projects, clock).map((t) => t.id);

  it('offers three, soonest date first, one per project or One offs', () => {
    expect(
      ids([
        task('undated', { project_id: 'p2' }),
        task('loaf', { project_id: 'p2', milestone_id: 'm2' }),
        task('draft', { project_id: 'p1', milestone_id: 'm1' }),
        task('draft2', { project_id: 'p1', milestone_id: 'm1' }),
        task('fence', { kind: 'one_off', next_due: '2026-11-18' }),
        task('windows', { kind: 'one_off', next_due: '2026-11-19' }),
      ]),
    ).toEqual(['fence', 'draft', 'loaf']);
  });

  it('skips work that is closed, waiting, unsorted, or in a project that is not running', () => {
    expect(
      ids([
        task('done', { project_id: 'p1', done_at: '2026-11-01T00:00:00Z' }),
        task('cancelled', { project_id: 'p1', cancelled_at: '2026-11-01T00:00:00Z' }),
        task('deleted', { project_id: 'p1', deleted_at: '2026-11-01T00:00:00Z' }),
        task('waiting', { project_id: 'p1', waiting_until: '2026-11-20' }),
        task('inbox', { kind: 'inbox' }),
        task('paused', { project_id: 'old' }),
        task('notyet', { project_id: 'soon' }),
        task('ok', { project_id: 'p1' }),
      ]),
    ).toEqual(['ok']);
  });

  it('skips a one off that is not due yet', () => {
    expect(
      ids([
        task('later', { kind: 'one_off', schedule: { type: 'float', every: 1, unit: 'month' }, next_due: '2027-01-01' }),
        task('dated', { kind: 'one_off', schedule: { type: 'once', from: '2027-01-01' } }),
        task('free', { kind: 'one_off', schedule: { type: 'once' } }),
      ]),
    ).toEqual(['free']);
  });

  it('ignores the date of a milestone already met', () => {
    const met: Milestone[] = [{ ...milestones[0]!, met_at: '2026-11-01T00:00:00Z' }, milestones[1]!];
    const tasks = [task('a', { project_id: 'p1', milestone_id: 'm1' }), task('b', { project_id: 'p2', milestone_id: 'm2' })];
    expect(welcomeOptions(tasks, met, projects, clock).map((t) => t.id)).toEqual(['b', 'a']);
  });
});

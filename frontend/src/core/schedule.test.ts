import { describe, expect, it } from 'vitest';
import { fixedClock } from './clock';
import { occurrenceId } from './records';
import {
  blocksToRelease,
  firstDue,
  isOnToday,
  isRepeating,
  moveOnce,
  nextDue,
  oneOffRows,
  onceOverlaps,
  retick,
  rowLine,
  scheduleLabel,
  projectDates,
  setOnceDates,
  tick,
  tickFromBlock,
  untick,
  validateSchedule,
  windowEnd,
} from './schedule';
import type { Task, TaskCompletion, TaskSchedule, TimeBlock } from './types';

const NOW = '2026-10-30T15:00:00Z';
const clockAt = (at = NOW, zone = 'UTC') => fixedClock(at, zone);

const task = (schedule: TaskSchedule | null, next_due: string | null = null, extra: Partial<Task> = {}): Task => ({
  id: 't1',
  kind: 'one_off',
  title: 'Paint the fence',
  schedule,
  next_due,
  ...extra,
});

const weekly: TaskSchedule = { type: 'recurring', every: 1, unit: 'week', anchor: '2026-10-03' };
const monthly28: TaskSchedule = { type: 'recurring', every: 1, unit: 'month', anchor: '2026-01-28' };
const float6: TaskSchedule = { type: 'float', every: 6, unit: 'week' };
const window23: TaskSchedule = { type: 'window', min: 2, max: 3, unit: 'month' };
const season: TaskSchedule = { type: 'seasonal', months: [10, 4] };
const secondTuesday: TaskSchedule = { type: 'rule', rrule: 'FREQ=MONTHLY;BYDAY=+2TU', anchor: '2026-01-01' };
const lastWeekdayOfQuarter: TaskSchedule = {
  type: 'rule',
  rrule: 'FREQ=MONTHLY;BYMONTH=3,6,9,12;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1',
  anchor: '2026-01-01',
};

// Applies a tick the way a caller would, returning the updated task and its completion record.
const applied = (t: Task, clock = clockAt()) => {
  const r = tick(t, clock);
  const completion: TaskCompletion = { ...r.completion.fields, id: r.completion.id };
  return { task: { ...t, ...r.task }, completion };
};

describe('once', () => {
  it('has no date, one date or the start of a range as its first due', () => {
    expect(firstDue({ type: 'once' }, '2026-10-30')).toBeNull();
    expect(firstDue({ type: 'once', from: '2026-12-01' }, '2026-10-30')).toBe('2026-12-01');
    expect(firstDue({ type: 'once', from: '2026-11-03', to: '2026-11-06' }, '2026-10-30')).toBe('2026-11-03');
  });

  it('does not repeat', () => {
    expect(isRepeating(task({ type: 'once' }))).toBe(false);
    expect(isRepeating(task(null))).toBe(false);
    expect(isRepeating(task(weekly))).toBe(true);
    expect(nextDue({ type: 'once', from: '2026-12-01' }, '2026-12-01', '2026-12-01')).toBeNull();
  });

  it('sets, clears and normalises dates', () => {
    expect(setOnceDates('2026-11-20', '2026-11-25')).toEqual({
      schedule: { type: 'once', from: '2026-11-20', to: '2026-11-25' },
      next_due: '2026-11-20',
    });
    expect(setOnceDates('2026-11-20', '2026-11-20').schedule).toEqual({ type: 'once', from: '2026-11-20', to: null });
    expect(setOnceDates(null, null)).toEqual({ schedule: { type: 'once', from: null, to: null }, next_due: null });
  });

  it('refuses an end before the start, and an end with no start', () => {
    expect(validateSchedule({ type: 'once', from: '2026-11-20', to: '2026-11-10' })).toBe(
      'The end date is before the start date.',
    );
    expect(validateSchedule({ type: 'once', to: '2026-11-10' })).toBe('Pick a date.');
    expect(validateSchedule({ type: 'once', from: '2026-11-20', to: '2026-11-25' })).toBeNull();
    expect(validateSchedule({ type: 'once' })).toBeNull();
  });

  it('keeps a range length when moved', () => {
    expect(moveOnce({ type: 'once', from: '2026-11-03', to: '2026-11-06' }, '2026-11-10')).toEqual({
      schedule: { type: 'once', from: '2026-11-10', to: '2026-11-13' },
      next_due: '2026-11-10',
    });
    expect(moveOnce({ type: 'once', from: '2026-11-03' }, '2026-11-10').schedule).toEqual({
      type: 'once',
      from: '2026-11-10',
      to: null,
    });
  });

  it('overlaps a span only when dated and not done', () => {
    const range = task({ type: 'once', from: '2026-11-03', to: '2026-11-06' });
    expect(onceOverlaps(range, '2026-11-02', '2026-11-08')).toBe(true);
    expect(onceOverlaps(range, '2026-11-06', '2026-11-08')).toBe(true);
    expect(onceOverlaps(range, '2026-11-07', '2026-11-08')).toBe(false);
    expect(onceOverlaps(range, '2026-10-26', '2026-11-02')).toBe(false);
    expect(onceOverlaps(task({ type: 'once', from: '2026-11-07' }), '2026-11-02', '2026-11-08')).toBe(true);
    expect(onceOverlaps(task({ type: 'once' }), '2026-11-02', '2026-11-08')).toBe(false);
    expect(onceOverlaps(task(weekly, '2026-11-07'), '2026-11-02', '2026-11-08')).toBe(false);
    expect(onceOverlaps({ ...range, done_at: NOW }, '2026-11-02', '2026-11-08')).toBe(false);
  });

  it('is on Today only when dated to that single day', () => {
    expect(isOnToday(task({ type: 'once', from: '2026-10-30' }), '2026-10-30')).toBe(true);
    expect(isOnToday(task({ type: 'once', from: '2026-10-30', to: '2026-10-30' }), '2026-10-30')).toBe(true);
    expect(isOnToday(task({ type: 'once', from: '2026-10-30', to: '2026-10-31' }), '2026-10-30')).toBe(false);
    expect(isOnToday(task({ type: 'once', from: '2026-10-29' }), '2026-10-30')).toBe(false);
    expect(isOnToday(task({ type: 'once' }), '2026-10-30')).toBe(false);
    expect(isOnToday(task(weekly, '2026-10-30'), '2026-10-30')).toBe(false);
  });
});

describe('a date moving to a project', () => {
  it('keeps a single day or a range, and drops a repeat, since repeats stay with One offs', () => {
    expect(projectDates({ schedule: { type: 'once', from: '2026-11-20', to: null } })).toEqual({ schedule: { type: 'once', from: '2026-11-20', to: null }, next_due: '2026-11-20' });
    expect(projectDates({ schedule: { type: 'once', from: '2026-11-16', to: '2026-11-20' } })).toEqual({ schedule: { type: 'once', from: '2026-11-16', to: '2026-11-20' }, next_due: '2026-11-16' });
    expect(projectDates({ schedule: { type: 'float', every: 2, unit: 'week' } })).toEqual({ schedule: null, next_due: null });
    expect(projectDates({ schedule: { type: 'once', from: null, to: null } })).toEqual({ schedule: null, next_due: null });
    expect(projectDates({})).toEqual({ schedule: null, next_due: null });
  });
});

describe('standard recurring', () => {
  it('starts on the first date on or after today', () => {
    expect(firstDue(weekly, '2026-10-30')).toBe('2026-10-31');
    expect(firstDue(weekly, '2026-10-31')).toBe('2026-10-31');
    expect(firstDue({ ...weekly, anchor: '2026-12-05' }, '2026-10-30')).toBe('2026-12-05');
  });

  it('ticking early uses up the occurrence, so the next one is one period on', () => {
    expect(nextDue(weekly, '2026-11-07', '2026-10-30')).toBe('2026-11-14');
    expect(nextDue(monthly28, '2026-11-28', '2026-10-30')).toBe('2026-12-28');
  });

  it('a second tick moves on again', () => {
    expect(nextDue(weekly, '2026-11-14', '2026-10-30')).toBe('2026-11-21');
  });

  it('ticking late skips to the first date after today, without a backlog', () => {
    expect(nextDue(weekly, '2026-10-03', '2026-10-30')).toBe('2026-10-31');
    expect(nextDue(weekly, '2026-10-31', '2026-10-31')).toBe('2026-11-07');
  });

  it('counts intervals from the anchor', () => {
    const fortnight: TaskSchedule = { type: 'recurring', every: 2, unit: 'week', anchor: '2026-10-03' };
    expect(nextDue(fortnight, '2026-10-17', '2026-10-17')).toBe('2026-10-31');
    expect(nextDue({ type: 'recurring', every: 3, unit: 'day', anchor: '2026-10-01' }, '2026-10-04', '2026-10-04')).toBe('2026-10-07');
  });

  it('takes weekdays, Monday first', () => {
    const monThu: TaskSchedule = { type: 'recurring', every: 1, unit: 'week', anchor: '2026-10-05', days: [0, 3] };
    expect(firstDue(monThu, '2026-10-30')).toBe('2026-11-02');
    expect(nextDue(monThu, '2026-11-02', '2026-11-02')).toBe('2026-11-05');
    expect(nextDue({ ...monThu, every: 2 }, '2026-10-08', '2026-10-08')).toBe('2026-10-19');
  });

  it('lands on the last day of a shorter month, then goes back to the anchor day', () => {
    const end: TaskSchedule = { type: 'recurring', every: 1, unit: 'month', anchor: '2026-01-31' };
    expect(nextDue(end, '2026-01-31', '2026-01-31')).toBe('2026-02-28');
    expect(nextDue(end, '2026-02-28', '2026-02-28')).toBe('2026-03-31');
    expect(nextDue(end, '2026-03-31', '2026-03-31')).toBe('2026-04-30');
    const leap: TaskSchedule = { type: 'recurring', every: 1, unit: 'year', anchor: '2028-02-29' };
    expect(nextDue(leap, '2028-02-29', '2028-02-29')).toBe('2029-02-28');
    expect(nextDue(leap, '2031-02-28', '2031-02-28')).toBe('2032-02-29');
  });
});

describe('float from last done', () => {
  it('has no date until first done', () => {
    expect(firstDue(float6, '2026-10-30')).toBeNull();
  });

  it('counts from the finish, whatever the old date was', () => {
    expect(nextDue(float6, '2026-11-14', '2026-10-30')).toBe('2026-12-11');
    expect(nextDue(float6, null, '2026-10-30')).toBe('2026-12-11');
    expect(firstDue(float6, '2026-10-30', '2026-10-01')).toBe('2026-11-12');
  });

  it('handles days, months and years', () => {
    expect(nextDue({ type: 'float', every: 10, unit: 'day' }, null, '2026-10-30')).toBe('2026-11-09');
    expect(nextDue({ type: 'float', every: 1, unit: 'month' }, null, '2026-01-31')).toBe('2026-02-28');
    expect(nextDue({ type: 'float', every: 1, unit: 'year' }, null, '2026-10-30')).toBe('2027-10-30');
  });
});

describe('flexible window', () => {
  it('starts its window from today when never done', () => {
    expect(firstDue(window23, '2026-10-30')).toBe('2026-12-30');
    expect(firstDue(window23, '2026-10-30', '2026-09-05')).toBe('2026-11-05');
  });

  it('counts from the finish, and the window ends max after it', () => {
    const due = nextDue(window23, '2026-11-05', '2026-10-30')!;
    expect(due).toBe('2026-12-30');
    expect(windowEnd(window23, due)).toBe('2027-01-30');
  });

  it('only windows have an end', () => {
    expect(windowEnd(float6, '2026-12-30')).toBeNull();
    expect(windowEnd(window23, null)).toBeNull();
  });

  it('cannot run backwards', () => {
    expect(validateSchedule({ type: 'window', min: 4, max: 3, unit: 'month' })).not.toBeNull();
    expect(validateSchedule({ type: 'window', min: 4, max: 4, unit: 'month' })).toBeNull();
  });
});

describe('seasonal', () => {
  it('starts today when in season, otherwise the first of the next listed month', () => {
    expect(firstDue(season, '2026-10-30')).toBe('2026-10-30');
    expect(firstDue(season, '2026-11-02')).toBe('2027-04-01');
    expect(firstDue(season, '2026-01-15')).toBe('2026-04-01');
  });

  it('ticking early uses up the coming season', () => {
    expect(nextDue({ type: 'seasonal', months: [4, 11] }, '2026-11-01', '2026-10-30')).toBe('2027-04-01');
  });

  it('ticking in season moves to the next listed month and wraps the year', () => {
    expect(nextDue(season, '2026-04-01', '2026-04-20')).toBe('2026-10-01');
    expect(nextDue(season, '2026-10-30', '2026-10-30')).toBe('2027-04-01');
    expect(nextDue({ type: 'seasonal', months: [6] }, '2026-06-01', '2026-06-10')).toBe('2027-06-01');
  });
});

describe('complex calendar rules', () => {
  it('finds the 2nd Tuesday', () => {
    expect(firstDue(secondTuesday, '2026-10-30')).toBe('2026-11-10');
    expect(firstDue(secondTuesday, '2026-11-10')).toBe('2026-11-10');
    expect(nextDue(secondTuesday, '2026-11-10', '2026-10-30')).toBe('2026-12-08');
  });

  it('finds the last weekday of the quarter', () => {
    expect(firstDue(lastWeekdayOfQuarter, '2026-10-30')).toBe('2026-12-31');
    expect(nextDue(lastWeekdayOfQuarter, '2026-12-31', '2026-12-31')).toBe('2027-03-31');
    expect(firstDue(lastWeekdayOfQuarter, '2026-06-01')).toBe('2026-06-30');
    // Oct 31 2026 is a Saturday, so the last weekday falls before the month's end.
    const october: TaskSchedule = { type: 'rule', rrule: 'FREQ=MONTHLY;BYMONTH=10;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1', anchor: '2026-01-01' };
    expect(firstDue(october, '2026-10-01')).toBe('2026-10-30');
  });

  it('returns null once the rule has ended', () => {
    const ending: TaskSchedule = { type: 'rule', rrule: 'FREQ=MONTHLY;COUNT=2', anchor: '2026-10-05' };
    expect(nextDue(ending, '2026-10-05', '2026-10-05')).toBe('2026-11-05');
    expect(nextDue(ending, '2026-11-05', '2026-11-05')).toBeNull();
  });

  it('returns null for a rule that never matches', () => {
    expect(firstDue({ type: 'rule', rrule: 'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30', anchor: '2026-01-01' }, '2026-10-30')).toBeNull();
  }, 20000);

  it('ignores any start date inside the rule text', () => {
    const rule: TaskSchedule = { type: 'rule', rrule: 'DTSTART:20300101T000000Z\nRRULE:FREQ=MONTHLY;BYDAY=+2TU', anchor: '2026-01-01' };
    expect(firstDue(rule, '2026-10-30')).toBe('2026-11-10');
  });
});

describe('malformed schedules, which can arrive through sync', () => {
  const bad: TaskSchedule[] = [
    { type: 'rule', rrule: 'not a rule', anchor: '2026-01-01' },
    { type: 'rule', rrule: 'BYDAY=TU', anchor: '2026-01-01' },
    { type: 'rule', rrule: 'FREQ=HOURLY', anchor: '2026-01-01' },
    { type: 'rule', rrule: 'FREQ=MONTHLY', anchor: 'soon' },
    { type: 'rule', rrule: 'FREQ=MONTHLY;INTERVAL=0', anchor: '2026-01-01' },
    { type: 'recurring', every: 0, unit: 'week', anchor: '2026-01-01' },
    { type: 'recurring', every: 1.5, unit: 'week', anchor: '2026-01-01' },
    { type: 'recurring', every: 1, unit: 'week', anchor: '' },
    { type: 'float', every: 0, unit: 'week' },
    { type: 'window', min: 0, max: 2, unit: 'month' },
    { type: 'seasonal', months: [] },
    { type: 'seasonal', months: [13] },
  ];

  it.each(bad.map((s) => [JSON.stringify(s), s] as const))('%s is refused and has no next date', (_, schedule) => {
    expect(validateSchedule(schedule)).not.toBeNull();
    expect(firstDue(schedule, '2026-10-30')).toBeNull();
    expect(nextDue(schedule, null, '2026-10-30')).toBeNull();
  });

  it('accepts the good ones', () => {
    for (const s of [weekly, monthly28, float6, window23, season, secondTuesday, lastWeekdayOfQuarter]) {
      expect(validateSchedule(s)).toBeNull();
    }
  });
});

describe('ticking', () => {
  it('finishes a one-time task with a completion', () => {
    const t = task({ type: 'once', from: '2026-10-30' }, '2026-10-30');
    const r = tick(t, clockAt());
    expect(r.task).toEqual({ done_at: NOW });
    expect(r.completion.id).toBe(occurrenceId('t1', '2026-10-30'));
    expect(r.completion.fields).toEqual({ task_id: 't1', done_at: NOW, previous_next: '2026-10-30', deleted_at: null });
  });

  it('keys an undated task by the day it was done', () => {
    expect(tick(task({ type: 'once' }), clockAt()).completion.id).toBe(occurrenceId('t1', '2026-10-30'));
    expect(tick(task(null), clockAt()).task).toEqual({ done_at: NOW });
  });

  it('moves a recurring task on and leaves it open, as one record', () => {
    const r = tick(task(weekly, '2026-11-07'), clockAt());
    expect(r.task).toEqual({ next_due: '2026-11-14' });
    expect(r.completion.fields.previous_next).toBe('2026-11-07');
  });

  it('gives two offline devices the same completion for one occurrence', () => {
    const t = task(weekly, '2026-11-07');
    expect(tick(t, clockAt('2026-11-01T10:00:00Z')).completion.id).toBe(tick(t, clockAt()).completion.id);
    expect(tick(t, clockAt()).completion.id).toBe(occurrenceId('t1', '2026-11-07'));
  });

  it('gives each tick of a recurring task its own completion', () => {
    const a = applied(task(weekly, '2026-11-07'));
    const b = applied(a.task);
    expect(b.completion.id).not.toBe(a.completion.id);
    expect(b.task.next_due).toBe('2026-11-21');
  });

  it('uses the local date of the finish, not the UTC one', () => {
    const r = tick(task(float6), clockAt('2026-11-01T03:00:00Z', 'America/Chicago'));
    expect(r.task.next_due).toBe('2026-12-12');
    expect(r.completion.id).toBe(occurrenceId('t1', '2026-10-31'));
  });

  it('logs a finish from a block once, and moves a recurring task on', () => {
    const block = { start: '2026-10-30T14:00:00Z', end: NOW };
    const nextDay = { start: '2026-10-31T14:00:00Z', end: '2026-10-31T15:00:00Z' };
    const t = task({ type: 'once', from: '2026-10-30' }, '2026-10-30');
    const first = applied(t);
    expect(tickFromBlock(t, [], block, clockAt())?.task).toEqual({ done_at: NOW });
    expect(tickFromBlock(first.task, [first.completion], block, clockAt())).toBeNull();

    const r = task(monthly28, '2026-10-28');
    const done = applied(r);
    expect(tickFromBlock(r, [], block, clockAt())?.task).toEqual({ next_due: '2026-11-28' });
    expect(tickFromBlock(done.task, [done.completion], block, clockAt())).toBeNull();
    // Answered a day late, the block's own day is the one it finishes, and that was done already.
    expect(tickFromBlock(done.task, [done.completion], block, clockAt('2026-10-31T15:00:00Z'))).toBeNull();
    expect(tickFromBlock(done.task, [done.completion], nextDay, clockAt('2026-10-31T15:00:00Z'))?.task).toEqual({ next_due: '2026-12-28' });
  });
});

describe('unticking', () => {
  it('restores the date of a recurring task', () => {
    const t = task(float6, '2026-11-14');
    const a = applied(t);
    const r = untick(a.task, a.completion, [a.completion], clockAt());
    expect(r.task).toEqual({ next_due: '2026-11-14' });
    expect(r.completion).toEqual({ deleted_at: NOW });
  });

  it('restores no date when the task had none', () => {
    const a = applied(task(float6));
    expect(untick(a.task, a.completion, [a.completion], clockAt()).task).toEqual({ next_due: null });
  });

  it('reopens a one-time task', () => {
    const a = applied(task({ type: 'once', from: '2026-11-03', to: '2026-11-06' }, '2026-11-03'));
    expect(untick(a.task, a.completion, [a.completion], clockAt()).task).toEqual({ done_at: null, next_due: '2026-11-03' });
  });

  it('an older completion only removes itself', () => {
    const a = applied(task(weekly, '2026-11-07'), clockAt('2026-10-03T10:00:00Z'));
    const b = applied(a.task);
    const r = untick(b.task, a.completion, [a.completion, b.completion], clockAt());
    expect(r.task).toEqual({});
    expect(r.completion).toEqual({ deleted_at: NOW });
  });

  it('a completion already removed does not count as the latest', () => {
    const a = applied(task(weekly, '2026-11-07'), clockAt('2026-10-03T10:00:00Z'));
    const b = applied(a.task);
    const removed = { ...b.completion, deleted_at: NOW };
    expect(untick(a.task, a.completion, [a.completion, removed], clockAt()).task).toEqual({ next_due: '2026-11-07' });
  });

  it('other tasks do not count as the latest', () => {
    const a = applied(task(weekly, '2026-11-07'));
    const other = { ...a.completion, id: 'c9', task_id: 't2', done_at: '2026-10-30T20:00:00Z' };
    expect(untick(a.task, a.completion, [a.completion, other], clockAt()).task).toEqual({ next_due: '2026-11-07' });
  });

  it('tells two ticks within one second apart by the date each one used up', () => {
    const a = applied(task(weekly, '2026-11-07'));
    const b = applied(a.task);
    expect(a.completion.done_at).toBe(b.completion.done_at);
    expect(untick(b.task, b.completion, [b.completion, a.completion], clockAt()).task).toEqual({ next_due: '2026-11-14' });
    expect(untick(b.task, a.completion, [b.completion, a.completion], clockAt()).task).toEqual({});
  });

  it('ticking again after an untick revives the same completion, leaving no stale entry', () => {
    const t = task(weekly, '2026-11-07');
    const a = applied(t);
    const undone = untick(a.task, a.completion, [a.completion], clockAt());
    const again = tick({ ...a.task, ...undone.task }, clockAt());
    expect(again.completion.id).toBe(a.completion.id);
    expect(again.completion.fields.deleted_at).toBeNull();
    expect(again.task).toEqual({ next_due: '2026-11-14' });
  });
});

describe('re-ticking in the finished list', () => {
  it('puts a recurring task back on the date the finish gave it', () => {
    const a = applied(task(weekly, '2026-11-07'));
    const undone = { ...a.completion, deleted_at: NOW };
    const r = retick({ ...a.task, next_due: '2026-11-07' }, undone, [undone], clockAt('2026-10-30T18:00:00Z'));
    expect(r.task).toEqual({ next_due: '2026-11-14' });
    expect(r.completion).toEqual({ deleted_at: null });
  });

  it('finishes a one-time task at its original time', () => {
    const a = applied(task({ type: 'once' }));
    const undone = { ...a.completion, deleted_at: NOW };
    const r = retick({ ...a.task, done_at: null }, undone, [undone], clockAt('2026-10-31T18:00:00Z'));
    expect(r.task).toEqual({ done_at: NOW });
  });

  it('an older completion changes no row', () => {
    const a = applied(task(weekly, '2026-11-07'), clockAt('2026-10-03T10:00:00Z'));
    const b = applied(a.task);
    const undone = { ...a.completion, deleted_at: NOW };
    expect(retick(b.task, undone, [undone, b.completion], clockAt()).task).toEqual({});
  });
});

describe('rows and the day changing', () => {
  const rowsAt = (tasks: Task[], completions: TaskCompletion[], at: string, zone = 'UTC') =>
    oneOffRows(tasks, completions, clockAt(at, zone));

  it('a finished one-time task stays ticked all day, then clears', () => {
    const a = applied(task({ type: 'once', from: '2026-10-30' }, '2026-10-30'));
    const today = rowsAt([a.task], [a.completion], '2026-10-30T23:59:00Z');
    expect(today).toHaveLength(1);
    expect(today[0]!.checked).toBe(true);
    expect(today[0]!.completion?.id).toBe(a.completion.id);
    expect(rowsAt([a.task], [a.completion], '2026-10-31T00:00:00Z')).toEqual([]);
  });

  it('a recurring task stays one row, ticked today and open tomorrow, on its new date', () => {
    const a = applied(task(weekly, '2026-11-07'));
    const today = rowsAt([a.task], [a.completion], NOW);
    expect(today[0]!.checked).toBe(true);
    expect(today[0]!.task.next_due).toBe('2026-11-14');
    const tomorrow = rowsAt([a.task], [a.completion], '2026-10-31T00:00:00Z');
    expect(tomorrow).toHaveLength(1);
    expect(tomorrow[0]!.checked).toBe(false);
    expect(tomorrow[0]!.completion).toBeUndefined();
    expect(tomorrow[0]!.task.next_due).toBe('2026-11-14');
  });

  it('the day changes at local midnight', () => {
    const a = applied(task({ type: 'once' }), clockAt('2026-10-31T03:00:00Z', 'America/Chicago'));
    expect(rowsAt([a.task], [a.completion], '2026-10-31T04:59:00Z', 'America/Chicago')).toHaveLength(1);
    expect(rowsAt([a.task], [a.completion], '2026-10-31T05:00:00Z', 'America/Chicago')).toHaveLength(0);
  });

  it('a cleared one-time task returns when reopened from the finished list', () => {
    const a = applied(task({ type: 'once', from: '2026-11-02', to: '2026-11-06' }, '2026-11-02'));
    const later = clockAt('2026-11-01T10:00:00Z');
    const undone = untick(a.task, a.completion, [a.completion], later);
    const rows = oneOffRows([{ ...a.task, ...undone.task }], [{ ...a.completion, ...undone.completion }], later);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.checked).toBe(false);
    expect(rows[0]!.task.next_due).toBe('2026-11-02');
  });

  it('an unticked task reads as open at once', () => {
    const a = applied(task(weekly, '2026-11-07'));
    const u = untick(a.task, a.completion, [a.completion], clockAt());
    const row = rowsAt([{ ...a.task, ...u.task }], [{ ...a.completion, ...u.completion }], NOW)[0]!;
    expect(row.checked).toBe(false);
    expect(row.task.next_due).toBe('2026-11-07');
  });

  it('after two ticks today the row offers the latest one to undo', () => {
    const a = applied(task(weekly, '2026-11-07'));
    const b = applied(a.task);
    expect(rowsAt([b.task], [b.completion, a.completion], NOW)[0]!.completion?.id).toBe(b.completion.id);
  });

  it('leaves out deleted, cancelled and non one-off tasks', () => {
    const rows = rowsAt(
      [
        task({ type: 'once' }, null, { id: 'a', deleted_at: NOW }),
        task({ type: 'once' }, null, { id: 'b', cancelled_at: NOW }),
        task(null, null, { id: 'c', kind: 'project' }),
        task(null, null, { id: 'd', kind: 'inbox' }),
        task({ type: 'once' }, null, { id: 'e' }),
      ],
      [],
      NOW,
    );
    expect(rows.map((r) => r.task.id)).toEqual(['e']);
  });

  it('puts the soonest date first and undated ones last, in the order given', () => {
    const rows = rowsAt(
      [
        task({ type: 'once' }, null, { id: 'a' }),
        task({ type: 'once', from: '2026-12-01' }, '2026-12-01', { id: 'b' }),
        task(weekly, '2026-11-07', { id: 'c' }),
        task({ type: 'once' }, null, { id: 'd' }),
      ],
      [],
      NOW,
    );
    expect(rows.map((r) => r.task.id)).toEqual(['c', 'b', 'a', 'd']);
  });
});

describe('releasing blocks', () => {
  const block = (id: string, start: string, extra: Partial<TimeBlock> = {}): TimeBlock => ({
    id,
    task_id: 't1',
    start,
    end: start,
    tz: 'UTC',
    ...extra,
  });

  it('frees unstarted future blocks before the new next date', () => {
    const blocks = [
      block('soon', '2026-11-06T18:00:00Z'),
      block('past', '2026-10-29T18:00:00Z'),
      block('started', '2026-10-31T18:00:00Z', { started_at: NOW }),
      block('gone', '2026-10-31T18:00:00Z', { cancelled: true }),
      block('deleted', '2026-10-31T18:00:00Z', { deleted_at: NOW }),
      block('other', '2026-10-31T18:00:00Z', { task_id: 't2' }),
      block('next-occurrence', '2026-11-14T18:00:00Z'),
    ];
    const t = task(weekly, '2026-11-14');
    expect(blocksToRelease(blocks, t, clockAt()).map((b) => b.id)).toEqual(['soon']);
  });

  it('frees all of them when the schedule has ended, and none for a one-time task', () => {
    const blocks = [block('a', '2030-01-01T18:00:00Z')];
    expect(blocksToRelease(blocks, task(weekly, null), clockAt())).toHaveLength(1);
    expect(blocksToRelease(blocks, task({ type: 'once' }), clockAt())).toHaveLength(0);
  });
});

describe('wording', () => {
  it.each<[string, TaskSchedule]>([
    ['Daily', { type: 'recurring', every: 1, unit: 'day', anchor: '2026-01-01' }],
    ['Weekly', weekly],
    ['Weekly on Mon and Thu', { ...weekly, days: [0, 3] }],
    ['Weekly on Mon, Tue and Fri', { ...weekly, days: [4, 0, 1] }],
    ['Every weekday', { ...weekly, days: [0, 1, 2, 3, 4] }],
    ['Daily', { ...weekly, days: [0, 1, 2, 3, 4, 5, 6] }],
    ['Every 2 weeks', { ...weekly, every: 2 }],
    ['Every 2 weeks on Mon and Thu', { ...weekly, every: 2, days: [0, 3] }],
    ['Monthly on the 28th', monthly28],
    ['Monthly on the 1st', { type: 'recurring', every: 1, unit: 'month', anchor: '2026-01-01' }],
    ['Monthly on the 2nd', { type: 'recurring', every: 1, unit: 'month', anchor: '2026-01-02' }],
    ['Monthly on the 3rd', { type: 'recurring', every: 1, unit: 'month', anchor: '2026-01-03' }],
    ['Monthly on the 11th', { type: 'recurring', every: 1, unit: 'month', anchor: '2026-01-11' }],
    ['Monthly on the 22nd', { type: 'recurring', every: 1, unit: 'month', anchor: '2026-01-22' }],
    ['Every 3 months on the 5th', { type: 'recurring', every: 3, unit: 'month', anchor: '2026-01-05' }],
    ['Yearly', { type: 'recurring', every: 1, unit: 'year', anchor: '2026-01-01' }],
    ['6 weeks after last done', float6],
    ['1 month after last done', { type: 'float', every: 1, unit: 'month' }],
    ['Every 2 to 3 months', window23],
    ['Every 4 months', { type: 'window', min: 4, max: 4, unit: 'month' }],
    ['In April and October', season],
    ['In March, June and October', { type: 'seasonal', months: [10, 3, 6] }],
    ['In June', { type: 'seasonal', months: [6] }],
    ['Every month on the 2nd Tuesday', secondTuesday],
    ['Every March, June, September and December on the last weekday', lastWeekdayOfQuarter],
    ['Every month on the 1st weekday', { type: 'rule', rrule: 'FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=1', anchor: '2026-01-01' }],
    ['Every month on the last day', { type: 'rule', rrule: 'FREQ=MONTHLY;BYMONTHDAY=-1', anchor: '2026-01-01' }],
  ])('%s', (label, schedule) => {
    expect(scheduleLabel(schedule)).toBe(label);
  });

  const line = (t: Task, completions: TaskCompletion[] = []) => rowLine(oneOffRows([t], completions, clockAt())[0]!);

  it('reads a one-time task with no date, a day or a range', () => {
    expect(line(task({ type: 'once' }))).toBe('No date');
    expect(line(task({ type: 'once', from: '2026-12-01' }, '2026-12-01'))).toBe('Dec 1');
    expect(line(task({ type: 'once', from: '2026-11-03', to: '2026-11-06' }, '2026-11-03', { estimate_min: 90 }))).toBe('Nov 3 to Nov 6, 1h 30m');
  });

  it('reads each repeating type with its next date', () => {
    expect(line(task(weekly, '2026-11-07', { estimate_min: 60 }))).toBe('Weekly, next Sat Nov 7, 1h');
    expect(line(task(monthly28, '2026-11-28', { estimate_min: 30 }))).toBe('Monthly on the 28th, next Nov 28, 30m');
    expect(line(task(float6, '2026-11-14'))).toBe('6 weeks after last done, next about Nov 14');
    expect(line(task(float6))).toBe('6 weeks after last done, next after first done');
    expect(line(task(window23, '2026-11-05'))).toBe('Every 2 to 3 months, next between Nov 5 and Dec 5');
    expect(line(task(season, '2027-04-01'))).toBe('In April and October, next in April');
    expect(line(task(secondTuesday, '2026-11-10'))).toBe('Every month on the 2nd Tuesday, next Nov 10');
  });

  it('says when a schedule has no more dates', () => {
    expect(line(task({ type: 'rule', rrule: 'FREQ=MONTHLY;COUNT=1', anchor: '2026-01-01' }))).toBe('Every month for 1 time, no more dates');
  });

  it('reads a ticked row', () => {
    const once = applied(task({ type: 'once' }, null, { estimate_min: 30 }));
    expect(line(once.task, [once.completion])).toBe('Done today');
    const weeklyDone = applied(task(weekly, '2026-11-07', { estimate_min: 60 }));
    expect(line(weeklyDone.task, [weeklyDone.completion])).toBe('Done today, next Sat Nov 14');
    const floatDone = applied(task(float6, '2026-11-14'));
    expect(line(floatDone.task, [floatDone.completion])).toBe('Done today, next about Dec 11');
    const windowDone = applied(task(window23, '2026-11-05'));
    expect(line(windowDone.task, [windowDone.completion])).toBe('Done today, next between Dec 30 and Jan 30');
    const seasonDone = applied(task({ type: 'seasonal', months: [4, 11] }, '2026-11-01'));
    expect(line(seasonDone.task, [seasonDone.completion])).toBe('Done today, next in April');
  });
});

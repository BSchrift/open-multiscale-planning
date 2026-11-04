import { describe, expect, it } from 'vitest';
import { fixedClock } from './clock';
import type { BlockRow } from './queries';
import { DEFAULT_SETTINGS } from './records';
import {
  checkInDue,
  missedBlocks,
  practicesToLog,
  REMINDER_ACTION,
  REMINDER_LIMIT,
  reminderRange,
  remindersToSchedule,
  snoozeUntil,
} from './reminders';
import type { AwayPeriod, Reminder } from './types';

const settings = DEFAULT_SETTINGS.reminders;
const clock = fixedClock('2026-11-02T09:00:00Z');
const day = (time: string) => `2026-11-02T${time}:00Z`;

const block = (id: string, start: string, end: string, over: Partial<BlockRow> = {}): BlockRow => ({
  id,
  start,
  end,
  tz: 'UTC',
  task_id: `task-${id}`,
  practice_id: null,
  started_at: null,
  ended_at: null,
  title: 'Paint the fence',
  task_kind: 'one_off',
  result: null,
  ...over,
});

const a = block('a', day('10:00'), day('11:00'));
const kindsAt = (rs: Reminder[]) => rs.map((r) => [r.kind, r.at]);
const titles = (r: Reminder | undefined) => r!.actions.map((x) => x.title);

describe('which reminders a block gets', () => {
  it('start, check-in after the delay, and end, each with a stable id', () => {
    const rs = remindersToSchedule([a], settings, [], clock);
    expect(kindsAt(rs)).toEqual([
      ['block_start', day('10:00')],
      ['check_in', day('10:05')],
      ['block_end', day('11:00')],
    ]);
    expect(rs.every((r) => r.block_id === 'a')).toBe(true);
    expect(new Set(rs.map((r) => r.id)).size).toBe(3);
    expect(remindersToSchedule([a], settings, [], clock).map((r) => r.id)).toEqual(rs.map((r) => r.id));
  });

  it('uses the configured delay', () => {
    const rs = remindersToSchedule([a], { ...settings, check_in_delay_min: 15 }, [], clock);
    expect(rs[1]).toMatchObject({ kind: 'check_in', at: day('10:15') });
  });

  it('asks the right questions', () => {
    const [start, check, end] = remindersToSchedule([a], settings, [], clock);
    expect(start).toMatchObject({ title: 'Paint the fence' });
    expect(titles(start)).toEqual(['Start', 'Do next block instead']);
    expect(check).toMatchObject({ title: 'Have you started?', body: 'Paint the fence' });
    expect(titles(check)).toEqual(['Yes, started', 'Ask again in 10 minutes', 'Do next block instead', 'Skip, choose a new time later']);
    expect(end).toMatchObject({ title: 'Block ended', body: 'Did you finish Paint the fence?' });
    expect(titles(end)).toEqual(['Done', 'Partly', 'Not done', 'Still going']);
  });

  it('only Partly needs the app in front, to ask for the time left', () => {
    const end = remindersToSchedule([a], settings, [], clock)[2]!;
    expect(end.actions.filter((x) => x.opens_app).map((x) => x.id)).toEqual([REMINDER_ACTION.partly]);
  });

  it('a practice ends by logging time, and a short one still gets all three', () => {
    const practice = block('p', day('10:00'), day('10:04'), { task_id: null, practice_id: 'pr1', task_kind: null, title: 'Piano practice' });
    const rs = remindersToSchedule([practice], settings, [], clock);
    expect(rs.map((r) => r.kind)).toEqual(['block_start', 'check_in', 'block_end']);
    expect(rs[1]!.at < rs[2]!.at).toBe(true);
    expect(titles(rs[2])).toEqual(['All 4m', 'Skip']);
    expect(rs[2]!.body).toBe('Piano practice');
  });

  it('still names a block whose title is gone', () => {
    const rs = remindersToSchedule([block('x', day('10:00'), day('11:00'), { title: null })], settings, [], clock);
    expect(rs[0]!.title).toBe('Time block');
  });
});

describe('settings', () => {
  it('turn each kind off on its own', () => {
    const kinds = (over: Partial<typeof settings>) => remindersToSchedule([a], { ...settings, ...over }, [], clock).map((r) => r.kind);
    expect(kinds({ block_start: false })).toEqual(['check_in', 'block_end']);
    expect(kinds({ check_in: false })).toEqual(['block_start', 'block_end']);
    expect(kinds({ block_end: false })).toEqual(['block_start', 'check_in']);
    expect(kinds({ block_start: false, check_in: false, block_end: false })).toEqual([]);
  });
});

describe('away dates', () => {
  const away: AwayPeriod[] = [{ id: 'a1', start: '2026-11-02', end: '2026-11-03' }];

  it('schedule nothing', () => {
    expect(remindersToSchedule([a], settings, away, clock)).toEqual([]);
  });

  it('leave blocks after them alone', () => {
    const later = block('l', '2026-11-04T10:00:00Z', '2026-11-04T11:00:00Z');
    expect(remindersToSchedule([a, later], settings, away, clock).map((r) => r.block_id)).toEqual(['l', 'l', 'l']);
  });

  it('are local dates, not UTC ones', () => {
    const chicago = fixedClock('2026-11-02T09:00:00Z', 'America/Chicago');
    // 03:00 UTC on the 3rd is still the evening of the 2nd in Chicago.
    const previousEvening = block('e', '2026-11-03T03:00:00Z', '2026-11-03T04:00:00Z');
    const onThe2nd: AwayPeriod[] = [{ id: 'a1', start: '2026-11-02', end: '2026-11-02' }];
    expect(remindersToSchedule([previousEvening], settings, onThe2nd, chicago)).toHaveLength(0);
    const onThe3rd: AwayPeriod[] = [{ id: 'a1', start: '2026-11-03', end: '2026-11-03' }];
    expect(remindersToSchedule([previousEvening], settings, onThe3rd, chicago)).toHaveLength(3);
  });

  it('ignore a removed period', () => {
    expect(remindersToSchedule([a], settings, [{ ...away[0]!, deleted_at: day('08:00') }], clock)).toHaveLength(3);
  });
});

describe('time passing and what cancels what', () => {
  it('drops what has already fired, keeping the rest of a running block', () => {
    const at = fixedClock(day('10:02'));
    expect(remindersToSchedule([a], settings, [], at).map((r) => r.kind)).toEqual(['check_in', 'block_end']);
    at.set(day('10:30'));
    expect(remindersToSchedule([a], settings, [], at).map((r) => r.kind)).toEqual(['block_end']);
    at.set(day('11:00'));
    expect(remindersToSchedule([a], settings, [], at)).toEqual([]);
  });

  it('starting a block leaves only its end', () => {
    const started = { ...a, started_at: day('09:59') };
    expect(remindersToSchedule([started], settings, [], clock).map((r) => r.kind)).toEqual(['block_end']);
  });

  it('ending a block or answering it leaves nothing', () => {
    expect(remindersToSchedule([{ ...a, ended_at: day('09:59') }], settings, [], clock)).toEqual([]);
    expect(remindersToSchedule([{ ...a, result: 'done' }], settings, [], clock)).toEqual([]);
    expect(remindersToSchedule([{ ...a, result: 'not' }], settings, [], clock)).toEqual([]);
  });
});

describe('Ask again in 10 minutes', () => {
  it('moves the check-in, and survives a reschedule after the first one fired', () => {
    const at = fixedClock(day('10:05'));
    const snoozed = { a: snoozeUntil(at) };
    expect(snoozed.a).toBe(day('10:15'));
    const rs = remindersToSchedule([a], settings, [], at, snoozed);
    expect(kindsAt(rs)).toEqual([
      ['check_in', day('10:15')],
      ['block_end', day('11:00')],
    ]);
  });

  it('keeps the same id, so it replaces rather than adds', () => {
    const before = remindersToSchedule([a], settings, [], clock)[1]!;
    const after = remindersToSchedule([a], settings, [], clock, { a: day('10:15') })[1]!;
    expect(after.id).toBe(before.id);
  });

  it('is dropped once started, or when it would land at or after the end', () => {
    expect(remindersToSchedule([{ ...a, started_at: day('10:06') }], settings, [], fixedClock(day('10:07')), { a: day('10:15') }).map((r) => r.kind)).toEqual(['block_end']);
    expect(remindersToSchedule([a], settings, [], fixedClock(day('10:55')), { a: day('11:05') }).map((r) => r.kind)).toEqual(['block_end']);
  });
});

describe('the soonest 64', () => {
  const many = Array.from({ length: 40 }, (_, i) => {
    const start = Date.parse(day('10:00')) + i * 3_600_000;
    return block(`b${String(i).padStart(2, '0')}`, new Date(start).toISOString().replace('.000Z', 'Z'), new Date(start + 1_800_000).toISOString().replace('.000Z', 'Z'));
  });

  it('keeps only the soonest, in time order', () => {
    const rs = remindersToSchedule(many.toReversed(), settings, [], clock);
    expect(rs).toHaveLength(REMINDER_LIMIT);
    expect(REMINDER_LIMIT).toBe(64);
    const times = rs.map((r) => r.at);
    expect(times).toEqual(times.toSorted());
    expect(rs[0]!.block_id).toBe('b00');
    // 21 whole blocks at three each, then the first of the 22nd.
    expect(rs[63]).toMatchObject({ block_id: 'b21', kind: 'block_start' });
  });

  it('muted and answered blocks use up none of the 64', () => {
    const rs = remindersToSchedule([{ ...many[0]!, result: 'done' }, ...many.slice(1)], settings, [], clock);
    expect(rs[0]!.block_id).toBe('b01');
    expect(rs).toHaveLength(REMINDER_LIMIT);
  });

  it('reads enough of the calendar to fill them, and includes a block already running', () => {
    expect(reminderRange(clock)).toEqual({ from_utc: '2026-11-01T09:00:00Z', to_utc: '2026-11-30T09:00:00Z' });
  });
});

describe('several missed blocks', () => {
  const at = fixedClock(day('21:10'));
  const task = (id: string, from: string, to: string, over: Partial<BlockRow> = {}) => block(id, day(from), day(to), { title: `Work ${id}`, ...over });
  const three = [task('a', '17:30', '18:00'), task('b', '18:00', '19:00'), task('c', '20:00', '21:00')];

  it('are every work block that ended with no answer', () => {
    expect(missedBlocks(three, [], at).map((b) => b.id)).toEqual(['a', 'b', 'c']);
    expect(missedBlocks([three[0]!], [], at).map((b) => b.id)).toEqual(['a']);
  });

  it('count down as they are answered', () => {
    const answered = [{ ...three[0]!, result: 'done' as const }, three[1]!, three[2]!];
    expect(missedBlocks(answered, [], at).map((b) => b.id)).toEqual(['b', 'c']);
  });

  it('leaves out blocks still running or to come, ended early, and practices, which just pass', () => {
    const others = [
      task('running', '21:00', '21:30'),
      task('next', '22:00', '23:00'),
      task('ended', '16:00', '17:00', { ended_at: day('16:30') }),
      task('practice', '15:00', '15:30', { task_id: null, practice_id: 'pr1' }),
    ];
    expect(missedBlocks([...three, ...others], [], at).map((b) => b.id)).toEqual(['a', 'b', 'c']);
  });

  it('includes a block that was started but never answered', () => {
    expect(missedBlocks([task('s', '20:00', '21:00', { started_at: day('20:00') })], [], at).map((b) => b.id)).toEqual(['s']);
  });

  it('leaves out away dates, which were muted', () => {
    const away: AwayPeriod[] = [{ id: 'a1', start: '2026-11-02', end: '2026-11-02' }];
    expect(missedBlocks(three, away, at)).toEqual([]);
  });

  it('is oldest first whatever order they arrive in', () => {
    expect(missedBlocks(three.toReversed(), [], at).map((b) => b.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('the in-app check-in', () => {
  it('asks at the same time as the notification, until started, answered or snoozed', () => {
    expect(checkInDue([a], settings, [], fixedClock(day('10:04')))).toBeUndefined();
    expect(checkInDue([a], settings, [], fixedClock(day('10:05')))?.id).toBe('a');
    expect(checkInDue([{ ...a, started_at: day('10:01') }], settings, [], fixedClock(day('10:06')))).toBeUndefined();
    expect(checkInDue([{ ...a, result: 'not' }], settings, [], fixedClock(day('10:06')))).toBeUndefined();
    expect(checkInDue([a], settings, [], fixedClock(day('10:06')), { a: day('10:15') })).toBeUndefined();
    expect(checkInDue([a], settings, [], fixedClock(day('10:15')), { a: day('10:15') })?.id).toBe('a');
  });

  it('stops once the block is over, and stays quiet when switched off or away', () => {
    expect(checkInDue([a], settings, [], fixedClock(day('11:00')))).toBeUndefined();
    expect(checkInDue([a], { ...settings, check_in: false }, [], fixedClock(day('10:06')))).toBeUndefined();
    expect(checkInDue([a], settings, [{ id: 'x', start: '2026-11-02', end: '2026-11-02' }], fixedClock(day('10:06')))).toBeUndefined();
  });

  it('asks halfway through a block shorter than the delay', () => {
    const short = block('s', day('10:00'), day('10:04'));
    expect(checkInDue([short], settings, [], fixedClock(day('10:02')))?.id).toBe('s');
  });
});

describe('practices to log', () => {
  const practice = (id: string, from: string, to: string, over: Partial<BlockRow> = {}) =>
    block(id, from, to, { task_id: null, practice_id: 'pr1', task_kind: null, title: 'Piano practice', ...over });

  it('are the ended, unanswered practice blocks of today, oldest first; earlier days just pass', () => {
    const at = fixedClock(day('21:00'));
    const blocks = [
      practice('late', day('19:00'), day('19:30')),
      practice('early', day('08:00'), day('08:30')),
      practice('answered', day('09:00'), day('09:30'), { result: 'done' }),
      practice('running', day('20:45'), day('21:15')),
      practice('yesterday', '2026-11-01T08:00:00Z', '2026-11-01T08:30:00Z'),
      block('task', day('10:00'), day('11:00')),
    ];
    expect(practicesToLog(blocks, [], at).map((b) => b.id)).toEqual(['early', 'late']);
    expect(practicesToLog(blocks, [{ id: 'x', start: '2026-11-02', end: '2026-11-02' }], at)).toEqual([]);
  });
});

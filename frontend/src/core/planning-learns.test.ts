import { describe, expect, it } from 'vitest';
import { fixedClock } from './clock';
import { addDays, localToInstant } from './dates';
import {
  addPlanningMinutes,
  loadWeekPlanning,
  nextPlanningTime,
  planningTimes,
  rowState,
  timeLeft,
  usualTime,
  weekEstimate,
  weekPlanningId,
} from './planning';
import { DEFAULT_SETTINGS, getRecord, transact, weekPlanId } from './records';
import type { Writer } from './records';
import type { WeekPlan } from './types';
import { openTestDb } from '../platform/node-sqlite';

// The week of Nov 16 is planned from Friday, Nov 13, in Chicago.
const ZONE = 'America/Chicago';
const WEEK = '2026-11-16';
const ID = weekPlanningId(WEEK);
const at = (date: string, time: string) => {
  const [h, m] = time.split(':').map(Number);
  return localToInstant(date, h! * 60 + (m ?? 0), ZONE);
};
const FRIDAY = at('2026-11-13', '10:00');

/** A finished week, planned for some minutes, starting on a day and time. */
const done = (week: string, minutes: number | null, started?: string): WeekPlan => ({
  id: weekPlanId(week),
  week_start: week,
  finished_at: at(week, '08:00'),
  ...(minutes !== null ? { planning_min: minutes } : {}),
  ...(started ? { planning_started_at: started } : {}),
});

describe('how long planning takes', () => {
  it('is the middle of the last 4 measured weeks, rounded up to 15, from 15m to 2h', () => {
    const plans = [done('2026-10-12', 50), done('2026-10-19', 22), done('2026-10-26', 31), done('2026-11-02', 40), done('2026-11-09', 46)];
    expect(weekEstimate(3, plans)).toEqual({ minutes: 45, guess: false, from: 4 });
    expect(weekEstimate(3, [done('2026-11-09', 7)])).toEqual({ minutes: 15, guess: false, from: 1 });
    expect(weekEstimate(3, [done('2026-11-09', 200)])).toEqual({ minutes: 120, guess: false, from: 1 });
  });

  it('learns only from finished plans of at least 5 active minutes', () => {
    const plans = [done('2026-11-02', 2), { ...done('2026-11-09', 60), finished_at: null }];
    expect(weekEstimate(3, plans)).toMatchObject({ minutes: 30, guess: true });
  });

  it('after stopping early, is what is left, rounded up, and at least 15m', () => {
    expect(timeLeft(30, 12)).toBe(30);
    expect(timeLeft(30, 20)).toBe(15);
    expect(timeLeft(45, 50)).toBe(15);
  });
});

describe('your usual time', () => {
  it('is the weekday and quarter hour planning began in 2 of the last 3 plans', () => {
    const plans = [
      done('2026-10-19', 30, at('2026-10-18', '17:07')),
      done('2026-10-26', 30, at('2026-10-24', '09:30')),
      done('2026-11-02', 30, at('2026-11-01', '17:12')),
      done('2026-11-09', 30, at('2026-11-07', '10:00')),
    ];
    // The last three began Saturday 9:30, Sunday 5:12pm and Saturday 10am: no pair.
    expect(usualTime(plans, ZONE)).toBeNull();
    expect(usualTime(plans.slice(0, 3), ZONE)).toEqual({ day: 6, minutes: 17 * 60 });
  });

  it('comes first among the times offered when it is free', () => {
    const clock = fixedClock(FRIDAY, ZONE);
    const input = { settings: DEFAULT_SETTINGS, calendar: null, sources: [], blocks: [], clock };
    expect(planningTimes(WEEK, 30, input, { day: 6, minutes: 17 * 60 })[0]).toEqual({ date: '2026-11-15', start: 17 * 60, end: 17 * 60 + 30, usual: true });
    const busy = [{ id: 'b', start: at('2026-11-15', '16:00'), end: at('2026-11-15', '18:00') }];
    expect(planningTimes(WEEK, 30, { ...input, blocks: busy }, { day: 6, minutes: 17 * 60 }).some((s) => s.usual)).toBe(false);
  });
});

describe('the minutes measured', () => {
  it('add up each time the flow closes, and the first records when planning began', async () => {
    const clock = fixedClock(FRIDAY, ZONE);
    const db = await openTestDb();
    const run = <R>(fn: (w: Writer) => Promise<R>) => transact(db, clock, fn);
    await run((w) => addPlanningMinutes(w, WEEK, 12, FRIDAY));
    await run((w) => addPlanningMinutes(w, WEEK, 9, at('2026-11-14', '09:00')));
    expect(await getRecord(db, 'week_plan', weekPlanId(WEEK))).toMatchObject({ planning_min: 21, planning_started_at: FRIDAY });
  });
});

describe('the row once something has happened', () => {
  const setup = async (now: string, seed: (w: Writer) => Promise<unknown>) => {
    const clock = fixedClock(now, ZONE);
    const db = await openTestDb();
    await transact(db, clock, async (w) => {
      await w.create('task', { kind: 'planning', title: 'Plan the week of Nov 16', plans: [`week:${WEEK}`] }, ID);
      await seed(w);
    });
    return { clock, p: await loadWeekPlanning(db, WEEK) };
  };

  it('says the time passed when the block went by and planning never opened', async () => {
    const t = await setup(at('2026-11-14', '12:00'), (w) =>
      w.create('time_block', { task_id: ID, start: at('2026-11-14', '09:00'), end: at('2026-11-14', '09:30'), tz: ZONE }),
    );
    expect(rowState(t.p, t.clock)).toBe('passed');
  });

  it('says planning stopped once it began and wasn’t finished, with no block still ahead', async () => {
    const t = await setup(at('2026-11-14', '12:00'), (w) => w.create('week_plan', { week_start: WEEK, planning_min: 12, planning_started_at: FRIDAY }, weekPlanId(WEEK)));
    expect(rowState(t.p, t.clock)).toBe('stopped');
    const ahead = await setup(at('2026-11-14', '12:00'), async (w) => {
      await w.create('week_plan', { week_start: WEEK, planning_min: 12, planning_started_at: FRIDAY }, weekPlanId(WEEK));
      await w.create('time_block', { task_id: ID, start: at('2026-11-15', '09:00'), end: at('2026-11-15', '09:30'), tz: ZONE });
    });
    expect(rowState(ahead.p, ahead.clock)).toBeNull();
  });

  it('asks for a time when nothing has happened yet', async () => {
    const t = await setup(FRIDAY, async () => undefined);
    expect(rowState(t.p, t.clock)).toBe('ask');
  });
});

describe("Review's next planning time", () => {
  const clock = (now: string) => fixedClock(now, ZONE);
  const input = (now: string) => ({ settings: DEFAULT_SETTINGS, calendar: null, sources: [], blocks: [], clock: clock(now) });

  it('is the same time a week on, when this session began before its week or on its first day', () => {
    const sunday = at('2026-11-15', '17:05');
    expect(nextPlanningTime(WEEK, sunday, 30, input(at('2026-11-15', '17:40')))).toEqual({
      slot: { date: '2026-11-22', start: 17 * 60, end: 17 * 60 + 30 },
      same: true,
    });
    const monday = at(WEEK, '08:10');
    expect(nextPlanningTime(WEEK, monday, 30, input(at(WEEK, '08:40')))?.slot.date).toBe('2026-11-23');
  });

  it('after a catch-up plan later in the week, is the best free time before the following week starts', () => {
    const wednesday = at('2026-11-18', '19:00');
    const next = nextPlanningTime(WEEK, wednesday, 30, input(at('2026-11-18', '19:30')));
    expect(next?.same).toBe(false);
    expect(next!.slot.date < addDays(WEEK, 7)).toBe(true);
  });
});

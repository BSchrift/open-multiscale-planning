import { describe, expect, it } from 'vitest';
import { fixedClock } from './clock';
import { localToInstant } from './dates';
import { applyPlanChange } from './plan';
import {
  addStretchMinutes,
  deletePlanning,
  finishStretchPlanning,
  makeDuePlanningTasks,
  planningTimes,
  schedulePlanning,
  startPlanning,
  stretchEstimate,
  stretchPlanningDue,
  stretchPlanningId,
} from './planning';
import { DEFAULT_SETTINGS, getRecord, getSettings, listRecords, SETTINGS_ID, transact, weekPlanId } from './records';
import type { Writer } from './records';
import type { Settings } from './types';
import { openTestDb } from '../platform/node-sqlite';

// Quarters, the last one planned: Jan 1 to Mar 31 is next, and its planning opens on Thursday, Dec 24, in Chicago.
const ZONE = 'America/Chicago';
const at = (date: string, time: string) => {
  const [h, m] = time.split(':').map(Number);
  return localToInstant(date, h! * 60 + (m ?? 0), ZONE);
};
const NEXT = { start: '2027-01-01', end: '2027-03-31' };
const ID = stretchPlanningId(NEXT.start);
const QUARTERS: Partial<Settings> = { plan_cadence: { every: 1, unit: 'quarters', anchor: '2026-10-01' }, plan_stretch: { last_planned: '2026-10-01' } };
const THURSDAY = at('2026-12-24', '10:00');

async function setup(now = THURSDAY, settings: Partial<Settings> = QUARTERS, seed: (w: Writer) => Promise<unknown> = async () => undefined) {
  const clock = fixedClock(now, ZONE);
  const db = await openTestDb();
  await transact(db, clock, async (w) => {
    await w.create('settings', settings, SETTINGS_ID);
    // This week planned, so only the stretch's task is due.
    await w.create('week_plan', { week_start: '2026-12-21', finished_at: at('2026-12-21', '08:00') }, weekPlanId('2026-12-21'));
    await seed(w);
  });
  const run = <R>(fn: (w: Writer) => Promise<R>) => transact(db, clock, fn);
  return { clock, db, run, task: () => getRecord(db, 'task', ID) };
}

describe("the stretch's planning task", () => {
  it('is made from a week before the stretch ends, named with its dates, with no time', async () => {
    const t = await setup();
    await t.run((w) => makeDuePlanningTasks(w, t.clock));
    expect(await t.task()).toMatchObject({ kind: 'planning', title: 'Plan Jan 1 to Mar 31', plans: ['stretch:2027-01-01'], estimate_min: 45 });
    expect(await listRecords(t.db, 'time_block')).toEqual([]);
    const early = await setup(at('2026-12-23', '10:00'));
    await early.run((w) => makeDuePlanningTasks(w, early.clock));
    expect(await early.task()).toBeUndefined();
  });

  it('is never made without a planning cadence', async () => {
    const t = await setup(THURSDAY, { plan_cadence: null, plan_stretch: {} });
    await t.run((w) => makeDuePlanningTasks(w, t.clock));
    expect((await listRecords(t.db, 'task')).filter((x) => x.id.startsWith('planning:stretch:'))).toEqual([]);
  });

  it('for a first plan is due at once, for the stretch under way, and guesses an hour', async () => {
    const settings = { plan_cadence: QUARTERS.plan_cadence!, plan_stretch: {} };
    expect(stretchPlanningDue({ ...DEFAULT_SETTINGS, ...settings }, '2026-11-13')).toEqual({ stretch: { start: '2026-10-01', end: '2026-12-31' }, first: true });
    expect(stretchEstimate({ ...DEFAULT_SETTINGS, ...settings }, true)).toEqual({ minutes: 60, guess: true });
  });

  it('is not made again once deleted', async () => {
    const t = await setup();
    await t.run((w) => makeDuePlanningTasks(w, t.clock));
    await t.run((w) => deletePlanning(w, { stretch: NEXT, first: false }, t.clock));
    await t.run((w) => makeDuePlanningTasks(w, t.clock));
    expect((await t.task())?.deleted_at).toBe(THURSDAY);
  });
});

describe('how long planning a stretch takes', () => {
  it('guesses 45 minutes after the first, then is the middle of the last 3 measured stretches', () => {
    const with_ = (history: number[]) => ({ ...DEFAULT_SETTINGS, stretch_planning: { start: '2026-10-01', history } });
    expect(stretchEstimate(DEFAULT_SETTINGS, false)).toEqual({ minutes: 45, guess: true });
    expect(stretchEstimate(with_([90, 20, 50, 70]), false)).toEqual({ minutes: 60, guess: false, from: 3 });
    expect(stretchEstimate(with_([3]), false)).toEqual({ minutes: 45, guess: true });
  });

  it('adds the minutes of each time in the flow to the stretch being planned', async () => {
    const t = await setup();
    await t.run((w) => addStretchMinutes(w, NEXT.start, 12, THURSDAY));
    await t.run((w) => addStretchMinutes(w, NEXT.start, 9, at('2026-12-25', '09:00')));
    expect((await getSettings(t.db)).stretch_planning).toEqual({ start: NEXT.start, started_at: THURSDAY, min: 21 });
  });
});

describe('the times offered for a stretch', () => {
  it('are before it starts, across both weeks', () => {
    const clock = fixedClock(at('2026-12-26', '21:30'), ZONE);
    const input = { settings: DEFAULT_SETTINGS, calendar: null, sources: [], blocks: [], clock };
    expect(planningTimes({ stretch: NEXT, first: false }, 45, input).map((s) => s.date)).toEqual(['2026-12-27', '2026-12-28', '2026-12-29']);
  });
});

describe('Start and Finish for a stretch', () => {
  const p = { stretch: NEXT, first: false };

  it('Start places a block from now for the estimate; Finish closes the task, frees a block ahead, and keeps the minutes', async () => {
    const t = await setup();
    const { until } = await t.run((w) => startPlanning(w, p, undefined, t.clock));
    expect(until).toBe(at('2026-12-24', '10:45'));
    await t.run((w) => schedulePlanning(w, p, { start: at('2026-12-26', '09:00'), end: at('2026-12-26', '09:45') }, t.clock));
    t.clock.set(at('2026-12-24', '10:20'));
    await t.run((w) => addStretchMinutes(w, NEXT.start, 20, THURSDAY));
    const { reverse, freed } = await t.run((w) => finishStretchPlanning(w, NEXT.start, t.clock));
    expect(freed).toBe(at('2026-12-26', '09:00'));
    expect((await t.task())?.done_at).toBe(at('2026-12-24', '10:20'));
    expect((await getSettings(t.db)).stretch_planning).toEqual({ start: NEXT.start, history: [20] });
    await t.run((w) => applyPlanChange(w, reverse));
    expect((await t.task())?.done_at).toBeNull();
  });

  it('Start on a stretch already planned only opens planning', async () => {
    const t = await setup(THURSDAY, { ...QUARTERS, plan_stretch: { last_planned: NEXT.start } });
    expect((await t.run((w) => startPlanning(w, p, undefined, t.clock))).until).toBeNull();
    expect(await t.task()).toBeUndefined();
  });
});

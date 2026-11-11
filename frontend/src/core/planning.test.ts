import { describe, expect, it } from 'vitest';
import { fixedClock } from './clock';
import { localToInstant } from './dates';
import { applyPlanChange } from './plan';
import {
  blockAhead,
  deletePlanning,
  finishWeek,
  loadWeekPlanning,
  makeDuePlanningTasks,
  planningTimes,
  planningWeekDue,
  skipWeek,
  schedulePlanning,
  startPlanning,
  stopPlanning,
  weekEstimate,
  weekGate,
  weekPlanningId,
  weekRow,
} from './planning';
import { DEFAULT_SETTINGS, getRecord, listRecords, transact, weekPlanId } from './records';
import type { Writer } from './records';
import { runSync } from './sync';
import { fakeSyncServer } from './sync-testing';
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

async function setup(now = FRIDAY, seed: (w: Writer) => Promise<unknown> = async () => undefined) {
  const clock = fixedClock(now, ZONE);
  const db = await openTestDb();
  await transact(db, clock, seed);
  const run = <R>(fn: (w: Writer) => Promise<R>) => transact(db, clock, fn);
  const task = () => getRecord(db, 'task', ID);
  const blocks = async () => (await listRecords(db, 'time_block')).filter((b) => b.task_id === ID && !b.cancelled);
  return { clock, db, run, task, blocks };
}

describe('the planning task', () => {
  it('is due for next week from three days before it starts', () => {
    expect(planningWeekDue('2026-11-12')).toBeNull();
    expect(planningWeekDue('2026-11-13')).toBe(WEEK);
    expect(planningWeekDue('2026-11-15')).toBe(WEEK);
    expect(planningWeekDue('2026-11-16')).toBeNull();
  });

  it('is made once its window opens, with no time placed, named with its dates', async () => {
    const t = await setup();
    await t.run((w) => makeDuePlanningTasks(w, t.clock));
    expect(await t.task()).toMatchObject({ kind: 'planning', title: 'Plan the week of Nov 16', plans: [`week:${WEEK}`], estimate_min: 30 });
    expect(await t.blocks()).toEqual([]);
  });

  it('is not made before its window, nor for a week already planned', async () => {
    const early = await setup(at('2026-11-12', '10:00'));
    await early.run((w) => makeDuePlanningTasks(w, early.clock));
    expect(await listRecords(early.db, 'task')).toEqual([]);
    const planned = await setup(FRIDAY, (w) => w.create('week_plan', { week_start: WEEK, finished_at: FRIDAY }, weekPlanId(WEEK)));
    await planned.run((w) => makeDuePlanningTasks(w, planned.clock));
    expect(await planned.task()).toBeUndefined();
  });

  it('is not made again once deleted', async () => {
    const t = await setup();
    await t.run((w) => makeDuePlanningTasks(w, t.clock));
    await t.run((w) => deletePlanning(w, WEEK, t.clock));
    await t.run((w) => makeDuePlanningTasks(w, t.clock));
    expect((await t.task())?.deleted_at).toBe(FRIDAY);
  });

  it('made by two devices before they sync is one task, and a delete on either wins over it', async () => {
    const clock = fixedClock(FRIDAY, ZONE);
    const server = fakeSyncServer({ now: () => clock.now() });
    const [phone, desk] = [await openTestDb(), await openTestDb()];
    await transact(phone, clock, (w) => makeDuePlanningTasks(w, clock));
    await transact(desk, clock, (w) => makeDuePlanningTasks(w, clock));
    await transact(desk, clock, (w) => deletePlanning(w, WEEK, clock));
    for (const db of [phone, desk, phone]) await runSync(db, server.send);
    const tasks = await listRecords(phone, 'task', { includeDeleted: true });
    expect(tasks.map((x) => [x.id, x.deleted_at])).toEqual([[ID, FRIDAY]]);
  });

  it('guesses 30 minutes, or 45 with more than 15 in the Inbox', () => {
    expect(weekEstimate(15)).toEqual({ minutes: 30, guess: true });
    expect(weekEstimate(16)).toEqual({ minutes: 45, guess: true });
  });
});

describe('when it asks', () => {
  it('shows next week’s row until the task has a time, and not once the week is planned', async () => {
    const t = await setup();
    await t.run((w) => makeDuePlanningTasks(w, t.clock));
    expect(weekRow(await loadWeekPlanning(t.db, WEEK), t.clock)).toBe(true);
    await t.run((w) => schedulePlanning(w, WEEK, { start: at('2026-11-15', '17:00'), end: at('2026-11-15', '17:30') }, t.clock));
    expect(weekRow(await loadWeekPlanning(t.db, WEEK), t.clock)).toBe(false);
    const planned = await setup(FRIDAY, (w) => w.create('task', { kind: 'planning', title: 'Plan the week of Nov 16' }, ID));
    await planned.run((w) => w.create('week_plan', { week_start: WEEK, finished_at: FRIDAY }, weekPlanId(WEEK)));
    expect(weekRow(await loadWeekPlanning(planned.db, WEEK), planned.clock)).toBe(false);
  });

  it('asks with the gate once the week has started unplanned, says when planning is set, and stays quiet once skipped', async () => {
    const monday = at(WEEK, '09:00');
    const t = await setup(monday);
    expect(weekGate(await loadWeekPlanning(t.db, WEEK), t.clock)).toBe('gate');
    await t.run((w) => schedulePlanning(w, WEEK, { start: at(WEEK, '18:00'), end: at(WEEK, '18:30') }, t.clock));
    const set = await loadWeekPlanning(t.db, WEEK);
    expect(weekGate(set, t.clock)).toBe('set');
    expect(blockAhead(set, t.clock)?.start).toBe(at(WEEK, '18:00'));
    await t.run((w) => deletePlanning(w, WEEK, t.clock));
    expect(weekGate(await loadWeekPlanning(t.db, WEEK), t.clock)).toBe('gate');
    await t.run((w) => skipWeek(w, WEEK, t.clock));
    expect(weekGate(await loadWeekPlanning(t.db, WEEK), t.clock)).toBeNull();
  });
});

describe('the times it offers', () => {
  const input = (clock: ReturnType<typeof fixedClock>, blocks: { id: string; start: string; end: string }[] = []) => ({
    settings: DEFAULT_SETTINGS,
    calendar: null,
    sources: [],
    blocks,
    clock,
  });

  it('are before the week starts, emptiest day first, one a day', () => {
    const clock = fixedClock(FRIDAY, ZONE);
    const busy = [{ id: 'b', start: at('2026-11-13', '17:00'), end: at('2026-11-13', '19:00') }];
    expect(planningTimes(WEEK, 30, input(clock, busy))).toEqual([
      { date: '2026-11-14', start: 9 * 60, end: 9 * 60 + 30 },
      { date: '2026-11-15', start: 9 * 60, end: 9 * 60 + 30 },
      { date: '2026-11-13', start: 19 * 60, end: 19 * 60 + 30 },
    ]);
  });

  it('offer Monday morning only when nothing earlier is free', () => {
    const clock = fixedClock(at('2026-11-15', '21:50'), ZONE);
    expect(planningTimes(WEEK, 30, input(clock))).toEqual([{ date: WEEK, start: 7 * 60, end: 7 * 60 + 30 }]);
  });

  it('once the week has begun, are the next free times from today, soonest first', () => {
    const clock = fixedClock(at('2026-11-18', '10:00'), ZONE);
    expect(planningTimes(WEEK, 30, input(clock)).map((s) => s.date)).toEqual(['2026-11-18', '2026-11-19', '2026-11-20']);
  });
});

describe('what each choice writes', () => {
  const made = (now = FRIDAY) => setup(now, (w) => makeDuePlanningTasks(w, fixedClock(now, ZONE)));

  it('Schedule places one block at the length chosen, and Undo takes the block back and keeps the task', async () => {
    const t = await made();
    const undo = await t.run((w) => schedulePlanning(w, WEEK, { start: at('2026-11-15', '17:00'), end: at('2026-11-15', '17:45') }, t.clock));
    expect(await t.blocks()).toMatchObject([{ start: at('2026-11-15', '17:00'), end: at('2026-11-15', '17:45') }]);
    expect((await t.task())?.estimate_min).toBe(45);
    await t.run((w) => applyPlanChange(w, undo));
    expect((await t.blocks()).filter((b) => !b.deleted_at)).toEqual([]);
    expect(await t.task()).toMatchObject({ estimate_min: 30 });
    expect((await t.task())?.deleted_at).toBeFalsy();
  });

  it('Schedule brings back a task deleted on another device', async () => {
    const t = await made();
    await t.run((w) => deletePlanning(w, WEEK, t.clock));
    await t.run((w) => schedulePlanning(w, WEEK, { start: at('2026-11-15', '17:00'), end: at('2026-11-15', '17:30') }, t.clock));
    expect((await t.task())?.deleted_at).toBeNull();
  });

  it('Delete takes the task and its blocks not yet started off every device, and Undo puts both back', async () => {
    const t = await made();
    await t.run((w) => schedulePlanning(w, WEEK, { start: at('2026-11-15', '17:00'), end: at('2026-11-15', '17:30') }, t.clock));
    const undo = await t.run((w) => deletePlanning(w, WEEK, t.clock));
    expect((await t.task())?.deleted_at).toBe(FRIDAY);
    expect(await t.blocks()).toEqual([]);
    await t.run((w) => applyPlanChange(w, undo));
    expect((await t.task())?.deleted_at).toBeNull();
    expect(await t.blocks()).toHaveLength(1);
  });

  it('Start places a started block from this minute for the estimate, ending sooner if the next block starts first', async () => {
    const t = await made();
    const { until } = await t.run((w) => startPlanning(w, WEEK, 30, t.clock));
    expect(until).toBe(at('2026-11-13', '10:30'));
    expect(await t.blocks()).toMatchObject([{ start: FRIDAY, end: until, started_at: FRIDAY }]);
    const busy = await setup(FRIDAY, (w) => w.create('time_block', { task_id: 'x', start: at('2026-11-13', '10:20'), end: at('2026-11-13', '11:00'), tz: ZONE }, 'x'));
    expect((await busy.run((w) => startPlanning(w, WEEK, 30, busy.clock))).until).toBe(at('2026-11-13', '10:20'));
  });

  it('Start makes the task if it isn’t there, never doubles a block under way, and with under 15 minutes free places none', async () => {
    const t = await setup();
    await t.run((w) => startPlanning(w, WEEK, 30, t.clock));
    expect(await t.task()).toMatchObject({ kind: 'planning', title: 'Plan the week of Nov 16' });
    expect((await t.run((w) => startPlanning(w, WEEK, 30, t.clock))).until).toBeNull();
    expect(await t.blocks()).toHaveLength(1);
    const tight = await setup(FRIDAY, (w) => w.create('time_block', { task_id: 'x', start: at('2026-11-13', '10:10'), end: at('2026-11-13', '11:00'), tz: ZONE }, 'x'));
    expect((await tight.run((w) => startPlanning(w, WEEK, 30, tight.clock))).until).toBeNull();
    expect(await tight.blocks()).toEqual([]);
  });

  it('Start on a week already planned only opens planning, and with no length given uses the estimate', async () => {
    const done = await setup(FRIDAY, (w) => w.create('week_plan', { week_start: WEEK, finished_at: FRIDAY }, weekPlanId(WEEK)));
    expect((await done.run((w) => startPlanning(w, WEEK, undefined, done.clock))).until).toBeNull();
    expect(await done.task()).toBeUndefined();
    const t = await setup(FRIDAY, async (w) => {
      for (let i = 0; i < 16; i++) await w.create('task', { kind: 'inbox', title: `Item ${i}` });
    });
    expect((await t.run((w) => startPlanning(w, WEEK, undefined, t.clock))).until).toBe(at('2026-11-13', '10:45'));
  });

  it('Start’s Undo takes the block away and leaves the task', async () => {
    const t = await made();
    const { reverse } = await t.run((w) => startPlanning(w, WEEK, 30, t.clock));
    await t.run((w) => applyPlanChange(w, reverse));
    expect((await t.blocks()).filter((b) => !b.deleted_at)).toEqual([]);
    expect((await t.task())?.deleted_at).toBeUndefined();
  });

  it('Finish ahead of the block finishes the task and frees the block, and Undo reopens all of it', async () => {
    const t = await made();
    await t.run((w) => schedulePlanning(w, WEEK, { start: at('2026-11-15', '17:00'), end: at('2026-11-15', '17:30') }, t.clock));
    const { reverse, freed } = await t.run((w) => finishWeek(w, WEEK, t.clock));
    expect(freed).toBe(at('2026-11-15', '17:00'));
    expect((await getRecord(t.db, 'week_plan', weekPlanId(WEEK)))?.finished_at).toBe(FRIDAY);
    expect((await t.task())?.done_at).toBe(FRIDAY);
    expect(await t.blocks()).toEqual([]);
    await t.run((w) => applyPlanChange(w, reverse));
    expect((await getRecord(t.db, 'week_plan', weekPlanId(WEEK)))?.finished_at).toBeNull();
    expect((await t.task())?.done_at).toBeNull();
    expect(await t.blocks()).toHaveLength(1);
  });

  it('Finish in its block ends the block at that minute', async () => {
    const t = await made();
    await t.run((w) => startPlanning(w, WEEK, 30, t.clock));
    t.clock.set(at('2026-11-13', '10:22'));
    const { freed } = await t.run((w) => finishWeek(w, WEEK, t.clock));
    expect(freed).toBeNull();
    expect((await t.blocks())[0]?.ended_at).toBe(at('2026-11-13', '10:22'));
    expect((await t.task())?.done_at).toBe(at('2026-11-13', '10:22'));
  });

  it('Save and exit ends the block under way at that minute, and leaves the task open', async () => {
    const t = await made();
    await t.run((w) => startPlanning(w, WEEK, 30, t.clock));
    t.clock.set(at('2026-11-13', '10:12'));
    await t.run((w) => stopPlanning(w, WEEK, t.clock));
    expect((await t.blocks())[0]).toMatchObject({ end: at('2026-11-13', '10:12'), ended_at: at('2026-11-13', '10:12') });
    expect((await t.task())?.done_at).toBeUndefined();
  });

  it('Save and exit in the first minute takes the block away, since it held no time', async () => {
    const t = await made();
    await t.run((w) => startPlanning(w, WEEK, 30, t.clock));
    t.clock.set(FRIDAY.replace(':00Z', ':40Z'));
    await t.run((w) => stopPlanning(w, WEEK, t.clock));
    expect(await t.blocks()).toEqual([]);
  });

  it('Skip for now skips the week and deletes its task, and Undo brings back both', async () => {
    const t = await setup(at(WEEK, '09:00'), (w) => w.create('task', { kind: 'planning', title: 'Plan the week of Nov 16' }, ID));
    const undo = await t.run((w) => skipWeek(w, WEEK, t.clock));
    expect((await getRecord(t.db, 'week_plan', weekPlanId(WEEK)))?.planning_skipped_at).toBe(at(WEEK, '09:00'));
    expect((await t.task())?.deleted_at).toBe(at(WEEK, '09:00'));
    await t.run((w) => applyPlanChange(w, undo));
    expect((await getRecord(t.db, 'week_plan', weekPlanId(WEEK)))?.planning_skipped_at).toBeNull();
    expect((await t.task())?.deleted_at).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { fixedClock } from './clock';
import { localToInstant, weekRange } from './dates';
import { applyPlanChange } from './plan';
import { isPlanned, loadWeekPlanning, weekGate, weekPlanningId } from './planning';
import { blocksInRange } from './queries';
import { getRecord, listRecords, outcomeId, practiceSessionId, transact, weekPickId, weekPlanId } from './records';
import type { Writer } from './records';
import { hasReset, resetWeek, weekReset } from './weekReset';
import { openTestDb } from '../platform/node-sqlite';

// The week of Nov 16, reset on Wednesday, Nov 18 at 10am, in Chicago.
const ZONE = 'America/Chicago';
const WEEK = '2026-11-16';
const NEXT = '2026-11-23';
const at = (date: string, time: string) => {
  const [h, m] = time.split(':').map(Number);
  return localToInstant(date, h! * 60 + (m ?? 0), ZONE);
};
const WEDNESDAY = at('2026-11-18', '10:00');
const SUNDAY_BEFORE = at('2026-11-15', '17:00');

async function setup(now = WEDNESDAY, seed: (w: Writer) => Promise<unknown> = async () => undefined) {
  const clock = fixedClock(now, ZONE);
  const db = await openTestDb();
  await transact(db, clock, seed);
  const run = <R>(fn: (w: Writer) => Promise<R>) => transact(db, clock, fn);
  // Every record as stored, clocks aside, to compare before and after.
  const snapshot = async () =>
    (await db.all<{ id: string; type: string; data: string }>('SELECT id, type, data FROM records ORDER BY id')).map((r) => ({
      id: r.id,
      type: r.type,
      data: Object.fromEntries(Object.entries(JSON.parse(r.data) as Record<string, unknown>).filter(([, v]) => v !== null)),
    }));
  return { clock, db, run, snapshot };
}

/** A planned week part way through: what has happened, what's still to come, and records in the weeks either side. */
async function plannedWeek(w: Writer) {
  const a = await w.create('task', { kind: 'one_off', title: 'Write the report', estimate_min: 240 });
  const b = await w.create('task', { kind: 'one_off', title: 'Call the bank', estimate_min: 120 });
  const c = await w.create('task', { kind: 'one_off', title: 'Taken out earlier', estimate_min: 60 });
  const run = await w.create('practice', { title: 'Run', target_min: 30, per: 'day' });
  await w.create('week_pick', { week_start: WEEK, task_id: a, minutes: 240 }, weekPickId(WEEK, a));
  await w.create('week_pick', { week_start: WEEK, task_id: b, minutes: 120 }, weekPickId(WEEK, b));
  await w.create('week_pick', { week_start: WEEK, task_id: c, minutes: 60, deleted_at: at('2026-11-16', '08:00') }, weekPickId(WEEK, c));
  await w.create('week_pick', { week_start: NEXT, task_id: a, minutes: 60 }, weekPickId(NEXT, a));
  await w.create(
    'week_plan',
    {
      week_start: WEEK,
      finished_at: SUNDAY_BEFORE,
      aims: { [a]: 300 },
      skipped_aims: ['some-project'],
      skipped_practices: ['some-practice'],
      skipped_sessions: [`${run}:2026-11-20`],
      skipped_past_end: ['ended-project'],
      planning_min: 25,
      planning_started_at: SUNDAY_BEFORE,
    },
    weekPlanId(WEEK),
  );
  await w.create('week_plan', { week_start: NEXT, finished_at: SUNDAY_BEFORE }, weekPlanId(NEXT));
  await w.create('task', { kind: 'planning', title: 'Plan the week of Nov 16', plans: [`week:${WEEK}`], done_at: SUNDAY_BEFORE }, weekPlanningId(WEEK));
  await w.create('task', { kind: 'planning', title: 'Plan the week of Nov 23', plans: [`week:${NEXT}`] }, weekPlanningId(NEXT));
  const block = (task: string, date: string, from: string, to: string, more: object = {}, id?: string) =>
    w.create('time_block', { task_id: task, start: at(date, from), end: at(date, to), tz: ZONE, ...more }, id);
  const session = (date: string, from: string, to: string, more: object = {}) =>
    w.create('time_block', { practice_id: run, start: at(date, from), end: at(date, to), tz: ZONE, ...more }, practiceSessionId(run, date));
  const ids = {
    a,
    b,
    run,
    // Kept: a past day's block never started, one answered, one started early, one under way now, a past session.
    goneBy: await block(a, '2026-11-16', '09:00', '10:00'),
    answered: await block(a, '2026-11-17', '09:00', '10:00', { started_at: at('2026-11-17', '09:00'), ended_at: at('2026-11-17', '10:00') }),
    startedEarly: await block(b, '2026-11-19', '09:00', '10:00', { started_at: at('2026-11-18', '09:55') }),
    underWay: await block(b, '2026-11-18', '09:30', '10:30'),
    pastSession: await session('2026-11-16', '07:00', '07:30'),
    // Next week's planning, placed in this week: planning, not part of this week's plan.
    planning: await block(weekPlanningId(NEXT), '2026-11-22', '17:00', '17:30'),
    // Removed: still to come, not started or answered, later today included, and a practice session.
    laterToday: await block(a, '2026-11-18', '14:00', '15:00'),
    friday: await block(b, '2026-11-20', '09:00', '10:00'),
    session: await session('2026-11-19', '07:00', '07:30'),
    // Other weeks: untouched.
    lastWeek: await block(a, '2026-11-12', '09:00', '10:00'),
    nextWeek: await block(a, '2026-11-24', '09:00', '10:00'),
  };
  await w.create('block_outcome', { result: 'done', answered_at: at('2026-11-17', '10:00') }, outcomeId(ids.answered));
  return ids;
}

const live = async (t: Awaited<ReturnType<typeof setup>>) =>
  (await listRecords(t.db, 'time_block')).filter((b) => !b.cancelled).map((b) => b.id);

describe('resetting a week', () => {
  it("takes out the week's picks and every block still to come, practice sessions included", async () => {
    let ids!: Awaited<ReturnType<typeof plannedWeek>>;
    const t = await setup(WEDNESDAY, async (w) => (ids = await plannedWeek(w)));
    await t.run((w) => resetWeek(w, WEEK, t.clock));

    const picks = (await listRecords(t.db, 'week_pick')).map((p) => p.id);
    expect(picks).toEqual([weekPickId(NEXT, ids.a)]);
    const blocks = await live(t);
    for (const gone of [ids.laterToday, ids.friday, ids.session]) expect(blocks).not.toContain(gone);
    expect((await getRecord(t.db, 'time_block', ids.session))?.deleted_at).toBe(WEDNESDAY);
  });

  it('keeps what has happened: past days, answered and started blocks, the block under way, and planning', async () => {
    let ids!: Awaited<ReturnType<typeof plannedWeek>>;
    const t = await setup(WEDNESDAY, async (w) => (ids = await plannedWeek(w)));
    await t.run((w) => resetWeek(w, WEEK, t.clock));

    const blocks = await live(t);
    for (const kept of [ids.goneBy, ids.answered, ids.startedEarly, ids.underWay, ids.pastSession, ids.planning, ids.lastWeek, ids.nextWeek]) {
      expect(blocks).toContain(kept);
    }
    expect(await getRecord(t.db, 'block_outcome', outcomeId(ids.answered))).toMatchObject({ result: 'done' });
    // The tasks and the practice themselves stay.
    expect(await getRecord(t.db, 'task', ids.a)).toMatchObject({ title: 'Write the report' });
    expect((await getRecord(t.db, 'practice', ids.run))?.deleted_at ?? null).toBeNull();
  });

  it("clears the week's aims, skips and finish, so the week shows as not planned and planning starts fresh", async () => {
    const t = await setup(WEDNESDAY, plannedWeek);
    await t.run((w) => resetWeek(w, WEEK, t.clock));

    const plan = await getRecord(t.db, 'week_plan', weekPlanId(WEEK));
    for (const field of ['finished_at', 'aims', 'skipped_aims', 'skipped_practices', 'skipped_sessions', 'skipped_past_end'] as const) {
      expect(plan?.[field] ?? null).toBeNull();
    }
    // The time already spent planning stays: the estimate and your usual time learn from it.
    expect(plan).toMatchObject({ planning_min: 25, planning_started_at: SUNDAY_BEFORE });
    const planning = await loadWeekPlanning(t.db, WEEK);
    expect(isPlanned(planning)).toBe(false);
    expect(weekGate(planning, t.clock)).toBe('gate');
    // Its planning task opens again; next week's plan is untouched.
    expect(planning.task?.done_at ?? null).toBeNull();
    expect(await getRecord(t.db, 'week_plan', weekPlanId(NEXT))).toMatchObject({ finished_at: SUNDAY_BEFORE });
  });

  it('clears Skip for now and brings back the planning task it deleted', async () => {
    const t = await setup(WEDNESDAY, async (w) => {
      await w.create('week_plan', { week_start: WEEK, planning_skipped_at: at('2026-11-16', '08:00') }, weekPlanId(WEEK));
      await w.create('task', { kind: 'planning', title: 'Plan the week of Nov 16', plans: [`week:${WEEK}`], deleted_at: at('2026-11-16', '08:00') }, weekPlanningId(WEEK));
    });
    await t.run((w) => resetWeek(w, WEEK, t.clock));

    const planning = await loadWeekPlanning(t.db, WEEK);
    expect(planning.plan?.planning_skipped_at ?? null).toBeNull();
    expect(planning.task?.deleted_at ?? null).toBeNull();
    expect(weekGate(planning, t.clock)).toBe('gate');
  });

  it('is undone exactly by its reverse', async () => {
    const t = await setup(WEDNESDAY, plannedWeek);
    const before = await t.snapshot();
    const reverse = await t.run((w) => resetWeek(w, WEEK, t.clock));
    expect(await t.snapshot()).not.toEqual(before);
    await t.run((w) => applyPlanChange(w, reverse));
    expect(await t.snapshot()).toEqual(before);
  });

  it('says what goes and what stays, for the confirm', async () => {
    const t = await setup(WEDNESDAY, plannedWeek);
    const r = weekReset(
      WEEK,
      await getRecord(t.db, 'week_plan', weekPlanId(WEEK)),
      await listRecords(t.db, 'week_pick'),
      await blocksInRange(t.db, weekRange(WEEK, ZONE)),
      t.clock.now(),
    );
    expect(r).toMatchObject({ blocks: expect.any(Array), sessions: 1, kept: 5, aims: true });
    expect(r.picks).toHaveLength(2);
    expect(r.blocks).toHaveLength(3);
    expect(hasReset(r)).toBe(true);
  });

  it('has nothing to reset in a week with nothing planned, and writes nothing', async () => {
    const t = await setup(WEDNESDAY, async (w) => {
      // Only what has happened: a block from Monday.
      const a = await w.create('task', { kind: 'one_off', title: 'Write the report' });
      await w.create('time_block', { task_id: a, start: at('2026-11-16', '09:00'), end: at('2026-11-16', '10:00'), tz: ZONE });
      // Only planning still to come, and a plan record with nothing set.
      await w.create('week_plan', { week_start: WEEK, planning_min: 10, aims: {}, skipped_practices: [] }, weekPlanId(WEEK));
    });
    const r = weekReset(WEEK, await getRecord(t.db, 'week_plan', weekPlanId(WEEK)), await listRecords(t.db, 'week_pick'), await blocksInRange(t.db, weekRange(WEEK, ZONE)), t.clock.now());
    expect(hasReset(r)).toBe(false);
    expect(r.kept).toBe(1);
    const before = await t.snapshot();
    expect(await t.run((w) => resetWeek(w, WEEK, t.clock))).toEqual({ writes: [] });
    expect(await t.snapshot()).toEqual(before);
  });

  it('never changes a week that has ended', async () => {
    const t = await setup(at('2026-11-24', '10:00'), plannedWeek);
    const before = await t.snapshot();
    expect(await t.run((w) => resetWeek(w, WEEK, t.clock))).toEqual({ writes: [] });
    expect(await t.snapshot()).toEqual(before);
  });

  it('resets next week before it starts, all of it still to come', async () => {
    let ids!: Awaited<ReturnType<typeof plannedWeek>>;
    const t = await setup(WEDNESDAY, async (w) => (ids = await plannedWeek(w)));
    await t.run((w) => resetWeek(w, NEXT, t.clock));

    expect((await listRecords(t.db, 'week_pick')).map((p) => p.id)).not.toContain(weekPickId(NEXT, ids.a));
    expect(await live(t)).not.toContain(ids.nextWeek);
    expect((await getRecord(t.db, 'week_plan', weekPlanId(NEXT)))?.finished_at ?? null).toBeNull();
    // This week is untouched.
    expect(await getRecord(t.db, 'week_plan', weekPlanId(WEEK))).toMatchObject({ finished_at: SUNDAY_BEFORE });
    expect(await live(t)).toContain(ids.friday);
  });
});

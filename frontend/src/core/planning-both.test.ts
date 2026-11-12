import { describe, expect, it } from 'vitest';
import { fixedClock } from './clock';
import { localToInstant } from './dates';
import { applyPlanChange } from './plan';
import {
  coveredWeek,
  deleteBoth,
  finishStretchPlanning,
  finishWeek,
  scheduleBoth,
  startBoth,
  stretchPlanningId,
  weekPlanningId,
} from './planning';
import { getRecord, listRecords, SETTINGS_ID, transact } from './records';
import type { Writer } from './records';
import { openTestDb } from '../platform/node-sqlite';

// Friday, Dec 25 in Chicago: Jan 1 to Mar 31 is due, and the week of Dec 28 is next.
const ZONE = 'America/Chicago';
const at = (date: string, time: string) => localToInstant(date, Number(time.slice(0, 2)) * 60 + Number(time.slice(3)), ZONE);
const STRETCH = { stretch: { start: '2027-01-01', end: '2027-03-31' }, first: false };
const WEEK = '2026-12-28';
const SID = stretchPlanningId('2027-01-01');
const WID = weekPlanningId(WEEK);
const FRIDAY = at('2026-12-25', '10:00');

async function setup() {
  const clock = fixedClock(FRIDAY, ZONE);
  const db = await openTestDb();
  await transact(db, clock, async (w) => {
    await w.create('settings', { plan_cadence: { every: 1, unit: 'quarters', anchor: '2026-10-01' }, plan_stretch: { last_planned: '2026-10-01' } }, SETTINGS_ID);
    await w.create('task', { kind: 'planning', title: 'Plan Jan 1 to Mar 31', plans: ['stretch:2027-01-01'] }, SID);
    await w.create('task', { kind: 'planning', title: 'Plan the week of Dec 28', plans: [`week:${WEEK}`] }, WID);
  });
  const run = <R>(fn: (w: Writer) => Promise<R>) => transact(db, clock, fn);
  const blocks = async (id: string) => (await listRecords(db, 'time_block')).filter((b) => b.task_id === id && !b.cancelled);
  return { clock, db, run, blocks, task: (id: string) => getRecord(db, 'task', id) };
}

describe('weekly and stretch plans together', () => {
  it('share one block, which belongs to the stretch and lists the week among its plans', async () => {
    const t = await setup();
    const undo = await t.run((w) => scheduleBoth(w, STRETCH, WEEK, { start: at('2026-12-27', '16:00'), end: at('2026-12-27', '17:15') }, t.clock));
    expect(await t.blocks(SID)).toHaveLength(1);
    expect(await t.blocks(WID)).toEqual([]);
    const task = await t.task(SID);
    expect(task).toMatchObject({ title: 'Plan Jan 1 to Mar 31 and the week of Dec 28', plans: ['stretch:2027-01-01', `week:${WEEK}`] });
    expect(coveredWeek(task ?? null)).toBe(WEEK);
    await t.run((w) => applyPlanChange(w, undo));
    expect(await t.task(SID)).toMatchObject({ title: 'Plan Jan 1 to Mar 31', plans: ['stretch:2027-01-01'] });
  });

  it('Delete on both deletes both tasks, with one Undo', async () => {
    const t = await setup();
    const undo = await t.run((w) => deleteBoth(w, STRETCH, WEEK, t.clock));
    expect((await t.task(SID))?.deleted_at).toBe(FRIDAY);
    expect((await t.task(WID))?.deleted_at).toBe(FRIDAY);
    await t.run((w) => applyPlanChange(w, undo));
    expect((await t.task(SID))?.deleted_at).toBeNull();
    expect((await t.task(WID))?.deleted_at).toBeNull();
  });

  it('Finish and plan the week carries on in the same block, and finishing the week ends it', async () => {
    const t = await setup();
    await t.run((w) => startBoth(w, STRETCH, WEEK, 75, t.clock));
    t.clock.set(at('2026-12-25', '10:40'));
    await t.run((w) => finishStretchPlanning(w, '2027-01-01', t.clock, true));
    expect((await t.task(SID))?.done_at).toBe(at('2026-12-25', '10:40'));
    expect((await t.blocks(SID))[0]?.ended_at).toBeFalsy();
    t.clock.set(at('2026-12-25', '11:02'));
    await t.run((w) => finishWeek(w, WEEK, t.clock));
    expect((await t.blocks(SID))[0]).toMatchObject({ end: at('2026-12-25', '11:02'), ended_at: at('2026-12-25', '11:02') });
    expect((await t.task(WID))?.done_at).toBe(at('2026-12-25', '11:02'));
  });

  it('Finish on the stretch alone ends the block and lets the week go back to its own row', async () => {
    const t = await setup();
    await t.run((w) => startBoth(w, STRETCH, WEEK, 75, t.clock));
    t.clock.set(at('2026-12-25', '10:40'));
    await t.run((w) => finishStretchPlanning(w, '2027-01-01', t.clock));
    expect((await t.blocks(SID))[0]?.ended_at).toBe(at('2026-12-25', '10:40'));
    expect(coveredWeek((await t.task(SID)) ?? null)).toBeNull();
    expect((await t.task(WID))?.done_at).toBeUndefined();
  });
});

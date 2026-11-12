import { describe, expect, it } from 'vitest';
import { fixedClock } from './clock';
import { localToInstant } from './dates';
import { loadWeekPlanning, planningReminder, weekPlanningId } from './planning';
import { DEFAULT_SETTINGS, transact, weekPlanId } from './records';
import type { Writer } from './records';
import { REMINDER_ACTION } from './reminders';
import { openTestDb } from '../platform/node-sqlite';

// Wednesday, Nov 11 in Chicago: the week of Nov 16 is next, and its row opens on Friday.
const ZONE = 'America/Chicago';
const WEEK = '2026-11-16';
const ID = weekPlanningId(WEEK);
const at = (date: string, time: string) => {
  const [h, m] = time.split(':').map(Number);
  return localToInstant(date, h! * 60 + (m ?? 0), ZONE);
};
const WEDNESDAY = at('2026-11-11', '10:00');

async function remind(seed: (w: Writer) => Promise<unknown> = async () => undefined, options: { on?: boolean; away?: { start: string; end: string }[] } = {}) {
  const clock = fixedClock(WEDNESDAY, ZONE);
  const db = await openTestDb();
  await transact(db, clock, seed);
  return planningReminder(await loadWeekPlanning(db, WEEK), {
    settings: DEFAULT_SETTINGS,
    calendar: null,
    sources: [],
    blocks: [],
    clock,
    plans: [],
    inbox: 3,
    on: options.on ?? true,
    away: (options.away ?? []).map((a, i) => ({ id: `a${i}`, ...a })),
  });
}

describe('the weekly reminder', () => {
  it('says next week isn’t planned, 3 hours before the time the row will offer, and opens the times', async () => {
    expect(await remind()).toEqual({
      id: `reminder:planning:${WEEK}`,
      kind: 'planning_unscheduled',
      block_id: ID,
      at: at('2026-11-13', '14:00'),
      title: "Next week isn't planned yet",
      body: 'About 30m. Fri 5pm is free.',
      actions: [{ id: REMINDER_ACTION.choosePlanningTime, title: 'Choose a time', opens_app: true }],
    });
  });

  it('goes once planning is scheduled, finished or deleted, with the switch off, or on away dates', async () => {
    const task = (w: Writer) => w.create('task', { kind: 'planning', title: 'Plan the week of Nov 16', plans: [`week:${WEEK}`] }, ID);
    expect(await remind(async (w) => (await task(w), w.create('time_block', { task_id: ID, start: at('2026-11-15', '17:00'), end: at('2026-11-15', '17:30'), tz: ZONE })))).toBeNull();
    expect(await remind((w) => w.create('week_plan', { week_start: WEEK, finished_at: WEDNESDAY }, weekPlanId(WEEK)))).toBeNull();
    expect(await remind(async (w) => (await task(w), w.set('task', ID, { deleted_at: WEDNESDAY })))).toBeNull();
    expect(await remind(undefined, { on: false })).toBeNull();
    expect(await remind(undefined, { away: [{ start: '2026-11-13', end: '2026-11-20' }] })).toBeNull();
  });
});

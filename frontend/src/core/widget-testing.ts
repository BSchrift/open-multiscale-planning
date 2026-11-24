// The widget spec's example day, as records, at each moment its states are drawn: Wednesday, Nov 18 in Los Angeles. The
// snapshot builder's tests, the action tests and the fixtures the Swift side reads (widgetFixtures.test.ts) all start here.
// Tests import this file; the app never does.

import type { Clock } from './clock';
import { fixedClock } from './clock';
import type { Db, SqlDriver } from './db';
import { META, openDb, setMeta } from './db';
import { CALENDAR_ID, outcomeId, transact, weekPlanId } from './records';
import type { Writer } from './records';

export const ZONE = 'America/Los_Angeles';
/** Local times on the example day (Nov 18) or the next (Nov 19), Pacific Standard Time, as instants. */
export const pst = (time: string, day = 18) => {
  const [h, m] = time.split(':').map(Number) as [number, number];
  return new Date(Date.UTC(2026, 10, day, h + 8, m)).toISOString().replace('.000Z', 'Z');
};

export type WidgetScenario = 'now' | 'start' | 'paused' | 'next' | 'empty' | 'finished' | 'signedout' | 'stale';

/** When each state is drawn, as the spec's notes have it. */
export const SCENARIO_AT: Record<WidgetScenario, string> = {
  now: pst('10:04'),
  start: pst('9:06'),
  paused: pst('10:04'),
  next: pst('10:48'),
  empty: pst('9:30'),
  finished: pst('18:20'),
  signedout: pst('10:04'),
  stale: pst('10:04'),
};

const done = (w: Writer, id: string, result: 'done' | 'partly' | 'not', at: string) =>
  w.create('block_outcome', { result, answered_at: at, ...(result === 'partly' ? { remaining_min: 30 } : {}) }, outcomeId(id));

async function exampleDay(w: Writer) {
  await w.create('practice', { title: 'Run', target_min: 45, per: 'week', state: 'active' }, 'run-practice');
  await w.create('practice', { title: 'Piano', target_min: 30, per: 'week', state: 'active' }, 'piano-practice');
  await w.create('task', { kind: 'project', project_id: 'multiscale', title: 'Write widget spec', estimate_min: 90, remaining_min: 90 }, 'spec-task');
  await w.create('task', { kind: 'one_off', title: 'Call the dentist' }, 'dentist-task');
  await w.create('task', { kind: 'project', project_id: 'multiscale', title: 'Review pull requests', estimate_min: 60, remaining_min: 60 }, 'prs-task');
  await w.create('task', { kind: 'project', project_id: 'multiscale', title: 'Draft release notes', estimate_min: 60, remaining_min: 60 }, 'notes-task');
  await w.create('time_block', { practice_id: 'run-practice', start: pst('7:00'), end: pst('7:45'), tz: ZONE }, 'run');
  await w.create('time_block', { task_id: 'spec-task', start: pst('9:00'), end: pst('10:30'), tz: ZONE }, 'spec');
  await w.create('time_block', { task_id: 'dentist-task', start: pst('11:00'), end: pst('11:15'), tz: ZONE }, 'dentist');
  await w.create('time_block', { task_id: 'prs-task', start: pst('13:00'), end: pst('14:00'), tz: ZONE }, 'prs');
  await w.create('time_block', { practice_id: 'piano-practice', start: pst('17:30'), end: pst('18:00'), tz: ZONE }, 'piano');
  await w.create('time_block', { task_id: 'notes-task', start: pst('9:00', 19), end: pst('10:00', 19), tz: ZONE }, 'notes');
  await w.create('calendar', { connected: true, events: [{ id: 'standup', calendar: 'work', title: 'Standup', start: pst('10:30'), end: pst('10:45') }] }, CALENDAR_ID);
  await w.create('week_plan', { week_start: '2026-11-16', finished_at: pst('8:00', 16) }, weekPlanId('2026-11-16'));
  await done(w, 'run', 'done', pst('7:46'));
}

/** The example day's records as they stand when the scenario is drawn, on a clock stopped then, in a new database. */
export async function widgetScenario(name: WidgetScenario, driver: SqlDriver): Promise<{ db: Db; clock: Clock & { set(at: string | number): void } }> {
  const clock = fixedClock(SCENARIO_AT[name], ZONE);
  const db = await openDb(driver);
  await transact(db, clock, async (w) => {
    if (name === 'empty') return;
    await exampleDay(w);
    if (name === 'now' || name === 'stale' || name === 'signedout') await w.set('time_block', 'spec', { started_at: '2026-11-18T17:00:41Z' });
    if (name === 'paused') await w.set('time_block', 'spec', { started_at: '2026-11-18T17:00:41Z', paused_at: pst('9:52') });
    if (name === 'next' || name === 'finished') {
      await w.set('time_block', 'spec', { started_at: '2026-11-18T17:00:41Z' });
      await done(w, 'spec', 'done', pst('10:31'));
    }
    if (name === 'finished') {
      await done(w, 'dentist', 'not', pst('11:16'));
      await done(w, 'prs', 'partly', pst('14:01'));
    }
  });
  await setMeta(db, META.lastSyncAt, name === 'stale' ? pst('7:58') : SCENARIO_AT[name]);
  if (name === 'signedout') await setMeta(db, META.lastSyncError, 'sign_in_expired');
  return { db, clock };
}

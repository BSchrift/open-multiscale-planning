import { describe, expect, it } from 'vitest';
import { fixedClock } from './clock';
import { openDb } from './db';
import {
  applyPlanChange,
  autoPickedOneOffs,
  cadenceLabel,
  changeCadence,
  currentStretch,
  doneDateError,
  doneInPlan,
  doneOf,
  dropMilestone,
  effectiveDue,
  gatherPlans,
  markMilestoneDone,
  markMilestoneNotMet,
  milestoneWarnings,
  moveDone,
  moveMilestone,
  msInPlan,
  msLate,
  nextStretch,
  originalDue,
  parkMilestone,
  pauseProject,
  plannable,
  plannedIds,
  planningDue,
  planMinutes,
  planStretch,
  projectCandidates,
  replannedBadge,
  resumeProject,
  scheduleOrder,
  sortedMilestones,
  stretchEnd,
  stretchFrom,
  suggestions,
  taskDue,
  taskWork,
  toggleInPlan,
  undoLastChange,
  unplanMilestone,
  withChange,
} from './plan';
import type { ProjectPlan, WeekInput } from './plan';
import { context, milestone, NEXT, NOW, reportPlan, task } from './plan-testing';
import { listRecords, transact } from './records';
import { status } from './status';
import { nodeSqliteDriver } from '../platform/node-sqlite';
import type { PlanCadence, PlanStretch, Task, TimeBlock, WeekPick } from './types';

const QUARTERS: PlanCadence = { every: 1, unit: 'quarters' };

function cadence(plan_cadence: PlanCadence | null, plan_stretch: PlanStretch = {}) {
  return { plan_cadence, plan_stretch };
}

describe('stretches from the cadence', () => {
  const months = cadence({ every: 3, unit: 'months', anchor: '2026-08-01' });

  it('ends a quarter on its calendar date, however late it starts', () => {
    expect(stretchFrom('2026-11-15', QUARTERS).end).toBe('2026-12-31');
    expect(stretchFrom('2027-01-01', QUARTERS).end).toBe('2027-03-31');
    expect(stretchFrom('2027-05-20', QUARTERS).end).toBe('2027-06-30');
    expect(stretchFrom('2027-07-01', QUARTERS).end).toBe('2027-09-30');
  });

  it('counts every N weeks or months from the start', () => {
    expect(stretchFrom('2026-11-01', { every: 6, unit: 'weeks' })).toEqual({ start: '2026-11-01', end: '2026-12-12' });
    expect(stretchFrom('2026-11-01', { every: 3, unit: 'months' })).toEqual({ start: '2026-11-01', end: '2027-01-31' });
  });

  it('survives a stored cadence of zero', () => {
    expect(stretchFrom('2026-11-01', { every: 0, unit: 'weeks' }).end).toBe('2026-11-07');
    expect(currentStretch(cadence({ every: 0, unit: 'weeks', anchor: '2026-10-01' }), '2026-11-01')?.start).toBe('2026-10-29');
  });

  it('rolls over on its date without planning', () => {
    expect(currentStretch(months, '2026-10-30')).toEqual({ start: '2026-08-01', end: '2026-10-31' });
    expect(currentStretch(months, '2026-11-01')).toEqual({ start: '2026-11-01', end: '2027-01-31' });
    expect(nextStretch(months, '2026-11-01')).toEqual({ start: '2027-02-01', end: '2027-04-30' });
  });

  it('keeps a monthly stretch from the 31st on each month’s end, never drifting to the 28th', () => {
    const m = cadence({ every: 1, unit: 'months', anchor: '2026-01-31' });
    expect(currentStretch(m, '2026-02-10')).toEqual({ start: '2026-01-31', end: '2026-02-27' });
    expect(nextStretch(m, '2026-02-10')).toEqual({ start: '2026-02-28', end: '2026-03-30' });
    expect(currentStretch(m, '2026-03-10')).toEqual({ start: '2026-02-28', end: '2026-03-30' });
    expect(currentStretch(m, '2026-12-15')).toEqual({ start: '2026-11-30', end: '2026-12-30' });
  });

  it('gives a short first stretch mid-quarter, then whole quarters', () => {
    const q = cadence({ ...QUARTERS, anchor: '2026-11-15' });
    expect(currentStretch(q, '2026-11-20')).toEqual({ start: '2026-11-15', end: '2026-12-31' });
    expect(nextStretch(q, '2026-11-20')).toEqual({ start: '2027-01-01', end: '2027-03-31' });
    expect(currentStretch(q, '2027-02-01')).toEqual({ start: '2027-01-01', end: '2027-03-31' });
  });

  it('uses the calendar quarter by default, with no anchor', () => {
    expect(currentStretch(cadence(QUARTERS), '2026-11-20')).toEqual({ start: '2026-10-01', end: '2026-12-31' });
  });

  it('has no current stretch before the first one starts', () => {
    const later = cadence({ ...QUARTERS, anchor: '2027-01-01' });
    expect(currentStretch(later, '2026-11-01')).toBeNull();
    expect(nextStretch(later, '2026-11-01')).toEqual({ start: '2027-01-01', end: '2027-03-31' });
  });

  it('has no fixed stretch without a cadence, and offers a next one to plan', () => {
    const none = cadence(null);
    expect(currentStretch(none, '2026-10-30')).toBeNull();
    expect(nextStretch(none, '2026-10-30')).toEqual({ start: '2026-11-02', end: '2027-02-02' });
  });

  it('lets one-off dates override, then the cadence carries on', () => {
    const s = cadence(months.plan_cadence, { one_offs: [{ start: '2026-11-01', end: '2027-02-15' }] });
    expect(currentStretch(s, '2026-12-01')).toEqual({ start: '2026-11-01', end: '2027-02-15' });
    expect(currentStretch(s, '2027-02-16')?.start).toBe('2027-02-16');
    expect(nextStretch(s, '2026-10-30')).toEqual({ start: '2026-11-01', end: '2027-02-15' });
  });

  it('cuts the current stretch short when a one-off starts inside it', () => {
    const s = cadence(months.plan_cadence, { one_offs: [{ start: '2026-10-15', end: '2026-12-01' }] });
    expect(currentStretch(s, '2026-09-01')).toEqual({ start: '2026-08-01', end: '2026-10-14' });
    expect(nextStretch(s, '2026-09-01')).toEqual({ start: '2026-10-15', end: '2026-12-01' });
  });

  it('honours a one-off with no cadence, so a plan keeps its stretch day to day', () => {
    const s = cadence(null, { one_offs: [{ start: '2026-11-02', end: '2027-01-15' }] });
    expect(currentStretch(s, '2026-12-01')).toEqual({ start: '2026-11-02', end: '2027-01-15' });
    expect(nextStretch(s, '2026-12-01').start).toBe('2027-01-16');
  });

  it('finds the end of a stretch by its start', () => {
    const q = cadence({ ...QUARTERS, anchor: '2026-10-15' }, { one_offs: [{ start: '2026-06-01', end: '2026-06-20' }] });
    expect(stretchEnd('2026-10-15', q, '2026-10-30')).toBe('2026-12-31');
    expect(stretchEnd('2027-01-01', q, '2026-10-30')).toBe('2027-03-31');
    expect(stretchEnd('2026-06-01', q, '2026-10-30')).toBe('2026-06-20');
    expect(stretchEnd('2026-06-01', cadence(null), '2026-10-30')).toBe('2026-06-01');
  });

  it('ends a past monthly stretch from the 31st where it really ended, long after', () => {
    const m = cadence({ every: 1, unit: 'months', anchor: '2026-01-31' });
    expect(stretchEnd('2026-02-28', m, '2026-04-15')).toBe('2026-03-30');
    const two = cadence({ every: 2, unit: 'months', anchor: '2027-12-31' });
    expect(stretchEnd('2028-02-29', two, '2028-09-01')).toBe('2028-04-29');
  });
});

describe('the stretch a plan speaks for', () => {
  const months = { every: 3, unit: 'months', anchor: '2026-10-01' } as const;

  it('is the current one until planning is close or under way', () => {
    const s = cadence(months, { last_planned: '2026-10-01' });
    expect(planStretch(s, '2026-10-30').start).toBe('2026-10-01');
    expect(planStretch(s, '2026-10-30', true).start).toBe('2027-01-01');
    expect(planStretch(s, '2026-12-23').start).toBe('2026-10-01');
    expect(planStretch(s, '2026-12-24').start).toBe('2027-01-01');
  });

  it('is the next one once that has been planned, or with no current stretch', () => {
    expect(planStretch(cadence(months, { last_planned: '2027-01-01' }), '2026-10-30').start).toBe('2027-01-01');
    expect(planStretch(cadence(null), '2026-10-30').start).toBe('2026-11-02');
  });

  it('asks from 7 days before the end, until it is planned', () => {
    // This stretch was planned; one never planned is asked for at once.
    expect(planningDue(cadence(months, { last_planned: '2026-10-01' }), '2026-12-23')).toBe(false);
    expect(planningDue(cadence(months, { last_planned: '2026-10-01' }), '2026-12-24')).toBe(true);
    expect(planningDue(cadence(months, { last_planned: '2027-01-01' }), '2026-12-24')).toBe(false);
    expect(planningDue(cadence(null), '2026-12-24')).toBe(false);
  });
});

describe('changing cadence', () => {
  const was = { plan_cadence: { every: 3, unit: 'months', anchor: '2026-08-01' }, plan_stretch: { last_note: 'kept' } } as const;
  const six: PlanCadence = { every: 6, unit: 'weeks' };

  it('switching when this plan ends keeps the stretch, then the new cadence runs', () => {
    const next = changeCadence(was, six, 'end', '2026-10-30');
    expect(next.plan_cadence).toEqual({ every: 6, unit: 'weeks', anchor: '2026-11-01' });
    expect(currentStretch(next, '2026-10-30')).toEqual({ start: '2026-08-01', end: '2026-10-31' });
    expect(nextStretch(next, '2026-10-30')).toEqual({ start: '2026-11-01', end: '2026-12-12' });
    expect(currentStretch(next, '2027-01-01')?.start).toBe('2026-12-13');
    expect(next.plan_stretch.last_note).toBe('kept');
  });

  it('ending now ends this stretch today and starts again tomorrow', () => {
    const next = changeCadence(was, { every: 3, unit: 'weeks' }, 'now', '2026-10-30');
    expect(currentStretch(next, '2026-10-30')).toEqual({ start: '2026-08-01', end: '2026-10-30' });
    expect(nextStretch(next, '2026-10-30')).toEqual({ start: '2026-10-31', end: '2026-11-20' });
    expect(currentStretch(next, '2026-10-31')).toEqual({ start: '2026-10-31', end: '2026-11-20' });
    // Planning is due for the new stretch, and it's that one planning is for, not the day that's ending.
    expect(next.plan_stretch.last_planned).toBe('2026-08-01');
    expect(planningDue(next, '2026-10-30')).toBe(true);
    expect(planStretch(next, '2026-10-30', true)).toEqual({ start: '2026-10-31', end: '2026-11-20' });
  });

  it('ending now keeps the ended plan, so an undated milestone in it is due today, not overdue by a made-up date', () => {
    const on = '2026-11-02';
    const next = changeCadence(cadence(QUARTERS), { every: 4, unit: 'weeks' }, 'now', on);
    const loaf = milestone('loaf', 'First loaf', null, { stretch: '2026-10-01' });
    const ctx = context({ settings: next, clock: fixedClock(`${on}T12:00:00Z`) });
    expect(stretchEnd('2026-10-01', next, on)).toBe(on);
    expect(msLate(loaf, ctx)).toBe(false);
    expect(effectiveDue(reportPlan({ end: '2027-03-31' }), loaf, ctx)).toBe(on);
  });

  it('turning it off clears the one-off dates', () => {
    const next = changeCadence({ ...was, plan_stretch: { one_offs: [{ start: '2026-11-01', end: '2026-12-01' }] } }, null, 'end', '2026-10-30');
    expect(next.plan_cadence).toBeNull();
    expect(next.plan_stretch.one_offs).toEqual([]);
  });

  it('with no current stretch, the first stretch starts on the chosen date', () => {
    const next = changeCadence(cadence(null), { every: 1, unit: 'quarters', anchor: '2026-11-15' }, 'end', '2026-11-01');
    expect(next.plan_cadence?.anchor).toBe('2026-11-15');
    expect(nextStretch(next, '2026-11-01')).toEqual({ start: '2026-11-15', end: '2026-12-31' });
  });
});

describe('milestones in a plan', () => {
  const ctx = context();

  it('takes a milestone by its stretch field or a date inside', () => {
    const p = reportPlan();
    expect(msInPlan(p, p.milestones[1]!, NEXT)).toBe(true);
    expect(msInPlan(p, p.milestones[0]!, NEXT)).toBe(false);
    expect(msInPlan(p, milestone('u', 'Undated', null, { stretch: NEXT.start }), NEXT)).toBe(true);
    expect(msInPlan(p, milestone('u', 'Undated', null), NEXT)).toBe(false);
    expect(msInPlan(p, milestone('e', 'Edge', NEXT.end), NEXT)).toBe(true);
    expect(msInPlan(p, milestone('e', 'After', '2027-02-01'), NEXT)).toBe(false);
  });

  it('leaves out dropped milestones and projects that are not active', () => {
    const p = reportPlan();
    expect(msInPlan(p, { ...p.milestones[1]!, dropped_at: NOW }, NEXT)).toBe(false);
    expect(msInPlan(reportPlan({ state: 'paused' }), p.milestones[1]!, NEXT)).toBe(false);
  });

  it('has an implicit Done at the end, in the plan only while inside the stretch', () => {
    const p = reportPlan();
    p.tasks.push(task('loose', null, 3));
    expect(doneOf(p)).toMatchObject({ id: 'done:report', title: 'Done', due: '2026-12-15', met: false });
    expect(doneOf(p).tasks.map((t) => t.id)).toEqual(['loose']);
    expect(doneOf(reportPlan({ state: 'finished' })).met).toBe(true);
    expect(doneInPlan(p, NEXT)).toBe(true);
    expect(doneInPlan(reportPlan({ end: '2027-02-10' }), NEXT)).toBe(false);
    expect(doneInPlan(reportPlan({ state: 'paused' }), NEXT)).toBe(false);
  });

  it('lists what is planned, leaving out reached milestones', () => {
    const p = reportPlan();
    p.milestones[2] = { ...p.milestones[2]!, met_at: NOW };
    p.tasks.push(task('loose', null, 3));
    expect(plannedIds(p, NEXT)).toEqual(['m2', 'done:report']);
    // 4h + 1h under the planned milestone, 3h under Done.
    expect(planMinutes(p, NEXT)).toBe(8 * 60);
  });

  it('reads an undated date as by the stretch end, capped at the project end', () => {
    const p = reportPlan();
    const parked = milestone('u', 'Undated', null, { stretch: NEXT.start });
    expect(effectiveDue(p, parked, ctx)).toBe('2026-12-15');
    expect(effectiveDue(reportPlan({ end: '2027-06-01' }), parked, ctx)).toBe(NEXT.end);
    expect(effectiveDue(p, milestone('u', 'Undated', null), ctx)).toBe('2026-12-15');
    expect(effectiveDue(p, p.milestones[1]!, ctx)).toBe('2026-11-09');
  });

  it('is late only after the stretch for undated, and never with no stretch', () => {
    const parked = milestone('u', 'Undated', null, { stretch: NEXT.start });
    const on = (date: string) => context({ clock: fixedClock(`${date}T12:00:00Z`) });
    expect(msLate(parked, on('2027-01-31'))).toBe(false);
    expect(msLate(parked, on('2027-02-01'))).toBe(true);
    expect(msLate(milestone('u', 'Undated', null), on('2027-06-01'))).toBe(false);
    expect(msLate(milestone('d', 'Dated', '2026-10-29'), ctx)).toBe(true);
    expect(msLate(milestone('d', 'Dated', '2026-10-30'), ctx)).toBe(false);
  });

  it('sorts by date with dropped ones last', () => {
    const p = reportPlan();
    p.milestones = [p.milestones[2]!, { ...p.milestones[0]!, dropped_at: NOW }, p.milestones[1]!, milestone('u', 'Undated', null)];
    expect(sortedMilestones(p, ctx).map((m) => m.id)).toEqual(['m2', 'm3', 'u', 'm1']);
  });

  it('gathers each project with its own live records', () => {
    const [plan] = gatherPlans(
      [reportPlan().project, { ...reportPlan({ id: 'gone' }).project, deleted_at: NOW }],
      [milestone('a', 'A', null), milestone('b', 'B', null, { project_id: 'other' }), milestone('c', 'C', null, { deleted_at: NOW })],
      [task('a', 'a', 1), task('b', null, 1, { project_id: 'other' }), task('c', null, 1, { deleted_at: NOW })],
    );
    expect(plan?.milestones.map((m) => m.id)).toEqual(['a']);
    expect(plan?.tasks.map((t) => t.id)).toEqual(['a']);
  });
});

describe('soonest-date project order', () => {
  const ctx = context();
  const named = (id: string, due: string | null, end = '2026-12-31') => {
    const p = reportPlan({ id, end });
    return { ...p, milestones: due ? [milestone(`${id}-m`, 'Next', due, { project_id: id })] : [], tasks: [task(`${id}-t`, null, 1, { project_id: id })] };
  };

  it('goes by next open dated milestone, or else the end date', () => {
    const order = plannable([named('late', '2026-12-01'), named('soon', '2026-11-05'), named('ends', null, '2026-11-20')], ctx);
    expect(order.map((p) => p.project.id)).toEqual(['soon', 'ends', 'late']);
  });

  it('ignores reached, dropped and undated milestones when dating a project', () => {
    const p = named('skip', '2026-11-01');
    p.milestones = [
      { ...p.milestones[0]!, met_at: NOW },
      milestone('d', 'Dropped', '2026-11-02', { project_id: 'skip', dropped_at: NOW }),
      milestone('u', 'Undated', null, { project_id: 'skip', stretch: NEXT.start }),
    ];
    const order = plannable([p, named('other', '2026-11-20')], ctx);
    expect(order.map((x) => x.project.id)).toEqual(['other', 'skip']);
  });

  it('leaves out paused, not started and ended projects', () => {
    const ended = named('ended', null, '2026-10-20');
    expect(plannable([ended, reportPlan({ id: 'paused', state: 'paused' }), reportPlan({ id: 'later', start: '2026-11-15' })], ctx)).toEqual([]);
  });

  it('keeps a past-end project with an overdue milestone', () => {
    expect(plannable([reportPlan({ end: '2026-10-20' })], ctx)).toHaveLength(1);
  });

  it('moves a project down when its date moves later', () => {
    const a = named('a', '2026-11-05');
    const b = named('b', '2026-11-10');
    expect(plannable([a, b], ctx).map((p) => p.project.id)).toEqual(['a', 'b']);
    a.milestones = [{ ...a.milestones[0]!, due: '2030-01-01' }];
    expect(plannable([a, b], ctx).map((p) => p.project.id)).toEqual(['b', 'a']);
  });
});

describe('what a task is due by, in a week', () => {
  const ctx = context();
  const WEEK = '2026-11-02';
  const dueOf = (due: string | null, fields = {}) => {
    const p = reportPlan();
    p.milestones = [milestone('m', 'Check figures', due, fields)];
    const t = task('t', 'm', 1);
    p.tasks = [t];
    return taskDue(t, p, WEEK, ctx);
  };

  it('puts an overdue milestone first', () => {
    expect(dueOf('2026-10-18')).toMatchObject({ dueDay: -1, label: 'Check figures, overdue since Oct 18', why: 'earliest open, because Check figures is overdue' });
  });

  it('counts a date inside the week, or the Monday after as its last planned week', () => {
    expect(dueOf('2026-11-06')).toMatchObject({ dueDay: 4, label: 'Check figures, due Nov 6', why: 'before Check figures is due Nov 6' });
    expect(dueOf('2026-11-09').dueDay).toBe(6);
    expect(dueOf('2026-11-10').dueDay).toBeUndefined();
    expect(dueOf('2026-11-10').why).toBe('on your emptiest day. Check figures is due Nov 10');
  });

  it('never counts an undated milestone outside a plan as due', () => {
    expect(dueOf(null)).toMatchObject({ label: 'Check figures, by Dec 15', why: 'on your emptiest day' });
    expect(dueOf(null).dueDay).toBeUndefined();
  });

  it('counts an undated one in a stretch ending soon, and calls it by', () => {
    const shortStretch = context({ settings: { plan_cadence: null, plan_stretch: { one_offs: [{ start: '2026-10-20', end: '2026-11-05' }] } } });
    const p = reportPlan();
    p.milestones = [milestone('m', 'Check figures', null, { stretch: '2026-10-20' })];
    const t = task('t', 'm', 1);
    expect(taskDue(t, { ...p, tasks: [t] }, WEEK, shortStretch)).toMatchObject({ dueDay: 3, label: 'Check figures, by Nov 5' });
  });

  it('has no date from no milestone, a met one or a dropped one', () => {
    expect(taskDue(task('t', null, 1), reportPlan(), WEEK, ctx)).toEqual({ label: '', why: 'on your emptiest day' });
    expect(dueOf('2026-10-18', { met_at: NOW }).dueDay).toBeUndefined();
    expect(dueOf('2026-10-18', { dropped_at: NOW }).dueDay).toBeUndefined();
  });

  it('gives a one off its dates', () => {
    const dated = (from: string, to?: string) => task('o', null, 1, { kind: 'one_off', project_id: null, schedule: { type: 'once', from, to: to ?? null } });
    expect(taskDue(dated('2026-11-03', '2026-11-06'), null, WEEK, ctx)).toEqual({
      dated: true,
      opensDay: 1,
      dueDay: 4,
      label: 'Nov 3 to Nov 6',
      why: 'between its dates',
    });
    expect(taskDue(dated('2026-11-02'), null, WEEK, ctx)).toEqual({ dated: true, dueDay: 0, label: 'Nov 2', why: 'on its date' });
    expect(taskDue(dated('2026-12-01', '2026-12-15'), null, WEEK, ctx).dueDay).toBeUndefined();
    expect(taskDue(task('o', null, 1, { kind: 'one_off', project_id: null }), null, WEEK, ctx)).toEqual({ label: '', why: 'on your emptiest day' });
  });

  it('turns those days into the dates suggested times rank by', () => {
    const fence = task('o', null, 1, { kind: 'one_off', project_id: null });
    expect(taskWork(fence, { dated: true, opensDay: 1, dueDay: 4, label: '', why: '' }, WEEK)).toEqual({ kind: 'one_off', due: '2026-11-06', opens: '2026-11-03' });
    expect(taskWork(task('t', null, 1), { label: '', why: '' }, WEEK)).toEqual({ kind: 'project', due: null, opens: null });
  });

  it('keeps the date of a one off dated after the week, so any time picked for it this week gets a note', () => {
    const fence = task('o', null, 1, { kind: 'one_off', project_id: null, schedule: { type: 'once', from: '2026-11-11', to: null } });
    expect(taskWork(fence, taskDue(fence, null, WEEK, ctx), WEEK)).toEqual({ kind: 'one_off', due: null, opens: '2026-11-11' });
  });
});

describe('the candidates for a week', () => {
  const ctx = context();
  const week = (fields: Partial<WeekInput> = {}): WeekInput => ({ weekStart: '2026-11-02', picks: [], blocks: [], ...fields });
  const pick = (task_id: string, minutes: number): WeekPick => ({ id: `pick:${task_id}`, week_start: '2026-11-02', task_id, minutes });
  const block = (task_id: string, start: string, end: string): TimeBlock => ({ id: `b:${task_id}`, task_id, start, end, tz: 'UTC' });

  it('lists work needing a new time first, then planned milestones by date, then Done, then the rest', () => {
    const p = reportPlan();
    p.milestones.push(milestone('far', 'Far off', '2027-05-01'));
    p.tasks.push(task('t6', 'far', 1), task('t7', null, 1));
    const ids = projectCandidates(p, week({ carried: new Set(['t5']) }), ctx).map((c) => c.task.id);
    expect(ids).toEqual(['t5', 't2', 't3', 't4', 't7', 't6']);
  });

  it('leaves out closed tasks and ones fully placed, but keeps tasks with no estimate pickable', () => {
    const p = reportPlan();
    p.tasks.push(task('none', null, 0, { estimate_min: null }), task('gone', null, 1, { cancelled_at: NOW }));
    const placed = block('t5', '2026-11-03T10:00:00Z', '2026-11-03T11:00:00Z');
    const ids = projectCandidates(p, week({ blocks: [placed] }), ctx).map((c) => c.task.id);
    expect(ids).toEqual(['t2', 't3', 't4', 'none']);
  });

  it('withPicked also keeps a task already on the calendar this week, so Pick shows it rather than dropping it', () => {
    const p = reportPlan();
    const placed = block('t5', '2026-11-03T10:00:00Z', '2026-11-03T11:00:00Z');
    expect(projectCandidates(p, week({ blocks: [placed] }), ctx).map((c) => c.task.id)).not.toContain('t5');
    expect(projectCandidates(p, week({ blocks: [placed] }), ctx, true).find((c) => c.task.id === 't5')).toMatchObject({ left: 0, placed: true });
  });

  it('counts only what is still ahead as placed, since a past block already changed what remains', () => {
    const p = reportPlan();
    const past = block('t3', '2026-10-29T10:00:00Z', '2026-10-29T11:00:00Z');
    const ahead = { ...block('t3', '2026-11-03T10:00:00Z', '2026-11-03T11:00:00Z'), id: 'b2' };
    const c = projectCandidates(p, week({ blocks: [past, ahead] }), ctx).find((x) => x.task.id === 't3');
    expect(c?.left).toBe(180);
  });

  it('reads picks for that week only, ignoring removed ones', () => {
    const p = reportPlan();
    const c = (picks: WeekPick[]) => projectCandidates(p, week({ picks }), ctx).find((x) => x.task.id === 't3');
    expect(c([pick('t3', 60)])).toMatchObject({ picked: true, week: 60 });
    expect(c([{ ...pick('t3', 60), week_start: '2026-11-09' }])?.picked).toBe(false);
    expect(c([{ ...pick('t3', 60), deleted_at: NOW }])?.picked).toBe(false);
  });

  it('starts a one off dated inside the week as picked, and no other', () => {
    const once = (id: string, from: string | null, to: string | null = null) =>
      task(id, null, 1, { kind: 'one_off', project_id: null, schedule: { type: 'once', from, to } });
    const list = [
      once('in', '2026-11-03', '2026-11-06'),
      once('spans', '2026-10-20', '2026-11-02'),
      once('later', '2026-12-01'),
      once('undated', null),
      once('past', '2026-10-20'),
      { ...once('done', '2026-11-04'), done_at: NOW },
      { ...once('no-time', '2026-11-06'), estimate_min: null },
      { ...once('used-up', '2026-11-06'), remaining_min: 0 },
    ];
    expect(autoPickedOneOffs(list, '2026-11-02').map((t) => t.id)).toEqual(['in', 'spans', 'no-time']);
  });

  it('adds a suggestion where a milestone is overdue or due soon, in full', () => {
    const p = reportPlan();
    expect(suggestions([p], [], week({ freeMin: 6000 }), ctx)).toEqual({
      t2: { minutes: 120, why: 'Suggested: milestone overdue' },
      t3: { minutes: 240, why: 'Suggested: due Nov 9' },
      t4: { minutes: 60, why: 'Suggested: due Nov 9' },
    });
  });

  it('suggests the part that reaches the aim, rounded up to 30 minutes, from planned milestones only', () => {
    const p = reportPlan({ weekly_aim: 300 });
    p.milestones = [milestone('m3', 'Send for review', '2026-12-01'), milestone('out', 'Later', '2027-03-01')];
    p.tasks = [task('out-1', 'out', 8), task('t5', 'm3', 8)];
    expect(suggestions([p], [], week({ freeMin: 6000 }), ctx)).toEqual({ t5: { minutes: 300, why: 'Suggested: reaches aim' } });
    const q = reportPlan({ weekly_aim: 100 });
    q.milestones = p.milestones;
    q.tasks = p.tasks;
    expect(suggestions([q], [], week({ freeMin: 6000 }), ctx).t5?.minutes).toBe(120);
  });

  it('counts placed and picked time toward the aim', () => {
    const p = reportPlan({ weekly_aim: 300 });
    p.milestones = [milestone('m3', 'Send for review', '2026-12-01')];
    p.tasks = [task('a', 'm3', 8), task('b', 'm3', 8), task('c', 'm3', 8)];
    const placed = block('a', '2026-11-03T10:00:00Z', '2026-11-03T12:00:00Z');
    const got = suggestions([p], [], week({ freeMin: 6000, picks: [pick('b', 120)], blocks: [placed] }), ctx);
    expect(got).toEqual({ a: { minutes: 60, why: 'Suggested: reaches aim' } });
  });

  it("counts a picked task's time once, as its pick, however much of it is placed", () => {
    const p = reportPlan({ weekly_aim: 240 });
    p.milestones = [milestone('m3', 'Send for review', '2026-12-01')];
    p.tasks = [task('a', 'm3', 6), task('b', 'm3', 2), task('c', 'm3', 2)];
    const picks = [pick('a', 60), pick('b', 120)];
    const before = suggestions([p], [], week({ freeMin: 6000, picks }), ctx);
    expect(before).toEqual({ c: { minutes: 60, why: 'Suggested: reaches aim' } });
    // Part of a placed, and all of b, which leaves b nothing more to place.
    const placed = [block('a', '2026-11-03T10:00:00Z', '2026-11-03T11:00:00Z'), { ...block('b', '2026-11-04T10:00:00Z', '2026-11-04T12:00:00Z'), id: 'b2' }];
    expect(suggestions([p], [], week({ freeMin: 6000, picks, blocks: placed }), ctx)).toEqual(before);
  });

  it('uses this week\'s aim over the usual one, including none', () => {
    const p = reportPlan({ weekly_aim: 300 });
    p.milestones = [milestone('m3', 'Send for review', '2026-12-01')];
    p.tasks = [task('a', 'm3', 8)];
    expect(suggestions([p], [], week({ freeMin: 6000, aims: { report: 60 } }), ctx).a?.minutes).toBe(60);
    expect(suggestions([p], [], week({ freeMin: 6000, aims: { report: 0 } }), ctx)).toEqual({});
  });

  it('draws aim time from Done when it is in the plan, and not from outside', () => {
    const p = reportPlan({ weekly_aim: 60 });
    p.milestones = [];
    p.tasks = [task('loose', null, 2)];
    expect(suggestions([p], [], week({ freeMin: 6000 }), ctx).loose?.minutes).toBe(60);
    const out = reportPlan({ weekly_aim: 60, end: '2027-05-01' });
    expect(suggestions([{ ...out, milestones: [], tasks: p.tasks }], [], week({ freeMin: 6000 }), ctx)).toEqual({});
  });

  it('caps what it suggests at the free time left, giving a partial suggestion, soonest project first', () => {
    const first = reportPlan({ id: 'first', weekly_aim: 0 });
    first.milestones = [milestone('f', 'Soon', '2026-11-03', { project_id: 'first' })];
    first.tasks = [task('ft', 'f', 3, { project_id: 'first' })];
    const second = reportPlan({ id: 'second', weekly_aim: 0 });
    second.milestones = [milestone('s', 'Later', '2026-11-06', { project_id: 'second' })];
    second.tasks = [task('st', 's', 3, { project_id: 'second' })];
    expect(suggestions([second, first], [], week({ freeMin: 240 }), ctx)).toEqual({
      ft: { minutes: 180, why: 'Suggested: due Nov 3' },
      st: { minutes: 60, why: 'Suggested: due Nov 6' },
    });
    expect(suggestions([second, first], [], week({ freeMin: 0 }), ctx)).toEqual({});
  });

  it('does not suggest what is picked, stale, or in a project planning cannot schedule', () => {
    const p = reportPlan({ weekly_aim: 0 });
    p.milestones = [milestone('m', 'Soon', '2026-11-03')];
    p.tasks = [
      task('picked', 'm', 1),
      task('stale', 'm', 1),
      task('open', 'm', 1),
    ];
    const got = suggestions([p], [], week({ freeMin: 6000, picks: [pick('picked', 60)], stale: new Set(['stale']) }), ctx);
    expect(Object.keys(got)).toEqual(['open']);
    expect(suggestions([{ ...p, project: { ...p.project, state: 'paused' } }], [], week({ freeMin: 6000 }), ctx)).toEqual({});
  });

  it('suggests one offs dated in the week and repeating ones toward their aim, and no later or undated one', () => {
    const oneOff = (id: string, fields: Partial<Task>) => task(id, null, 1, { kind: 'one_off', project_id: null, ...fields });
    const list = [
      oneOff('dated', { schedule: { type: 'once', from: '2026-11-03', to: '2026-11-06' } }),
      oneOff('later', { schedule: { type: 'once', from: '2026-12-01', to: '2026-12-15' } }),
      oneOff('undated', { schedule: { type: 'once' } }),
      oneOff('repeats', { schedule: { type: 'float', every: 6, unit: 'week' } }),
    ];
    const got = suggestions([], list, week({ freeMin: 6000, oneOffAim: 120 }), ctx);
    expect(got).toEqual({
      dated: { minutes: 60, why: 'Suggested: Nov 3 to Nov 6' },
      repeats: { minutes: 60, why: 'Suggested: reaches aim' },
    });
  });

  it('treats a repeating one off as due when its next date falls in the week, and not after', () => {
    const repeating = (id: string, next_due: string) =>
      task(id, null, 1, { kind: 'one_off', project_id: null, next_due, schedule: { type: 'float', every: 6, unit: 'week' } });
    const got = suggestions([], [repeating('soon', '2026-11-05'), repeating('far', '2027-01-05')], week({ freeMin: 6000 }), ctx);
    expect(got).toEqual({ soon: { minutes: 60, why: 'Suggested: Nov 5' } });
  });

  it('schedules due work first, then by project order, carried work and earlier milestones first, one offs after', () => {
    const a = reportPlan({ id: 'a', weekly_aim: 0 });
    a.milestones = [milestone('a-m1', 'A soon', '2026-11-04', { project_id: 'a' }), milestone('a-m2', 'A later', '2026-12-20', { project_id: 'a' })];
    a.tasks = [task('a-later', 'a-m2', 1, { project_id: 'a' }), task('a-soon', 'a-m1', 1, { project_id: 'a' }), task('a-not-picked', 'a-m1', 1, { project_id: 'a' })];
    const b = reportPlan({ id: 'b', weekly_aim: 0 });
    b.milestones = [milestone('b1', 'B soon', '2026-11-03', { project_id: 'b' }), milestone('b2', 'B later', '2026-12-10', { project_id: 'b' })];
    b.tasks = [task('b-soon', 'b1', 1, { project_id: 'b' }), task('b-later', 'b2', 1, { project_id: 'b' }), task('b-carried', 'b2', 1, { project_id: 'b' })];
    const off = reportPlan({ id: 'off', state: 'paused' });
    off.milestones = [];
    off.tasks = [task('off-t', null, 1, { project_id: 'off' })];
    const dated = task('one-dated', null, 1, { kind: 'one_off', project_id: null, schedule: { type: 'once', from: '2026-11-04' } });
    const plain = task('one-plain', null, 1, { kind: 'one_off', project_id: null });
    const picked = ['a-later', 'a-soon', 'b-soon', 'b-later', 'b-carried', 'off-t', 'one-dated', 'one-plain'].map((id) => pick(id, 60));
    const order = scheduleOrder([a, b, off], [plain, dated], week({ picks: picked, carried: new Set(['b-carried']) }), ctx);
    expect(order.map((c) => c.task.id)).toEqual(['b-soon', 'a-soon', 'one-dated', 'b-carried', 'b-later', 'a-later', 'one-plain']);
  });

  it('keeps a picked task listed once all its time is placed, so the list shows progress', () => {
    const p = reportPlan();
    const off = task('one', null, 1, { kind: 'one_off', project_id: null });
    const blocks = [block('t5', '2026-11-03T10:00:00Z', '2026-11-03T11:00:00Z'), { ...block('one', '2026-11-03T12:00:00Z', '2026-11-03T13:00:00Z'), id: 'b2' }];
    const order = scheduleOrder([p], [off], week({ picks: [pick('t5', 60), pick('one', 60)], blocks }), ctx);
    expect(order.map((c) => [c.task.id, c.left])).toEqual([['t5', 0], ['one', 0]]);
  });
});

describe('replanning a project', () => {
  const ctx = context();
  const on = (date: string) => context({ clock: fixedClock(`${date}T12:00:00Z`) });
  const ms = (plan: ProjectPlan, id: string) => plan.milestones.find((m) => m.id === id)!;
  const tk = (plan: ProjectPlan, id: string) => plan.tasks.find((t) => t.id === id)!;
  const log = (plan: ProjectPlan) => plan.project.slip_log ?? [];
  const undone = (plan: ProjectPlan) => withChange(plan, undoLastChange(plan)!);
  const moved = (plan: ProjectPlan, id: string, day: string, c = ctx) => withChange(plan, moveMilestone(plan, id, day, c));

  describe('moving a milestone', () => {
    it('counts a later date as slip, says so, and undoes', () => {
      const before = reportPlan();
      const after = moved(before, 'm2', '2026-12-05');
      expect(ms(after, 'm2').due).toBe('2026-12-05');
      expect(log(after)[0]).toMatchObject({ kind: 'move', milestone_id: 'm2', from: '2026-11-09', to: '2026-12-05', days: 26, at: NOW });
      expect(log(after)[0]?.text).toBe('Oct 30: Moved Draft chapters from Nov 9 to Dec 5.');
      expect(replannedBadge(after)).toBe('Replanned: 26 days later');
      const back = undone(after);
      expect(ms(back, 'm2').due).toBe('2026-11-09');
      expect(log(back)).toEqual([]);
      expect(replannedBadge(back)).toBeNull();
    });

    it('measures slip from the first date, so moving back gives it back', () => {
      let p = moved(reportPlan(), 'm2', '2026-11-20');
      p = moved(p, 'm2', '2026-11-15');
      expect(log(p).map((e) => e.days)).toEqual([11, -5]);
      expect(replannedBadge(p)).toBe('Replanned: 6 days later');
      p = moved(p, 'm2', '2026-11-01');
      expect(replannedBadge(p)).toBeNull();
      expect(originalDue(p, ms(p, 'm2'), ctx)).toBe('2026-11-09');
    });

    it('moving earlier than the first date is no slip', () => {
      expect(log(moved(reportPlan(), 'm2', '2026-11-01'))[0]?.days).toBe(0);
    });

    it('is free on the day it was added, and counts from that date after', () => {
      const p = reportPlan();
      p.milestones.push(milestone('new', 'Book a room', '2026-11-20', { added_on: '2026-10-30' }));
      const corrected = moved(p, 'new', '2026-11-25');
      expect(ms(corrected, 'new').due).toBe('2026-11-25');
      expect(log(corrected)).toEqual([]);
      const next = moved(corrected, 'new', '2026-11-27', on('2026-10-31'));
      expect(log(next)[0]?.days).toBe(2);
    });

    it('pushes Done when past the end, counting both, and undoes all of it', () => {
      const after = moved(reportPlan(), 'm3', '2027-01-05');
      expect(after.project.end).toBe('2027-01-05');
      expect(log(after)[0]).toMatchObject({ days: 35, end_days: 21 });
      expect(replannedBadge(after)).toBe('Replanned: 56 days later');
      const back = undone(after);
      expect(back.project.end).toBe('2026-12-15');
      expect(ms(back, 'm3').due).toBe('2026-12-01');
    });

    it('pulls the start earlier when dated before it, with no slip', () => {
      const after = moved(reportPlan(), 'm2', '2026-09-20');
      expect(after.project.start).toBe('2026-09-20');
      expect(undone(after).project.start).toBe('2026-10-01');
    });

    it('gives an undated milestone a date and takes it out of its named plan, and undo restores both', () => {
      const p = reportPlan({ end: '2027-06-01' });
      p.milestones[1] = { ...p.milestones[1]!, due: null, stretch: NEXT.start };
      const after = moved(p, 'm2', '2027-02-10');
      expect(ms(after, 'm2')).toMatchObject({ due: '2027-02-10', stretch: null });
      // By Jan 31 became Feb 10.
      expect(log(after)[0]).toMatchObject({ from: NEXT.end, days: 10 });
      expect(ms(undone(after), 'm2')).toMatchObject({ due: null, stretch: NEXT.start });
    });

    it('moves an overdue one into the plan by date and clears Overdue', () => {
      const after = moved(reportPlan(), 'm1', '2026-11-06');
      expect(status(after, ctx).pill).toBe('Behind');
      expect(replannedBadge(after)).toBe('Replanned: 19 days later');
      expect(msInPlan(after, ms(after, 'm1'), NEXT)).toBe(true);
      expect(status(undone(after), ctx).pill).toBe('Overdue');
    });

    it('warns about passing the next milestone, the end, and the start', () => {
      const p = reportPlan();
      expect(milestoneWarnings(p, 'm1', '2026-11-20', ctx)).toEqual(['This puts it after Draft chapters.']);
      expect(milestoneWarnings(p, 'm3', '2027-01-05', ctx)).toEqual(["That moves the project's end to Jan 5."]);
      expect(milestoneWarnings(p, 'm1', '2026-09-20', ctx)).toEqual(["That's before the project starts, Oct 1."]);
      expect(milestoneWarnings(p, 'm2', '2026-11-20', ctx)).toEqual([]);
    });
  });

  describe('bringing a milestone in and out of a plan', () => {
    it('brings an overdue one in undated, counting real slip, which clears Overdue', () => {
      const p = reportPlan();
      const after = withChange(p, parkMilestone(p, 'm1', NEXT, ctx));
      expect(ms(after, 'm1')).toMatchObject({ due: null, stretch: NEXT.start });
      expect(effectiveDue(after, ms(after, 'm1'), ctx)).toBe('2026-12-15');
      expect(replannedBadge(after)).toBe('Replanned: 58 days later');
      expect(status(after, ctx).pill).not.toBe('Overdue');
      const back = undone(after);
      expect(replannedBadge(back)).toBeNull();
      expect(status(back, ctx).pill).toBe('Overdue');
    });

    it('does not count clearing a future date as slip, then counts from the same first date', () => {
      const p = reportPlan();
      const cleared = withChange(p, parkMilestone(p, 'm3', NEXT, ctx));
      expect(replannedBadge(cleared)).toBeNull();
      expect(ms(cleared, 'm3')).toMatchObject({ due: null, stretch: NEXT.start });
      const dated = moved(cleared, 'm3', '2026-12-08');
      expect(log(dated).at(-1)?.days).toBe(7);
    });

    it('keeps slip already counted when a slipped milestone is cleared', () => {
      const slipped = moved(reportPlan(), 'm3', '2026-12-08');
      const cleared = withChange(slipped, parkMilestone(slipped, 'm3', NEXT, ctx));
      expect(replannedBadge(cleared)).toBe('Replanned: 7 days later');
      const again = moved(cleared, 'm3', '2026-12-10');
      expect(replannedBadge(again)).toBe('Replanned: 9 days later');
    });

    it('takes a date inside the stretch out by clearing it, and it never goes overdue', () => {
      const p = reportPlan();
      const out = withChange(p, unplanMilestone(p, 'm2', NEXT, ctx));
      expect(ms(out, 'm2')).toMatchObject({ due: null, stretch: null });
      expect(msInPlan(out, ms(out, 'm2'), NEXT)).toBe(false);
      expect(msLate(ms(out, 'm2'), on('2027-06-01'))).toBe(false);
      expect(ms(undone(out), 'm2').due).toBe('2026-11-09');
    });

    it('just clears the plan name of one dated outside the stretch', () => {
      const p = reportPlan();
      p.milestones[0] = { ...p.milestones[0]!, stretch: NEXT.start };
      const out = withChange(p, unplanMilestone(p, 'm1', NEXT, ctx));
      expect(ms(out, 'm1')).toMatchObject({ due: '2026-10-18', stretch: null });
    });

    it('returns one brought in from a later date to that date', () => {
      const p = reportPlan({ end: '2027-06-01' });
      p.milestones[2] = { ...p.milestones[2]!, due: '2027-03-01' };
      const inPlan = toggleInPlan(p, 'm3', NEXT, ctx);
      const parked = withChange(p, inPlan);
      expect(ms(parked, 'm3')).toMatchObject({ due: null, stretch: NEXT.start });
      expect(log(parked)[0]?.text).toBe('Oct 30: Added Send for review to this plan, by Jan 31.');
      const out = withChange(parked, toggleInPlan(parked, 'm3', NEXT, ctx));
      expect(ms(out, 'm3')).toMatchObject({ due: '2027-03-01', stretch: null });
      expect(replannedBadge(out)).toBeNull();
    });

    it('resumes a paused project and pulls a later start when one is brought in, undone as one', () => {
      let p = reportPlan({ start: '2027-02-01', end: '2027-06-01' });
      p.milestones = [milestone('m', 'Check figures', null)];
      p.tasks = [];
      p = withChange(p, pauseProject(p, on('2026-10-20')));
      const after = withChange(p, toggleInPlan(p, 'm', NEXT, ctx));
      expect(after.project).toMatchObject({ state: 'active', start: NEXT.start, end: '2027-06-11' });
      expect(ms(after, 'm').stretch).toBe(NEXT.start);
      expect(log(after).at(-1)?.text).toBe('Oct 30: Added Check figures to this plan, by Jan 31. Project resumed.');
      expect(replannedBadge(after)).toBe('Replanned: 10 days later');
      const back = undone(after);
      expect(back.project).toMatchObject({ state: 'paused', start: '2027-02-01', end: '2027-06-01' });
      expect(ms(back, 'm').stretch).toBeNull();
    });

    it('resuming alone can be enough, when the date is already inside', () => {
      let p = reportPlan();
      p = withChange(p, pauseProject(p, on('2026-10-30')));
      const after = withChange(p, toggleInPlan(p, 'm2', NEXT, ctx));
      expect(after.project.state).toBe('active');
      expect(ms(after, 'm2')).toMatchObject({ due: '2026-11-09' });
      expect(msInPlan(after, ms(after, 'm2'), NEXT)).toBe(true);
    });
  });

  describe('dropping a milestone', () => {
    it('keeps done tasks on record and moves open ones to the next open milestone', () => {
      const p = reportPlan();
      const after = withChange(p, dropMilestone(p, 'm1', { cancelOpen: false }, ctx));
      expect(ms(after, 'm1').dropped_at).toBe(NOW);
      expect(tk(after, 't1')).toMatchObject({ milestone_id: 'm1', done_at: '2026-10-10T12:00:00Z' });
      expect(tk(after, 't2')).toMatchObject({ milestone_id: 'm2', moved_from: 'm1' });
      expect(log(after)[0]?.text).toBe('Oct 30: Dropped Gather notes. Moved 1 task to Draft chapters.');
      expect(replannedBadge(after)).toBe('Replanned: 1 milestone dropped');
      const back = undone(after);
      expect(ms(back, 'm1').dropped_at).toBeNull();
      expect(tk(back, 't2')).toMatchObject({ milestone_id: 'm1', moved_from: null });
    });

    it('with no later milestone, moves open tasks to Done', () => {
      const p = reportPlan();
      p.milestones = [ms(p, 'm1')];
      const after = withChange(p, dropMilestone(p, 'm1', { cancelOpen: false }, ctx));
      expect(tk(after, 't2').milestone_id).toBeNull();
      expect(log(after)[0]?.text).toBe('Oct 30: Dropped Gather notes. Moved 1 task to Done.');
    });

    it('can cancel open tasks, along with what is scheduled and picked for them', () => {
      const p = reportPlan();
      const blocks: TimeBlock[] = [
        { id: 'ahead', task_id: 't2', start: '2026-11-03T10:00:00Z', end: '2026-11-03T11:00:00Z', tz: 'UTC' },
        { id: 'past', task_id: 't2', start: '2026-10-29T10:00:00Z', end: '2026-10-29T11:00:00Z', tz: 'UTC' },
        { id: 'other', task_id: 't3', start: '2026-11-03T10:00:00Z', end: '2026-11-03T11:00:00Z', tz: 'UTC' },
      ];
      const picks: WeekPick[] = [
        { id: 'pick1', week_start: '2026-11-02', task_id: 't2', minutes: 60 },
        { id: 'pick2', week_start: '2026-11-02', task_id: 't3', minutes: 60 },
      ];
      const change = dropMilestone(p, 'm1', { cancelOpen: true, blocks, picks }, ctx);
      const after = withChange(p, change);
      expect(tk(after, 't2').cancelled_at).toBe(NOW);
      expect(log(after)[0]?.text).toBe('Oct 30: Dropped Gather notes. Cancelled 1 task.');
      expect(change.writes).toContainEqual({ type: 'time_block', id: 'ahead', fields: { cancelled: true } });
      expect(change.writes).toContainEqual({ type: 'week_pick', id: 'pick1', fields: { deleted_at: NOW } });
      expect(change.writes.filter((w) => ['past', 'other', 'pick2'].includes(w.id))).toEqual([]);
      const undo = undoLastChange(after)!;
      expect(undo.writes).toContainEqual({ type: 'time_block', id: 'ahead', fields: { cancelled: null } });
      expect(undo.writes).toContainEqual({ type: 'week_pick', id: 'pick1', fields: { deleted_at: null } });
      expect(tk(undone(after), 't2').cancelled_at).toBeNull();
    });

    it('skips a milestone that is reached, dropped or earlier when choosing where tasks go', () => {
      const p = reportPlan();
      p.milestones[1] = { ...ms(p, 'm2'), dropped_at: NOW };
      const after = withChange(p, dropMilestone(p, 'm1', { cancelOpen: false }, ctx));
      expect(tk(after, 't2').milestone_id).toBe('m3');
    });

    it('simply removes one added today with nothing done, leaving no record', () => {
      const p = reportPlan();
      p.milestones.push(milestone('new', 'Book a room', '2026-11-05', { added_on: '2026-10-30' }));
      p.tasks.push(task('t9', 'new', 1));
      const after = withChange(p, dropMilestone(p, 'new', { cancelOpen: false }, ctx));
      expect(after.milestones.find((m) => m.id === 'new')).toBeUndefined();
      expect(tk(after, 't9').milestone_id).toBe('m2');
      expect(log(after)).toEqual([]);
    });

    it('cancels the open tasks of one added today when asked, with what is scheduled and picked for them', () => {
      const p = reportPlan();
      p.milestones.push(milestone('new', 'Book a room', '2026-11-05', { added_on: '2026-10-30' }));
      p.tasks.push(task('t9', 'new', 1));
      const blocks: TimeBlock[] = [{ id: 'ahead', task_id: 't9', start: '2026-11-03T10:00:00Z', end: '2026-11-03T11:00:00Z', tz: 'UTC' }];
      const picks: WeekPick[] = [{ id: 'pick9', week_start: '2026-11-02', task_id: 't9', minutes: 60 }];
      const change = dropMilestone(p, 'new', { cancelOpen: true, blocks, picks }, ctx);
      const after = withChange(p, change);
      expect(after.milestones.find((m) => m.id === 'new')).toBeUndefined();
      expect(tk(after, 't9')).toMatchObject({ milestone_id: 'new', cancelled_at: NOW });
      expect(change.writes).toContainEqual({ type: 'time_block', id: 'ahead', fields: { cancelled: true } });
      expect(change.writes).toContainEqual({ type: 'week_pick', id: 'pick9', fields: { deleted_at: NOW } });
    });
  });

  describe('marking a milestone done', () => {
    it('ticks its open tasks and meets it, and undo reverses only those', () => {
      const p = reportPlan();
      const after = withChange(p, markMilestoneDone(p, 'm1', {}, ctx));
      expect(tk(after, 't2').done_at).toBe(NOW);
      expect(ms(after, 'm1').met_at).toBe(NOW);
      expect(log(after)[0]).toMatchObject({ kind: 'met', milestone_id: 'm1' });
      expect(log(after)[0]?.text).toBe('Oct 30: Marked Gather notes done, and ticked 1 task.');
      // A task ticked since then stays ticked.
      const later = { ...after, tasks: after.tasks.map((t) => (t.id === 't3' ? { ...t, done_at: NOW } : t)) };
      const back = undone(later);
      expect(tk(back, 't2').done_at).toBeNull();
      expect(tk(back, 't1').done_at).toBe('2026-10-10T12:00:00Z');
      expect(tk(back, 't3').done_at).toBe(NOW);
      expect(ms(back, 'm1').met_at).toBeNull();
    });

    it('says so plainly with no open tasks, and clears what was still scheduled', () => {
      const p = reportPlan();
      const none = withChange(p, markMilestoneDone(p, 'm3', {}, ctx));
      expect(log(none)[0]?.text).toBe('Oct 30: Marked Send for review done, and ticked 1 task.');
      const closed = { ...p, tasks: p.tasks.filter((t) => t.id !== 't5') };
      expect(log(withChange(closed, markMilestoneDone(closed, 'm3', {}, ctx)))[0]?.text).toBe('Oct 30: Marked Send for review done.');
      const blocks: TimeBlock[] = [{ id: 'ahead', task_id: 't2', start: '2026-11-03T10:00:00Z', end: '2026-11-03T11:00:00Z', tz: 'UTC' }];
      expect(markMilestoneDone(p, 'm1', { blocks }, ctx).writes).toContainEqual({ type: 'time_block', id: 'ahead', fields: { cancelled: true } });
    });

    it('can be marked not met', () => {
      const p = reportPlan();
      p.milestones[2] = { ...ms(p, 'm3'), met_at: '2026-10-20T12:00:00Z' };
      const after = withChange(p, markMilestoneNotMet(p, 'm3', ctx));
      expect(ms(after, 'm3').met_at).toBeNull();
      expect(log(after)[0]?.text).toBe('Oct 30: Marked Send for review not met.');
      expect(ms(undone(after), 'm3').met_at).toBe('2026-10-20T12:00:00Z');
    });
  });

  describe('moving Done', () => {
    it('counts a later end as slip and an earlier one as none', () => {
      const p = reportPlan();
      const later = withChange(p, moveDone(p, '2027-02-10', ctx));
      expect(later.project.end).toBe('2027-02-10');
      expect(replannedBadge(later)).toBe('Replanned: 57 days later');
      expect(log(later)[0]).toMatchObject({ kind: 'end', from: '2026-12-15', to: '2027-02-10' });
      expect(log(later)[0]?.text).toBe('Oct 30: Done moved to Feb 10.');
      expect(doneInPlan(later, NEXT)).toBe(false);
      expect(undone(later).project.end).toBe('2026-12-15');
      expect(replannedBadge(withChange(p, moveDone(p, '2026-12-05', ctx)))).toBeNull();
    });

    it('stays last, and undated milestones follow it', () => {
      const p = reportPlan();
      expect(doneDateError(p, '2026-11-20')).toBe('Done stays last. Pick Dec 1 or later.');
      expect(doneDateError(p, '2026-12-01')).toBeNull();
      expect(() => moveDone(p, '2026-11-20', ctx)).toThrow('Done stays last');
      const q = reportPlan({ end: '2027-01-15' });
      q.milestones = [milestone('u', 'Undated', null, { stretch: NEXT.start })];
      expect(doneDateError(q, '2026-09-01')).toBe('Done stays last. Pick Oct 1 or later.');
      const pulled = withChange(q, moveDone(q, '2026-12-20', ctx));
      expect(effectiveDue(pulled, ms(pulled, 'u'), ctx)).toBe('2026-12-20');
    });
  });

  describe('pausing and resuming', () => {
    it('moves open dates by the days paused, counted as slip', () => {
      const p = reportPlan();
      p.milestones[0] = { ...ms(p, 'm1'), met_at: '2026-10-05T12:00:00Z' };
      p.milestones[1] = { ...ms(p, 'm2'), dropped_at: '2026-10-05T12:00:00Z' };
      const paused = withChange(p, pauseProject(p, on('2026-10-16')));
      expect(paused.project.state).toBe('paused');
      const after = withChange(paused, resumeProject(paused, ctx));
      expect(after.project).toMatchObject({ state: 'active', end: '2026-12-29' });
      expect(ms(after, 'm1').due).toBe('2026-10-18');
      expect(ms(after, 'm2').due).toBe('2026-11-09');
      expect(ms(after, 'm3').due).toBe('2026-12-15');
      expect(replannedBadge(after)).toBe('Replanned: 14 days later, 1 milestone dropped');
      expect(log(after).at(-1)?.text).toBe('Oct 30: Resumed. Open dates moved by the 14 days it was paused.');
      const back = undone(after);
      expect(back.project).toMatchObject({ state: 'paused', end: '2026-12-15' });
      expect(ms(back, 'm3').due).toBe('2026-12-01');
    });

    it('does not count a resumed shift again on the next move', () => {
      const p = reportPlan();
      const paused = withChange(p, pauseProject(p, on('2026-10-16')));
      const resumed = withChange(paused, resumeProject(paused, ctx));
      expect(log(moved(resumed, 'm3', '2026-12-16')).at(-1)?.days).toBe(1);
    });

    it('resumes with no shift if the pause date is unknown', () => {
      const p = reportPlan({ state: 'paused' });
      const after = withChange(p, resumeProject(p, ctx));
      expect(after.project).toMatchObject({ state: 'active', end: '2026-12-15' });
      expect(log(after)[0]?.text).toBe('Oct 30: Resumed.');
    });
  });

  it('undoes only the newest change, then the one before', () => {
    const one = moved(reportPlan(), 'm2', '2026-11-20');
    const two = moved(one, 'm3', '2026-12-05');
    const back = undone(two);
    expect(ms(back, 'm3').due).toBe('2026-12-01');
    expect(ms(back, 'm2').due).toBe('2026-11-20');
    expect(ms(undone(back), 'm2').due).toBe('2026-11-09');
    expect(undoLastChange(reportPlan())).toBeNull();
  });

  it('badges days and drops together, with singular words', () => {
    const p = moved(reportPlan(), 'm3', '2026-12-02');
    expect(replannedBadge(p)).toBe('Replanned: 1 day later');
    const q = withChange(p, dropMilestone(p, 'm1', { cancelOpen: false }, ctx));
    const r = withChange(q, dropMilestone(q, 'm2', { cancelOpen: false }, ctx));
    expect(replannedBadge(r)).toBe('Replanned: 1 day later, 2 milestones dropped');
  });

  it('writes a change and its Undo through records, and can reverse it from what was replaced', async () => {
    const clock = fixedClock(NOW);
    const db = await openDb(nodeSqliteDriver());
    const p = reportPlan();
    await transact(db, clock, async (w) => {
      const { id: _project, ...project } = p.project;
      await w.create('project', project, 'report');
      for (const { id, ...m } of p.milestones) await w.create('milestone', m, id);
      for (const { id, ...t } of p.tasks) await w.create('task', t, id);
    });
    const load = async (): Promise<ProjectPlan> =>
      gatherPlans(await listRecords(db, 'project'), await listRecords(db, 'milestone'), await listRecords(db, 'task'))[0]!;

    await transact(db, clock, (w) => applyPlanChange(w, dropMilestone(p, 'm1', { cancelOpen: true }, ctx)));
    let saved = await load();
    expect(saved.milestones.find((m) => m.id === 'm1')?.dropped_at).toBe(NOW);
    expect(saved.tasks.find((t) => t.id === 't2')?.cancelled_at).toBe(NOW);
    expect(saved.project.slip_log).toHaveLength(1);

    await transact(db, clock, (w) => applyPlanChange(w, undoLastChange(saved)!));
    saved = await load();
    expect(saved.milestones.find((m) => m.id === 'm1')?.dropped_at).toBeNull();
    expect(saved.tasks.find((t) => t.id === 't2')?.cancelled_at).toBeNull();
    expect(saved.project.slip_log).toEqual([]);

    const inverse = await transact(db, clock, (w) => applyPlanChange(w, moveMilestone(saved, 'm2', '2026-11-20', ctx)));
    await transact(db, clock, (w) => applyPlanChange(w, inverse));
    saved = await load();
    expect(saved.milestones.find((m) => m.id === 'm2')?.due).toBe('2026-11-09');
    expect(saved.project.slip_log).toEqual([]);
  });
});

describe('cadenceLabel', () => {
  it('names the cadence as Settings and the Plan page show it', () => {
    expect(cadenceLabel(null)).toBe('Not set');
    expect(cadenceLabel({ every: 1, unit: 'quarters' })).toBe('Calendar quarters');
    expect(cadenceLabel({ every: 3, unit: 'quarters' })).toBe('Calendar quarters');
    expect(cadenceLabel({ every: 1, unit: 'months' })).toBe('Every month');
    expect(cadenceLabel({ every: 3, unit: 'months', anchor: '2026-02-01' })).toBe('Every 3 months');
    expect(cadenceLabel({ every: 2, unit: 'weeks' })).toBe('Every 2 weeks');
  });
});

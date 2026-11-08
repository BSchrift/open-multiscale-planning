import { describe, expect, it } from 'vitest';
import { openTestDb } from '../platform/node-sqlite';
import {
  loadAnalyticsData,
  raisedEstimates,
  stretchAnalytics,
  toggleAvoidedSlot,
  weekAnalytics,
} from './analytics';
import type { AnalyticsData } from './analytics';
import { fixedClock } from './clock';
import { addDays, addWeeks, localToInstant } from './dates';
import { gatherPlans, msReached, toggleInPlan, withChange } from './plan';
import type { ProjectPlan } from './plan';
import { needsNewTime } from './queries';
import { deleteWork, queueItems } from './queue';
import { getRecord, outcomeId, transact } from './records';
import { closeProject } from './tasks';
import type { BlockResult, Milestone, Task, TimeBlock } from './types';

const ZONE = 'America/Chicago';
const WEEK = '2026-11-02'; // A Monday, and the week the clock sits in.
const NOW = localToInstant('2026-11-06', 12 * 60, ZONE); // Friday noon.
const clock = fixedClock(NOW, ZONE);

let seq = 0;

function emptyData(): AnalyticsData {
  return {
    objectives: [
      { id: 'g2', title: 'Learn to bake bread', state: 'active', order: 2 },
      { id: 'g1', title: 'Write the report', state: 'active', order: 1 },
    ],
    projects: [
      { id: 'p1', objective_id: 'g1', title: 'First draft', state: 'active', start: '2026-09-01', end: '2026-12-31' },
      { id: 'p2', objective_id: 'g2', title: 'Sourdough', state: 'active', start: '2026-09-01', end: '2026-12-31' },
      { id: 'p3', objective_id: null, title: 'Paint the fence', state: 'active', start: '2026-09-01', end: '2026-12-31' },
    ],
    milestones: [],
    tasks: [
      { id: 't1', kind: 'project', project_id: 'p1', title: 'Outline' },
      { id: 't2', kind: 'project', project_id: 'p2', title: 'Feed the starter' },
      { id: 't3', kind: 'project', project_id: 'p3', title: 'Buy paint' },
      { id: 'o1', kind: 'one_off', title: 'Clean the windows' },
    ],
    blocks: [],
    outcomes: [],
    practices: [
      { id: 'pr1', objective_id: 'g2', title: 'Knead dough', target_min: 30, per: 'day', days: [0, 2, 4], state: 'active' },
      { id: 'pr2', title: 'Stretch', target_min: 70, per: 'week', state: 'active' },
    ],
    away: [],
    avoided_slots: [],
  };
}

interface BlockOpts extends Partial<TimeBlock> {
  mins?: number;
  result?: BlockResult;
  logged?: number;
}

/** Adds a block at a local date and time, with an outcome if a result is given. */
function block(data: AnalyticsData, owner: { task?: string; practice?: string }, date: string, at: number, opts: BlockOpts = {}) {
  const { mins = 60, result, logged, ...rest } = opts;
  const id = `b${++seq}`;
  data.blocks.push({
    id,
    task_id: owner.task ?? null,
    practice_id: owner.practice ?? null,
    start: localToInstant(date, at, ZONE),
    end: localToInstant(date, at + mins, ZONE),
    tz: ZONE,
    ...rest,
  });
  if (result) {
    data.outcomes.push({ id: outcomeId(id), result, answered_at: NOW, ...(logged === undefined ? {} : { logged_min: logged }) });
  }
  return id;
}

const MON = '2026-11-02';
const TUE = '2026-11-03';

describe('reliability', () => {
  it('counts done and partly as a share of answered blocks, by project work and one offs', () => {
    const d = emptyData();
    block(d, { task: 't1' }, MON, 540, { result: 'done' });
    block(d, { task: 't1' }, MON, 600, { result: 'partly', logged: 30 });
    block(d, { task: 't2' }, MON, 660, { result: 'not' });
    block(d, { task: 'o1' }, MON, 720, { result: 'done' });
    const r = weekAnalytics(d, clock, WEEK).reliability;
    expect(r.project).toEqual({ done: 1, partly: 1, not: 1, total: 3, pct: 67 });
    expect(r.one_offs).toEqual({ done: 1, partly: 0, not: 0, total: 1, pct: 100 });
  });

  it('reads 0% with no answers rather than dividing by zero', () => {
    expect(weekAnalytics(emptyData(), clock, WEEK).reliability.project).toEqual({ done: 0, partly: 0, not: 0, total: 0, pct: 0 });
  });

  it('leaves out practices, cancelled blocks and away dates', () => {
    const d = emptyData();
    block(d, { practice: 'pr1' }, MON, 540, { result: 'not' });
    block(d, { task: 't1' }, MON, 600, { result: 'not', cancelled: true });
    block(d, { task: 't1' }, TUE, 600, { result: 'not' });
    d.away.push({ id: 'a1', start: TUE, end: TUE });
    expect(weekAnalytics(d, clock, WEEK).reliability.project.total).toBe(0);
  });
});

describe('unanswered blocks', () => {
  it('counts task blocks that have ended with no answer', () => {
    const d = emptyData();
    block(d, { task: 't1' }, MON, 540);
    block(d, { task: 'o1' }, MON, 660);
    block(d, { task: 't1' }, MON, 780, { result: 'done' });
    expect(weekAnalytics(d, clock, WEEK).unanswered).toBe(2);
  });

  it('skips blocks not yet ended, missed practices, cancelled blocks and away dates', () => {
    const d = emptyData();
    block(d, { task: 't1' }, '2026-11-06', 11 * 60 + 30); // Runs past now.
    block(d, { task: 't1' }, '2026-11-07', 540); // Future.
    block(d, { practice: 'pr1' }, MON, 540);
    block(d, { task: 't1' }, MON, 600, { cancelled: true });
    block(d, { task: 't1' }, TUE, 600);
    d.away.push({ id: 'a1', start: TUE, end: TUE });
    expect(weekAnalytics(d, clock, WEEK).unanswered).toBe(0);
  });
});

describe('started on time', () => {
  it('is the share of started or answered blocks begun within 10 minutes, early counting as on time', () => {
    const d = emptyData();
    const at = (min: number) => localToInstant(MON, min, ZONE);
    block(d, { task: 't1' }, MON, 540, { started_at: at(550), result: 'done' }); // Exactly 10 late.
    block(d, { task: 't1' }, MON, 600, { started_at: at(590), result: 'done' }); // Early.
    block(d, { practice: 'pr1' }, MON, 660, { started_at: at(671), result: 'done' }); // 11 late.
    block(d, { task: 't1' }, MON, 720, { result: 'not' }); // Never started.
    block(d, { task: 't1' }, MON, 780); // Unanswered: not included.
    expect(weekAnalytics(d, clock, WEEK).started_on_time).toBe(50);
  });

  it('is null when nothing counts', () => {
    expect(weekAnalytics(emptyData(), clock, WEEK).started_on_time).toBeNull();
  });
});

describe('time by goal', () => {
  it('compares delivered with planned, with practices under their goal and goals in their order', () => {
    const d = emptyData();
    block(d, { task: 't1' }, MON, 540, { mins: 120, result: 'done' });
    block(d, { task: 't1' }, MON, 700, { result: 'not' });
    block(d, { task: 't2' }, MON, 800, { mins: 60, result: 'partly', logged: 15 });
    block(d, { practice: 'pr1' }, MON, 900, { mins: 30, result: 'done' });
    block(d, { task: 'o1' }, '2026-11-07', 540); // Later this week: planned, not yet delivered.
    const t = weekAnalytics(d, clock, WEEK).time;
    expect(t.rows.map((r) => [r.id, r.name, r.delivered_min, r.planned_min, r.pct])).toEqual([
      ['g1', 'Write the report', 120, 180, 67],
      ['g2', 'Learn to bake bread', 45, 90, 50],
      ['one_offs', 'One offs', 0, 60, 0],
    ]);
    expect([t.delivered_min, t.planned_min]).toEqual([165, 330]);
  });

  it('caps pct at 100 and uses actual time when Mark done now or an early start changed it', () => {
    const d = emptyData();
    const at = (min: number) => localToInstant(MON, min, ZONE);
    block(d, { task: 't1' }, MON, 540, { result: 'done', ended_at: at(570) }); // Ended 30m early.
    block(d, { task: 't2' }, MON, 700, { mins: 30, result: 'done', started_at: at(670) }); // Started 30m early.
    const rows = weekAnalytics(d, clock, WEEK).time.rows;
    expect(rows.find((r) => r.id === 'g1')!.delivered_min).toBe(30);
    expect(rows.find((r) => r.id === 'g2')!.delivered_min).toBe(60);
    expect(rows.find((r) => r.id === 'g2')!.pct).toBe(100);
  });

  it('shows No goal only with time in it, and keeps an archived goal only while it has time', () => {
    const d = emptyData();
    expect(weekAnalytics(d, clock, WEEK).time.rows.map((r) => r.id)).toEqual(['g1', 'g2', 'one_offs']);
    d.objectives.push({ id: 'g3', title: 'Old goal', state: 'archived' });
    d.projects.push({ id: 'p4', objective_id: 'g3', title: 'Old project', state: 'finished', start: '2026-01-01', end: '2026-02-01' });
    d.tasks.push({ id: 't4', kind: 'project', project_id: 'p4', title: 'Old task' });
    expect(weekAnalytics(d, clock, WEEK).time.rows.map((r) => r.id)).toEqual(['g1', 'g2', 'one_offs']);
    block(d, { task: 't3' }, MON, 540, { result: 'done' });
    block(d, { task: 't4' }, MON, 600, { result: 'done' });
    const rows = weekAnalytics(d, clock, WEEK).time.rows;
    expect(rows.map((r) => r.name)).toEqual(['Write the report', 'Learn to bake bread', 'Old goal', 'No goal', 'One offs']);
  });

  it('ignores a block whose task or practice is gone', () => {
    const d = emptyData();
    block(d, { task: 'gone' }, MON, 540, { result: 'done' });
    const w = weekAnalytics(d, clock, WEEK);
    expect(w.time.planned_min).toBe(0);
    expect(w.unanswered).toBe(0);
  });

  it('drops an unanswered block on an away date from planned time, but keeps an answered one', () => {
    const d = emptyData();
    block(d, { task: 't1' }, TUE, 540);
    block(d, { task: 't1' }, TUE, 600, { result: 'done' });
    d.away.push({ id: 'a1', start: TUE, end: TUE });
    expect(weekAnalytics(d, clock, WEEK).time.rows[0]).toMatchObject({ delivered_min: 60, planned_min: 60 });
  });

  it('places a block in the local week, not the UTC one', () => {
    const d = emptyData();
    // Sunday 8pm in Chicago is already Monday in UTC.
    block(d, { task: 't1' }, '2026-11-01', 20 * 60, { result: 'done' });
    expect(weekAnalytics(d, clock, WEEK).time.planned_min).toBe(0);
    expect(weekAnalytics(d, clock, addWeeks(WEEK, -1)).time.planned_min).toBe(60);
  });
});

describe('practice time against target', () => {
  it('uses the daily target on its days, a weekly target as is, and logged minutes first', () => {
    const d = emptyData();
    block(d, { practice: 'pr1' }, MON, 540, { mins: 30, result: 'done' });
    block(d, { practice: 'pr1' }, TUE, 540, { mins: 30, result: 'partly', logged: 15 });
    block(d, { practice: 'pr1' }, '2026-11-04', 540, { mins: 30, result: 'not' });
    block(d, { practice: 'pr2' }, MON, 600, { mins: 90, result: 'done' });
    expect(weekAnalytics(d, clock, WEEK).practices).toEqual([
      { id: 'pr1', name: 'Knead dough', spent_min: 45, target_min: 90, pct: 50 },
      { id: 'pr2', name: 'Stretch', spent_min: 90, target_min: 70, pct: 100 },
    ]);
  });

  it('a daily practice with no days listed means every day', () => {
    const d = emptyData();
    d.practices = [{ id: 'pr3', title: 'Read', target_min: 10, per: 'day', state: 'active' }];
    expect(weekAnalytics(d, clock, WEEK).practices[0]!.target_min).toBe(70);
  });

  it('multiplies the target over the range, from the week of the first session', () => {
    const d = emptyData();
    block(d, { practice: 'pr2' }, addWeeks(MON, -1), 540, { mins: 70, result: 'done' });
    const stretch = { start: addWeeks(WEEK, -3), end: addWeeks(WEEK, 5) };
    expect(stretchAnalytics(d, clock, stretch).practices.find((p) => p.id === 'pr2')).toMatchObject({ spent_min: 70, target_min: 140, pct: 50 });
  });

  it('hides an ended practice with no time in range', () => {
    const d = emptyData();
    d.practices[1]!.state = 'ended';
    expect(weekAnalytics(d, clock, WEEK).practices.map((p) => p.id)).toEqual(['pr1']);
    block(d, { practice: 'pr2' }, MON, 540, { result: 'done' });
    expect(weekAnalytics(d, clock, WEEK).practices.map((p) => p.id)).toEqual(['pr1', 'pr2']);
  });
});

describe('week view', () => {
  it('knows the current week from a past one and compares with the prior week', () => {
    const d = emptyData();
    block(d, { task: 't1' }, addWeeks(MON, -1), 540, { mins: 120, result: 'done' });
    block(d, { task: 't1' }, MON, 540, { mins: 180, result: 'done' });
    const now = weekAnalytics(d, clock, WEEK);
    const past = weekAnalytics(d, clock, addWeeks(WEEK, -1));
    expect([now.current, past.current]).toEqual([true, false]);
    expect(now.trend.rows[0]).toMatchObject({ id: 'all', name: 'All time', shown_min: 180, change_min: 60 });
    expect(past.trend.rows[0]).toMatchObject({ shown_min: 120, change_min: null }); // Nothing before it.
  });
});

describe('trend', () => {
  it('has eight weeks ending this week, on one shared scale, and a zero draws nothing', () => {
    const d = emptyData();
    block(d, { task: 't1' }, addWeeks(MON, -7), 540, { mins: 60, result: 'done' });
    block(d, { task: 't2' }, MON, 540, { mins: 240, result: 'done' });
    const { trend } = weekAnalytics(d, clock, addWeeks(WEEK, -7));
    expect(trend.weeks[0]).toBe(addWeeks(WEEK, -7));
    expect(trend.weeks[7]).toBe(WEEK);
    expect(trend.rows.map((r) => r.id)).toEqual(['all', 'g1', 'g2', 'one_offs']);
    const all = trend.rows[0]!;
    expect(all.bars[7]).toEqual({ week: WEEK, min: 240, h: 44, on: false });
    expect(all.bars[0]).toEqual({ week: addWeeks(WEEK, -7), min: 60, h: 11, on: true });
    expect(all.bars[3]).toMatchObject({ min: 0, h: 0 });
    expect(trend.rows[1]!.bars[0]!.h).toBe(11);
    expect(trend.rows[1]!.bars[7]!.h).toBe(0);
  });

  it('gives a tiny value at least a 2px bar', () => {
    const d = emptyData();
    block(d, { task: 't1' }, MON, 540, { mins: 600, result: 'done' });
    block(d, { task: 't1' }, addWeeks(MON, -1), 540, { mins: 5, result: 'done' });
    expect(weekAnalytics(d, clock, WEEK).trend.rows[0]!.bars[6]!.h).toBe(2);
  });

  it('copes with no time at all', () => {
    expect(weekAnalytics(emptyData(), clock, WEEK).trend.rows[0]!.bars.every((b) => b.h === 0)).toBe(true);
  });
});

describe('stretch view', () => {
  const stretch = { start: '2026-10-01', end: '2026-12-31' };

  it('counts every week touching the stretch up to this week, and marks them', () => {
    const d = emptyData();
    block(d, { task: 't1' }, '2026-09-28', 540, { mins: 60, result: 'done' }); // Same week as the first.
    block(d, { task: 't1' }, '2026-09-27', 540, { mins: 60, result: 'done' }); // Week before: out.
    block(d, { task: 't1' }, MON, 540, { mins: 60, result: 'done' });
    block(d, { task: 't1' }, addWeeks(MON, 1), 540, { mins: 60 }); // Next week: not yet.
    const s = stretchAnalytics(d, clock, stretch);
    expect(s.time.delivered_min).toBe(120);
    expect(s.time.planned_min).toBe(120);
    expect(s.trend.rows[0]!.shown_min).toBe(120);
    expect(s.trend.rows[0]!.change_min).toBeNull();
    expect(s.weeks).toEqual(Array.from({ length: 6 }, (_, i) => addWeeks('2026-09-28', i)));
    expect(s.trend.rows[0]!.bars.map((b) => b.on)).toEqual([false, false, true, true, true, true, true, true]);
  });

  it('with no stretch uses the last eight weeks, all marked', () => {
    const d = emptyData();
    block(d, { task: 't1' }, addWeeks(MON, -7), 540, { result: 'done' });
    block(d, { task: 't1' }, addWeeks(MON, -8), 540, { result: 'done' });
    const s = stretchAnalytics(d, clock, null);
    expect(s.time.delivered_min).toBe(60);
    expect(s.trend.rows[0]!.bars.every((b) => b.on)).toBe(true);
  });

  it('totals a long stretch past the eight bars', () => {
    const d = emptyData();
    block(d, { task: 't1' }, addWeeks(MON, -10), 540, { result: 'done' });
    const s = stretchAnalytics(d, clock, { start: addWeeks(WEEK, -12), end: addWeeks(WEEK, 1) });
    expect(s.time.delivered_min).toBe(60);
    expect(s.trend.rows[0]!.shown_min).toBe(60);
  });

  it('adds up reliability, unanswered and started on time over its weeks', () => {
    const d = emptyData();
    block(d, { task: 't1' }, addWeeks(MON, -1), 540, { result: 'done' });
    block(d, { task: 't1' }, MON, 540, { result: 'not' });
    block(d, { task: 't1' }, MON, 700);
    const s = stretchAnalytics(d, clock, stretch);
    expect(s.reliability.project.total).toBe(2);
    expect(s.unanswered).toBe(1);
    expect(s.started_on_time).toBe(0);
  });

  describe('milestones met on their original date', () => {
    const ms = (id: string, f: Partial<Milestone>): Milestone => ({ id, project_id: 'p1', title: id, ...f });

    it('uses the first moved-from date, then the due date', () => {
      const d = emptyData();
      d.projects[0]!.slip_log = [
        { at: NOW, kind: 'move', milestone_id: 'm1', from: '2026-10-10', to: '2026-10-30' },
        { at: NOW, kind: 'move', milestone_id: 'm2', from: '2026-10-12', to: '2026-10-20' },
        { at: NOW, kind: 'move', milestone_id: 'm2', from: '2026-10-20', to: '2026-10-25' },
      ];
      d.milestones = [
        ms('m1', { due: '2026-10-30', met_at: localToInstant('2026-10-30', 600, ZONE) }), // Moved, met late.
        ms('m2', { due: '2026-10-25', met_at: localToInstant('2026-10-11', 600, ZONE) }), // Met before the original.
        ms('m3', { due: '2026-10-15', met_at: localToInstant('2026-10-15', 1400, ZONE) }), // Last minute, local time.
        ms('m4', { due: '2026-10-16', dropped_at: NOW }), // Dropped counts as not met.
        ms('m5', { due: '2026-10-17' }), // Open and past.
        ms('m6', { due: '2026-11-30', met_at: NOW }), // Its date hasn't come: met early.
        ms('m7', { due: '2026-09-01', met_at: localToInstant('2026-09-01', 600, ZONE) }), // Before the stretch.
        ms('m8', { due: null }), // No date.
        ms('m9', { due: '2027-02-01', met_at: localToInstant('2026-10-05', 600, ZONE) }), // Due after the stretch, met early in it.
        ms('m10', { due: '2026-12-01', met_at: localToInstant('2026-09-20', 600, ZONE) }), // Met before the stretch began.
        ms('m11', { due: '2026-12-10' }), // Not due yet, open.
      ];
      expect(stretchAnalytics(d, clock, stretch).milestones_met).toEqual({ met: 2, total: 5, early: 2 });
    });

    it('reads moves from entry records too, and a project from before them exactly as it was', async () => {
      const db = await openTestDb();
      const move = { at: NOW, kind: 'move' as const, from: '2026-10-10', to: '2026-10-30' };
      const met = localToInstant('2026-10-30', 600, ZONE);
      await transact(db, clock, async (w) => {
        await w.create('project', { title: 'First draft', state: 'active', start: '2026-09-01', end: '2026-12-31' }, 'p1');
        await w.create('milestone', { project_id: 'p1', title: 'Outline', due: '2026-10-30', met_at: met }, 'm1');
        // The array alone, as a bundle from before entry records logged it.
        await w.create('project', { title: 'Sourdough', state: 'active', start: '2026-09-01', end: '2026-12-31', slip_log: [{ ...move, milestone_id: 'm2' }] }, 'p2');
        await w.create('milestone', { project_id: 'p2', title: 'First loaf', due: '2026-10-30', met_at: met }, 'm2');
        // The record alone, as when another device's array replaced the one that logged it.
        await w.create('slip_entry', { project_id: 'p1', ...move, milestone_id: 'm1' }, 'slip:p1:moved');
      });
      const d = await loadAnalyticsData(db);
      expect(d.projects.find((p) => p.id === 'p2')).toEqual(await getRecord(db, 'project', 'p2'));
      // Both were met on the date they were moved to, so neither counts as met on its first date.
      expect(stretchAnalytics(d, clock, stretch).milestones_met).toEqual({ met: 0, total: 2, early: 0 });
    });

    it('counts a milestone reached by finishing its tasks, on the day the last one was done', () => {
      const d = emptyData();
      const done = (date: string) => localToInstant(date, 600, ZONE);
      d.milestones = [ms('m1', { due: '2026-10-20' }), ms('m2', { due: '2026-10-21' }), ms('m3', { due: '2026-10-22' })];
      d.tasks.push(
        { id: 'a', kind: 'project', project_id: 'p1', milestone_id: 'm1', title: 'Sketch it', done_at: done('2026-10-12') },
        { id: 'b', kind: 'project', project_id: 'p1', milestone_id: 'm1', title: 'Write it', done_at: done('2026-10-19') },
        { id: 'c', kind: 'project', project_id: 'p1', milestone_id: 'm1', title: 'Skip it', cancelled_at: NOW },
        { id: 'd', kind: 'project', project_id: 'p1', milestone_id: 'm2', title: 'Late', done_at: done('2026-10-23') }, // After its date.
        { id: 'e', kind: 'project', project_id: 'p1', milestone_id: 'm3', title: 'Open' }, // Not all done.
        { id: 'f', kind: 'project', project_id: 'p1', milestone_id: 'm3', title: 'Done', done_at: done('2026-10-10') },
      );
      expect(stretchAnalytics(d, clock, stretch).milestones_met).toEqual({ met: 1, total: 3, early: 0 });
    });

    for (const state of ['finished', 'dropped'] as const) {
      it(`leaves a half-done milestone unmet once its project is ${state}, though closing cancelled the rest`, async () => {
        const db = await openTestDb();
        await transact(db, clock, async (w) => {
          await w.create('project', { title: 'Sourdough', state: 'active', start: '2026-09-01', end: '2026-12-31' }, 'p');
          await w.create('milestone', { project_id: 'p', title: 'First loaf', due: '2026-10-20' }, 'm');
          await w.create('task', { kind: 'project', project_id: 'p', milestone_id: 'm', title: 'Feed the starter', done_at: localToInstant('2026-10-05', 600, ZONE) }, 'a');
          await w.create('task', { kind: 'project', project_id: 'p', milestone_id: 'm', title: 'Bake it' }, 'b');
        });
        await transact(db, clock, (w) => closeProject(w, 'p', state, clock));
        const d = await loadAnalyticsData(db);
        expect(stretchAnalytics(d, clock, stretch).milestones_met).toEqual({ met: 0, total: 1, early: 0 });
        const [plan] = gatherPlans(d.projects, d.milestones, d.tasks);
        expect(msReached(plan!, plan!.milestones[0]!)).toBe(false);
      });
    }

    it('dates a milestone added to a plan undated by its stretch, not by the project end it was parked from', () => {
      const settings = { plan_cadence: { every: 1, unit: 'quarters' as const }, plan_stretch: {} };
      let plan: ProjectPlan = {
        project: { ...emptyData().projects[0]!, end: '2026-12-15' },
        milestones: [ms('loaf', { added_on: '2026-09-28' }), ms('later', { added_on: '2026-09-28' })],
        tasks: [],
      };
      // Planned in the flow: one into this stretch, one into the next, which also moves the project's end out.
      const planning = { settings, clock: fixedClock('2026-09-28T12:00:00Z', ZONE), planning: true };
      plan = withChange(plan, toggleInPlan(plan, 'loaf', stretch, planning));
      plan = withChange(plan, toggleInPlan(plan, 'later', { start: '2027-01-01', end: '2027-03-31' }, planning));
      const d = emptyData();
      d.projects = [plan.project];
      d.milestones = plan.milestones.map((m) => (m.id === 'loaf' ? { ...m, met_at: localToInstant('2026-11-20', 600, ZONE) } : m));
      const end = fixedClock(localToInstant('2026-12-31', 18 * 60, ZONE), ZONE);
      expect(stretchAnalytics(d, end, stretch).milestones_met).toEqual({ met: 1, total: 1, early: 0 });
    });
  });

  describe('estimate drift', () => {
    it('compares actual time with estimates on tasks finished in range', () => {
      const d = emptyData();
      const inRange = localToInstant('2026-10-20', 600, ZONE);
      d.tasks.push(
        { id: 'x1', kind: 'project', project_id: 'p1', title: 'A', estimate_min: 100, done_at: inRange },
        { id: 'x2', kind: 'one_off', title: 'B', estimate_min: 100, done_at: inRange },
        { id: 'x3', kind: 'one_off', title: 'No estimate', done_at: inRange },
        { id: 'x4', kind: 'one_off', title: 'Early', estimate_min: 100, done_at: localToInstant('2026-08-01', 600, ZONE) },
        { id: 'x5', kind: 'one_off', title: 'Open', estimate_min: 100 },
        { id: 'x6', kind: 'one_off', title: 'No blocks', estimate_min: 500, done_at: inRange },
      );
      block(d, { task: 'x1' }, '2026-10-19', 540, { mins: 150, result: 'done' });
      block(d, { task: 'x2' }, '2026-10-19', 700, { mins: 90, result: 'done' });
      for (const t of ['x3', 'x4', 'x5']) block(d, { task: t }, '2026-10-19', 900, { result: 'done' });
      expect(stretchAnalytics(d, clock, stretch).estimate_drift).toBe(20);
    });

    it('is null with nothing to compare', () => {
      expect(stretchAnalytics(emptyData(), clock, stretch).estimate_drift).toBeNull();
    });
  });
});

describe('patterns', () => {
  const tuesdays = (n: number) => Array.from({ length: n }, (_, i) => addWeeks(TUE, -i));
  const stretch = { start: '2026-10-01', end: '2026-12-31' };
  const texts = (d: AnalyticsData) => stretchAnalytics(d, clock, stretch).patterns.map((p) => p.text);

  /** n answered blocks on the same weekday at the same time, the newest `done` of them done. */
  function history(d: AnalyticsData, first: string, at: number, n: number, done: number) {
    for (let i = 0; i < n; i++) block(d, { task: 't1' }, addWeeks(first, -i), at, { result: i < done ? 'done' : 'not' });
  }

  it('names the slot that rarely holds, with the action that stops suggesting it', () => {
    const d = emptyData();
    history(d, TUE, 18 * 60, 6, 1);
    const [p] = stretchAnalytics(d, clock, stretch).patterns;
    expect(p).toEqual({
      kind: 'avoid',
      text: 'Tuesday evenings rarely hold: 1 of the last 6 blocks was done.',
      label: 'Stop suggesting them',
      slot: { day: 1, from: 1020, to: 1440 },
    });
  });

  it('names the slot that holds best, as information only', () => {
    const d = emptyData();
    history(d, '2026-10-31', 9 * 60, 10, 9);
    expect(stretchAnalytics(d, clock, stretch).patterns).toEqual([
      { kind: 'best', text: 'Saturday mornings hold best: 9 of the last 10 blocks were done.' },
    ]);
  });

  it('looks only at the last ten blocks of a slot and at all of history', () => {
    const d = emptyData();
    history(d, TUE, 18 * 60, 10, 1);
    for (const date of tuesdays(5)) block(d, { task: 't1' }, addWeeks(date, -10), 18 * 60, { result: 'done' });
    expect(texts(d)).toEqual(['Tuesday evenings rarely hold: 1 of the last 10 blocks was done.']);
  });

  it('needs five answers, and stays quiet in the middle', () => {
    const few = emptyData();
    history(few, TUE, 18 * 60, 4, 0);
    expect(texts(few)).toEqual([]);
    const middling = emptyData();
    history(middling, TUE, 18 * 60, 10, 5);
    expect(texts(middling)).toEqual([]);
  });

  it('counts only done as holding, and skips practices and away dates', () => {
    const d = emptyData();
    for (let i = 0; i < 6; i++) block(d, { task: 't1' }, addWeeks(TUE, -i), 18 * 60, { result: 'partly', logged: 10 });
    expect(texts(d)[0]).toBe('Tuesday evenings rarely hold: 0 of the last 6 blocks were done.');
    const e = emptyData();
    for (let i = 0; i < 6; i++) block(e, { practice: 'pr1' }, addWeeks(TUE, -i), 18 * 60, { result: 'not' });
    expect(texts(e)).toEqual([]);
    const f = emptyData();
    history(f, TUE, 18 * 60, 6, 0);
    f.away.push({ id: 'a1', start: addWeeks(TUE, -6), end: TUE });
    expect(texts(f)).toEqual([]);
  });

  it('splits the day at noon and 5pm', () => {
    const d = emptyData();
    history(d, TUE, 11 * 60, 6, 0);
    history(d, '2026-11-04', 16 * 60 + 59, 6, 6);
    expect(texts(d)).toEqual([
      'Tuesday mornings rarely hold: 0 of the last 6 blocks were done.',
      'Wednesday afternoons hold best: 6 of the last 6 blocks were done.',
    ]);
  });

  it('reads a block in the zone it was placed in', () => {
    const d = emptyData();
    // 7am Wednesday in Tokyo is Tuesday evening in Chicago.
    for (let i = 0; i < 6; i++) {
      const date = addWeeks('2026-11-04', -i);
      block(d, { task: 't1' }, date, 7 * 60, { result: 'not', tz: 'Asia/Tokyo', start: localToInstant(date, 7 * 60, 'Asia/Tokyo'), end: localToInstant(date, 8 * 60, 'Asia/Tokyo') });
    }
    expect(texts(d)[0]).toBe('Wednesday mornings rarely hold: 0 of the last 6 blocks were done.');
  });

  it('an avoided slot says so, offers the way back, and stays even with no history', () => {
    const d = emptyData();
    history(d, TUE, 18 * 60, 6, 1);
    d.avoided_slots = [{ day: 1, from: 1020, to: 1440 }];
    expect(stretchAnalytics(d, clock, stretch).patterns).toEqual([
      {
        kind: 'avoided',
        text: 'Tuesday evenings are no longer suggested.',
        label: 'Suggest them again',
        slot: { day: 1, from: 1020, to: 1440 },
      },
    ]);
    expect(texts({ ...emptyData(), avoided_slots: d.avoided_slots })).toEqual(['Tuesday evenings are no longer suggested.']);
  });

  it('then offers the next worst slot', () => {
    const d = emptyData();
    history(d, TUE, 18 * 60, 6, 0);
    history(d, '2026-11-04', 18 * 60, 6, 1);
    expect(texts(d)[0]).toContain('Tuesday');
    d.avoided_slots = [{ day: 1, from: 1020, to: 1440 }];
    expect(texts(d)).toEqual(['Tuesday evenings are no longer suggested.', 'Wednesday evenings rarely hold: 1 of the last 6 blocks was done.']);
  });

  it('toggleAvoidedSlot adds and removes, leaving others alone', () => {
    const a = { day: 1, from: 1020, to: 1440 } as const;
    const b = { day: 2, from: 0, to: 720 } as const;
    expect(toggleAvoidedSlot([b], a)).toEqual([b, a]);
    expect(toggleAvoidedSlot([b, a], { ...a })).toEqual([b]);
  });

  describe('estimates', () => {
    function finished(d: AnalyticsData, n: number, estimate: number, actual: number, project = 'p1') {
      for (let i = 0; i < n; i++) {
        const id = `f${++seq}`;
        d.tasks.push({ id, kind: 'project', project_id: project, title: id, estimate_min: estimate, done_at: localToInstant(addDays('2026-10-01', i), 600, ZONE) });
        block(d, { task: id }, addDays('2026-10-01', i), 300 + i * 2, { mins: actual, result: 'done' });
      }
    }

    it('names a project whose tasks run long, rounded to 5%, with its action', () => {
      const d = emptyData();
      finished(d, 5, 100, 142);
      const p = stretchAnalytics(d, clock, stretch).patterns.find((x) => x.kind === 'estimate');
      expect(p).toEqual({
        kind: 'estimate',
        text: 'First draft tasks take about 40% longer than you estimate.',
        label: 'Raise estimates',
        project_id: 'p1',
        over_pct: 40,
      });
    });

    it('needs five finished tasks and at least 25% over, and only on an active project', () => {
      const few = emptyData();
      finished(few, 4, 100, 200);
      expect(texts(few).join()).not.toContain('longer');
      const close = emptyData();
      finished(close, 5, 100, 120);
      expect(texts(close).join()).not.toContain('longer');
      const over = emptyData();
      finished(over, 5, 100, 200);
      over.projects[0]!.state = 'finished';
      expect(texts(over).join()).not.toContain('longer');
    });

    it('shows only the project furthest over', () => {
      const d = emptyData();
      finished(d, 5, 100, 130, 'p1');
      finished(d, 5, 100, 200, 'p2');
      expect(texts(d).filter((t) => t.includes('longer'))).toEqual(['Sourdough tasks take about 100% longer than you estimate.']);
    });

    it('once estimates were raised, counts only tasks finished since, so the same work is not offered again', () => {
      const d = emptyData();
      finished(d, 5, 100, 200);
      d.projects[0]!.estimates_raised_at = localToInstant('2026-10-20', 600, ZONE);
      expect(texts(d).join()).not.toContain('longer');
      for (let i = 0; i < 5; i++) {
        const id = `n${i}`;
        d.tasks.push({ id, kind: 'project', project_id: 'p1', title: id, estimate_min: 100, done_at: localToInstant(addDays('2026-10-21', i), 600, ZONE) });
        block(d, { task: id }, addDays('2026-10-21', i), 300 + i * 2, { mins: 150, result: 'done' });
      }
      expect(texts(d)).toContain('First draft tasks take about 50% longer than you estimate.');
    });

    it('raisedEstimates lengthens open estimated tasks in the project, to the next 15 minutes', () => {
      const tasks: Task[] = [
        { id: 'a', kind: 'project', project_id: 'p1', title: 'A', estimate_min: 60, remaining_min: 30 },
        { id: 'b', kind: 'project', project_id: 'p1', title: 'B', estimate_min: 100 },
        { id: 'c', kind: 'project', project_id: 'p1', title: 'No estimate' },
        { id: 'd', kind: 'project', project_id: 'p1', title: 'Done', estimate_min: 60, done_at: NOW },
        { id: 'e', kind: 'project', project_id: 'p1', title: 'Dropped', estimate_min: 60, cancelled_at: NOW },
        { id: 'f', kind: 'project', project_id: 'p2', title: 'Other', estimate_min: 60 },
      ];
      expect(raisedEstimates(tasks, 'p1', 40)).toEqual([
        { id: 'a', estimate_min: 90, remaining_min: 45 },
        { id: 'b', estimate_min: 150 },
      ]);
    });
  });
});

describe('week view leaves stretch-only figures out', () => {
  it('has no patterns or milestones', () => {
    const w = weekAnalytics(emptyData(), clock, WEEK);
    expect('patterns' in w).toBe(false);
    expect('milestones_met' in w).toBe(false);
  });
});

describe('loadAnalyticsData', () => {
  it('reads saved records, without deleted ones, and fills in settings', async () => {
    const db = await openTestDb();
    await transact(db, clock, (w) => w.create('task', { kind: 'one_off', title: 'Paint the fence' }, 'k1'));
    await transact(db, clock, (w) => w.create('time_block', { task_id: 'k1', start: localToInstant(MON, 540, ZONE), end: localToInstant(MON, 600, ZONE), tz: ZONE }, 'bk1'));
    await transact(db, clock, (w) => w.create('block_outcome', { result: 'done', answered_at: NOW }, outcomeId('bk1')));
    await transact(db, clock, (w) => w.create('time_block', { task_id: 'k1', start: localToInstant(MON, 700, ZONE), end: localToInstant(MON, 760, ZONE), tz: ZONE, deleted_at: NOW }, 'bk2'));
    const data = await loadAnalyticsData(db);
    expect(data.avoided_slots).toEqual([]);
    expect(weekAnalytics(data, clock, WEEK).time.rows).toEqual([
      { id: 'one_offs', name: 'One offs', delivered_min: 60, planned_min: 60, pct: 100 },
    ]);
  });

  it('still counts a repeating one off’s miss once Delete drops its row from Needs a new time', async () => {
    const db = await openTestDb();
    await transact(db, clock, async (w) => {
      await w.create('task', { kind: 'one_off', title: 'Water the plants', schedule: { type: 'recurring', every: 1, unit: 'week', anchor: '2026-10-05' }, next_due: '2026-11-09' }, 'r');
      await w.create('time_block', { task_id: 'r', start: localToInstant(MON, 540, ZONE), end: localToInstant(MON, 600, ZONE), tz: ZONE }, 'br');
      await w.create('block_outcome', { result: 'not', answered_at: NOW }, outcomeId('br'));
    });
    const before = weekAnalytics(await loadAnalyticsData(db), clock, WEEK);
    expect(before.reliability.one_offs).toMatchObject({ not: 1, total: 1 });

    const [item] = queueItems(await needsNewTime(db), [], [], clock);
    await transact(db, clock, (w) => deleteWork(w, item!, clock));
    expect(await needsNewTime(db)).toEqual([]);
    expect(weekAnalytics(await loadAnalyticsData(db), clock, WEEK)).toEqual(before);
  });
});

// Goal backlogs in Pick tasks and Schedule: one Backlogs band after the projects, never suggested, and a picked
// backlog task waits to be placed like any other.

import { describe, expect, it } from 'vitest';
import { fixedClock } from '../../../../core/clock';
import { openDb } from '../../../../core/db';
import { transact, weekPickId } from '../../../../core/records';
import type { Writer } from '../../../../core/records';
import { nodeSqliteDriver } from '../../../../platform/node-sqlite';
import { loadWeek, weekModel as weekView } from '../../week/data';
import { loadPlanning, weekModel } from '../model';
import { scheduleModel } from '../schedule/model';
import { seedWeek } from '../testing';
import { pickModel } from './model';

const NOW = '2026-11-02T20:00:00Z';
const WEEK = '2026-11-02';

async function load(seed: (w: Writer) => Promise<void>) {
  const clock = fixedClock(NOW, 'America/Chicago');
  const db = await openDb(nodeSqliteDriver());
  await transact(db, clock, seed);
  const data = await loadPlanning(db, clock, WEEK);
  const m = weekModel(data, clock);
  return { data, m, clock, view: pickModel(data, m, clock) };
}

async function backlogs(w: Writer) {
  await seedWeek(w);
  await w.create('objective', { title: 'Learn to bake bread', state: 'active', order: 1 }, 'g1');
  await w.create('objective', { title: 'Stay fit', state: 'active', order: 2 }, 'g2');
  await w.create('objective', { title: 'Grow vegetables', state: 'active', order: 3 }, 'g3');
  // Its placeholder end falls this week, which must never make a backlog task due.
  const backlog = { state: 'active' as const, start: '2026-10-01', end: '2026-11-06', weekly_aim: 300 };
  await w.create('project', { objective_id: 'g1', title: 'Learn to bake bread, Backlog', ...backlog }, 'backlog:g1');
  await w.create('project', { objective_id: 'g2', title: 'Stay fit, Backlog', ...backlog }, 'backlog:g2');
  await w.create('project', { objective_id: 'g3', title: 'Grow vegetables, Backlog', ...backlog }, 'backlog:g3');
  const task = (id: string, project: string, title: string, order: number, extra = {}) =>
    w.create('task', { kind: 'project', project_id: project, title, estimate_min: 60, order, ...extra }, id);
  await task('k2', 'backlog:g1', 'Read the book', 2);
  await task('k1', 'backlog:g1', 'Watch a shaping video', 1);
  await task('k3', 'backlog:g2', 'Get a bike fit', 1);
  await task('k4', 'backlog:g3', 'Ask about an allotment', 1, { done_at: '2026-10-20T15:00:00Z' });
}

describe('Pick tasks with goal backlogs', () => {
  it('lists each backlog with open tasks after the projects, in goal order, its tasks in arrival order', async () => {
    const { view } = await load(backlogs);
    expect(view.projects.map((p) => p.plan.project.id)).not.toContain('backlog:g1');
    expect(view.backlogs.map((b) => b.goal)).toEqual(['Learn to bake bread', 'Stay fit']);
    expect(view.backlogs[0]!.rows.map((r) => r.title)).toEqual(['Watch a shaping video', 'Read the book']);
    expect(view.backlogs[0]!.counts).toBe('2 tasks, 2h');
  });

  it('never suggests or dates a backlog task, whatever its placeholder dates or an older aim say', async () => {
    const { view } = await load(backlogs);
    for (const r of view.backlogs.flatMap((b) => b.rows)) {
      expect(r.hint).toBeUndefined();
      expect(r.dueDay).toBeUndefined();
    }
  });

  it('lists none while no backlog has open tasks', async () => {
    const { view } = await load(seedWeek);
    expect(view.backlogs).toEqual([]);
  });

  it('puts a picked backlog task in Schedule, read as its goal and Backlog', async () => {
    const { data, m, clock } = await load(async (w) => {
      await backlogs(w);
      await w.create('week_pick', { week_start: WEEK, task_id: 'k1', minutes: 60 }, weekPickId(WEEK, 'k1'));
    });
    const row = scheduleModel(data, m, [], clock).rows.find((t) => t.id === 'k1');
    expect(row?.context).toBe('Learn to bake bread, Backlog');
  });
});

describe('Week with a picked backlog task', () => {
  it('waits in To schedule, and Edit this week lists the backlog after the projects', async () => {
    const clock = fixedClock(NOW, 'America/Chicago');
    const db = await openDb(nodeSqliteDriver());
    await transact(db, clock, async (w) => {
      await backlogs(w);
      await w.create('week_pick', { week_start: WEEK, task_id: 'k1', minutes: 60 }, weekPickId(WEEK, 'k1'));
    });
    const view = weekView(await loadWeek(db, clock, WEEK), clock);
    expect(view.unscheduled.map((i) => i.id)).toContain('k1');
    const names = view.addGroups.map((g) => g.name);
    expect(names.indexOf('Learn to bake bread, Backlog')).toBeGreaterThan(names.indexOf('Write the report'));
  });
});

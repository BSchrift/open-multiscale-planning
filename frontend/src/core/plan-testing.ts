// A sample project for planning and status tests: one overdue milestone, one soon, one later.

import { fixedClock } from './clock';
import type { PlanContext, ProjectPlan } from './plan';
import type { Milestone, Project, Task } from './types';

export const NOW = '2026-10-30T12:00:00Z';

/** The stretch here is Aug 1 to Oct 31, planned, and planning is due, so plans speak for Nov 1 to Jan 31. */
export function context(overrides: Partial<PlanContext> = {}): PlanContext {
  return {
    settings: { plan_cadence: { every: 3, unit: 'months', anchor: '2026-08-01' }, plan_stretch: { last_planned: '2026-08-01' } },
    clock: fixedClock(NOW),
    ...overrides,
  };
}

export const NEXT = { start: '2026-11-01', end: '2027-01-31' };

export function task(id: string, milestone_id: string | null, hours: number, fields: Partial<Task> = {}): Task {
  return { id, kind: 'project', project_id: 'report', milestone_id, title: `Task ${id}`, estimate_min: hours * 60, ...fields };
}

export function milestone(id: string, title: string, due: string | null, fields: Partial<Milestone> = {}): Milestone {
  return { id, project_id: 'report', title, due, ...fields };
}

export function reportPlan(project: Partial<Project> = {}): ProjectPlan {
  return {
    project: { id: 'report', title: 'Write the report', state: 'active', start: '2026-10-01', end: '2026-12-15', weekly_aim: 240, ...project },
    milestones: [
      milestone('m1', 'Gather notes', '2026-10-18'),
      milestone('m2', 'Draft chapters', '2026-11-09'),
      milestone('m3', 'Send for review', '2026-12-01'),
    ],
    tasks: [
      task('t1', 'm1', 1, { done_at: '2026-10-10T12:00:00Z' }),
      task('t2', 'm1', 2),
      task('t3', 'm2', 4),
      task('t4', 'm2', 1),
      task('t5', 'm3', 1),
    ],
  };
}

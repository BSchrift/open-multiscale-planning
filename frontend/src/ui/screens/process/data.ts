// What Process reads: the Inbox, every project it can send to with its status, and what a new home needs.

import type { Clock } from '../../../core/clock';
import { addMonths, today } from '../../../core/dates';
import type { Sql } from '../../../core/db';
import { currentStretch, gatherPlans, plannedIds } from '../../../core/plan';
import type { PlanContext, ProjectPlan, Stretch } from '../../../core/plan';
import { inboxTasks, projectTasks } from '../../../core/queries';
import type { InboxRow } from '../../../core/queries';
import { getSettings, listRecords } from '../../../core/records';
import { status } from '../../../core/status';
import type { LocalDate, Objective } from '../../../core/types';

export interface Destination {
  plan: ProjectPlan;
  title: string;
  pill: string;
  goal: string | null;
}

export interface ProcessData {
  inbox: InboxRow[];
  /** Up to eight live projects in added order, so each button keeps its place. Planning a stretch, its own come first. */
  shown: Destination[];
  /** Every other active or paused project, for finding by name. */
  others: Destination[];
  /** Goals a new project or practice can go under. */
  goals: Objective[];
  /** Where a new project ends: with the stretch being planned, else the one under way, else in three months. */
  end: LocalDate;
}

const SHOWN = 8;

export async function loadProcess(sql: Sql, clock: Clock, stretch?: Stretch): Promise<ProcessData> {
  const [inbox, projects, milestones, tasks, settings, away, objectives] = await Promise.all([
    inboxTasks(sql),
    listRecords(sql, 'project'),
    listRecords(sql, 'milestone'),
    projectTasks(sql),
    getSettings(sql),
    listRecords(sql, 'away_period'),
    listRecords(sql, 'objective'),
  ]);
  const ctx: PlanContext = { settings, clock, away };
  const all = gatherPlans(projects, milestones, tasks)
    .filter((plan) => plan.project.state === 'active' || plan.project.state === 'paused')
    .map((plan) => {
      const st = status(plan, ctx);
      // A project in the stretch being planned has a number even before it starts.
      const planned = !!stretch && plan.project.state === 'active' && plannedIds(plan, stretch).length > 0;
      const live = plan.project.state === 'active' && ((st.pill !== 'Not started' && !st.ended) || planned);
      const goal = objectives.find((o) => o.id === plan.project.objective_id)?.title ?? null;
      return { live, planned, dest: { plan, title: plan.project.title, pill: st.pill, goal } };
    });
  const first = stretch ? [...all.filter((d) => d.planned), ...all.filter((d) => !d.planned)] : all;
  const shown = first.filter((d) => d.live).slice(0, SHOWN).map((d) => d.dest);
  const on = today(clock);
  return {
    inbox,
    shown,
    others: all.map((d) => d.dest).filter((d) => !shown.includes(d)),
    goals: objectives,
    end: stretch?.end ?? currentStretch(settings, on)?.end ?? addMonths(on, 3),
  };
}

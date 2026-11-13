// What Process reads: the Inbox, every project it can add to under its goal, and what a new home needs.

import type { Clock } from '../../../core/clock';
import { addMonths, today } from '../../../core/dates';
import type { Sql } from '../../../core/db';
import { currentStretch, gatherPlans, plannedIds } from '../../../core/plan';
import type { ProjectPlan, Stretch } from '../../../core/plan';
import { inboxTasks, projectTasks } from '../../../core/queries';
import type { InboxRow } from '../../../core/queries';
import { getSettings, listRecords } from '../../../core/records';
import type { LocalDate, Objective } from '../../../core/types';

export interface Destination {
  plan: ProjectPlan;
  title: string;
  goal: string | null;
}

/** Projects under one heading in the picker: a goal, no goal, or the stretch being planned. */
export interface PickGroup {
  label: string;
  dests: Destination[];
}

export interface ProcessData {
  inbox: InboxRow[];
  /** Every active or paused project under its goal, in added order. Planning a stretch, its own come first. */
  groups: PickGroup[];
  /** Goals a new project or practice can go under. */
  goals: Objective[];
  /** Where a new project ends: with the stretch being planned, else the one under way, else in three months. */
  end: LocalDate;
}

export async function loadProcess(sql: Sql, clock: Clock, stretch?: Stretch): Promise<ProcessData> {
  const [inbox, projects, milestones, tasks, settings, objectives] = await Promise.all([
    inboxTasks(sql),
    listRecords(sql, 'project'),
    listRecords(sql, 'milestone'),
    projectTasks(sql),
    getSettings(sql),
    listRecords(sql, 'objective'),
  ]);
  const dests = gatherPlans(projects, milestones, tasks)
    .filter((plan) => plan.project.state === 'active' || plan.project.state === 'paused')
    .map((plan) => ({ plan, title: plan.project.title, goal: objectives.find((o) => o.id === plan.project.objective_id)?.title ?? null }));
  // A project in the stretch being planned comes first, even before it starts.
  const planned = stretch ? dests.filter((d) => d.plan.project.state === 'active' && plannedIds(d.plan, stretch).length > 0) : [];
  const rest = dests.filter((d) => !planned.includes(d));
  const groups: PickGroup[] = [
    { label: 'In this stretch', dests: planned },
    ...objectives.map((o) => ({ label: o.title, dests: rest.filter((d) => d.plan.project.objective_id === o.id) })),
    { label: 'No goal', dests: rest.filter((d) => !objectives.some((o) => o.id === d.plan.project.objective_id)) },
  ].filter((g) => g.dests.length > 0);
  const on = today(clock);
  return {
    inbox,
    groups,
    goals: objectives,
    end: stretch?.end ?? currentStretch(settings, on)?.end ?? addMonths(on, 3),
  };
}

// What Process reads: the Inbox, and every project it can send to with its status.

import type { Clock } from '../../../core/clock';
import { thisWeek, weekRange } from '../../../core/dates';
import type { Sql } from '../../../core/db';
import { gatherPlans } from '../../../core/plan';
import type { PlanContext, ProjectPlan } from '../../../core/plan';
import { blocksInRange, inboxTasks, projectTasks } from '../../../core/queries';
import type { InboxRow } from '../../../core/queries';
import { CALENDAR_ID, getRecord, getSettings, listRecords } from '../../../core/records';
import { slotContext } from '../../../core/slots';
import type { SlotContext } from '../../../core/slots';
import { status } from '../../../core/status';

export interface Destination {
  plan: ProjectPlan;
  title: string;
  pill: string;
  goal: string | null;
}

export interface ProcessData {
  inbox: InboxRow[];
  /** Up to eight live projects in added order, so each button keeps its place. */
  shown: Destination[];
  /** Every other active or paused project, for the selector. */
  others: Destination[];
}

const SHOWN = 8;

export async function loadProcess(sql: Sql, clock: Clock): Promise<ProcessData> {
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
      const live = plan.project.state === 'active' && st.pill !== 'Not started' && !st.ended;
      const goal = objectives.find((o) => o.id === plan.project.objective_id)?.title ?? null;
      return { live, dest: { plan, title: plan.project.title, pill: st.pill, goal } };
    });
  const shown = all.filter((d) => d.live).slice(0, SHOWN).map((d) => d.dest);
  return { inbox, shown, others: all.map((d) => d.dest).filter((d) => !shown.includes(d)) };
}

/** This week as slots see it, read inside the transaction that places the block. */
export async function thisWeekSlots(sql: Sql, clock: Clock): Promise<SlotContext> {
  const week = thisWeek(clock);
  const settings = await getSettings(sql);
  return slotContext({
    week,
    availability: settings.availability,
    avoided: settings.avoided_slots,
    sources: await listRecords(sql, 'calendar_source'),
    calendar: (await getRecord(sql, 'calendar', CALENDAR_ID)) ?? null,
    blocks: await blocksInRange(sql, weekRange(week, clock.zone())),
    clock,
  });
}

// The wording and shapes the Plan page, the flow and the More line share. Domain rules stay in core/plan.

import type { Clock } from '../../../core/clock';
import { formatDate, formatMinutes, localDate, today } from '../../../core/dates';
import { status } from '../../../core/status';
import {
  currentStretch,
  doneInPlan,
  effectiveDue,
  msInPlan,
  msLate,
  msReached,
  nextStretch,
  planningDue,
  planningOpens,
  planStretch,
} from '../../../core/plan';
import type { CadenceSettings, PlanChange, PlanContext, ProjectPlan, Stretch } from '../../../core/plan';
import type { Writer } from '../../../core/records';
import { onceOverlaps, onceWhen } from '../../../core/schedule';
import type { LocalDate, Milestone, Task } from '../../../core/types';
import type { DiamondState } from '../../components/MilestoneDiamond';
import type { PlanData } from './data';
import type { PlanFlow } from './flowState';

export const range = (st: Stretch) => `${formatDate(st.start)} to ${formatDate(st.end)}`;

/** Writes one planning change and keeps its reverse for the Undo line. Resolves to whether it saved. */
export type Act = (key: string, text: string, build: (w: Writer) => Promise<PlanChange>) => Promise<boolean>;

/** Rounded, for totals that are only ever about right. */
export const hrs = (minutes: number) => `${Math.round(minutes / 60)}h`;

export function planContext(data: PlanData, clock: Clock, planning: boolean): PlanContext {
  return { settings: data.settings, clock, away: data.away, planning };
}

/** 'Jan 20', or 'by Mar 31' when undated. */
export function msWhen(plan: ProjectPlan, m: Milestone, ctx: PlanContext): string {
  return `${m.due ? '' : 'by '}${formatDate(effectiveDue(plan, m, ctx))}`;
}

export interface Where {
  cur: Stretch | null;
  next: Stretch;
  due: boolean;
  /** The next stretch has been planned. */
  planned: boolean;
  /** No stretch has started yet, so planning starts by asking how often. */
  first: boolean;
  /** Never planned, so this plan is for the stretch that holds today rather than the next. */
  firstPlan: boolean;
  lineText: string;
  lineCta: string;
  moreLine: string;
}

/**
 * A first plan's dates until Finish or Change saves them: from the day planning began, or today, to the end of the
 * stretch that holds today. Once its dates are set, that stretch.
 */
export function firstStretch(settings: CadenceSettings, cur: Stretch, on: LocalDate, flow: PlanFlow): Stretch {
  const begun = flow.begunOn && flow.begunOn >= cur.start && flow.begunOn <= on ? flow.begunOn : on;
  return planStretch(settings, begun, true);
}

/** Where planning stands today, for the Plan page and the More line. */
export function whereNow(settings: CadenceSettings, on: LocalDate, flow: PlanFlow): Where {
  const cur = currentStretch(settings, on);
  const next = nextStretch(settings, on);
  const due = planningDue(settings, on);
  const planned = settings.plan_stretch.last_planned === next.start;
  const nextPlanning = formatDate(planningOpens(planned || !cur ? next : cur));
  const starts = `Your ${flow.restart ? 'new' : 'first'} stretch starts ${formatDate(next.start)}`;
  const cadence = !!settings.plan_cadence;
  const firstPlan = !!cur && !settings.plan_stretch.last_planned;
  const which = firstPlan ? 'your first' : 'the next';
  return {
    cur,
    next,
    due,
    planned,
    first: cadence && !cur && !flow.restart,
    firstPlan,
    lineText: !cadence
      ? 'Plan whenever you like.'
      : !cur
        ? `${starts}.`
        : due
          ? `This stretch: ${range(firstPlan ? firstStretch(settings, cur, on, flow) : cur)}. Time to plan ${which} stretch.`
          : `This stretch: ${range(cur)}. Next planning: ${nextPlanning}.`,
    lineCta: flow.begun ? 'Continue planning' : due ? `Plan ${which} stretch` : 'Plan now',
    moreLine: flow.begun
      ? 'Planning under way'
      : !cadence
        ? 'Set your planning cadence'
        : due
          ? `Time to plan ${which} stretch`
          : !cur
            ? starts
            : `Next planning: ${nextPlanning}`,
  };
}

interface PlanItem {
  key: string;
  name: string;
  state: DiamondState;
  when: string;
  late: boolean;
  reached: boolean;
}

export interface PlanGroup {
  key: string;
  title: string;
  oneOffs?: boolean;
  items: PlanItem[];
}

const lateText = (date: LocalDate) => `Was due ${formatDate(date)}`;

/** A stretch's plan, project by project in added order, then One offs. */
export function planGroups(data: PlanData, st: Stretch, ctx: PlanContext): PlanGroup[] {
  const on = today(ctx.clock);
  const groups: PlanGroup[] = [];
  for (const plan of data.plans) {
    const { project } = plan;
    const items: PlanItem[] = plan.milestones
      .filter((m) => !m.dropped_at && msInPlan(plan, m, st))
      .sort((a, b) => (effectiveDue(plan, a, ctx) < effectiveDue(plan, b, ctx) ? -1 : 1))
      .map((m) => {
        const reached = msReached(plan, m);
        const late = !reached && msLate(m, ctx);
        const met = m.met_at ? ` ${formatDate(localDate(m.met_at, ctx.clock.zone()))}` : '';
        return {
          key: m.id,
          name: m.title,
          state: reached ? { met: true } : { on: true, late },
          when: reached ? `Met${met}` : late ? lateText(m.due ?? effectiveDue(plan, m, ctx)) : msWhen(plan, m, ctx),
          late,
          reached,
        };
      });
    if (doneInPlan(plan, st)) {
      const late = project.end < on;
      items.push({
        key: `done:${project.id}`,
        name: 'Done',
        state: { on: true, done: true, late },
        when: late ? lateText(project.end) : `due ${formatDate(project.end)}`,
        late,
        reached: false,
      });
    }
    if (items.length) groups.push({ key: project.id, title: project.title, items });
  }
  const oneOffs = oneOffsIn(data.oneOffs, st);
  if (oneOffs.length) {
    groups.push({
      key: 'oneoffs',
      title: 'One offs',
      oneOffs: true,
      items: oneOffs.map((t) => ({ key: t.id, name: t.title, state: {}, when: oneOffWhen(t), late: false, reached: false })),
    });
  }
  return groups;
}

export interface Call {
  key: string;
  plan: ProjectPlan;
  /** Absent for a project past its end. */
  milestone?: Milestone;
  title: string;
  sub: string;
  leftMin: number;
}

/** What needs a call before planning: projects past their end, then overdue milestones. */
export function needsCall(data: PlanData, ctx: PlanContext): Call[] {
  const on = today(ctx.clock);
  const active = data.plans.filter((p) => p.project.state === 'active');
  const ended = active
    .filter((p) => p.project.end < on)
    .map((plan): Call => {
      const left = status(plan, ctx).leftMin;
      const sub = `Project ended ${formatDate(plan.project.end)}${left ? `, ${formatMinutes(left)} left.` : '.'}`;
      return { key: plan.project.id, plan, title: plan.project.title, sub, leftMin: left };
    });
  const late = active.flatMap((plan) =>
    plan.milestones
      .filter((m) => !m.dropped_at && !msReached(plan, m) && msLate(m, ctx))
      .map((m): Call => {
        const sub = `${plan.project.title}. Was due ${formatDate(effectiveDue(plan, m, ctx))}.`;
        return { key: m.id, plan, milestone: m, title: m.title, sub, leftMin: 0 };
      }),
  );
  return [...ended, ...late];
}

/** Dated one offs inside a stretch, soonest first. They add no hours to a plan. */
export function oneOffsIn(tasks: readonly Task[], st: Stretch): Task[] {
  return tasks.filter((t) => onceOverlaps(t, st.start, st.end)).sort((a, b) => (oneOffFrom(a) < oneOffFrom(b) ? -1 : 1));
}

const oneOffFrom = (t: Task) => (t.schedule?.type === 'once' ? (t.schedule.from ?? '') : '');
export const oneOffWhen = (t: Task) => (t.schedule?.type === 'once' ? onceWhen(t.schedule) : '');

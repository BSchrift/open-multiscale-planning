// Traffic lights. Status is computed, never stored, from milestones plus pace: the first rule that matches wins.

import { addDays, diffDays, formatDate, formatMinutes, isDay, today } from './dates';
import { dropTarget, effectiveDue, lateMilestone, milestoneWarnings, minutesLeft, moveMilestone, withChange } from './plan';
import type { PlanChange, PlanContext, ProjectPlan } from './plan';
import type { LocalDate, Milestone, SlipEntry } from './types';

export type StatusTone = 'red' | 'amber' | 'green' | 'grey';

export interface ProjectStatus {
  tone: StatusTone;
  pill: string;
  /** The short line beside the pill. */
  word: string;
  /** How much it needs you, for showing a goal's worst project: 3 is red, 2 amber, 1 green, 0 quiet. */
  rank: number;
  doneMin: number;
  leftMin: number;
  /** Percent of the work done, and how much is expected by now. */
  pct: number;
  expected: number;
  late?: Milestone;
  ended?: boolean;
}

const days = (n: number) => `${n} ${n === 1 ? 'day' : 'days'}`;

export function status(plan: ProjectPlan, ctx: PlanContext): ProjectStatus {
  const { project, tasks } = plan;
  const on = today(ctx.clock);
  const counted = tasks.filter((t) => !t.cancelled_at);
  const doneMin = counted.reduce(
    // Time already worked on an open task counts, or noting progress would lower the percentage.
    (sum, t) => sum + (t.done_at ? (t.estimate_min ?? 0) : Math.max(0, (t.estimate_min ?? 0) - minutesLeft(t))),
    0,
  );
  const leftMin = counted.filter((t) => !t.done_at).reduce((sum, t) => sum + minutesLeft(t), 0);
  const elapsed = diffDays(project.start, on);
  const pct = Math.round((doneMin / Math.max(1, doneMin + leftMin)) * 100);
  const expected = expectedPct(project.start, project.end, on, ctx);
  const base = { doneMin, leftMin, pct, expected };
  const done = formatMinutes(doneMin);
  const left = formatMinutes(leftMin);
  const pace = `${pct}% done, ${expected}% expected by now`;

  if (project.state === 'finished' || project.state === 'dropped') {
    return { ...base, tone: 'grey', pill: project.state === 'finished' ? 'Finished' : 'Dropped', word: `${done} logged`, rank: 0 };
  }
  if (project.state === 'paused') return { ...base, tone: 'grey', pill: 'Paused', word: `${done} done, ${left} left`, rank: 0 };
  if (elapsed < 0) return { ...base, tone: 'grey', pill: 'Not started', word: `Starts ${formatDate(project.start)}`, rank: 0 };
  const late = lateMilestone(plan, ctx);
  if (late) {
    const ago = diffDays(effectiveDue(plan, late, ctx), on);
    return { ...base, tone: 'red', pill: 'Overdue', word: `${late.title} was due ${days(ago)} ago`, rank: 3, late };
  }
  if (project.end < on) {
    const word = `Should have ended ${days(diffDays(project.end, on))} ago; ${left} left`;
    return { ...base, tone: 'red', pill: 'Past end date', word, rank: 3, ended: true };
  }
  if (tasks.length === 0 && elapsed >= 7) {
    return { ...base, tone: 'amber', pill: 'No tasks', word: 'Add tasks so this can be scheduled', rank: 2 };
  }
  if (elapsed > 14 && expected - pct > 15) return { ...base, tone: 'amber', pill: 'Behind', word: pace, rank: 2 };
  return { ...base, tone: 'green', pill: 'On track', word: pace, rank: 1 };
}

function expectedPct(start: LocalDate, end: LocalDate, on: LocalDate, ctx: PlanContext): number {
  const awayBetween = (from: LocalDate, to: LocalDate) =>
    (ctx.away ?? [])
      .filter((a) => !a.deleted_at)
      .reduce((sum, a) => {
        const first = a.start > from ? a.start : from;
        const after = addDays(a.end, 1) < to ? addDays(a.end, 1) : to;
        return sum + Math.max(0, diffDays(first, after));
      }, 0);
  const span = Math.max(1, diffDays(start, end) - awayBetween(start, end));
  return Math.max(0, Math.min(100, Math.round(((diffDays(start, on) - awayBetween(start, on)) / span) * 100)));
}

const taskWord = (n: number) => `${n} ${n === 1 ? 'task' : 'tasks'}`;

/** The words for an overdue milestone's question: move its date, drop it, or mark it done. */
export function fixSummary(plan: ProjectPlan, id: string, ctx: PlanContext) {
  const m = plan.milestones.find((x) => x.id === id);
  if (!m) throw new Error(`No milestone ${id} in project ${plan.project.id}`);
  const own = plan.tasks.filter((t) => t.milestone_id === id && !t.cancelled_at);
  const open = own.filter((t) => !t.done_at);
  const openMin = open.reduce((sum, t) => sum + minutesLeft(t), 0);
  const target = dropTarget(plan, m, ctx);
  const targetDue = target && `${target.due ? 'due' : 'by'} ${formatDate(effectiveDue(plan, target, ctx))}`;
  return {
    title: `${m.title} was due ${formatDate(effectiveDue(plan, m, ctx))}`,
    sub: own.length ? `${own.length - open.length} of ${taskWord(own.length)} done, ${formatMinutes(openMin)} left.` : 'No tasks under this milestone.',
    doneCount: own.length - open.length,
    target,
    markLabel: open.length ? `Mark ${taskWord(open.length)} done` : 'Mark done',
    keepLabel: `Move to ${target ? `${target.title}, ${targetDue}` : `Done, ${formatDate(plan.project.end)}`}`,
    cancelLabel: `Cancel ${open.length === 1 ? 'it' : 'them'}, ${formatMinutes(openMin)} off the project`,
  };
}

/** What moving an overdue milestone to a date would do. It has to be a date after today. */
export function previewMove(plan: ProjectPlan, id: string, date: string, ctx: PlanContext) {
  const on = today(ctx.clock);
  if (!isDay(date) || date <= on) {
    return { valid: false, moveLabel: 'Move date', preview: `Pick a date after ${formatDate(on)}.`, warnings: [] as string[] };
  }
  const before = status(plan, ctx).pill;
  const after = status(withChange(plan, moveMilestone(plan, id, date, ctx)), ctx).pill;
  return {
    valid: true,
    moveLabel: `Move to ${formatDate(date)}`,
    preview: before === after ? `Project stays ${before}.` : `Project goes from ${before} to ${after}.`,
    warnings: milestoneWarnings(plan, id, date, ctx),
  };
}

/** Adds what the change did to the project's status to its log line. A change with no log line comes back as it was. */
export function withStatusLine(plan: ProjectPlan, change: PlanChange, ctx: PlanContext): PlanChange {
  const before = status(plan, ctx).pill;
  const after = status(withChange(plan, change), ctx).pill;
  const line = before === after ? `Project is still ${before}.` : `Project went from ${before} to ${after}.`;
  return {
    writes: change.writes.map((w) => {
      const log = w.fields.slip_log as SlipEntry[] | undefined;
      const last = log?.at(-1);
      if (!log || !last) return w;
      return { ...w, fields: { ...w.fields, slip_log: [...log.slice(0, -1), { ...last, text: `${last.text} ${line}` }] } };
    }),
  };
}

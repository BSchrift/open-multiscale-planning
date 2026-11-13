// Pick tasks as rows: projects soonest first with their open tasks under milestones, One offs, the projects that
// can't be planned now, and those past their end. Both layouts draw from this.

import type { AimRow } from '../../../../core/capacity';
import type { Clock } from '../../../../core/clock';
import { addDays, formatDate, formatMinutes, localDate, today } from '../../../../core/dates';
import {
  effectiveDue,
  lateMilestone,
  msInPlan,
  msLate,
  msReached,
  oneOffCandidates,
  planStretch,
  projectCandidates,
  taskDue,
} from '../../../../core/plan';
import type { Candidate, ProjectPlan } from '../../../../core/plan';
import { status } from '../../../../core/status';
import type { ProjectStatus } from '../../../../core/status';
import { ONE_OFFS_BUCKET } from '../../../../core/types';
import type { Minutes, SlipEntry, Task } from '../../../../core/types';
import type { DiamondState } from '../../../components/MilestoneDiamond';
import type { TimelineMark } from '../../../components/TimelineBar';
import type { PlanningData, WeekModel } from '../model';

export interface PickTask {
  c: Candidate;
  title: string;
  oneOff: boolean;
  hint?: { minutes: Minutes; why: string };
  /** What Add puts in the plan: the suggested part, or all that's left. */
  adds: Minutes;
  /** The line under the title on desktop. */
  meta: string;
  /** What tapping the title shows on phone. */
  note: string;
  /** Why it needs a new time, such as when it wasn't done, if it does. */
  reason: string;
  /** Finished today: struck through, with Undo, and nothing to add. */
  done: boolean;
}

export interface PickGroup {
  key: string;
  head: string;
  isMs: boolean;
  late: boolean;
  state?: DiamondState;
  rows: PickTask[];
  planned: Minutes;
}

export interface PickProject {
  plan: ProjectPlan;
  status: ProjectStatus;
  aim?: AimRow;
  groups: PickGroup[];
  hintN: number;
  planned: Minutes;
  marks: TimelineMark[];
  alt: string;
  lateText: string;
  next: string;
  goal: string;
  change?: SlipEntry;
}

const join = (parts: string[]) => parts.filter(Boolean).join('. ');

export function pickModel(d: PlanningData, m: WeekModel, clock: Clock) {
  const { ctx, input, hints, queue } = m;
  const on = today(clock);
  const st = planStretch(d.settings, on);
  const reasonOf = new Map(queue.map((q) => [q.id, q.reason]));

  const task = (c: Candidate): PickTask => {
    const hint = hints[c.task.id];
    const reason = reasonOf.get(c.task.id) ?? '';
    const carried = c.stale ? `Still want this? ${reason}` : c.carried ? `Needs a new time: ${reason}` : '';
    const oneOff = c.task.kind === 'one_off';
    const dates = oneOff && !hint ? taskDue(c.task, null, input.weekStart, ctx).label : '';
    return {
      c,
      title: c.task.title,
      oneOff,
      ...(hint ? { hint } : {}),
      adds: hint?.minutes ?? c.left,
      meta: join([c.picked ? 'In the plan' : (hint?.why ?? ''), carried, dates]),
      note: join([c.picked ? '' : (hint?.why ?? ''), carried, dates]),
      reason,
      done: !!c.task.done_at,
    };
  };
  // Finished today, so a task marked done here stays in its place, struck through, until the day is over.
  const doneToday = (tasks: readonly Task[]): Candidate[] =>
    tasks
      .filter((t) => t.done_at && !t.deleted_at && localDate(t.done_at, clock.zone()) === on)
      .map((t) => ({ task: t, left: 0, ahead: 0, picked: false, week: 0, carried: false, stale: false, placed: false }));
  // Each finished one goes back before the first open one that came after it in the tasks' own order, so it stays
  // where it was, and focus and the pointer stay on the row that was ticked. The open ones keep their order.
  const inPlace = (rows: PickTask[], tasks: readonly Task[]) => {
    const at = new Map(tasks.map((t, i) => [t.id, i]));
    const idx = (r: PickTask) => at.get(r.c.task.id) ?? 0;
    const out = rows.filter((r) => !r.done);
    for (const d of rows.filter((r) => r.done).sort((a, b) => idx(a) - idx(b))) {
      const i = out.findIndex((r) => !r.done && idx(r) > idx(d));
      out.splice(i < 0 ? out.length : i, 0, d);
    }
    return out;
  };

  const marksOf = (plan: ProjectPlan) =>
    plan.milestones
      .filter((ms) => !ms.dropped_at)
      .map((ms) => {
        const met = msReached(plan, ms);
        const late = !met && msLate(ms, ctx);
        const inPlan = !met && msInPlan(plan, ms, st);
        const due = effectiveDue(plan, ms, ctx);
        const when = met ? ', met' : late ? `, overdue since ${formatDate(due)}` : `, ${ms.due ? 'due' : 'by'} ${formatDate(due)}`;
        return { mark: { id: ms.id, date: due, state: { on: inPlan, met, late } }, label: `Milestone ${ms.title}${when}${inPlan ? ', in the plan' : ''}` };
      });

  const aims = m.aimRows(m.planned);
  const aimOf = (bucket: string) => aims.find((r) => r.bucket === bucket && r.aim > 0);

  const projects: PickProject[] = m.ranked.map((plan) => {
    const groups: PickGroup[] = [];
    const groupFor = (key: string, head: string, extra: Partial<PickGroup> = {}) => {
      let g = groups.find((x) => x.key === key);
      if (!g) groups.push((g = { key, head, isMs: false, late: false, rows: [], planned: 0, ...extra }));
      return g;
    };
    // Tasks already on the calendar stay listed with nothing left to add, so changing an estimate never hides one.
    for (const c of [...projectCandidates(plan, input, ctx, true), ...doneToday(plan.tasks)]) {
      const due = taskDue(c.task, plan, input.weekStart, ctx);
      const ms = due.milestone;
      const late = (due.dueDay ?? 0) < 0;
      const g = c.carried
        ? groupFor('carried', 'Needs a new time')
        : ms
          ? groupFor(ms.id, due.label, { isMs: true, late, state: { on: msInPlan(plan, ms, st), late } })
          : groupFor('none', 'Done');
      g.rows.push(task(c));
      g.planned += c.week;
    }
    for (const g of groups) g.rows = inPlace(g.rows, plan.tasks);
    const s = status(plan, ctx);
    const marks = marksOf(plan);
    const { project } = plan;
    const next = plan.milestones.find((x) => x !== s.late && !x.dropped_at && !msReached(plan, x));
    const late = lateMilestone(plan, ctx);
    return {
      plan,
      status: s,
      ...(aimOf(project.id) ? { aim: aimOf(project.id)! } : {}),
      groups,
      hintN: groups.reduce((n, g) => n + g.rows.filter((r) => r.hint).length, 0),
      planned: groups.reduce((sum, g) => sum + g.planned, 0),
      marks: marks.map((x) => x.mark),
      alt: `${project.title} runs ${formatDate(project.start)} to ${formatDate(project.end)}. ${marks.map((x) => x.label).join('. ') || 'No milestones'}.`,
      lateText: late ? `${late.title} was due ${formatDate(effectiveDue(plan, late, ctx))}.` : '',
      next: next ? `Next: ${next.title}, ${formatDate(effectiveDue(plan, next, ctx))}.` : '',
      goal: d.records.objectives.find((o) => o.id === project.objective_id)?.title ?? '',
      ...(project.slip_log?.length ? { change: project.slip_log.at(-1)! } : {}),
    };
  });

  // Those due this week come first, as oneOffCandidates puts them, each part in the tasks' own order.
  const dueFirst = (c: Candidate) => (taskDue(c.task, null, input.weekStart, ctx).dueDay != null ? 0 : 1);
  const oneOffCands = [...oneOffCandidates(m.oneOffs, input, ctx, true), ...doneToday(m.oneOffs)];
  const oneOffRows = [0, 1].flatMap((part) => inPlace(oneOffCands.filter((c) => dueFirst(c) === part).map(task), m.oneOffs));
  const oneOffs = {
    rows: oneOffRows,
    aim: aimOf(ONE_OFFS_BUCKET),
    planned: oneOffRows.reduce((sum, r) => sum + r.c.week, 0),
    count: oneOffRows.filter((r) => r.c.picked).length,
  };

  const statuses = m.plans.map((plan) => ({ plan, status: status(plan, ctx) }));
  const skipped = m.weekPlan?.skipped_past_end ?? [];
  const pastEnd = statuses.filter(({ plan, status: s }) => plan.project.state === 'active' && s.ended && !skipped.includes(plan.project.id));
  const ranked = new Set(m.ranked.map((p) => p.project.id));
  const others = statuses
    .filter(({ plan }) => ['active', 'paused'].includes(plan.project.state) && !ranked.has(plan.project.id))
    .filter(({ plan }) => !pastEnd.some((p) => p.plan === plan))
    .map(({ plan, status: s }) => ({ plan, status: s, marks: marksOf(plan).map((x) => x.mark), sum: plan.project.state === 'paused' ? "Can't be planned while paused" : s.word }));

  const planned = [...projects.flatMap((p) => p.groups.flatMap((g) => g.rows)), ...oneOffRows].filter((r) => r.c.picked);
  const hintMin = Object.values(hints).reduce((sum, h) => sum + h.minutes, 0);
  const picked = m.picks.reduce((sum, p) => sum + p.minutes, 0);
  return {
    projects,
    oneOffs,
    pastEnd,
    others,
    planned,
    hintMin,
    picked,
    axis: { start: addDays(on, -28), end: addDays(on, 181) },
    stretch: d.settings.plan_cadence ? st : undefined,
    weekSpan: { start: input.weekStart, end: addDays(input.weekStart, 6) },
  };
}

/**
 * The stops a week's time for a task can take: each quarter hour under its time, then all of it, so a 20 minute task
 * reaches 20m rather than stopping at 15m.
 */
export function weekStops(left: Minutes): Minutes[] {
  const stops: Minutes[] = [];
  for (let m = 15; m < left; m += 15) stops.push(m);
  return [...stops, left];
}

/** The stop nearest a time, for a slider's value. */
export const stopIndex = (stops: readonly Minutes[], minutes: Minutes) =>
  stops.reduce((best, m, i) => (Math.abs(m - minutes) < Math.abs(stops[best]! - minutes) ? i : best), 0);

export type PickView = ReturnType<typeof pickModel>;

/** The aim meter's words, shared by both layouts. */
export function aimWords(aim: AimRow) {
  const value = aim.skipped ? 'Skipped' : `${formatMinutes(aim.got)} of ${formatMinutes(aim.aim)}`;
  const alt = aim.skipped
    ? 'Weekly aim skipped this week'
    : `Weekly aim ${formatMinutes(aim.aim)}, ${formatMinutes(aim.got)} planned${aim.met ? ', reached' : `, ${formatMinutes(aim.aim - aim.got)} short`}`;
  return { value, alt, cls: aim.skipped ? 'off' : aim.met ? 'met' : '', canSkip: aim.aim > 0 && (!aim.met || aim.skipped) };
}

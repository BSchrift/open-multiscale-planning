// Pick tasks as rows: projects soonest first with their open tasks under milestones, One offs, the projects that
// can't be planned now, and those past their end. Both layouts draw from this.
//
// This stretch first: a task is in this stretch when its milestone is in the plan of the current stretch, or of the
// next once that's planned, and one with no milestone when its project ends in one. Filters hide only what can wait.
// A milestone with anything in it that needs you shows whole, wherever it is: overdue, needing a new time, due by the
// Monday after the week, suggested or in the week. So does a project whose pill says it needs you, or that's new since
// the stretch was planned. Anything else outside this stretch folds in place, counted, and a project with nothing that
// needs you is hidden whole until asked for. Until a stretch is planned nothing is filtered, and the view says why.

import type { AimRow } from '../../../../core/capacity';
import type { Clock } from '../../../../core/clock';
import { addDays, formatDate, formatMinutes, formatWeekday, localDate, today } from '../../../../core/dates';
import {
  effectiveDue,
  isPlanned,
  minutesLeft,
  oneOffCandidates,
  plannedIds,
  plannedStretches,
  planStretch,
  projectCandidates,
  taskDue,
} from '../../../../core/plan';
import type { Candidate, ProjectPlan } from '../../../../core/plan';
import { status } from '../../../../core/status';
import type { ProjectStatus } from '../../../../core/status';
import { ONE_OFFS_BUCKET } from '../../../../core/types';
import type { LocalDate, Milestone, Minutes, Task } from '../../../../core/types';
import type { DiamondState } from '../../../components/MilestoneDiamond';
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
  /** Overdue or due by the Monday after the week: its day, negative when overdue. */
  dueDay?: number;
}

export interface PickGroup {
  key: string;
  head: string;
  /** An overdue milestone's line on phone, one line long: 'Gather notes, overdue'. */
  short: string;
  isMs: boolean;
  late: boolean;
  state?: DiamondState;
  rows: PickTask[];
  planned: Minutes;
  milestone?: Milestone;
  /** What it sorts by: its milestone's date, or for Done the project's end. */
  date: LocalDate;
  /** Outside this stretch: dated outside both plans, or in a project outside them. Done and undated never are. */
  outside: boolean;
  /** Something in it needs you, so no filter, fold or switch hides it. */
  must: boolean;
  /** Folded while what's outside this stretch is hidden. */
  folded: boolean;
  /** Its open tasks, as a fold counts them: '2 tasks, 1h 30m, 1 with no estimate'. */
  open: number;
  counts: string;
}

/** Why a project outside this stretch shows: a tag on its heading, shorter on phone, and the words a screen reader hears. */
export interface PickReason {
  long: string;
  short: string;
  sr: string;
  tone: 'red' | 'blue' | 'new' | '';
}

export interface PickProject {
  plan: ProjectPlan;
  status: ProjectStatus;
  aim?: AimRow;
  groups: PickGroup[];
  planned: Minutes;
  /** In this stretch: a milestone of it is in a plan, or Done is. */
  inStretch: boolean;
  /** Shown before anything outside this stretch is asked for. */
  shown: boolean;
  /** New since the stretch was planned, so it shows whole, with nothing folded. */
  whole: boolean;
  reason?: PickReason;
  /** Its open tasks hidden while what's outside this stretch is: those folded, or all of them when it's hidden. */
  more: number;
}

/** Something that needs you before Continue: a question to answer, a task that needs a new time, or work due. */
export interface NeedItem {
  key: string;
  title: string;
  /** Where it is, a project or One offs. */
  where: string;
  why: string;
  /** The row, for a task; a project's id, for a question. */
  row?: PickTask;
  project?: string;
}

export interface NeedYou {
  questions: NeedItem[];
  newTime: NeedItem[];
  due: NeedItem[];
}

const join = (parts: string[]) => parts.filter(Boolean).join('. ');
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const unestimated = (t: Task) => t.estimate_min == null && t.remaining_min == null;
/** The pills that mean a project needs you, so it shows in place even outside this stretch. */
const NEEDS_YOU = ['No tasks', 'Behind', 'Overdue', 'Past end date'];

/** '2 tasks, 1h 30m, 1 with no estimate': what a fold holds. */
function counted(rows: readonly PickTask[]) {
  const open = rows.filter((r) => !r.done);
  const minutes = open.reduce((sum, r) => sum + minutesLeft(r.c.task), 0);
  const none = open.filter((r) => unestimated(r.c.task)).length;
  return { open: open.length, counts: [plural(open.length, 'task'), minutes ? formatMinutes(minutes) : '', none ? `${none} with no estimate` : ''].filter(Boolean).join(', ') };
}

/** The words for everything that needs you, by Continue: at 0 they say so, so the line is never just missing. */
export function needWords(need: NeedYou) {
  const { questions: q, newTime: t, due: d } = need;
  const n = q.length + t.length + d.length;
  if (!n) return { n, line: 'Everything due or overdue is in the week, and nothing is waiting for an answer.', short: 'Everything due or overdue is in the week.', link: '', next: 'Continue to scheduling' };
  const parts = (words: [number, string][]) => words.filter(([k]) => k > 0).map(([, w]) => w).join(', ');
  return {
    n,
    line: `${parts([
      [q.length, plural(q.length, 'question') + ' to answer'],
      [t.length, `${plural(t.length, 'task')} that ${t.length === 1 ? 'needs' : 'need'} a new time`],
      [d.length, `${d.length} due or overdue not in the week`],
    ])}.`,
    short: parts([
      [q.length, `${q.length} to answer`],
      [t.length, `${t.length} new time`],
      [d.length, `${d.length} due`],
    ]),
    link: `Show the ${n} that need you: ${parts([
      [q.length, `${q.length} to answer`],
      [t.length, `${t.length} ${t.length === 1 ? 'needs' : 'need'} a new time`],
      [d.length, `${d.length} due or overdue`],
    ])}.`,
    next: `Continue to scheduling, ${n} need you`,
  };
}

export function pickModel(d: PlanningData, m: WeekModel, clock: Clock) {
  const { ctx, input, hints, queue } = m;
  const on = today(clock);
  const st = planStretch(d.settings, on);
  // With no cadence there are no stretches to filter by; with one, nothing is filtered until a stretch is planned.
  const stretches = d.settings.plan_cadence ? plannedStretches(d.settings, on) : [];
  const filter = stretches.length > 0;
  const from = stretches[0]?.start ?? '';
  const counts = filter ? stretches : [st];
  const reasonOf = new Map(queue.map((q) => [q.id, q.reason]));

  const task = (c: Candidate, plan: ProjectPlan | null): PickTask => {
    const hint = hints[c.task.id];
    const reason = reasonOf.get(c.task.id) ?? '';
    const carried = c.stale ? `Still want this? ${reason}` : c.carried ? `Needs a new time: ${reason}` : '';
    const oneOff = c.task.kind === 'one_off';
    const due = taskDue(c.task, plan, input.weekStart, ctx);
    const dates = oneOff && !hint ? due.label : '';
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
      ...(due.dueDay != null ? { dueDay: due.dueDay } : {}),
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
  // A row needs you when it's overdue, needs a new time, is due by the Monday after, is suggested or is in the week. One
  // ticked done today keeps its place, so it never folds away under the pointer.
  const needs = (r: PickTask) => r.done || r.c.carried || r.dueDay != null || !!r.hint || r.c.picked || r.c.placed;
  // A new milestone with no date or stretch can't be in a plan yet, so it shows rather than starting out of sight.
  const fresh = (ms?: Milestone) => filter && !!ms && !ms.due && !ms.stretch && (ms.added_on ?? '') >= from;

  const aims = m.aimRows(m.planned);
  const aimOf = (bucket: string) => aims.find((r) => r.bucket === bucket && r.aim > 0);

  const projects: PickProject[] = m.ranked.map((plan) => {
    const { project } = plan;
    const s = status(plan, ctx);
    const inStretch = !filter || stretches.some((x) => plannedIds(plan, x).length > 0);
    // Made, or started, since the stretch began, and in no stretch's plan yet. A project from before added_on has none.
    const whole = filter && !inStretch && (project.start >= from || (project.added_on ?? '') >= from) && !plan.milestones.some((x) => x.stretch);
    const groups: PickGroup[] = [];
    const groupFor = (key: string, head: string, extra: Partial<PickGroup> = {}) => {
      let g = groups.find((x) => x.key === key);
      if (!g) groups.push((g = { key, head, short: head, isMs: false, late: false, rows: [], planned: 0, date: project.end, outside: false, must: false, folded: false, open: 0, counts: '', ...extra }));
      return g;
    };
    const msGroup = (ms: Milestone) => {
      const due = taskDue({ milestone_id: ms.id } as Task, plan, input.weekStart, ctx);
      const late = (due.dueDay ?? 0) < 0;
      return groupFor(ms.id, due.label, {
        isMs: true,
        late,
        milestone: ms,
        date: effectiveDue(plan, ms, ctx),
        short: late ? `${ms.title}, overdue` : due.label,
        state: { on: isPlanned({ milestone_id: ms.id }, plan, counts), late },
      });
    };
    // Tasks already on the calendar stay listed with nothing left to add, so changing an estimate never hides one.
    for (const c of [...projectCandidates(plan, input, ctx, true), ...doneToday(plan.tasks)]) {
      const ms = taskDue(c.task, plan, input.weekStart, ctx).milestone;
      const g = c.carried ? groupFor('carried', 'Needs a new time', { date: '' }) : ms ? msGroup(ms) : groupFor('none', `Done, by ${formatDate(project.end)}`);
      g.rows.push(task(c, plan));
      g.planned += c.week;
    }
    // An overdue milestone is asked about on its own line, so it has one even with no open tasks.
    if (s.late) msGroup(s.late).must = true;
    // Work needing a new time first, then by date, Done last.
    groups.sort((a, b) => {
      const key = (g: PickGroup) => `${g.date}${g.isMs ? 0 : 1}`;
      return key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;
    });
    for (const g of groups) {
      g.rows = inPlace(g.rows, plan.tasks);
      Object.assign(g, counted(g.rows));
      const ms = g.milestone;
      g.must ||= g.rows.some(needs) || fresh(ms);
      if (!filter || g.key === 'carried') continue;
      g.outside = !inStretch || (!!ms && (!!ms.due || !!ms.stretch) && !isPlanned({ milestone_id: ms.id }, plan, stretches));
      g.folded = g.outside && !g.must && !whole;
    }
    const rows = groups.flatMap((g) => g.rows.filter((r) => !r.done));
    const shown = inStretch || whole || NEEDS_YOU.includes(s.pill) || groups.some((g) => g.must);
    const reason = filter && !inStretch ? reasonFor(s, whole, rows, groups) : undefined;
    return {
      plan,
      status: s,
      ...(aimOf(project.id) ? { aim: aimOf(project.id)! } : {}),
      groups,
      planned: groups.reduce((sum, g) => sum + g.planned, 0),
      inStretch,
      shown,
      whole,
      ...(reason ? { reason } : {}),
      more: groups.filter((g) => !shown || g.folded).reduce((n, g) => n + g.open, 0),
    };
  });

  /** The first reason that applies, most pressing first. */
  function reasonFor(s: ProjectStatus, whole: boolean, rows: PickTask[], groups: PickGroup[]): PickReason {
    const tag = (short: string, tone: PickReason['tone'] = '', sr = short.toLowerCase()) => ({ long: `${short}, outside this stretch`, short, sr: `${sr}, outside this stretch`, tone });
    const inWeek = rows.filter((r) => r.c.picked || r.c.placed).length;
    const after = addDays(input.weekStart, 7);
    if (s.late) return { long: 'Overdue, from last stretch', short: 'Overdue, last stretch', sr: 'overdue from the last stretch, outside this stretch', tone: 'red' };
    if (whole) return { long: 'New since you planned this stretch', short: 'New', sr: 'new since you planned this stretch', tone: 'new' };
    if (rows.some((r) => r.c.carried)) return tag('Needs a new time', 'red');
    if (rows.some((r) => r.dueDay != null)) return tag(`Due by ${formatWeekday(after)}, ${formatDate(after)}`, 'red', `due by ${formatWeekday(after)}, ${formatDate(after)}`);
    if (inWeek) return tag('In this week', 'blue', `${plural(inWeek, 'task')} in this week`);
    if (rows.some((r) => r.hint)) return tag('Suggested', 'blue');
    if (s.pill === 'Past end date') return tag('Past end date', 'red');
    if (s.pill === 'No tasks') return tag('No tasks');
    if (s.pill === 'Behind') return tag('Behind pace');
    if (groups.some((g) => fresh(g.milestone))) return tag('New milestone', 'new');
    return { long: 'Outside this stretch', short: 'Outside this stretch', sr: 'outside this stretch', tone: '' };
  }

  // Those due this week come first, as oneOffCandidates puts them, each part in the tasks' own order.
  const dueFirst = (c: Candidate) => (taskDue(c.task, null, input.weekStart, ctx).dueDay != null ? 0 : 1);
  const oneOffCands = [...oneOffCandidates(m.oneOffs, input, ctx, true), ...doneToday(m.oneOffs)];
  const oneOffParts = [0, 1].map((part) => inPlace(oneOffCands.filter((c) => dueFirst(c) === part).map((c) => task(c, null)), m.oneOffs));
  const oneOffRows = oneOffParts.flat();
  const oneOffs = {
    rows: oneOffRows,
    groups: [
      { key: 'week', head: 'This week', rows: oneOffParts[0]! },
      { key: 'later', head: 'Later or no date', rows: oneOffParts[1]! },
    ].filter((g) => g.rows.length),
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
    .map(({ plan, status: s }) => {
      const open = plural(plan.tasks.filter((t) => !t.done_at && !t.cancelled_at).length, 'open task');
      return { plan, status: s, sum: plan.project.state === 'paused' ? `${open}. Can't be planned while paused.` : `${open}. ${s.word}.` };
    });

  // What the toggle reveals: folds in shown projects, and the projects hidden whole, in the list's order.
  const where = projects.filter((p) => p.more > 0).map((p) => ({ id: p.plan.project.id, title: p.plan.project.title, n: p.more, hidden: !p.shown }));
  const dates = projects.flatMap((p) => p.groups.filter((g) => (!p.shown || g.folded) && g.open).map((g) => g.date)).sort();
  const outside = {
    n: where.reduce((sum, w) => sum + w.n, 0),
    folded: where.filter((w) => !w.hidden).reduce((sum, w) => sum + w.n, 0),
    where,
    ...(dates[0] ? { earliest: dates[0] } : {}),
  };

  const projectRows = projects.flatMap((p) => p.groups.flatMap((g) => g.rows.map((row) => ({ row, where: p.plan.project.title }))));
  const allRows = [...projectRows, ...oneOffRows.map((row) => ({ row, where: 'One offs' }))].filter(({ row }) => !row.done);
  const item = ({ row, where }: { row: PickTask; where: string }, why: string): NeedItem => ({ key: `t:${row.c.task.id}`, title: row.title, where, why, row });
  const dueOn = (day: number) => addDays(input.weekStart, day);
  const needYou: NeedYou = {
    questions: [
      ...projects.filter((p) => p.status.late).map((p) => {
        const ms = p.status.late!;
        return { key: `q:${ms.id}`, title: ms.title, where: p.plan.project.title, why: `overdue since ${formatDate(effectiveDue(p.plan, ms, ctx))}`, project: p.plan.project.id };
      }),
      ...pastEnd.map(({ plan }) => ({ key: `q:${plan.project.id}`, title: plan.project.title, where: 'Past its end date', why: `ended ${formatDate(plan.project.end)}`, project: plan.project.id })),
    ],
    newTime: allRows.filter(({ row }) => row.c.carried && !row.c.picked).map((x) => item(x, x.row.reason ? x.row.reason.charAt(0).toLowerCase() + x.row.reason.slice(1) : 'needs a new time')),
    due: allRows
      .filter(({ row }) => row.dueDay != null && !row.c.carried && !row.c.picked && !row.c.placed)
      .map((x) => item(x, x.row.dueDay! < 0 ? 'overdue' : `due ${formatWeekday(dueOn(x.row.dueDay!))}, ${formatDate(dueOn(x.row.dueDay!))}`)),
  };

  // Planned milestones with nothing to do under them yet, as stretch planning counts them.
  const noTasks = filter
    ? m.ranked.reduce((n, plan) => {
        const open = (id: string | null) => plan.tasks.some((t) => (t.milestone_id ?? null) === id && !t.done_at && !t.cancelled_at);
        const ids = new Set(stretches.flatMap((x) => plannedIds(plan, x)));
        return n + [...ids].filter((id) => (id.startsWith('done:') ? !plan.tasks.some((t) => !t.done_at && !t.cancelled_at) : !open(id))).length;
      }, 0)
    : 0;

  const planned = [...projects.flatMap((p) => p.groups.flatMap((g) => g.rows)), ...oneOffRows].filter((r) => r.c.picked);
  const hintMin = Object.values(hints).reduce((sum, h) => sum + h.minutes, 0);
  const picked = m.picks.reduce((sum, p) => sum + p.minutes, 0);
  const cadence = !!d.settings.plan_cadence;
  return {
    projects,
    oneOffs,
    pastEnd,
    others,
    planned,
    hintMin,
    picked,
    /** This stretch: the first of those planned, or with none planned the one planning would plan. */
    stretch: cadence ? (stretches[0] ?? st) : undefined,
    stretches,
    filter,
    /** Why nothing is filtered, when it isn't. */
    why: filter ? null : cadence ? { unplanned: st } : ('no cadence' as const),
    outside,
    needYou,
    noTasks,
    inbox: d.records.tasks.filter((t) => t.kind === 'inbox' && !t.done_at && !t.cancelled_at && !t.deleted_at).length,
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

/** Minutes on this week's calendar when that's all the time a task has left, else 0. */
export const allOnCalendar = (c: Candidate) => (c.left ? 0 : c.ahead);

/** A picked task's time this week: '2h', or '15m on calendar' once all of it is there, whatever its share says. */
export const weekText = (c: Candidate) => (allOnCalendar(c) ? `${formatMinutes(c.ahead)} on calendar` : formatMinutes(c.week));

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

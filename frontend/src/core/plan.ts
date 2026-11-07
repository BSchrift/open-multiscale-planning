// Planning logic: stretches and the cadence, which milestones are in a plan, the soonest-date project order,
// suggested picks, the order tasks are scheduled in, and replanning a project's dates. Pure: it takes records and
// returns values. A change to records comes back as a PlanChange for the caller to write with applyPlanChange.

import type { Clock } from './clock';
import { addDays, addMonths, blockMinutes, dayNumber, diffDays, formatDate, instantMs, localDate, nowInstant, quarterEnd, quarterStart, thisWeek, today } from './dates';
import type { Writer } from './records';
import type { Work } from './slots';
import type {
  AwayPeriod,
  BaseRecord,
  CadenceUnit,
  Fields,
  LocalDate,
  Milestone,
  Minutes,
  PlanCadence,
  PlanStretch,
  Project,
  Settings,
  SlipEntry,
  Task,
  TimeBlock,
  WeekPick,
} from './types';
import { ONE_OFFS_BUCKET } from './types';

export interface Stretch {
  start: LocalDate;
  end: LocalDate;
}

export type CadenceSettings = Pick<Settings, 'plan_cadence' | 'plan_stretch'>;

const later = (a: LocalDate, b: LocalDate) => (a > b ? a : b);

/** The stretch starting on a date. A calendar quarter ends on its date, however late in it you start. */
export function stretchFrom(start: LocalDate, cadence: { every: number; unit: CadenceUnit }): Stretch {
  if (cadence.unit === 'quarters') return { start, end: quarterEnd(start) };
  const every = Math.max(1, cadence.every);
  return {
    start,
    end: addDays(cadence.unit === 'weeks' ? addDays(start, every * 7) : addMonths(start, every), -1),
  };
}

/** One cadence before a date, a quarter without one: a goal with nothing changed since then is asked if it still is one. */
export function cadenceBefore({ plan_cadence: cadence }: CadenceSettings, on: LocalDate): LocalDate {
  if (!cadence || cadence.unit === 'quarters') return addMonths(on, -3);
  const every = Math.max(1, cadence.every);
  return cadence.unit === 'weeks' ? addDays(on, -7 * every) : addMonths(on, -every);
}

/** Where the cadence takes over: its anchor, or after the last one-off dates that have passed. */
function cadenceStart(cadence: PlanCadence, oneOffs: readonly Stretch[], on: LocalDate): LocalDate {
  const anchor = cadence.anchor ?? quarterStart(on);
  return oneOffs.filter((o) => o.end < on).reduce((start, o) => later(start, addDays(o.end, 1)), anchor);
}

/** Stretches follow the calendar, so they roll over on their date whether or not planning happened. */
export function currentStretch({ plan_cadence: cadence, plan_stretch: pinned }: CadenceSettings, on: LocalDate): Stretch | null {
  const oneOffs = pinned.one_offs ?? [];
  const inOneOff = oneOffs.find((o) => on >= o.start && on <= o.end);
  if (inOneOff) return inOneOff;
  if (!cadence) return null;
  const start = cadenceStart(cadence, oneOffs, on);
  if (on < start) return null;
  let cur = stretchFrom(start, cadence);
  // Months count from the start, so a stretch from the 31st keeps to each month's end rather than drifting to the 28th.
  const every = Math.max(1, cadence.every);
  for (let k = 1; cur.end < on; k++) {
    cur =
      cadence.unit === 'months'
        ? { start: addMonths(start, k * every), end: addDays(addMonths(start, (k + 1) * every), -1) }
        : stretchFrom(addDays(cur.end, 1), cadence);
  }
  const cutBy = oneOffs.filter((o) => o.start > cur.start && o.start <= cur.end).map((o) => o.start).sort()[0];
  return cutBy ? { start: cur.start, end: addDays(cutBy, -1) } : cur;
}

export function nextStretch(settings: CadenceSettings, on: LocalDate): Stretch {
  const { plan_cadence: cadence, plan_stretch: pinned } = settings;
  const oneOffs = pinned.one_offs ?? [];
  const upcoming = oneOffs.filter((o) => o.start > on).sort((a, b) => (a.start < b.start ? -1 : 1))[0];
  if (upcoming) return upcoming;
  const cur = currentStretch(settings, on);
  if (!cadence) {
    const start = cur ? addDays(cur.end, 1) : addDays(on, 3);
    return { start, end: addMonths(start, 3) };
  }
  if (!cur) return stretchFrom(cadenceStart(cadence, oneOffs, on), cadence);
  // The stretch the day after holds, so months keep counting from the cadence's start.
  return currentStretch(settings, addDays(cur.end, 1)) ?? stretchFrom(addDays(cur.end, 1), cadence);
}

/**
 * The end of the stretch starting on a date. A past one is the stretch that held on its start, so months keep counting
 * from the cadence's start. With nothing to go on, it's that date.
 */
export function stretchEnd(start: LocalDate, settings: CadenceSettings, on: LocalDate): LocalDate {
  const known = [
    ...(settings.plan_stretch.one_offs ?? []),
    currentStretch(settings, on),
    nextStretch(settings, on),
    currentStretch(settings, start),
  ];
  const match = known.find((s) => s?.start === start);
  if (match) return match.end;
  return settings.plan_cadence ? stretchFrom(start, settings.plan_cadence).end : start;
}

/**
 * When planning for the stretch after this one opens: a week before its end, but not on its first day unless that's
 * its last, so a short stretch just planned isn't asked for again at once.
 */
export const planningOpens = (st: Stretch): LocalDate => later(addDays(st.end, -7), earlier(addDays(st.start, 1), st.end));

const planningWindow = (cur: Stretch, on: LocalDate) => on >= planningOpens(cur);

/**
 * The stretch solid diamonds speak for: the one being planned once planning is due or under way, else the current one.
 * A first plan is for the stretch that holds today, from today unless its dates have been set.
 */
export function planStretch(settings: CadenceSettings, on: LocalDate, planning = false): Stretch {
  const cur = currentStretch(settings, on);
  if (cur && !settings.plan_stretch.last_planned) {
    const set = (settings.plan_stretch.one_offs ?? []).some((o) => o.start === cur.start);
    return planning && !set ? { start: on, end: cur.end } : cur;
  }
  const next = nextStretch(settings, on);
  return !cur || planning || settings.plan_stretch.last_planned === next.start || planningWindow(cur, on) ? next : cur;
}

/** Whether to ask for planning now. With no cadence there are no prompts. Never planned, the first plan is due at once. */
export function planningDue(settings: CadenceSettings, on: LocalDate): boolean {
  const cur = currentStretch(settings, on);
  if (!cur || !settings.plan_cadence) return false;
  const last = settings.plan_stretch.last_planned;
  return !last || (last !== nextStretch(settings, on).start && planningWindow(cur, on));
}

/**
 * New cadence settings. 'end' pins the current stretch as a one-off so only what follows takes the new cadence;
 * 'now' pins it as ending today, so its undated milestones are due today, and starts again tomorrow, with planning
 * due for that rather than a first plan of today. A null cadence is no fixed schedule. Changing cadence never moves a date.
 */
export function changeCadence(settings: CadenceSettings, cadence: PlanCadence | null, when: 'end' | 'now', on: LocalDate): CadenceSettings {
  const pinned: PlanStretch = settings.plan_stretch;
  if (!cadence) return { plan_cadence: null, plan_stretch: { ...pinned, one_offs: [] } };
  const cur = currentStretch(settings, on);
  if (!cur) return { plan_cadence: { ...cadence, anchor: cadence.anchor ?? on }, plan_stretch: pinned };
  if (when === 'now') {
    return { plan_cadence: { ...cadence, anchor: addDays(on, 1) }, plan_stretch: { ...pinned, one_offs: [{ start: cur.start, end: on }], last_planned: cur.start } };
  }
  return { plan_cadence: { ...cadence, anchor: addDays(cur.end, 1) }, plan_stretch: { ...pinned, one_offs: [cur] } };
}

/** 'Calendar quarters', 'Every month', 'Every 3 months', or 'Not set' for no fixed schedule. */
export function cadenceLabel(cadence: PlanCadence | null): string {
  if (!cadence) return 'Not set';
  if (cadence.unit === 'quarters') return 'Calendar quarters';
  return cadence.every === 1 ? `Every ${cadence.unit.slice(0, -1)}` : `Every ${cadence.every} ${cadence.unit}`;
}

/** Why a stretch's new dates won't do, or null. A next one has to start after today; a first one still holds today. */
export function stretchError(to: Stretch, on: LocalDate, first = false): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(to.start) || !/^\d{4}-\d{2}-\d{2}$/.test(to.end)) return 'Pick a start and an end.';
  if (first) return to.start > on ? 'Start today or earlier.' : to.end < on ? 'End today or later.' : null;
  if (to.start <= on) return 'Start after today.';
  return to.end < to.start ? 'End on or after the start.' : null;
}

/** New dates for a stretch, pinned so the cadence carries on after it. Milestones added to it follow its start; no project date moves. */
export function pinStretch(settings: CadenceSettings, milestones: readonly Milestone[], from: Stretch, to: Stretch): { settings: CadenceSettings; change: PlanChange } {
  const pinned = settings.plan_stretch;
  const one_offs = [...(pinned.one_offs ?? []).filter((o) => o.start !== from.start), to].sort((a, b) => (a.start < b.start ? -1 : 1));
  const moved = from.start === to.start ? [] : milestones.filter((m) => m.stretch === from.start && !m.deleted_at);
  return {
    settings: {
      plan_cadence: settings.plan_cadence,
      plan_stretch: { ...pinned, one_offs, ...(pinned.last_planned === from.start ? { last_planned: to.start } : {}) },
    },
    change: { writes: moved.map((m) => ({ type: 'milestone', id: m.id, fields: { stretch: to.start } })) },
  };
}

export interface PlanContext {
  settings: CadenceSettings;
  clock: Clock;
  /** Away dates pause pace. */
  away?: readonly AwayPeriod[];
  /** Whether the planning flow is under way, which makes the plan speak for the next stretch. */
  planning?: boolean;
}

/** A project with its live milestones and tasks. */
export interface ProjectPlan {
  project: Project;
  milestones: Milestone[];
  tasks: Task[];
}

export function gatherPlans(projects: readonly Project[], milestones: readonly Milestone[], tasks: readonly Task[]): ProjectPlan[] {
  return projects
    .filter((project) => !project.deleted_at)
    .map((project) => ({
      project,
      milestones: milestones.filter((m) => m.project_id === project.id && !m.deleted_at),
      tasks: tasks.filter((t) => t.project_id === project.id && !t.deleted_at),
    }));
}

const earlier = (a: LocalDate, b: LocalDate) => (a < b ? a : b);

/** A milestone's date. With none, it means by the stretch's end, capped at the project's end so Done stays last. */
export function effectiveDue({ project }: ProjectPlan, m: Milestone, ctx: PlanContext): LocalDate {
  if (m.due) return m.due;
  return m.stretch ? earlier(stretchEnd(m.stretch, ctx.settings, today(ctx.clock)), project.end) : project.end;
}

/** Undated means by the stretch's end, so it can't be overdue until that stretch has passed. */
export function msLate(m: Milestone, ctx: PlanContext): boolean {
  const on = today(ctx.clock);
  if (m.due) return m.due < on;
  return !!m.stretch && stretchEnd(m.stretch, ctx.settings, on) < on;
}

/**
 * The tasks a milestone is reached by: all but cancelled ones. Those that finishing or dropping the project cancelled
 * still count, since they were never done.
 */
export function msTasks({ project, tasks }: { project: Project; tasks: readonly Task[] }, m: Milestone): Task[] {
  const closed = new Set(
    (project.slip_log ?? [])
      .filter((e) => e.kind === 'close' && Array.isArray(e.undo))
      .flatMap((e) => (e.undo as RecordWrite[]).filter((w) => w.type === 'task').map((w) => w.id)),
  );
  return tasks.filter((t) => t.milestone_id === m.id && (!t.cancelled_at || closed.has(t.id)));
}

export function msDone(plan: ProjectPlan, m: Milestone): boolean {
  const own = msTasks(plan, m);
  return own.length > 0 && own.every((t) => t.done_at);
}

export function msReached(plan: ProjectPlan, m: Milestone): boolean {
  return !!m.met_at || msDone(plan, m);
}

/** The milestones still to reach. */
const openMilestones = (plan: ProjectPlan) => plan.milestones.filter((m) => !m.dropped_at && !msReached(plan, m));

/** The earliest milestone past its date, if any. */
export function lateMilestone(plan: ProjectPlan, ctx: PlanContext): Milestone | undefined {
  return openMilestones(plan)
    .filter((m) => msLate(m, ctx))
    .sort((a, b) => (effectiveDue(plan, a, ctx) < effectiveDue(plan, b, ctx) ? -1 : 1))[0];
}

export function msInPlan({ project }: ProjectPlan, m: Milestone, st: Stretch): boolean {
  return project.state === 'active' && !m.dropped_at && (m.stretch === st.start || (!!m.due && m.due >= st.start && m.due <= st.end));
}

export function doneInPlan({ project }: ProjectPlan, st: Stretch): boolean {
  return project.state === 'active' && project.end >= st.start && project.end <= st.end;
}

/** Every project has an implicit Done at its end, always last. It's a view, never stored, and only Finish marks it met. */
export function doneOf({ project, tasks }: ProjectPlan) {
  return {
    id: `done:${project.id}`,
    title: 'Done',
    due: project.end,
    met: project.state === 'finished',
    tasks: tasks.filter((t) => !t.milestone_id),
  };
}

/** Ids in the plan, with Done as done:<project>. Reached milestones are behind you, so they aren't counted. */
export function plannedIds(plan: ProjectPlan, st: Stretch): string[] {
  return [
    ...plan.milestones.filter((m) => !msReached(plan, m) && msInPlan(plan, m, st)).map((m) => m.id),
    ...(doneInPlan(plan, st) ? [doneOf(plan).id] : []),
  ];
}

const isOpen = (t: Task) => !t.done_at && !t.cancelled_at;

/** What's left of a task: the time remaining, or else its estimate. */
export const minutesLeft = (t: Task) => t.remaining_min ?? t.estimate_min ?? 0;

/** Open time under planned milestones. Tasks with no milestone sit under Done. */
export function planMinutes(plan: ProjectPlan, st: Stretch): number {
  const ids = plannedIds(plan, st);
  return plan.tasks
    .filter((t) => isOpen(t) && ids.includes(t.milestone_id ?? doneOf(plan).id))
    .reduce((sum, t) => sum + minutesLeft(t), 0);
}

/** By date, with dropped ones last. */
export function sortedMilestones(plan: ProjectPlan, ctx: PlanContext): Milestone[] {
  const key = (m: Milestone) => `${m.dropped_at ? 1 : 0}${effectiveDue(plan, m, ctx)}`;
  return [...plan.milestones].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

/** The projects planning can schedule now, soonest date first, so there's no order to keep up. */
export function plannable(plans: readonly ProjectPlan[], ctx: PlanContext): ProjectPlan[] {
  const on = today(ctx.clock);
  const when = (plan: ProjectPlan) =>
    openMilestones(plan).filter((m) => m.due).map((m) => m.due!).sort()[0] ?? plan.project.end;
  return plans
    .filter(({ project }) => project.state === 'active' && project.start <= on)
    // A project past its end with an overdue milestone still needs that sorted out, so it stays.
    .filter((plan) => plan.project.end >= on || lateMilestone(plan, ctx))
    .map((plan) => ({ plan, date: when(plan) }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .map(({ plan }) => plan);
}

export interface TaskDue {
  /** The day of the week it's due, 0 for Monday. Negative means overdue. Absent when it isn't due this week. */
  dueDay?: number;
  /** Days from Monday to the first day it can happen, when that's after Monday. Past Sunday, it only adds a note. */
  opensDay?: number;
  /** The milestone that sets its date. */
  milestone?: Milestone;
  /** A one off's own dates, rather than a milestone's. */
  dated?: boolean;
  label: string;
  /** Why a time is suggested for it. */
  why: string;
}

const EMPTIEST_DAY = 'on your emptiest day';

/** A one off's dates: a once rule's range, or a repeating one's next date. */
function oneOffDates({ schedule, next_due }: Task): { from: LocalDate; to: LocalDate | null } | null {
  if (schedule?.type === 'once') return schedule.from ? { from: schedule.from, to: schedule.to ?? null } : null;
  return next_due ? { from: next_due, to: null } : null;
}

const hasOwnEnd = (d: { from: LocalDate; to: LocalDate | null }) => !!d.to && d.to !== d.from;

function oneOffDue(t: Task, weekStart: LocalDate): TaskDue {
  const dates = oneOffDates(t);
  if (!dates) return { label: '', why: EMPTIEST_DAY };
  const opens = diffDays(weekStart, dates.from);
  const closes = diffDays(weekStart, dates.to ?? dates.from);
  return {
    dated: true,
    label: hasOwnEnd(dates) ? `${formatDate(dates.from)} to ${formatDate(dates.to!)}` : formatDate(dates.from),
    why: dates.to ? 'between its dates' : 'on its date',
    ...(opens > 0 ? { opensDay: opens } : {}),
    ...(closes <= 6 ? { dueDay: closes } : {}),
  };
}

/** The dates core/slots ranks a task's suggested times by, from its taskDue in the week starting weekStart. */
export function taskWork(t: Task, due: TaskDue, weekStart: LocalDate): Work {
  return {
    kind: t.kind === 'one_off' ? 'one_off' : 'project',
    due: due.dueDay != null ? addDays(weekStart, due.dueDay) : null,
    opens: due.opensDay != null ? addDays(weekStart, due.opensDay) : null,
  };
}

/** What a task is due by, from a milestone or a one off's dates, which sets the day that's best for it. */
export function taskDue(t: Task, plan: ProjectPlan | null, weekStart: LocalDate, ctx: PlanContext): TaskDue {
  if (!plan) return oneOffDue(t, weekStart);
  const m = plan.milestones.find((x) => x.id === t.milestone_id && !x.dropped_at && !x.met_at);
  if (!m) return { label: '', why: EMPTIEST_DAY };
  const due = effectiveDue(plan, m, ctx);
  const date = formatDate(due);
  const when = `${m.due ? 'due' : 'by'} ${date}`;
  const label = `${m.title}, ${when}`;
  const days = diffDays(weekStart, due);
  if (!m.due && !m.stretch) return { milestone: m, label, why: EMPTIEST_DAY };
  if (days < 0 && m.due) {
    return { dueDay: -1, milestone: m, label: `${m.title}, overdue since ${date}`, why: `earliest open, because ${m.title} is overdue` };
  }
  // A milestone due the Monday after still counts, because this is its last planned week.
  if (days <= 7) return { dueDay: Math.max(0, Math.min(days, 6)), milestone: m, label, why: `before ${m.title} is ${when}` };
  return { milestone: m, label, why: `${EMPTIEST_DAY}. ${m.title} is ${when}` };
}

/** The week being planned. picks and blocks may hold other weeks' too; picks are matched by week. */
export interface WeekInput {
  weekStart: LocalDate;
  picks: readonly WeekPick[];
  /** This week's blocks. */
  blocks: readonly TimeBlock[];
  /** Tasks that need a new time, which list first. */
  carried?: ReadonlySet<string>;
  /** Tasks being asked "Still want this?", which aren't suggested. */
  stale?: ReadonlySet<string>;
  /** This week's aims, by project id or ONE_OFFS_BUCKET, over the usual ones. */
  aims?: Readonly<Record<string, Minutes>>;
  oneOffAim?: Minutes | null;
  /** Open time left in the week after everything placed or picked. Suggestions never go past it. */
  freeMin?: Minutes;
}

export interface Candidate {
  task: Task;
  /** Minutes not yet placed. */
  left: Minutes;
  picked: boolean;
  /** Minutes picked for this week. */
  week: Minutes;
  carried: boolean;
  stale: boolean;
  /** Has time on this week's calendar. */
  placed: boolean;
}

const liveBlocks = (week: WeekInput) => week.blocks.filter((b) => !b.cancelled && !b.deleted_at);
const livePicks = (week: WeekInput) => week.picks.filter((p) => p.week_start === week.weekStart && !p.deleted_at);

function candidate(t: Task, week: WeekInput, ctx: PlanContext): Candidate {
  const pick = livePicks(week).find((p) => p.task_id === t.id);
  // Only blocks still ahead: answering a past block has already changed the time remaining.
  const ahead = liveBlocks(week)
    .filter((b) => b.task_id === t.id && instantMs(b.start) > ctx.clock.now())
    .reduce((sum, b) => sum + blockMinutes(b), 0);
  return {
    task: t,
    left: Math.max(0, minutesLeft(t) - ahead),
    picked: !!pick,
    week: pick?.minutes ?? 0,
    carried: !!week.carried?.has(t.id),
    stale: !!week.stale?.has(t.id),
    placed: liveBlocks(week).some((b) => b.task_id === t.id),
  };
}

const unestimated = (t: Task) => t.estimate_min == null && t.remaining_min == null;

// shortcut: a task with no estimate stays pickable but has no minutes to suggest, so it never shows as suggested; give it a default length if that's missed.
const toPlace = (c: Candidate) => c.left > 0 || unestimated(c.task);

/**
 * A project's open tasks: work needing a new time, then planned milestones by date, then Done, then the rest.
 * withPicked also keeps picked tasks, and ones on this week's calendar, whose time is all placed.
 */
export function projectCandidates(plan: ProjectPlan, week: WeekInput, ctx: PlanContext, withPicked = false): Candidate[] {
  const st = planStretch(ctx.settings, today(ctx.clock), ctx.planning);
  const key = (c: Candidate) => {
    if (c.carried) return -1;
    const due = taskDue(c.task, plan, week.weekStart, ctx);
    if (due.milestone) {
      const inPlan = msInPlan(plan, due.milestone, st) || due.dueDay != null;
      return (inPlan ? 0 : 2e9) + dayNumber(effectiveDue(plan, due.milestone, ctx));
    }
    return doneInPlan(plan, st) ? 1e9 : 4e9;
  };
  return plan.tasks
    .filter(isOpen)
    .map((t) => candidate(t, week, ctx))
    .filter((c) => toPlace(c) || (withPicked && (c.picked || c.placed)))
    .map((c) => ({ c, k: key(c) }))
    .sort((a, b) => a.k - b.k)
    .map(({ c }) => c);
}

/** The week's open one offs, those due this week first. withPicked also keeps picked or placed ones whose time is all placed. */
export function oneOffCandidates(tasks: readonly Task[], week: WeekInput, ctx: PlanContext, withPicked = false): Candidate[] {
  const due = (c: Candidate) => (taskDue(c.task, null, week.weekStart, ctx).dueDay != null ? 0 : 1);
  return tasks
    .filter((t) => t.kind === 'one_off' && isOpen(t) && !t.deleted_at)
    .map((t) => candidate(t, week, ctx))
    .filter((c) => toPlace(c) || (withPicked && (c.picked || c.placed)))
    .sort((a, b) => due(a) - due(b));
}

const inWeek = (dates: { from: LocalDate; to: LocalDate | null }, weekStart: LocalDate) =>
  dates.from <= addDays(weekStart, 6) && (dates.to ?? dates.from) >= weekStart;

/** One offs that start picked: nothing else is picked until you add it. One with no estimate is picked like one added by hand. */
export function autoPickedOneOffs(tasks: readonly Task[], weekStart: LocalDate): Task[] {
  return tasks.filter((t) => {
    const dates = t.schedule?.type === 'once' ? oneOffDates(t) : null;
    return t.kind === 'one_off' && isOpen(t) && !t.deleted_at && (minutesLeft(t) > 0 || unestimated(t)) && !!dates && inWeek(dates, weekStart);
  });
}

/** Repeating ones count while their next date isn't past the week. A dated or undated one counts only when its dates fall in it. */
function oneOffDueThisWeek(c: Candidate, weekStart: LocalDate): boolean {
  if (c.carried) return true;
  const dates = oneOffDates(c.task);
  if (c.task.schedule?.type === 'once') return !!dates && inWeek(dates, weekStart);
  return !dates || dates.from <= addDays(weekStart, 6);
}

export type Suggestions = Record<string, { minutes: Minutes; why: string }>;

/**
 * Marks work overdue or due soon, then what reaches each aim from the plan's own milestones, soonest project first.
 * Nothing joins the plan on its own: this only says what to offer, and how much of it.
 */
export function suggestions(plans: readonly ProjectPlan[], oneOffs: readonly Task[], week: WeekInput, ctx: PlanContext): Suggestions {
  const out: Suggestions = {};
  const st = planStretch(ctx.settings, today(ctx.clock), ctx.planning);
  let free = week.freeMin ?? 0;
  const give = (c: Candidate, amount: Minutes, why: string) => {
    const had = out[c.task.id]?.minutes ?? 0;
    const take = Math.min(amount, c.left - had, free);
    if (take <= 0) return 0;
    out[c.task.id] = { minutes: had + take, why: out[c.task.id]?.why ?? why };
    free -= take;
    return take;
  };
  const dueWhy = (due: TaskDue) => {
    if (due.dated) return `Suggested: ${due.label}`;
    if (due.dueDay! < 0) return 'Suggested: milestone overdue';
    return `Suggested: ${due.label.slice(due.milestone!.title.length + 2)}`;
  };
  const fill = (rows: Candidate[], plan: ProjectPlan | null, planned: Minutes, aim: Minutes) => {
    let total = planned;
    const offerable = rows.filter((c) => !c.picked && !c.stale);
    for (const c of offerable) {
      const due = taskDue(c.task, plan, week.weekStart, ctx);
      if (due.dueDay != null) total += give(c, c.left, dueWhy(due));
    }
    for (const c of offerable.filter((x) => isPlanned(x.task, plan, st))) {
      if (total < aim) total += give(c, Math.ceil((aim - total) / 30) * 30, 'Suggested: reaches aim');
    }
  };
  // As the aim meters count it: each pick in full, and blocks only for work not picked, so nothing counts twice.
  const plannedFor = (tasks: readonly Task[]) => {
    const ids = new Set(tasks.map((t) => t.id));
    const picks = livePicks(week).filter((p) => ids.has(p.task_id));
    const picked = new Set(picks.map((p) => p.task_id));
    const placed = liveBlocks(week).filter((b) => b.task_id && ids.has(b.task_id) && !picked.has(b.task_id));
    return picks.reduce((sum, p) => sum + p.minutes, 0) + placed.reduce((sum, b) => sum + blockMinutes(b), 0);
  };
  for (const plan of plannable(plans, ctx)) {
    const aim = week.aims?.[plan.project.id] ?? plan.project.weekly_aim ?? 0;
    fill(projectCandidates(plan, week, ctx), plan, plannedFor(plan.tasks), aim);
  }
  const rows = oneOffCandidates(oneOffs, week, ctx).filter((c) => oneOffDueThisWeek(c, week.weekStart));
  fill(rows, null, plannedFor(oneOffs), week.aims?.[ONE_OFFS_BUCKET] ?? week.oneOffAim ?? 0);
  return out;
}

/** A task counts as planned if its milestone is in the plan, or Done is for one with no milestone. One offs don't need it. */
function isPlanned(t: Task, plan: ProjectPlan | null, st: Stretch): boolean {
  if (!plan) return true;
  const m = t.milestone_id ? plan.milestones.find((x) => x.id === t.milestone_id) : null;
  return m ? msInPlan(plan, m, st) : doneInPlan(plan, st);
}

/** Everything picked, due work first, then project order with one offs last, then carried work and milestone date. */
export function scheduleOrder(plans: readonly ProjectPlan[], oneOffs: readonly Task[], week: WeekInput, ctx: PlanContext): Candidate[] {
  const ranked = plannable(plans, ctx);
  const projectRows = ranked.flatMap((plan, rank) =>
    projectCandidates(plan, week, ctx, true)
      .filter((c) => c.picked)
      .map((c) => {
        const due = taskDue(c.task, plan, week.weekStart, ctx);
        const date = c.carried ? -1 : due.milestone ? dayNumber(effectiveDue(plan, due.milestone, ctx)) : 9e9;
        return { c, k: [due.dueDay != null ? 0 : 1, rank, date] as const };
      }),
  );
  const oneOffRows = oneOffCandidates(oneOffs, week, ctx, true)
    .filter((c) => c.picked)
    .map((c) => ({ c, k: [taskDue(c.task, null, week.weekStart, ctx).dueDay != null ? 0 : 1, ranked.length, c.carried ? -1 : 9e9] as const }));
  return [...projectRows, ...oneOffRows]
    .sort((a, b) => a.k[0] - b.k[0] || a.k[1] - b.k[1] || a.k[2] - b.k[2])
    .map(({ c }) => c);
}

/** One record's new field values. */
export interface RecordWrite {
  type: 'objective' | 'project' | 'milestone' | 'task' | 'time_block' | 'week_pick' | 'week_plan' | 'task_completion' | 'block_outcome' | 'practice';
  id: string;
  fields: Record<string, unknown>;
}

/** What a replanning action changes, as a list of writes applied in order. Write it in one transaction. */
export interface PlanChange {
  writes: RecordWrite[];
}

/** Writes a change, and returns its exact reverse from the values replaced, for an Undo held on screen. */
export async function applyPlanChange(w: Writer, change: PlanChange): Promise<PlanChange> {
  const reverse: RecordWrite[] = [];
  for (const { type, id, fields } of change.writes) {
    reverse.unshift({ type, id, fields: await w.set(type, id, fields as Fields<typeof type>) });
  }
  return { writes: reverse };
}

/** The plan as it would be after a change, for previews. Changes to anything else are ignored. */
export function withChange(plan: ProjectPlan, change: PlanChange): ProjectPlan {
  const patch = <T extends BaseRecord>(type: RecordWrite['type'], rec: T) =>
    change.writes.filter((w) => w.type === type && w.id === rec.id).reduce((r, w) => ({ ...r, ...w.fields }), rec);
  return {
    project: patch('project', plan.project),
    milestones: plan.milestones.map((m) => patch('milestone', m)).filter((m) => !m.deleted_at),
    tasks: plan.tasks.map((t) => patch('task', t)).filter((t) => !t.deleted_at),
  };
}

interface Edit {
  type: RecordWrite['type'];
  record: BaseRecord;
  fields: Record<string, unknown>;
}

type NewEntry = Omit<SlipEntry, 'at' | 'undo' | 'text'> & { text: string };

const slipLog = ({ project }: ProjectPlan) => project.slip_log ?? [];

/** Only this change's fields are reversed by its Undo, so tasks ticked since then stay ticked. */
function logged(plan: ProjectPlan, ctx: PlanContext, edits: readonly Edit[], entry: NewEntry | null): PlanChange {
  const writes: RecordWrite[] = edits.map(({ type, record, fields }) => ({ type, id: record.id, fields }));
  if (!entry) return { writes };
  const undo: RecordWrite[] = edits.map(({ type, record, fields }) => ({
    type,
    id: record.id,
    fields: Object.fromEntries(Object.keys(fields).map((k) => [k, (record as unknown as Record<string, unknown>)[k] ?? null])),
  }));
  const line = { at: nowInstant(ctx.clock), ...entry, text: `${formatDate(today(ctx.clock))}: ${entry.text}`, undo };
  writes.push({ type: 'project', id: plan.project.id, fields: { slip_log: [...slipLog(plan), line] } });
  return { writes };
}

function milestoneIn(plan: ProjectPlan, id: string): Milestone {
  const m = plan.milestones.find((x) => x.id === id);
  if (!m) throw new Error(`No milestone ${id} in project ${plan.project.id}`);
  return m;
}

const moves = (plan: ProjectPlan, m: Milestone) => slipLog(plan).filter((e) => e.kind === 'move' && e.milestone_id === m.id);

/** The date slip is measured from: before the first logged move, or else its date now. A same-day correction isn't logged. */
export function originalDue(plan: ProjectPlan, m: Milestone, ctx: PlanContext): LocalDate {
  return moves(plan, m)[0]?.from ?? effectiveDue(plan, m, ctx);
}

/** Days of slip a move to this date adds, on top of what's already been counted for this milestone. */
function slipTo(plan: ProjectPlan, m: Milestone, day: LocalDate, ctx: PlanContext): number {
  if (m.added_on === today(ctx.clock)) return 0;
  const original = originalDue(plan, m, ctx);
  const counted = m.due
    ? Math.max(0, diffDays(original, m.due))
    : slipLog(plan).filter((e) => e.milestone_id === m.id).reduce((sum, e) => sum + (e.days ?? 0), 0);
  return Math.max(0, diffDays(original, day)) - counted;
}

/** Moves a milestone to a date, which takes it out of any plan it named. Done is always last, so a later date pushes it. */
export function moveMilestone(plan: ProjectPlan, id: string, day: LocalDate, ctx: PlanContext): PlanChange {
  const { project } = plan;
  const m = milestoneIn(plan, id);
  const end_days = Math.max(0, diffDays(project.end, day));
  const projectFields = { ...(end_days ? { end: day } : {}), ...(day < project.start ? { start: day } : {}) };
  const edits: Edit[] = [{ type: 'milestone', record: m, fields: { due: day, stretch: null } }];
  if (Object.keys(projectFields).length) edits.push({ type: 'project', record: project, fields: projectFields });
  // A date corrected on the day it was added is free, unless it pushed the project's end.
  if (m.added_on === today(ctx.clock) && !end_days) return logged(plan, ctx, edits, null);
  const from = effectiveDue(plan, m, ctx);
  return logged(plan, ctx, edits, {
    kind: 'move',
    milestone_id: id,
    from,
    to: day,
    days: slipTo(plan, m, day, ctx),
    ...(end_days ? { end_days } : {}),
    text: `Moved ${m.title} from ${formatDate(from)} to ${formatDate(day)}.`,
  });
}

/** Puts a milestone in a plan with no date, meaning by the stretch's end. An overdue one moved up has really slipped; a future date being cleared hasn't. */
export function parkMilestone(plan: ProjectPlan, id: string, st: Stretch, ctx: PlanContext): PlanChange {
  const { project } = plan;
  const m = milestoneIn(plan, id);
  const end = project.end < st.start ? st.end : project.end;
  const by = earlier(end, st.end);
  const late = !!m.due && m.due < today(ctx.clock);
  const edits: Edit[] = [{ type: 'milestone', record: m, fields: { due: null, stretch: st.start } }];
  if (end !== project.end) edits.push({ type: 'project', record: project, fields: { end } });
  return logged(plan, ctx, edits, {
    kind: 'move',
    milestone_id: id,
    from: effectiveDue(plan, m, ctx),
    to: null,
    days: late ? slipTo(plan, m, by, ctx) : 0,
    ...(end !== project.end ? { end_days: diffDays(project.end, end) } : {}),
    text: `Added ${m.title} to this plan, by ${formatDate(by)}.`,
  });
}

/** The later date a milestone was parked from, if parking it is the last thing that moved it. */
function parkedFrom(plan: ProjectPlan, m: Milestone, st: Stretch): LocalDate | null {
  const last = moves(plan, m).at(-1);
  if (m.due || !last || last.to !== null) return null;
  const undo = Array.isArray(last.undo) ? (last.undo as RecordWrite[]) : [];
  const was = undo.find((w) => w.type === 'milestone' && w.id === m.id)?.fields.due as LocalDate | null | undefined;
  return was && was > st.end ? was : null;
}

/** Out of the plan. A date inside the stretch is cleared; one parked from a later date goes back to it. */
export function unplanMilestone(plan: ProjectPlan, id: string, st: Stretch, ctx: PlanContext): PlanChange {
  const m = milestoneIn(plan, id);
  const was = parkedFrom(plan, m, st);
  if (was) return moveMilestone(plan, id, was, ctx);
  const outside = !!m.due && (m.due < st.start || m.due > st.end);
  const from = effectiveDue(plan, m, ctx);
  return logged(plan, ctx, [{ type: 'milestone', record: m, fields: outside ? { stretch: null } : { due: null, stretch: null } }], {
    kind: 'move',
    milestone_id: id,
    from,
    to: outside ? m.due : null,
    days: 0,
    text: `Took ${m.title} out of this plan${m.due && !outside ? ' and cleared its date' : ''}.`,
  });
}

const isLogWrite = (w: RecordWrite) => 'slip_log' in w.fields;
const lastEntry = (change: PlanChange) => (change.writes.find(isLogWrite)?.fields.slip_log as SlipEntry[]).at(-1)!;

/** Adds a milestone to the plan or takes it out. Bringing one in resumes a paused project and pulls a later start into the stretch, undone as one change. */
export function toggleInPlan(plan: ProjectPlan, id: string, st: Stretch, ctx: PlanContext): PlanChange {
  if (msInPlan(plan, milestoneIn(plan, id), st)) return unplanMilestone(plan, id, st, ctx);
  const resumed = plan.project.state === 'paused' ? resumeProject(plan, ctx) : null;
  let ready = resumed ? withChange(plan, resumed) : plan;
  const before = ready.project;
  const pull: Edit[] = before.start > st.end ? [{ type: 'project', record: before, fields: { start: st.start } }] : [];
  if (pull.length) ready = { ...ready, project: { ...before, start: st.start } };
  const m = milestoneIn(ready, id);
  const inner = msInPlan(ready, m, st)
    ? logged(ready, ctx, [], {
        kind: 'move',
        milestone_id: id,
        from: m.due,
        to: m.due,
        days: 0,
        text: `Added ${m.title} to this plan, ${formatDate(effectiveDue(ready, m, ctx))}.`,
      })
    : parkMilestone(ready, id, st, ctx);
  if (!resumed && !pull.length) return inner;
  const entry = lastEntry(inner);
  const earlierEntry = resumed ? lastEntry(resumed) : null;
  const pulled = logged(ready, ctx, pull, null).writes;
  const merged = {
    ...entry,
    days: (entry.days ?? 0) + (earlierEntry?.days ?? 0),
    text: `${entry.text}${resumed ? ' Project resumed.' : ''}`,
    // Applied in order, so the oldest values are written last and win.
    undo: [
      ...(entry.undo as RecordWrite[]),
      ...pull.map(({ type, record }) => ({ type, id: record.id, fields: { start: before.start } })),
      ...((earlierEntry?.undo as RecordWrite[]) ?? []),
    ],
  };
  return {
    writes: [
      ...(resumed?.writes.filter((w) => !isLogWrite(w)) ?? []),
      ...pulled,
      ...inner.writes.filter((w) => !isLogWrite(w)),
      { type: 'project', id: plan.project.id, fields: { slip_log: [...slipLog(plan), merged] } },
    ],
  };
}

const plural = (n: number) => `${n} ${n === 1 ? 'task' : 'tasks'}`;

/** What's scheduled and picked for tasks that have closed, so a closed task can't keep its time or fire a reminder. */
export interface ScheduledWork {
  blocks?: readonly TimeBlock[];
  picks?: readonly WeekPick[];
}

function clearScheduled(tasks: readonly Task[], work: ScheduledWork, ctx: PlanContext): Edit[] {
  const ids = new Set(tasks.map((t) => t.id));
  const now = ctx.clock.now();
  return [
    ...(work.blocks ?? [])
      .filter((b) => b.task_id && ids.has(b.task_id) && !b.cancelled && !b.deleted_at && !b.started_at && instantMs(b.start) > now)
      .map((record): Edit => ({ type: 'time_block', record, fields: { cancelled: true } })),
    ...(work.picks ?? [])
      .filter((p) => ids.has(p.task_id) && !p.deleted_at && p.week_start >= thisWeek(ctx.clock))
      .map((record): Edit => ({ type: 'week_pick', record, fields: { deleted_at: nowInstant(ctx.clock) } })),
  ];
}

const openUnder = (plan: ProjectPlan, m: Milestone) => plan.tasks.filter((t) => t.milestone_id === m.id && isOpen(t));

/** Where a dropped milestone's open tasks go: the next open milestone. */
export function dropTarget(plan: ProjectPlan, m: Milestone, ctx: PlanContext): Milestone | undefined {
  const floor = later(today(ctx.clock), effectiveDue(plan, m, ctx));
  return openMilestones(plan)
    .filter((x) => x.id !== m.id && effectiveDue(plan, x, ctx) >= floor)
    .sort((a, b) => (effectiveDue(plan, a, ctx) < effectiveDue(plan, b, ctx) ? -1 : 1))[0];
}

/** Drops a milestone. Done tasks stay on record, and open ones move to the next open milestone or are cancelled. */
export function dropMilestone(plan: ProjectPlan, id: string, options: { cancelOpen: boolean } & ScheduledWork, ctx: PlanContext): PlanChange {
  const m = milestoneIn(plan, id);
  const open = openUnder(plan, m);
  const target = dropTarget(plan, m, ctx);
  const now = nowInstant(ctx.clock);
  const doneAny = plan.tasks.some((t) => t.milestone_id === id && t.done_at);
  // Added today with nothing done, it's a mistake rather than a change of plan, so it leaves no record.
  if (m.added_on === today(ctx.clock) && !doneAny) {
    const edits: Edit[] = [{ type: 'milestone', record: m, fields: { deleted_at: now } }];
    for (const record of open) edits.push({ type: 'task', record, fields: options.cancelOpen ? { cancelled_at: now } : { milestone_id: target?.id ?? null } });
    if (options.cancelOpen) edits.push(...clearScheduled(open, options, ctx));
    return logged(plan, ctx, edits, null);
  }
  const edits: Edit[] = [{ type: 'milestone', record: m, fields: { dropped_at: now } }];
  for (const record of open) {
    edits.push({
      type: 'task',
      record,
      fields: options.cancelOpen ? { cancelled_at: now } : { milestone_id: target?.id ?? null, moved_from: id },
    });
  }
  if (options.cancelOpen) edits.push(...clearScheduled(open, options, ctx));
  const what = !open.length
    ? ''
    : options.cancelOpen
      ? ` Cancelled ${plural(open.length)}.`
      : ` Moved ${plural(open.length)} to ${target?.title ?? 'Done'}.`;
  return logged(plan, ctx, edits, { kind: 'drop', milestone_id: id, text: `Dropped ${m.title}.${what}` });
}

/** Meets a milestone and ticks its open tasks. */
export function markMilestoneDone(plan: ProjectPlan, id: string, work: ScheduledWork, ctx: PlanContext): PlanChange {
  const m = milestoneIn(plan, id);
  const open = openUnder(plan, m);
  const now = nowInstant(ctx.clock);
  const edits: Edit[] = [
    { type: 'milestone', record: m, fields: { met_at: now } },
    ...open.map((record): Edit => ({ type: 'task', record, fields: { done_at: now } })),
    ...clearScheduled(open, work, ctx),
  ];
  const ticked = open.length ? `, and ticked ${plural(open.length)}` : '';
  return logged(plan, ctx, edits, { kind: 'met', milestone_id: id, text: `Marked ${m.title} done${ticked}.` });
}

export function markMilestoneNotMet(plan: ProjectPlan, id: string, ctx: PlanContext): PlanChange {
  const m = milestoneIn(plan, id);
  return logged(plan, ctx, [{ type: 'milestone', record: m, fields: { met_at: null } }], {
    kind: 'met',
    milestone_id: id,
    text: `Marked ${m.title} not met.`,
  });
}

/** Done stays last, so its date can't go before a dated milestone or the start. Null when the date is fine. */
export function doneDateError({ project, milestones }: ProjectPlan, end: LocalDate): string | null {
  const floor = milestones.filter((m) => m.due && !m.dropped_at).reduce((max, m) => later(max, m.due!), project.start);
  return end < floor ? `Done stays last. Pick ${formatDate(floor)} or later.` : null;
}

/**
 * Changes the project's end, which is its implicit Done. Undated milestones follow it. Only a later date is slip. A
 * new start saved with it is checked with it and undone with it.
 */
export function moveDone(plan: ProjectPlan, end: LocalDate, ctx: PlanContext, start?: LocalDate): PlanChange {
  const { project } = plan;
  const error = doneDateError(start ? { ...plan, project: { ...project, start } } : plan, end);
  if (error) throw new Error(error);
  return logged(plan, ctx, [{ type: 'project', record: project, fields: start ? { start, end } : { end } }], {
    kind: 'end',
    from: project.end,
    to: end,
    days: Math.max(0, diffDays(project.end, end)),
    text: `Done moved to ${formatDate(end)}.`,
  });
}

export function pauseProject(plan: ProjectPlan, ctx: PlanContext): PlanChange {
  return logged(plan, ctx, [{ type: 'project', record: plan.project, fields: { state: 'paused' } }], { kind: 'pause', text: 'Paused.' });
}

/** Resuming moves open dates by the days it was paused, and that counts as slip. */
export function resumeProject(plan: ProjectPlan, ctx: PlanContext): PlanChange {
  const { project } = plan;
  const paused = slipLog(plan).filter((e) => e.kind === 'pause').at(-1);
  const days = paused ? Math.max(0, diffDays(localDate(paused.at, ctx.clock.zone()), today(ctx.clock))) : 0;
  const edits: Edit[] = [{ type: 'project', record: project, fields: { state: 'active', ...(days ? { end: addDays(project.end, days) } : {}) } }];
  if (days) {
    for (const record of plan.milestones) {
      if (record.due && !record.met_at && !record.dropped_at) edits.push({ type: 'milestone', record, fields: { due: addDays(record.due, days) } });
    }
  }
  return logged(plan, ctx, edits, {
    kind: 'resume',
    days,
    text: days ? `Resumed. Open dates moved by the ${days} days it was paused.` : 'Resumed.',
  });
}

/** Reverses the newest change and takes it off the log. Null when there's nothing to undo. */
export function undoLastChange(plan: ProjectPlan): PlanChange | null {
  const log = slipLog(plan);
  const last = log.at(-1);
  if (!last) return null;
  return {
    writes: [
      ...(Array.isArray(last.undo) ? (last.undo as RecordWrite[]) : []),
      { type: 'project', id: plan.project.id, fields: { slip_log: log.slice(0, -1) } },
    ],
  };
}

/** Brings back a finished or dropped project as it was, reopening the tasks closing it cancelled. Their freed time stays free. */
export function restoreProject(plan: ProjectPlan): PlanChange {
  if (slipLog(plan).at(-1)?.kind === 'close') return undoLastChange(plan)!;
  return { writes: [{ type: 'project', id: plan.project.id, fields: { state: 'active' } }] };
}

/** Real days later and milestones dropped, or null when nothing has been replanned. */
export function replannedBadge(plan: ProjectPlan): string | null {
  const days = slipLog(plan).reduce((sum, e) => sum + (e.days ?? 0) + (e.end_days ?? 0), 0);
  const drops = plan.milestones.filter((m) => m.dropped_at).length;
  const parts = [
    ...(days > 0 ? [`${days} ${days === 1 ? 'day' : 'days'} later`] : []),
    ...(drops ? [`${drops} ${drops === 1 ? 'milestone' : 'milestones'} dropped`] : []),
  ];
  return parts.length ? `Replanned: ${parts.join(', ')}` : null;
}

/** What a new date would run into. These are notes, and never block the move. */
export function milestoneWarnings(plan: ProjectPlan, id: string, day: LocalDate, ctx: PlanContext): string[] {
  const { project } = plan;
  const self = milestoneIn(plan, id);
  const selfDue = effectiveDue(plan, self, ctx);
  const passed = openMilestones(plan)
    .filter((m) => m.id !== id && effectiveDue(plan, m, ctx) < day)
    .sort((a, b) => (effectiveDue(plan, a, ctx) < effectiveDue(plan, b, ctx) ? 1 : -1))[0];
  return [
    ...(passed && effectiveDue(plan, passed, ctx) >= selfDue ? [`This puts it after ${passed.title}.`] : []),
    ...(day > project.end ? [`That moves the project's end to ${formatDate(day)}.`] : []),
    ...(day < project.start ? [`That's before the project starts, ${formatDate(project.start)}.`] : []),
  ];
}

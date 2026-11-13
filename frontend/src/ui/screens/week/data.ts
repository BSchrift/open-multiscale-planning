// Everything Week reads for one week, and the figures both layouts draw from it. The rules live in core.

import { loadAnalyticsData } from '../../../core/analytics';
import { openTime, plannedByKind, pushbackLately, weekAlerts, weeklyAims } from '../../../core/capacity';
import type { Clock } from '../../../core/clock';
import { addDays, addWeeks, formatMinutes, instantMs, thisWeek, today, weekRange } from '../../../core/dates';
import type { Sql } from '../../../core/db';
import { FIRST_BLOCK_MIN, gatherPlans, minutesLeft, NO_ESTIMATE_MIN, oneOffCandidates, pickToPlace, plannable, projectCandidates, scheduleOrder, taskDue, taskWork } from '../../../core/plan';
import type { Candidate, PlanContext, ProjectPlan, WeekInput } from '../../../core/plan';
import { loadWeekPlanning, PLANNING_LEAD_DAYS, weekEstimate, weekGate, weekRow } from '../../../core/planning';
import type { WeekPlanning } from '../../../core/planning';
import { blocksInRange, inboxCount, needsNewTime } from '../../../core/queries';
import { blockConflicts, busyEvents, queueItems } from '../../../core/queue';
import { CALENDAR_ID, getRecord, getSettings, listRecords } from '../../../core/records';
import { onceOverlaps } from '../../../core/schedule';
import { infoSpans, offers, practicesLeft, practiceSlots, slotContext, spansAhead } from '../../../core/slots';
import type { Slot, SlotContext, Span, Work } from '../../../core/slots';
import { ONE_OFFS_BUCKET } from '../../../core/types';
import type { LocalDate, Minutes, Practice, Task, TimeBlock } from '../../../core/types';
import { placedBlocks } from '../../components/weekgrid';
import type { PlacedBlock } from '../../components/weekgrid';
import type { BlockKind } from '../../components/blocks/describe';

// shortcut: reads every task, project and block on each change, as planning does; add narrower queries if Week slows.
export async function loadWeek(sql: Sql, clock: Clock, week: LocalDate) {
  const range = weekRange(week, clock.zone());
  const [blocks, settings, calendar, sources, weekPlans, picks, queue, records, planning, nextPlanning, inbox] = await Promise.all([
    blocksInRange(sql, range),
    getSettings(sql),
    getRecord(sql, 'calendar', CALENDAR_ID),
    listRecords(sql, 'calendar_source'),
    listRecords(sql, 'week_plan'),
    listRecords(sql, 'week_pick'),
    needsNewTime(sql),
    loadAnalyticsData(sql),
    loadWeekPlanning(sql, week),
    loadWeekPlanning(sql, addWeeks(week, 1)),
    inboxCount(sql),
  ]);
  return { week, blocks, settings, calendar: calendar ?? null, sources, weekPlans, picks, queue, records, planning, nextPlanning, inbox };
}

export type WeekData = Awaited<ReturnType<typeof loadWeek>>;

/** A task that can be added to the week, with what slots.ts needs to suggest times for it. */
export interface AddRow {
  task: Task;
  /** Minutes still to place; a task with no estimate gets half an hour. */
  left: Minutes;
  work: Work;
  context: string;
  /** This week's blocks for it not yet over, soonest first. */
  placed: PlacedBlock[];
}

interface AddGroup {
  name: string;
  oneOffs: boolean;
  rows: AddRow[];
}

/** Work waiting for a time this week: picked tasks, one offs dated in it, and practices short of their target. */
export interface LaneItem {
  /** The task's or practice's. */
  id: string;
  title: string;
  kind: BlockKind;
  work: Work;
  /** Minutes still to place. */
  left: Minutes;
  /** A new block's length: up to 2h of a task, or one session of a practice. */
  length: Minutes;
  /** '2h of 3h left', '2 × 30m' */
  line: string;
  /** A one off's dates: it waits above those days. */
  dates?: { from: LocalDate; to: LocalDate };
  task?: Task;
  practice?: Practice;
  /** Picked for this week, so it can be taken out again. */
  picked: boolean;
  /** Up to three suggested times, best first. */
  offers: Slot[];
}

/** What can be put on the calendar: a task, or a practice's session. */
export type Placeable = Pick<LaneItem, 'id' | 'title' | 'kind' | 'work' | 'task' | 'practice'>;

export const rowItem = (r: AddRow): Placeable => ({ id: r.task.id, title: r.task.title, kind: r.work.kind === 'one_off' ? 'one_off' : 'project', work: r.work, task: r.task });

/** The due and open dates slots.ts ranks by, from a task's milestone or its own dates. */
function workOf(t: Task, plan: ProjectPlan | null, week: LocalDate, ctx: PlanContext): { work: Work; label: string } {
  const due = taskDue(t, plan, week, ctx);
  return { work: taskWork(t, due, week), label: due.label };
}

export function weekModel(d: WeekData, clock: Clock) {
  const { week, settings, records, calendar, sources } = d;
  const now = clock.now();
  const current = thisWeek(clock);
  const ctx: SlotContext = slotContext({
    week,
    availability: settings.availability,
    avoided: settings.avoided_slots,
    sources,
    calendar,
    blocks: d.blocks,
    clock,
  });
  const info: Span[] = infoSpans({ week, calendar, sources, clock });

  const upcoming = d.blocks.filter((b) => !b.result && instantMs(b.end) > now);
  const conflicts = new Map(blockConflicts(upcoming, busyEvents(calendar ?? undefined, sources)).map((c) => [c.block.id, c.event.title]));
  const blocks: PlacedBlock[] = placedBlocks(ctx.placed, d.blocks, now).map((b) => {
    const clash = conflicts.get(b.id);
    return clash ? { ...b, note: `Conflicts with ${clash}`, clash: true } : b;
  });

  // What's planned is the whole week's, as past days show what happened. Free is only what's still ahead, as Review does.
  const open = openTime(ctx);
  const planned = plannedByKind(ctx.placed);
  const free = Math.max(0, open - plannedByKind(spansAhead(ctx.placed, ctx)).total);

  // Tasks to add, in the same order as the drawer: work needing a new time, One offs, then projects soonest first.
  const planCtx: PlanContext = { settings, clock, away: records.away };
  const plans = gatherPlans(records.projects, records.milestones, records.tasks);
  const ranked = plannable(plans, planCtx);
  const queue = queueItems(d.queue, d.weekPlans, d.picks, clock);
  const carried = new Set(queue.filter((q) => !q.stale).map((q) => q.id));
  const input: WeekInput = {
    weekStart: week,
    picks: d.picks,
    blocks: d.blocks.map((b): TimeBlock => ({ ...b, tz: b.tz ?? clock.zone() })),
    carried,
  };
  const oneOffs = records.tasks.filter((t) => t.kind === 'one_off');
  const addRow = (c: Candidate, plan: ProjectPlan | null): AddRow => {
    const { work, label } = workOf(c.task, plan, week, planCtx);
    const where = plan ? plan.project.title : 'One off';
    return {
      task: c.task,
      left: c.left || NO_ESTIMATE_MIN,
      work,
      context: label ? `${where}, ${label}` : where,
      placed: blocks.filter((b) => b.task_id === c.task.id && !b.ended),
    };
  };
  const groups: AddGroup[] = [
    { name: 'One offs', oneOffs: true, rows: oneOffCandidates(oneOffs, input, planCtx).map((c) => addRow(c, null)) },
    ...ranked.map((plan) => ({ name: plan.project.title, oneOffs: false, rows: projectCandidates(plan, input, planCtx).map((c) => addRow(c, plan)) })),
  ];
  const fresh = groups.flatMap((g) => g.rows).filter((r) => carried.has(r.task.id));
  const addGroups = [
    { name: 'Needs a new time', oneOffs: false, rows: fresh },
    ...groups.map((g) => ({ ...g, rows: g.rows.filter((r) => !carried.has(r.task.id)) })),
  ].filter((g) => g.rows.length > 0);

  // To schedule: picks less what's placed, one offs dated in the week with nothing placed, and practices short of
  // their target. Dated ones wait above their days, the rest above the whole week.
  const weekPlan = d.weekPlans.find((p) => p.week_start === week) ?? null;
  const datesOf = (t: Task) => {
    const s = t.schedule;
    return t.kind === 'one_off' && s?.type === 'once' && s.from && onceOverlaps(t, week, addDays(week, 6)) ? { from: s.from, to: s.to ?? s.from } : undefined;
  };
  const taskItem = (t: Task, left: Minutes, picked: Minutes | null): LaneItem => {
    const plan = ranked.find((p) => p.project.id === t.project_id) ?? null;
    const { work } = workOf(t, plan, week, planCtx);
    const length = Math.min(left, FIRST_BLOCK_MIN);
    return {
      id: t.id,
      title: t.title,
      kind: t.kind === 'one_off' ? 'one_off' : 'project',
      work,
      left,
      length,
      line: picked && left < picked ? `${formatMinutes(left)} of ${formatMinutes(picked)} left` : formatMinutes(left),
      ...(datesOf(t) ? { dates: datesOf(t)! } : {}),
      task: t,
      picked: picked !== null,
      offers: offers(length, work, ctx).slice(0, 3),
    };
  };
  const picks = scheduleOrder(plans, oneOffs, input, planCtx);
  const unscheduled: LaneItem[] = [
    ...picks.flatMap((c) => {
      const { picked, left } = pickToPlace(c, blocks);
      return left > 0 ? [taskItem(c.task, left, picked)] : [];
    }),
    ...oneOffs
      .filter((t) => !t.cancelled_at && datesOf(t) && !picks.some((c) => c.task.id === t.id) && !blocks.some((b) => b.task_id === t.id))
      .map((t) => taskItem(t, minutesLeft(t) || NO_ESTIMATE_MIN, null)),
    ...practicesLeft(records.practices, ctx, weekPlan?.skipped_practices ?? [], weekPlan?.skipped_sessions ?? []).map(
      (x): LaneItem => ({
        id: x.practice.id,
        title: x.practice.title,
        kind: 'practice',
        work: { kind: 'project' },
        left: x.minutes,
        length: x.length,
        line: x.sessions > 1 ? `${x.sessions} × ${formatMinutes(x.length)}` : formatMinutes(x.minutes),
        practice: x.practice,
        picked: false,
        offers: practiceSlots(x.practice, ctx, weekPlan?.skipped_sessions ?? []).slice(0, 3),
      }),
    ),
  ].sort((a, b) => (a.dates?.from ?? '~').localeCompare(b.dates?.from ?? '~'));

  // An unscheduled planning task heads To schedule in the week it's due in: next week's, dated to the days before that
  // week starts; this week's, once it has begun unplanned, from today. Clicked, it opens the times; dragged, it's placed.
  const on = today(clock);
  const estimate = weekEstimate(d.inbox, d.weekPlans).minutes;
  const planningItem = (p: WeekPlanning, dates: { from: LocalDate; to: LocalDate }): LaneItem => ({
    id: p.task!.id,
    title: p.task!.title,
    kind: 'planning',
    work: { kind: 'project' },
    left: estimate,
    length: estimate,
    line: formatMinutes(estimate),
    dates,
    task: p.task!,
    picked: false,
    offers: [],
  });
  const planning: LaneItem[] = [
    ...(week === current && d.planning.task && !d.planning.task.deleted_at && weekGate(d.planning, clock) === 'gate'
      ? [planningItem(d.planning, { from: on, to: addDays(week, 6) })]
      : []),
    ...(week === current && weekRow(d.nextPlanning, clock)
      ? [planningItem(d.nextPlanning, { from: on > addDays(d.nextPlanning.week, -PLANNING_LEAD_DAYS) ? on : addDays(d.nextPlanning.week, -PLANNING_LEAD_DAYS), to: addDays(d.nextPlanning.week, -1) })]
      : []),
  ];

  const got: Record<string, Minutes> = {};
  const bucketOf = new Map(records.tasks.map((t) => [t.id, t.project_id ?? ONE_OFFS_BUCKET]));
  for (const b of blocks) {
    const bucket = b.task_id ? bucketOf.get(b.task_id) : undefined;
    if (bucket) got[bucket] = (got[bucket] ?? 0) + b.end - b.start;
  }
  const aims = weeklyAims({ projects: ranked.map((p) => p.project), oneOffsAim: settings.one_offs_weekly_aim, weekPlan, got });
  const pushback = pushbackLately(d.weekPlans, records, clock);

  return {
    ctx,
    info,
    blocks,
    open,
    planned,
    free,
    alerts: week >= current ? weekAlerts(ctx, aims, pushback) : [],
    addGroups,
    unscheduled: [...planning, ...unscheduled],
    current,
    thisPlanned: d.weekPlans.some((p) => p.week_start === current && !!p.finished_at),
  };
}

export type WeekModel = ReturnType<typeof weekModel>;

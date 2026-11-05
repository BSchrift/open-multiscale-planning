// Everything Week reads for one week, and the figures both layouts draw from it. The rules live in core.

import { loadAnalyticsData } from '../../../core/analytics';
import { openTime, plannedByKind, pushbackLately, weekAlerts, weeklyAims } from '../../../core/capacity';
import type { Clock } from '../../../core/clock';
import { addDays, instantMs, thisWeek, weekRange } from '../../../core/dates';
import type { Sql } from '../../../core/db';
import { gatherPlans, oneOffCandidates, plannable, projectCandidates, taskDue, taskWork } from '../../../core/plan';
import type { Candidate, PlanContext, ProjectPlan, WeekInput } from '../../../core/plan';
import { blocksInRange, needsNewTime } from '../../../core/queries';
import { blockConflicts, busyEvents, queueItems } from '../../../core/queue';
import { CALENDAR_ID, getRecord, getSettings, listRecords } from '../../../core/records';
import { onceOverlaps } from '../../../core/schedule';
import { infoSpans, slotContext, spansAhead } from '../../../core/slots';
import type { SlotContext, Span, Work } from '../../../core/slots';
import { ONE_OFFS_BUCKET } from '../../../core/types';
import type { LocalDate, Minutes, Task, TimeBlock } from '../../../core/types';
import { dayName, placedBlocks, slotRange } from '../../components/weekgrid';
import type { PlacedBlock } from '../../components/weekgrid';

// shortcut: reads every task, project and block on each change, as planning does; add narrower queries if Week slows.
export async function loadWeek(sql: Sql, clock: Clock, week: LocalDate) {
  const range = weekRange(week, clock.zone());
  const [blocks, settings, calendar, sources, weekPlans, picks, queue, records] = await Promise.all([
    blocksInRange(sql, range),
    getSettings(sql),
    getRecord(sql, 'calendar', CALENDAR_ID),
    listRecords(sql, 'calendar_source'),
    listRecords(sql, 'week_plan'),
    listRecords(sql, 'week_pick'),
    needsNewTime(sql),
    loadAnalyticsData(sql),
  ]);
  return { week, blocks, settings, calendar: calendar ?? null, sources, weekPlans, picks, queue, records };
}

export type WeekData = Awaited<ReturnType<typeof loadWeek>>;

export { dayName };
export { slotRange as range };

export { KIND_WORD } from '../../components/blocks/describe';

export type WeekBlock = PlacedBlock;

/** A task that can be added to the week, with what slots.ts needs to suggest times for it. */
export interface AddRow {
  task: Task;
  /** Minutes still to place; a task with no estimate gets half an hour. */
  left: Minutes;
  work: Work;
  context: string;
  /** This week's blocks for it not yet over, soonest first. */
  placed: WeekBlock[];
}

export interface AddGroup {
  name: string;
  oneOffs: boolean;
  rows: AddRow[];
}

const NO_ESTIMATE_MIN = 30;

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
  const rows = new Map(d.blocks.map((b) => [b.id, b]));
  const blocks: WeekBlock[] = placedBlocks(ctx.placed, d.blocks, now).map((b) => {
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

  // One offs dated in the week with no time yet, which wait above the days they span.
  const lane = oneOffs
    .filter((t) => !t.cancelled_at && onceOverlaps(t, week, addDays(week, 6)) && !blocks.some((b) => b.task_id === t.id))
    .sort((a, b) => ((a.schedule as { from: string }).from < (b.schedule as { from: string }).from ? -1 : 1));

  const weekPlan = d.weekPlans.find((p) => p.week_start === week) ?? null;
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
    lane,
    practices: new Map(records.practices.map((p) => [p.id, p])),
    rows,
    current,
    thisPlanned: d.weekPlans.some((p) => p.week_start === current && !!p.finished_at),
  };
}

export type WeekModel = ReturnType<typeof weekModel>;

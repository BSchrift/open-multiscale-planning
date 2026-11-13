// What every planning step reads for one week, and the figures they share. The rules live in core; this only
// gathers records and hands them over.

import { loadAnalyticsData } from '../../../core/analytics';
import type { AnalyticsData } from '../../../core/analytics';
import { openTime, pushbackLately, weeklyAims, weekUse } from '../../../core/capacity';
import type { Clock } from '../../../core/clock';
import { blockMinutes, nowInstant, weekRange } from '../../../core/dates';
import type { Sql } from '../../../core/db';
import { gatherPlans, plannable, suggestions } from '../../../core/plan';
import type { PlanContext, WeekInput } from '../../../core/plan';
import { blocksInRange, needsNewTime, placedMinutes } from '../../../core/queries';
import type { BlockRow, QueueRow } from '../../../core/queries';
import { queueItems } from '../../../core/queue';
import { CALENDAR_ID, getRecord, getSettings, listRecords, weekPlanId } from '../../../core/records';
import { practicesLeft, slotContext } from '../../../core/slots';
import { ONE_OFFS_BUCKET } from '../../../core/types';
import type { CalendarSource, CalendarState, LocalDate, Minutes, Practice, Settings, TimeBlock, WeekPick, WeekPlan } from '../../../core/types';

export interface PlanningData {
  week: LocalDate;
  settings: Settings;
  records: AnalyticsData;
  /** Every pick and week plan, which the queue needs to tell fresh work from work passed over. */
  picks: WeekPick[];
  weekPlans: WeekPlan[];
  /** This week's blocks. */
  blocks: BlockRow[];
  queue: QueueRow[];
  calendar: CalendarState | null;
  sources: CalendarSource[];
  /** Time placed this week that wasn't picked and is still to come: practices and repeating work. */
  placed: Minutes;
}

// shortcut: reads every record on each change, which is fine for one person's data; add narrower queries if it slows.
export async function loadPlanning(sql: Sql, clock: Clock, week: LocalDate): Promise<PlanningData> {
  const range = weekRange(week, clock.zone());
  const [settings, records, picks, weekPlans, blocks, queue, calendar, sources, placed] = await Promise.all([
    getSettings(sql),
    loadAnalyticsData(sql),
    listRecords(sql, 'week_pick'),
    listRecords(sql, 'week_plan'),
    blocksInRange(sql, range),
    needsNewTime(sql),
    getRecord(sql, 'calendar', CALENDAR_ID),
    listRecords(sql, 'calendar_source'),
    placedMinutes(sql, { ...range, week_start: week, now: nowInstant(clock) }),
  ]);
  return { week, settings, records, picks, weekPlans, blocks, queue, calendar: calendar ?? null, sources, placed };
}

/** What the week's open time and its use are worked out from: a little of what loadPlanning reads. */
export interface FitData {
  week: LocalDate;
  settings: Settings;
  /** This week's picks. */
  picks: WeekPick[];
  weekPlan: WeekPlan | null;
  practices: Practice[];
  blocks: BlockRow[];
  calendar: CalendarState | null;
  sources: CalendarSource[];
  placed: Minutes;
}

/** Only what the fit needs, so Does it fit can show on every step without reading the whole history again. */
export async function loadFit(sql: Sql, clock: Clock, week: LocalDate): Promise<FitData> {
  const range = weekRange(week, clock.zone());
  const [settings, picks, weekPlan, practices, blocks, calendar, sources, placed] = await Promise.all([
    getSettings(sql),
    listRecords(sql, 'week_pick'),
    getRecord(sql, 'week_plan', weekPlanId(week)),
    listRecords(sql, 'practice'),
    blocksInRange(sql, range),
    getRecord(sql, 'calendar', CALENDAR_ID),
    listRecords(sql, 'calendar_source'),
    placedMinutes(sql, { ...range, week_start: week, now: nowInstant(clock) }),
  ]);
  return {
    week,
    settings,
    picks: picks.filter((p) => p.week_start === week),
    weekPlan: weekPlan && !weekPlan.deleted_at ? weekPlan : null,
    practices,
    blocks,
    calendar: calendar ?? null,
    sources,
    placed,
  };
}

/** The week's open time, and how much of it practices, repeating work and picks use. */
export function weekFit(d: FitData, clock: Clock) {
  const slot = slotContext({
    week: d.week,
    availability: d.settings.availability,
    avoided: d.settings.avoided_slots,
    sources: d.sources,
    calendar: d.calendar,
    blocks: d.blocks,
    clock,
  });
  const open = openTime(slot);
  // shortcut: picks count in full in a week under way, work already done on them too; take off their past blocks if replanning mid-week reads too full.
  const picked = d.picks.reduce((sum, p) => sum + p.minutes, 0);
  // Practices still to place take their time too, so Pick tasks counts them before Schedule.
  const practices = practicesLeft(d.practices, slot, d.weekPlan?.skipped_practices ?? []).reduce((sum, p) => sum + p.minutes, 0);
  const repeating = d.placed + practices;
  return { slot, open, repeating, use: weekUse({ open, placed: repeating, picked }) };
}

/** The figures Pick tasks and Review share. */
export function weekModel(d: PlanningData, clock: Clock) {
  const { week, settings, records } = d;
  const ctx: PlanContext = { settings, clock, away: records.away };
  const plans = gatherPlans(records.projects, records.milestones, records.tasks);
  const ranked = plannable(plans, ctx);
  const weekPlan = d.weekPlans.find((p) => p.week_start === week) ?? null;
  const queue = queueItems(d.queue, d.weekPlans, d.picks, clock);
  const picks = d.picks.filter((p) => p.week_start === week);
  const blocks: TimeBlock[] = d.blocks.map((b) => ({ ...b, tz: b.tz ?? clock.zone() }));
  const { slot, open, repeating, use } = weekFit({ ...d, picks, weekPlan, practices: records.practices }, clock);
  const input: WeekInput = {
    weekStart: week,
    picks,
    blocks,
    carried: new Set(queue.filter((q) => !q.stale).map((q) => q.id)),
    stale: new Set(queue.filter((q) => q.stale).map((q) => q.id)),
    aims: weekPlan?.aims ?? {},
    oneOffAim: settings.one_offs_weekly_aim ?? null,
    freeMin: use.free,
  };
  const oneOffs = records.tasks.filter((t) => t.kind === 'one_off');
  const hints = suggestions(plans, oneOffs, input, ctx);

  const bucketOf = new Map(records.tasks.map((t) => [t.id, t.project_id ?? ONE_OFFS_BUCKET]));
  const add = (into: Record<string, Minutes>, taskId: string | null | undefined, minutes: Minutes) => {
    const bucket = taskId ? bucketOf.get(taskId) : undefined;
    if (bucket) into[bucket] = (into[bucket] ?? 0) + minutes;
  };
  // Pick tasks counts picks and time already placed for anything not picked; Review counts what's placed.
  const pickedIds = new Set(picks.map((p) => p.task_id));
  const planned: Record<string, Minutes> = {};
  const placedBy: Record<string, Minutes> = {};
  for (const p of picks) add(planned, p.task_id, p.minutes);
  for (const b of d.blocks) {
    if (!pickedIds.has(b.task_id ?? '')) add(planned, b.task_id, blockMinutes(b));
    add(placedBy, b.task_id, blockMinutes(b));
  }
  const aimRows = (got: Record<string, Minutes>) =>
    weeklyAims({ projects: ranked.map((p) => p.project), oneOffsAim: settings.one_offs_weekly_aim, weekPlan, got });

  const pushback = pushbackLately(d.weekPlans, records, clock);

  return { ctx, plans, ranked, weekPlan, queue, picks, slot, open, repeating, use, input, oneOffs, hints, pushback, planned, placedBy, aimRows };
}

export type WeekModel = ReturnType<typeof weekModel>;

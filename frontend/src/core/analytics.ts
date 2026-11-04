// Reliability and patterns, computed from records and never stored. The week and stretch views share one shape;
// the stretch view adds patterns, milestones met and estimate drift. Everything returned is numbers for the UI to
// format, except pattern text, which is built here because its wording depends on the counts.

import type { Clock } from './clock';
import { addWeeks, instantMs, localDate, localMinutes, thisWeek, today, weekday, weekStart } from './dates';
import type { Sql } from './db';
import { msTasks } from './plan';
import { isAway } from './queue';
import { getSettings, listRecords, outcomeId } from './records';
import { ONE_OFFS_BUCKET } from './types';
import type {
  AvoidedSlot,
  AwayPeriod,
  BlockOutcome,
  BlockResult,
  Fields,
  Instant,
  LocalDate,
  Milestone,
  Minutes,
  Objective,
  Practice,
  Project,
  SlipEntry,
  Task,
  TimeBlock,
  TimeOfDay,
  Weekday,
} from './types';

const TREND_WEEKS = 8;
const ON_TIME_MS = 10 * 60_000;
const BAR_MAX_PX = 44;
const BAR_MIN_PX = 2;
const NO_GOAL = 'no_goal';
const ALL_TIME = 'all';

const PATTERN_LAST = 10;
const PATTERN_MIN = 5;
const RARELY_HOLDS = 1 / 3;
const HOLDS_BEST = 4 / 5;
const OVER_ESTIMATE_PCT = 25;

const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;
const PARTS_OF_DAY = [
  { name: 'morning', from: 0, to: 720 },
  { name: 'afternoon', from: 720, to: 1020 },
  { name: 'evening', from: 1020, to: 1440 },
] as const;

export interface AnalyticsData {
  objectives: Objective[];
  projects: Project[];
  milestones: Milestone[];
  tasks: Task[];
  blocks: TimeBlock[];
  outcomes: BlockOutcome[];
  practices: Practice[];
  away: AwayPeriod[];
  avoided_slots: AvoidedSlot[];
}

export async function loadAnalyticsData(sql: Sql): Promise<AnalyticsData> {
  const [objectives, projects, milestones, tasks, blocks, outcomes, practices, away, settings] = await Promise.all([
    listRecords(sql, 'objective'),
    listRecords(sql, 'project'),
    listRecords(sql, 'milestone'),
    listRecords(sql, 'task'),
    listRecords(sql, 'time_block'),
    listRecords(sql, 'block_outcome'),
    listRecords(sql, 'practice'),
    listRecords(sql, 'away_period'),
    getSettings(sql),
  ]);
  return { objectives, projects, milestones, tasks, blocks, outcomes, practices, away, avoided_slots: settings.avoided_slots };
}

export interface ReliabilityCount {
  done: number;
  partly: number;
  not: number;
  total: number;
  /** Done and Partly as a share of the blocks answered. */
  pct: number;
}

export interface TimeRow {
  /** An objective id, NO_GOAL or ONE_OFFS_BUCKET. */
  id: string;
  name: string;
  delivered_min: Minutes;
  planned_min: Minutes;
  pct: number;
}

export interface PracticeRow {
  id: string;
  name: string;
  spent_min: Minutes;
  target_min: Minutes;
  pct: number;
}

export interface TrendBar {
  week: LocalDate;
  min: Minutes;
  /** Height in pixels, on a scale shared by every row. Zero draws nothing. */
  h: number;
  /** Whether this week counts in the view. */
  on: boolean;
}

export interface TrendRow {
  id: string;
  name: string;
  /** Time in the view's weeks. */
  shown_min: Minutes;
  /** Against the prior week, in a week view whose prior week has any blocks. */
  change_min: Minutes | null;
  bars: TrendBar[];
}

export interface WeekAnalytics {
  /** The weeks counted, by their Mondays. */
  weeks: LocalDate[];
  /** Whether those weeks include this one, so its figures are "so far". */
  current: boolean;
  time: { rows: TimeRow[]; delivered_min: Minutes; planned_min: Minutes };
  practices: PracticeRow[];
  reliability: { project: ReliabilityCount; one_offs: ReliabilityCount };
  /** Task blocks that ended with no answer, which reliability leaves out. */
  unanswered: number;
  /** Percent of blocks started within 10 minutes, or null with none to count. */
  started_on_time: number | null;
  trend: { weeks: LocalDate[]; rows: TrendRow[] };
}

export type Pattern =
  /** Write toggleAvoidedSlot's result to settings.avoided_slots. */
  | { kind: 'avoid' | 'avoided'; text: string; label: string; slot: AvoidedSlot }
  /** Write raisedEstimates's result to the tasks. */
  | { kind: 'estimate'; text: string; label: string; project_id: string; over_pct: number }
  | { kind: 'best'; text: string };

export interface StretchAnalytics extends WeekAnalytics {
  patterns: Pattern[];
  /** Of those due so far, how many were met by their original date; early counts ones not due yet but already met. */
  milestones_met: { met: number; total: number; early: number };
  /** Percent actual time ran over estimates (negative is under), or null with nothing to compare. */
  estimate_drift: number | null;
}

/** What one block adds up to. Cancelled blocks and blocks whose task or practice is gone have none. */
interface Fact {
  block: TimeBlock;
  week: LocalDate;
  /** The time row it belongs to. */
  row: string;
  planned: Minutes;
  delivered: Minutes;
  result: BlockResult | null;
  /** On an away date, so it stays out of reliability, on-time and patterns. */
  away: boolean;
}

const minutesBetween = (from: Instant, to: Instant) => Math.round((instantMs(to) - instantMs(from)) / 60_000);
const cappedPct = (part: number, whole: number) => (whole > 0 ? Math.min(100, Math.round((part / whole) * 100)) : 0);

function deliveredMinutes(block: TimeBlock, outcome: BlockOutcome | undefined, planned: Minutes): Minutes {
  if (!outcome || outcome.result === 'not') return 0;
  if (outcome.logged_min != null) return outcome.logged_min;
  // shortcut: a Partly with no logged minutes counts the whole span, upgrade if the prompt stops logging them.
  const span = minutesBetween(block.started_at ?? block.start, block.ended_at ?? block.end);
  return span > 0 ? span : planned;
}

function blockFacts(data: AnalyticsData, zone: string): Fact[] {
  const tasks = new Map(data.tasks.map((t) => [t.id, t]));
  const projects = new Map(data.projects.map((p) => [p.id, p]));
  const practices = new Map(data.practices.map((p) => [p.id, p]));
  const goals = new Set(data.objectives.map((o) => o.id));
  const outcomes = new Map(data.outcomes.map((o) => [o.id, o]));
  const goalRow = (id: string | null | undefined) => (id && goals.has(id) ? id : NO_GOAL);

  const facts: Fact[] = [];
  for (const block of data.blocks) {
    if (block.cancelled) continue;
    const task = block.task_id ? tasks.get(block.task_id) : undefined;
    const practice = block.practice_id ? practices.get(block.practice_id) : undefined;
    if (!task && !practice) continue;
    const row = practice
      ? goalRow(practice.objective_id)
      : task!.project_id
        ? goalRow(projects.get(task!.project_id)?.objective_id)
        : ONE_OFFS_BUCKET;
    const outcome = outcomes.get(outcomeId(block.id));
    const date = localDate(block.start, block.tz || zone);
    const away = isAway(date, data.away);
    if (away && !outcome) continue;
    const planned = minutesBetween(block.start, block.end);
    facts.push({
      block,
      week: weekStart(localDate(block.start, zone)),
      row,
      planned,
      delivered: deliveredMinutes(block, outcome, planned),
      result: outcome?.result ?? null,
      away,
    });
  }
  return facts;
}

const sumDelivered = (facts: readonly Fact[]) => facts.reduce((sum, f) => sum + f.delivered, 0);

function reliability(facts: readonly Fact[]): ReliabilityCount {
  const count = (result: BlockResult) => facts.filter((f) => f.result === result).length;
  const [done, partly, not] = [count('done'), count('partly'), count('not')];
  const total = done + partly + not;
  return { done, partly, not, total, pct: cappedPct(done + partly, total) };
}

function startedOnTime(facts: readonly Fact[]): number | null {
  const counted = facts.filter((f) => !f.away && (f.result || f.block.started_at));
  if (!counted.length) return null;
  const onTime = counted.filter(
    (f) => f.block.started_at && instantMs(f.block.started_at) - instantMs(f.block.start) <= ON_TIME_MS,
  );
  return Math.round((onTime.length / counted.length) * 100);
}

function practiceRows(data: AnalyticsData, facts: readonly Fact[], scope: readonly LocalDate[]): PracticeRow[] {
  const rows: PracticeRow[] = [];
  for (const p of data.practices) {
    const own = facts.filter((f) => f.block.practice_id === p.id);
    const inScope = own.filter((f) => scope.includes(f.week));
    const spent = sumDelivered(inScope);
    if (p.state !== 'active' && !spent) continue;
    const weekly = p.per === 'day' ? p.target_min * (p.days?.length || 7) : p.target_min;
    // A practice has no start date, so its first session stands in: earlier weeks shouldn't count against it.
    const first = own.reduce<LocalDate | null>((min, f) => (!min || f.week < min ? f.week : min), null);
    const target = weekly * scope.filter((w) => !first || w >= first).length;
    rows.push({ id: p.id, name: p.title, spent_min: spent, target_min: target, pct: cappedPct(spent, target) });
  }
  return rows;
}

function timeRowNames(data: AnalyticsData, facts: readonly Fact[], visibleWeeks: ReadonlySet<LocalDate>): [string, string][] {
  const withTime = new Set(facts.filter((f) => visibleWeeks.has(f.week)).map((f) => f.row));
  const goals = data.objectives
    .filter((o) => o.state !== 'archived' || withTime.has(o.id))
    .sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity) || (a.id < b.id ? -1 : 1))
    .map((o): [string, string] => [o.id, o.title]);
  if (withTime.has(NO_GOAL)) goals.push([NO_GOAL, 'No goal']);
  goals.push([ONE_OFFS_BUCKET, 'One offs']);
  return goals;
}

function buildAnalytics(data: AnalyticsData, clock: Clock, scope: LocalDate[], isWeekView: boolean): WeekAnalytics {
  const nowMs = clock.now();
  const week = thisWeek(clock);
  const facts = blockFacts(data, clock.zone());
  const inScope = facts.filter((f) => scope.includes(f.week));
  const taskFacts = inScope.filter((f) => f.block.task_id && !f.away);
  const trendWeeks = Array.from({ length: TREND_WEEKS }, (_, i) => addWeeks(week, i - TREND_WEEKS + 1));
  const rowNames = timeRowNames(data, facts, new Set([...scope, ...trendWeeks]));

  const time = rowNames.map(([id, name]): TimeRow => {
    const own = inScope.filter((f) => f.row === id);
    const delivered = sumDelivered(own);
    const planned = own.reduce((sum, f) => sum + f.planned, 0);
    return { id, name, delivered_min: delivered, planned_min: planned, pct: cappedPct(delivered, planned) };
  });

  const delivered = new Map<string, Minutes>();
  for (const f of facts) {
    delivered.set(`${f.week}|${f.row}`, (delivered.get(`${f.week}|${f.row}`) ?? 0) + f.delivered);
    delivered.set(`${f.week}|${ALL_TIME}`, (delivered.get(`${f.week}|${ALL_TIME}`) ?? 0) + f.delivered);
  }
  const valueOf = (w: LocalDate, id: string) => delivered.get(`${w}|${id}`) ?? 0;
  const barMax = Math.max(0, ...trendWeeks.map((w) => valueOf(w, ALL_TIME)));
  const prior = scope[0] ? addWeeks(scope[0], -1) : null;
  const hasPrior = isWeekView && facts.some((f) => f.week === prior);
  const trendRows = [[ALL_TIME, 'All time'] as [string, string], ...rowNames].map(([id, name]): TrendRow => ({
    id,
    name,
    shown_min: scope.reduce((sum, w) => sum + valueOf(w, id), 0),
    change_min: hasPrior ? valueOf(scope[0]!, id) - valueOf(prior!, id) : null,
    bars: trendWeeks.map((w) => {
      const min = valueOf(w, id);
      return { week: w, min, h: min ? Math.max(BAR_MIN_PX, Math.round((min / barMax) * BAR_MAX_PX)) : 0, on: scope.includes(w) };
    }),
  }));

  return {
    weeks: scope,
    current: scope.includes(week),
    time: { rows: time, delivered_min: sumDelivered(inScope), planned_min: inScope.reduce((sum, f) => sum + f.planned, 0) },
    practices: practiceRows(data, facts, scope),
    reliability: {
      project: reliability(taskFacts.filter((f) => f.row !== ONE_OFFS_BUCKET)),
      one_offs: reliability(taskFacts.filter((f) => f.row === ONE_OFFS_BUCKET)),
    },
    unanswered: taskFacts.filter((f) => !f.result && instantMs(f.block.end) <= nowMs).length,
    started_on_time: startedOnTime(inScope),
    trend: { weeks: trendWeeks, rows: trendRows },
  };
}

/** Any week by its Monday. Only weeks in the trend's eight have a bar marked. */
export function weekAnalytics(data: AnalyticsData, clock: Clock, week: LocalDate): WeekAnalytics {
  return buildAnalytics(data, clock, [week], true);
}

const PACE_WEEKS = 4;

/** Minutes a week of project work done over the last four whole weeks, which a plan's hours are compared with. Null with none. */
export function recentPace(data: AnalyticsData, clock: Clock): Minutes | null {
  const now = thisWeek(clock);
  const from = addWeeks(now, -PACE_WEEKS);
  // shortcut: away weeks still count as weeks, so they lower the pace; leave them out if planning after time away reads low.
  const facts = blockFacts(data, clock.zone()).filter((f) => f.block.task_id && f.row !== ONE_OFFS_BUCKET && f.week >= from && f.week < now);
  return facts.some((f) => f.delivered > 0) ? Math.round(sumDelivered(facts) / PACE_WEEKS) : null;
}

/** The current stretch, or the last eight weeks with no stretch. Counts each week touching it, up to this week. */
export function stretchAnalytics(
  data: AnalyticsData,
  clock: Clock,
  stretch: { start: LocalDate; end: LocalDate } | null,
): StretchAnalytics {
  const now = thisWeek(clock);
  const first = stretch ? weekStart(stretch.start) : addWeeks(now, 1 - TREND_WEEKS);
  const last = stretch && weekStart(stretch.end) < now ? weekStart(stretch.end) : now;
  const scope: LocalDate[] = [];
  for (let w = first; w <= last; w = addWeeks(w, 1)) scope.push(w);

  const date = today(clock);
  const from = stretch?.start ?? first;
  const to = stretch && stretch.end < date ? stretch.end : date;
  return {
    ...buildAnalytics(data, clock, scope, false),
    patterns: patterns(data, clock),
    milestones_met: milestonesMet(data, clock.zone(), from, to, stretch),
    estimate_drift: estimateDrift(data, clock.zone(), from, to),
  };
}

/** A move's from is a real date unless the milestone had neither a date nor a plan, when it was only the project's end. */
function hadDate(e: SlipEntry, id: string): boolean {
  const before = (Array.isArray(e.undo) ? (e.undo as { type: string; id: string; fields: Record<string, unknown> }[]) : []).find(
    (w) => w.type === 'milestone' && w.id === id,
  )?.fields;
  return !before || before.due != null || before.stretch != null;
}

/**
 * A milestone's first date: its baseline's, or the date it was first moved from, or the date it has, or undated in
 * the stretch looked at, that stretch's end capped at the project's end.
 */
function originalDate(m: Milestone, project: Project, stretch: { start: LocalDate; end: LocalDate } | null): LocalDate | null {
  const byStretch = stretch && m.stretch === stretch.start ? (stretch.end < project.end ? stretch.end : project.end) : null;
  return (
    project.baseline?.milestones.find((b) => b.id === m.id)?.due ??
    project.slip_log?.find((e) => e.kind === 'move' && e.milestone_id === m.id && hadDate(e, m.id))?.from ??
    m.due ??
    byStretch
  );
}

function milestonesMet(data: AnalyticsData, zone: string, from: LocalDate, to: LocalDate, stretch: { start: LocalDate; end: LocalDate } | null) {
  const projects = new Map(data.projects.map((p) => [p.id, p]));
  let met = 0;
  let total = 0;
  let early = 0;
  for (const m of data.milestones) {
    const project = projects.get(m.project_id);
    const original = project && originalDate(m, project, stretch);
    if (!original || original < from) continue;
    const on = metOn(m, project, data.tasks, zone);
    if (original > to) {
      // Not due yet, but met in this time.
      if (on && on >= from && on <= to) early++;
      continue;
    }
    total++;
    if (on && on <= original) met++;
  }
  return { met, total, early };
}

/** When a milestone was met: marked met, or else reached when the last of its tasks was done. */
function metOn(m: Milestone, project: Project, tasks: readonly Task[], zone: string): LocalDate | null {
  if (m.met_at) return localDate(m.met_at, zone);
  const own = msTasks({ project, tasks }, m);
  if (m.dropped_at || !own.length || !own.every((t) => t.done_at)) return null;
  return localDate(own.reduce((last, t) => (instantMs(t.done_at!) > instantMs(last) ? t.done_at! : last), own[0]!.done_at!), zone);
}

function deliveredByTask(data: AnalyticsData, zone: string): Map<string, Minutes> {
  const byTask = new Map<string, Minutes>();
  for (const f of blockFacts(data, zone)) {
    const id = f.block.task_id;
    if (id) byTask.set(id, (byTask.get(id) ?? 0) + f.delivered);
  }
  return byTask;
}

function estimateDrift(data: AnalyticsData, zone: string, from: LocalDate, to: LocalDate): number | null {
  const actualByTask = deliveredByTask(data, zone);
  let estimate = 0;
  let actual = 0;
  for (const t of data.tasks) {
    const spent = actualByTask.get(t.id);
    if (!t.done_at || !t.estimate_min || !spent) continue;
    const done = localDate(t.done_at, zone);
    if (done < from || done > to) continue;
    estimate += t.estimate_min;
    actual += spent;
  }
  return estimate ? Math.round(((actual - estimate) / estimate) * 100) : null;
}

const partOfDay = (minutes: TimeOfDay) => PARTS_OF_DAY.find((p) => minutes >= p.from && minutes < p.to) ?? PARTS_OF_DAY[0];
const slotName = (slot: AvoidedSlot) => `${DAY_NAMES[slot.day]} ${partOfDay(slot.from).name}s`;
const sameSlot = (a: AvoidedSlot, b: AvoidedSlot) => a.day === b.day && a.from === b.from && a.to === b.to;

interface SlotHolds {
  slot: AvoidedSlot;
  done: number;
  blocks: number;
}

/** How the last few answered task blocks went, for each day and part of the day with enough of them. */
function slotHolds(data: AnalyticsData, zone: string): SlotHolds[] {
  const bySlot = new Map<string, { slot: AvoidedSlot; results: { at: Instant; result: BlockResult }[] }>();
  for (const f of blockFacts(data, zone)) {
    if (!f.block.task_id || f.away || !f.result) continue;
    const tz = f.block.tz || zone;
    const part = partOfDay(localMinutes(f.block.start, tz));
    const day: Weekday = weekday(localDate(f.block.start, tz));
    const key = `${day}|${part.from}`;
    const entry = bySlot.get(key) ?? { slot: { day, from: part.from, to: part.to }, results: [] };
    entry.results.push({ at: f.block.start, result: f.result });
    bySlot.set(key, entry);
  }
  const holds: SlotHolds[] = [];
  for (const { slot, results } of bySlot.values()) {
    if (results.length < PATTERN_MIN) continue;
    const last = results.sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, PATTERN_LAST);
    holds.push({ slot, done: last.filter((r) => r.result === 'done').length, blocks: last.length });
  }
  return holds.sort(
    (a, b) => a.done / a.blocks - b.done / b.blocks || b.blocks - a.blocks || a.slot.day - b.slot.day || a.slot.from - b.slot.from,
  );
}

const lastBlocksPhrase = (h: SlotHolds) =>
  `${h.done} of the last ${h.blocks} blocks ${h.done === 1 ? 'was' : 'were'} done.`;

function worstEstimate(data: AnalyticsData, zone: string): Extract<Pattern, { kind: 'estimate' }> | null {
  const actualByTask = deliveredByTask(data, zone);
  let worst: Extract<Pattern, { kind: 'estimate' }> | null = null;
  let worstOver = 0;
  for (const project of data.projects) {
    if (project.state !== 'active') continue;
    const finished = data.tasks
      // Work finished before the last raise was already answered, so only what's finished since can ask again.
      .filter((t) => t.project_id === project.id && t.done_at && t.done_at > (project.estimates_raised_at ?? '') && t.estimate_min && actualByTask.get(t.id))
      .sort((a, b) => (a.done_at! < b.done_at! ? 1 : -1))
      .slice(0, PATTERN_LAST);
    if (finished.length < PATTERN_MIN) continue;
    const estimate = finished.reduce((sum, t) => sum + t.estimate_min!, 0);
    const actual = finished.reduce((sum, t) => sum + actualByTask.get(t.id)!, 0);
    const over = ((actual - estimate) / estimate) * 100;
    if (over < OVER_ESTIMATE_PCT || over <= worstOver) continue;
    worstOver = over;
    const overPct = Math.round(over / 5) * 5;
    worst = {
      kind: 'estimate',
      text: `${project.title} tasks take about ${overPct}% longer than you estimate.`,
      label: 'Raise estimates',
      project_id: project.id,
      over_pct: overPct,
    };
  }
  return worst;
}

function patterns(data: AnalyticsData, clock: Clock): Pattern[] {
  const zone = clock.zone();
  const avoided = data.avoided_slots;
  const holds = slotHolds(data, zone).filter((h) => !avoided.some((a) => sameSlot(a, h.slot)));
  const worst = holds[0];
  const best = holds[holds.length - 1];
  const estimate = worstEstimate(data, zone);
  const out: Pattern[] = avoided.map((slot) => ({
    kind: 'avoided',
    text: `${slotName(slot)} are no longer suggested.`,
    label: 'Suggest them again',
    slot,
  }));
  if (worst && worst.done / worst.blocks <= RARELY_HOLDS) {
    out.push({
      kind: 'avoid',
      text: `${slotName(worst.slot)} rarely hold: ${lastBlocksPhrase(worst)}`,
      label: 'Stop suggesting them',
      slot: worst.slot,
    });
  }
  if (estimate) out.push(estimate);
  if (best && best.done / best.blocks >= HOLDS_BEST) {
    out.push({ kind: 'best', text: `${slotName(best.slot)} hold best: ${lastBlocksPhrase(best)}` });
  }
  return out;
}

/** The list for settings.avoided_slots after pressing a pattern's button. */
export function toggleAvoidedSlot(slots: readonly AvoidedSlot[], slot: AvoidedSlot): AvoidedSlot[] {
  return slots.some((s) => sameSlot(s, slot)) ? slots.filter((s) => !sameSlot(s, slot)) : [...slots, slot];
}

const raised = (minutes: Minutes, overPct: number) => Math.ceil((minutes * (100 + overPct)) / 100 / 15) * 15;

/** New estimates for a project's open tasks, to write in one transact with the project's estimates_raised_at. */
export function raisedEstimates(tasks: readonly Task[], projectId: string, overPct: number): (Fields<'task'> & { id: string })[] {
  return tasks
    .filter((t) => t.project_id === projectId && t.estimate_min && !t.done_at && !t.cancelled_at)
    .map((t) => ({
      id: t.id,
      estimate_min: raised(t.estimate_min!, overPct),
      ...(t.remaining_min != null ? { remaining_min: raised(t.remaining_min, overPct) } : {}),
    }));
}

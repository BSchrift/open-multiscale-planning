// Planning as a task. From three days before a week starts, the app saves a task for planning it, "Plan the week of
// Nov 16", with no time placed: the one record the app makes without a tap. Only a tap gives it a time, Delete or Skip
// for now takes it away on every device, and only finishing the plan finishes it. Its id is fixed per week, so two
// devices making or scheduling it make one task, and a deleted one is never made again for its week.
//
// Today and Week work out what to show from the task, its blocks and the week's plan, on each device: nothing about
// the row is stored.

import type { Clock } from './clock';
import { addDays, addWeeks, blockMinutes, formatDate, instantMs, nowInstant, thisWeek, toInstant, today, weekStart } from './dates';
import type { Sql } from './db';
import { markDoneNow, placeBlock, startBlock } from './blocks';
import { applyPlanChange } from './plan';
import type { PlanChange, RecordWrite } from './plan';
import { blocksInRange, inboxCount, taskBlocks } from './queries';
import { getRecord, weekPlanId } from './records';
import type { Writer } from './records';
import { offers, slotContext } from './slots';
import type { Offer, PlacedBlock, Slot } from './slots';
import { closeTask } from './tasks';
import type { CalendarSource, CalendarState, Fields, Instant, LocalDate, Minutes, Settings, Task, TimeBlock, WeekPlan } from './types';

/** Next week's task is made, and its row shows, from this many days before the week starts. */
export const PLANNING_LEAD_DAYS = 3;
/** The least time a block from now gets. With less free, Start opens planning with no block. */
export const SHORTEST_PLANNING_MIN = 15;
const FIRST_GUESS_MIN = 30;
const FULL_INBOX_GUESS_MIN = 45;
/** More Inbox items than this make the first guess longer. */
const FULL_INBOX = 15;
const MINUTE_MS = 60_000;

export const weekPlanningId = (week: LocalDate) => `planning:week:${week}`;

/** Absolute dates, because the block is read out of context: on Week, in older apps and in the Google mirror. */
export const weekPlanningTitle = (week: LocalDate) => `Plan the week of ${formatDate(week)}`;

/** The week a planning task id is for, or null for any other task. */
export function planningWeekOf(taskId: string | null | undefined): LocalDate | null {
  return taskId?.startsWith('planning:week:') ? taskId.slice('planning:week:'.length) : null;
}

/** The week whose planning task is due on a day: next week, from three days before it starts. */
export function planningWeekDue(on: LocalDate): LocalDate | null {
  const next = addWeeks(weekStart(on), 1);
  return on >= addDays(next, -PLANNING_LEAD_DAYS) ? next : null;
}

export interface Estimate {
  minutes: Minutes;
  /** No history yet, so the sheet says it's a first guess. */
  guess: boolean;
}

/** How long planning a week takes: until there's history, 30 minutes, or 45 with a full Inbox. */
export function weekEstimate(inbox: number): Estimate {
  return { minutes: inbox > FULL_INBOX ? FULL_INBOX_GUESS_MIN : FIRST_GUESS_MIN, guess: true };
}

const taskFields = (week: LocalDate, minutes: Minutes): Fields<'task'> => ({
  kind: 'planning',
  title: weekPlanningTitle(week),
  plans: [`week:${week}`],
  estimate_min: minutes,
});

/**
 * Makes the planning task that's due and has no record yet, deleted or not, unless its week is already planned. Run
 * whenever a device works out Today. Written as automatic, so on a device that hasn't pulled yet it has the lowest
 * clock: two devices make one task, and anyone's write, a delete included, wins over it. It places no time.
 */
export async function makeDuePlanningTasks(w: Writer, clock: Clock): Promise<void> {
  const week = planningWeekDue(today(clock));
  if (!week) return;
  if ((await getRecord(w.sql, 'week_plan', weekPlanId(week)))?.finished_at) return;
  if (await getRecord(w.sql, 'task', weekPlanningId(week))) return;
  await w.automatic.create('task', taskFields(week, weekEstimate(await inboxCount(w.sql)).minutes), weekPlanningId(week));
}

/** A week's planning as it stands: its plan, its task (deleted or not) and the task's blocks still on the calendar. */
export interface WeekPlanning {
  week: LocalDate;
  plan: WeekPlan | null;
  task: Task | null;
  blocks: TimeBlock[];
}

export async function loadWeekPlanning(sql: Sql, week: LocalDate): Promise<WeekPlanning> {
  const id = weekPlanningId(week);
  return {
    week,
    plan: (await getRecord(sql, 'week_plan', weekPlanId(week))) ?? null,
    task: (await getRecord(sql, 'task', id)) ?? null,
    blocks: await taskBlocks(sql, { task_id: id }),
  };
}

const isOpen = (task: Task | null): task is Task => !!task && !task.deleted_at && !task.done_at && !task.cancelled_at;
export const isPlanned = (p: WeekPlanning) => !!p.plan?.finished_at;

/** The planning block under way or still to come, soonest first. Ended or stopped ones don't count. */
export function blockAhead(p: WeekPlanning, clock: Clock): TimeBlock | undefined {
  if (!isOpen(p.task)) return undefined;
  return p.blocks.find((b) => !b.ended_at && instantMs(b.end) > clock.now());
}

/** Next week's row: from three days before, while its task waits for a time and the week isn't planned. */
export function weekRow(p: WeekPlanning, clock: Clock): boolean {
  const on = today(clock);
  return on < p.week && on >= addDays(p.week, -PLANNING_LEAD_DAYS) && !isPlanned(p) && isOpen(p.task) && !blockAhead(p, clock);
}

/**
 * What this week asks, once it has started unplanned: the gate, or 'set' while its planning block is still to come.
 * Nothing while the block is under way, which the Now card shows, or once the week is planned or skipped.
 */
export function weekGate(p: WeekPlanning, clock: Clock): 'gate' | 'set' | null {
  if (isPlanned(p) || p.plan?.planning_skipped_at) return null;
  const ahead = blockAhead(p, clock);
  if (!ahead) return 'gate';
  return instantMs(ahead.start) > clock.now() ? 'set' : null;
}

export interface TimesInput {
  settings: Pick<Settings, 'availability' | 'avoided_slots'>;
  calendar: CalendarState | null;
  sources: CalendarSource[];
  /** Blocks on this week and the next, so offers go around them. */
  blocks: PlacedBlock[];
  clock: Clock;
}

const slotOf = (o: Offer): Slot => ({ date: o.date, start: o.start, end: o.end });

/**
 * Times to plan a week in, best first, at most three. Ahead of the week, they're before it starts, from offers(); Monday
 * morning only when nothing earlier is free. Once the week has begun, the next free times from today, one a day.
 */
export function planningTimes(week: LocalDate, minutes: Minutes, input: TimesInput): Slot[] {
  const { settings, calendar, sources, blocks, clock } = input;
  // shortcut: an hour closed to projects by one block and to one offs by another reads as open; split blocks are rare.
  const availability = settings.availability.filter((b) => b.projects && b.one_offs);
  const ctx = (wk: LocalDate) => slotContext({ week: wk, availability, avoided: settings.avoided_slots, sources, calendar, blocks, clock });
  const current = thisWeek(clock);
  if (week > current) {
    const before = offers(minutes, { kind: 'project' }, ctx(current)).filter((o) => o.date < week);
    if (before.length > 0) return before.slice(0, 3).map(slotOf);
    // Due the day before, so Monday's offer starts at its first open hour rather than the evening.
    return offers(minutes, { kind: 'project', due: addDays(week, -1) }, ctx(week))
      .filter((o) => o.date === week)
      .slice(0, 1)
      .map(slotOf);
  }
  return offers(minutes, { kind: 'project' }, ctx(week))
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 3)
    .map(slotOf);
}

/** A block from this minute for the estimate, ending sooner if another block starts first, or null under 15 minutes. */
export function nowSlot(minutes: Minutes, blocks: readonly { start: Instant }[], clock: Clock): { start: Instant; end: Instant } | null {
  const now = clock.now();
  const start = Math.floor(now / MINUTE_MS) * MINUTE_MS;
  const next = Math.min(...blocks.map((b) => instantMs(b.start)).filter((ms) => ms > now));
  const end = Math.min(start + minutes * MINUTE_MS, next);
  return end - start >= SHORTEST_PLANNING_MIN * MINUTE_MS ? { start: toInstant(start), end: toInstant(end) } : null;
}

/** Makes the task, or brings it back, for an explicit action. Returns the writes that put it back as it was. */
async function ensureTask(w: Writer, week: LocalDate, fields: Fields<'task'>): Promise<RecordWrite[]> {
  const id = weekPlanningId(week);
  const task = await getRecord(w.sql, 'task', id);
  if (!task) {
    await w.create('task', { ...taskFields(week, fields.estimate_min ?? FIRST_GUESS_MIN), ...fields }, id);
    return [];
  }
  const back = { ...(task.deleted_at ? { deleted_at: null } : {}), ...(task.done_at ? { done_at: null } : {}), ...fields };
  return [{ type: 'task', id, fields: await w.set('task', id, back) }];
}

/**
 * Start: a started planning block from this minute, for the estimate unless given a length, made with the task if it
 * isn't there. A planning block already under way is never doubled; it's started if it wasn't. A week already planned
 * gets nothing: Start only opens planning. Returns the block's end, or null when no block was placed, and the reverse,
 * which takes the block away and leaves the task.
 */
export async function startPlanning(
  w: Writer,
  week: LocalDate,
  length: Minutes | undefined,
  clock: Clock,
): Promise<{ reverse: PlanChange; until: Instant | null }> {
  const none = { reverse: { writes: [] }, until: null };
  if ((await getRecord(w.sql, 'week_plan', weekPlanId(week)))?.finished_at) return none;
  const minutes = length ?? weekEstimate(await inboxCount(w.sql)).minutes;
  const id = weekPlanningId(week);
  await ensureTask(w, week, {});
  const now = clock.now();
  const running = (await taskBlocks(w.sql, { task_id: id })).find((b) => !b.ended_at && instantMs(b.start) <= now && instantMs(b.end) > now);
  if (running) {
    if (!running.started_at) await startBlock(w, running.id, clock);
    return none;
  }
  const ahead = await blocksInRange(w.sql, { from_utc: nowInstant(clock), to_utc: toInstant(now + minutes * MINUTE_MS) });
  const slot = nowSlot(minutes, ahead, clock);
  if (!slot) return none;
  const block = await w.create('time_block', { task_id: id, ...slot, tz: clock.zone(), started_at: nowInstant(clock) });
  return { reverse: { writes: [{ type: 'time_block', id: block, fields: { deleted_at: nowInstant(clock) } }] }, until: slot.end };
}

/** Schedule: places the planning block, bringing the task back if it was deleted. Undo takes the block and keeps the task. */
export async function schedulePlanning(w: Writer, week: LocalDate, times: { start: Instant; end: Instant }, clock: Clock): Promise<PlanChange> {
  const restored = await ensureTask(w, week, { estimate_min: blockMinutes(times) });
  const placed = await placeBlock(w, weekPlanningId(week), times, clock);
  const estimate = restored.map((r) => ({ ...r, fields: 'estimate_min' in r.fields ? { estimate_min: r.fields.estimate_min } : {} }));
  return { writes: [...placed.writes, ...estimate.filter((r) => Object.keys(r.fields).length > 0)] };
}

/** Delete: the task goes on every device with its blocks not yet started. Undo puts both back. */
export async function deletePlanning(w: Writer, week: LocalDate, clock: Clock): Promise<PlanChange> {
  const task = await getRecord(w.sql, 'task', weekPlanningId(week));
  if (!isOpen(task ?? null)) return { writes: [] };
  return closeTask(w, task!.id, 'deleted', clock);
}

/** Sets a field on a week's plan, making the plan if needed. Returns the reverse. */
async function setWeekPlan(w: Writer, week: LocalDate, fields: Fields<'week_plan'>): Promise<RecordWrite> {
  const id = weekPlanId(week);
  if (await getRecord(w.sql, 'week_plan', id)) return { type: 'week_plan', id, fields: await w.set('week_plan', id, fields) };
  await w.create('week_plan', { week_start: week, ...fields }, id);
  return { type: 'week_plan', id, fields: Object.fromEntries(Object.keys(fields).map((k) => [k, null])) };
}

/** Skip for now, once the week has started: the week is skipped on every device and its task deleted. Undo brings back both. */
export async function skipWeek(w: Writer, week: LocalDate, clock: Clock): Promise<PlanChange> {
  const skipped = await setWeekPlan(w, week, { planning_skipped_at: nowInstant(clock) });
  const deleted = await deletePlanning(w, week, clock);
  return { writes: [...deleted.writes, skipped] };
}

/**
 * Finish plan: the week is planned and its planning task done. A planning block under way ends at this minute, as Mark
 * done now does, and any still to come is freed. Returns the reverse, which reopens all of it, and the start of the
 * block freed, for the toast.
 */
export async function finishWeek(w: Writer, week: LocalDate, clock: Clock): Promise<{ reverse: PlanChange; freed: Instant | null }> {
  const planned = await setWeekPlan(w, week, { finished_at: nowInstant(clock) });
  const task = await getRecord(w.sql, 'task', weekPlanningId(week));
  if (!isOpen(task ?? null)) return { reverse: { writes: [planned] }, freed: null };
  const now = clock.now();
  const live = (await taskBlocks(w.sql, { task_id: task!.id })).filter((b) => !b.ended_at && instantMs(b.end) > now);
  const running = live.find((b) => instantMs(b.start) <= now);
  const freed = live.find((b) => instantMs(b.start) > now && !b.started_at)?.start ?? null;
  const closed = running ? await markDoneNow(w, running.id, clock) : await closeTask(w, task!.id, 'done', clock);
  return { reverse: { writes: [...closed.writes, planned] }, freed };
}

/**
 * Save and exit: planning blocks under way end at this minute, so the rest of their time is free; one stopped in its
 * first minute held no time, and goes. Two, when two devices each started it before syncing. The task stays open.
 */
export async function stopPlanning(w: Writer, week: LocalDate, clock: Clock): Promise<void> {
  const now = clock.now();
  const minute = Math.floor(now / MINUTE_MS) * MINUTE_MS;
  const running = (await taskBlocks(w.sql, { task_id: weekPlanningId(week) })).filter(
    (b) => !b.ended_at && instantMs(b.start) <= now && instantMs(b.end) > now,
  );
  const writes: RecordWrite[] = running.map((b) => ({
    type: 'time_block',
    id: b.id,
    fields: minute > instantMs(b.start) ? { end: toInstant(minute), ended_at: nowInstant(clock) } : { cancelled: true },
  }));
  await applyPlanChange(w, { writes });
}

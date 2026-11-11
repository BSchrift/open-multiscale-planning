// Planning as a task. From three days before a week starts, the app saves a task for planning it, "Plan the week of
// Nov 16", with no time placed: the one record the app makes without a tap. Only a tap gives it a time, Delete or Skip
// for now takes it away on every device, and only finishing the plan finishes it. Its id is fixed per week, so two
// devices making or scheduling it make one task, and a deleted one is never made again for its week.
//
// Today and Week work out what to show from the task, its blocks and the week's plan, on each device: nothing about
// the row is stored.

import type { Clock } from './clock';
import {
  addDays,
  addWeeks,
  blockMinutes,
  formatDate,
  formatMinutes,
  formatTimeOfDay,
  formatWeekday as formatWeekdayShort,
  instantMs,
  localDate,
  localMinutes,
  nowInstant,
  thisWeek,
  toInstant,
  today,
  weekday,
  weekDates,
  weekStart,
} from './dates';
import type { Sql } from './db';
import { markDoneNow, placeBlock, startBlock } from './blocks';
import { applyPlanChange, planningDue, planStretch } from './plan';
import type { PlanChange, RecordWrite, Stretch } from './plan';
import { blocksInRange, inboxCount, taskBlocks } from './queries';
import { isAway } from './queue';
import { REMINDER_ACTION } from './reminders';
import { getRecord, getSettings, listRecords, SETTINGS_ID, weekPlanId } from './records';
import type { Writer } from './records';
import { fits, GRID, offers, slotContext, slotInstants } from './slots';
import type { Offer, PlacedBlock, Slot } from './slots';
import { closeTask } from './tasks';
import type {
  AwayPeriod,
  CalendarSource,
  CalendarState,
  Fields,
  Instant,
  LocalDate,
  Minutes,
  Reminder,
  Settings,
  Task,
  TimeBlock,
  TimeOfDay,
  Weekday,
  WeekPlan,
} from './types';

/** Next week's task is made, and its row shows, from this many days before the week starts. */
export const PLANNING_LEAD_DAYS = 3;
/** The least time a block from now gets. With less free, Start opens planning with no block. */
export const SHORTEST_PLANNING_MIN = 15;
const FIRST_GUESS_MIN = 30;
const FULL_INBOX_GUESS_MIN = 45;
/** More Inbox items than this make the first guess longer. */
const FULL_INBOX = 15;
/** The longest a planning block gets, the same cap a first block and Start have. */
export const LONGEST_PLANNING_MIN = 120;
/** Plans the estimate learns from, and the fewest active minutes one needs to count. */
const MEASURED_WEEKS = 4;
const SHORTEST_MEASURED_MIN = 5;
/** Your usual time is when planning began in this many of the last few plans. */
const USUAL_OF = 3;
const USUAL_IN = 2;
/** A stretch's first plan includes how often to plan, so it's longer. */
const FIRST_STRETCH_MIN = 60;
const STRETCH_GUESS_MIN = 45;
const MEASURED_STRETCHES = 3;
const MINUTE_MS = 60_000;

export const weekPlanningId = (week: LocalDate) => `planning:week:${week}`;

/** Absolute dates, because the block is read out of context: on Week, in older apps and in the Google mirror. */
export const weekPlanningTitle = (week: LocalDate) => `Plan the week of ${formatDate(week)}`;

export const stretchPlanningId = (start: LocalDate) => `planning:stretch:${start}`;
export const stretchPlanningTitle = (st: Stretch) => `Plan ${formatDate(st.start)} to ${formatDate(st.end)}`;

/** What a planning task is for: a week, by its Monday, or a stretch. */
export type PlanningFor = LocalDate | { stretch: Stretch; first: boolean };
export const isWeek = (p: PlanningFor): p is LocalDate => typeof p === 'string';
export const planningId = (p: PlanningFor) => (isWeek(p) ? weekPlanningId(p) : stretchPlanningId(p.stretch.start));

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
  /** How many plans it's the middle of. */
  from?: number;
}

const upTo15 = (minutes: number) => Math.ceil(minutes / GRID) * GRID;
const bounded = (minutes: number) => Math.min(LONGEST_PLANNING_MIN, Math.max(SHORTEST_PLANNING_MIN, upTo15(minutes)));

/**
 * How long planning a week takes: the middle of the last 4 finished plans with at least 5 active minutes, rounded up
 * to 15 and kept between 15m and 2h. Until there's one, 30 minutes, or 45 with a full Inbox.
 */
export function weekEstimate(inbox: number, plans: readonly WeekPlan[] = []): Estimate {
  const measured = plans
    .filter((p) => p.finished_at && !p.deleted_at && (p.planning_min ?? 0) >= SHORTEST_MEASURED_MIN)
    .sort((a, b) => b.week_start.localeCompare(a.week_start))
    .slice(0, MEASURED_WEEKS)
    .map((p) => p.planning_min!)
    .sort((a, b) => a - b);
  if (measured.length === 0) return { minutes: inbox > FULL_INBOX ? FULL_INBOX_GUESS_MIN : FIRST_GUESS_MIN, guess: true };
  const mid = measured.length / 2;
  const middle = measured.length % 2 ? measured[Math.floor(mid)]! : (measured[mid - 1]! + measured[mid]!) / 2;
  return { minutes: bounded(middle), guess: false, from: measured.length };
}

/** The middle of some measured minutes, or null with none. */
function middleOf(minutes: number[]): number | null {
  const sorted = [...minutes].sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = sorted.length / 2;
  return sorted.length % 2 ? sorted[Math.floor(mid)]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * How long planning a stretch takes: the middle of the last 3 measured stretches, as for weeks. Until there's one, an
 * hour for the first, which asks how often to plan, and 45 minutes after that.
 */
export function stretchEstimate(settings: Pick<Settings, 'stretch_planning'>, first: boolean): Estimate {
  const measured = (settings.stretch_planning?.history ?? []).filter((m) => m >= SHORTEST_MEASURED_MIN).slice(-MEASURED_STRETCHES);
  const middle = middleOf(measured);
  if (middle === null) return { minutes: first ? FIRST_STRETCH_MIN : STRETCH_GUESS_MIN, guess: true };
  return { minutes: bounded(middle), guess: false, from: measured.length };
}

/**
 * The stretch whose planning task is due: a first plan's at once, for the stretch under way; the next one's from a week
 * before the current one ends. None without a planning cadence.
 */
export function stretchPlanningDue(settings: Pick<Settings, 'plan_cadence' | 'plan_stretch'>, on: LocalDate): { stretch: Stretch; first: boolean } | null {
  if (!planningDue(settings, on)) return null;
  const st = planStretch(settings, on);
  return { stretch: { start: st.start, end: st.end }, first: !settings.plan_stretch.last_planned };
}

/** Adds the minutes of one time in the stretch flow to the stretch being planned, noting when it began. */
export async function addStretchMinutes(w: Writer, start: LocalDate, minutes: Minutes, began: Instant): Promise<void> {
  const held = (await getSettings(w.sql)).stretch_planning;
  const same = held?.start === start;
  const next = {
    start,
    started_at: same && held?.started_at ? held.started_at : began,
    min: (same ? (held?.min ?? 0) : 0) + minutes,
    ...(held?.history ? { history: held.history } : {}),
  };
  await w.create('settings', { stretch_planning: next }, SETTINGS_ID);
}

/** After stopping early: the estimate less the minutes spent, rounded up, and at least 15m. */
export const timeLeft = (estimate: Minutes, spent: Minutes): Minutes => bounded(estimate - spent);

export interface UsualTime {
  day: Weekday;
  minutes: TimeOfDay;
}

/** The weekday and quarter hour planning began in 2 of the last 3 plans, or null. */
export function usualTime(plans: readonly WeekPlan[], zone: string): UsualTime | null {
  const starts = plans
    .filter((p) => p.planning_started_at && !p.deleted_at)
    .sort((a, b) => b.week_start.localeCompare(a.week_start))
    .slice(0, USUAL_OF)
    .map((p) => {
      const at = p.planning_started_at!;
      return { day: weekday(localDate(at, zone)), minutes: Math.floor(localMinutes(at, zone) / GRID) * GRID };
    });
  return starts.find((s) => starts.filter((o) => o.day === s.day && o.minutes === s.minutes).length >= USUAL_IN) ?? null;
}

/** Adds the minutes of one time in the planning flow to its week, and notes when planning first began. */
export async function addPlanningMinutes(w: Writer, week: LocalDate, minutes: Minutes, began: Instant): Promise<void> {
  const plan = await getRecord(w.sql, 'week_plan', weekPlanId(week));
  const fields: Fields<'week_plan'> = {
    ...(minutes > 0 ? { planning_min: (plan?.planning_min ?? 0) + minutes } : {}),
    ...(plan?.planning_started_at ? {} : { planning_started_at: began }),
  };
  if (Object.keys(fields).length > 0) await setWeekPlan(w, week, fields);
}

const taskFields = (p: PlanningFor, minutes: Minutes): Fields<'task'> => ({
  kind: 'planning',
  title: isWeek(p) ? weekPlanningTitle(p) : stretchPlanningTitle(p.stretch),
  plans: [isWeek(p) ? `week:${p}` : `stretch:${p.stretch.start}`],
  estimate_min: minutes,
});

/**
 * Makes the planning task that's due and has no record yet, deleted or not, unless its week is already planned. Run
 * whenever a device works out Today. Written as automatic, so on a device that hasn't pulled yet it has the lowest
 * clock: two devices make one task, and anyone's write, a delete included, wins over it. It places no time.
 */
export async function makeDuePlanningTasks(w: Writer, clock: Clock): Promise<void> {
  const on = today(clock);
  const week = planningWeekDue(on);
  if (week && !(await getRecord(w.sql, 'week_plan', weekPlanId(week)))?.finished_at && !(await getRecord(w.sql, 'task', weekPlanningId(week)))) {
    const estimate = weekEstimate(await inboxCount(w.sql), await listRecords(w.sql, 'week_plan')).minutes;
    await w.automatic.create('task', taskFields(week, estimate), weekPlanningId(week));
  }
  const settings = await getSettings(w.sql);
  const due = stretchPlanningDue(settings, on);
  if (due && !(await getRecord(w.sql, 'task', planningId(due)))) {
    await w.automatic.create('task', taskFields(due, stretchEstimate(settings, due.first).minutes), planningId(due));
  }
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

/** A planning task, deleted or not, and its blocks still on the calendar. */
export async function loadTaskPlanning(sql: Sql, id: string): Promise<Pick<WeekPlanning, 'task' | 'blocks'>> {
  return { task: (await getRecord(sql, 'task', id)) ?? null, blocks: await taskBlocks(sql, { task_id: id }) };
}

/** A stretch's planning row: while its task is open and has no time. */
export const stretchRow = (p: Pick<WeekPlanning, 'task' | 'blocks'>, clock: Clock) => isOpen(p.task) && !blockAhead(p, clock);

const isOpen = (task: Task | null): task is Task => !!task && !task.deleted_at && !task.done_at && !task.cancelled_at;
export const isPlanned = (p: WeekPlanning) => !!p.plan?.finished_at;

/** The planning block under way or still to come, soonest first. Ended or stopped ones don't count. */
export function blockAhead(p: Pick<WeekPlanning, 'task' | 'blocks'>, clock: Clock): TimeBlock | undefined {
  if (!isOpen(p.task)) return undefined;
  return p.blocks.find((b) => !b.ended_at && instantMs(b.end) > clock.now());
}

/**
 * What the row says once something has happened: 'stopped' once planning began and wasn't finished, 'passed' when its
 * block went by unopened, else 'ask'. Null while a planning block is under way or still to come.
 */
export function rowState(p: WeekPlanning, clock: Clock): 'ask' | 'passed' | 'stopped' | null {
  if (blockAhead(p, clock)) return null;
  if (p.plan?.planning_started_at || p.plan?.planning_min) return 'stopped';
  return p.blocks.some((b) => !b.started_at && instantMs(b.end) <= clock.now()) ? 'passed' : 'ask';
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

export interface Time extends Slot {
  /** Your usual time, said beside it. */
  usual?: boolean;
}

/**
 * Times to plan a week in, best first, at most three. Your usual time leads when it's free and still to come before
 * the week starts, or later this week once it has begun. Ahead of the week, the rest are before it starts, from
 * offers(); Monday morning only when nothing earlier is free. Once the week has begun, the next free times from today,
 * one a day.
 */
export function planningTimes(p: PlanningFor, minutes: Minutes, input: TimesInput, usual: UsualTime | null = null): Time[] {
  const { settings, calendar, sources, blocks, clock } = input;
  // shortcut: an hour closed to projects by one block and to one offs by another reads as open; split blocks are rare.
  const availability = settings.availability.filter((b) => b.projects && b.one_offs);
  const ctx = (wk: LocalDate) => slotContext({ week: wk, availability, avoided: settings.avoided_slots, sources, calendar, blocks, clock });
  const current = thisWeek(clock);
  const window = ctx(current);
  // Ahead of a week, before it starts; ahead of a stretch, before it starts. A first stretch plan is under way already.
  const before = isWeek(p) ? p : p.first ? today(clock) : p.stretch.start;
  const ahead = before > today(clock);
  const day = usual && weekDates(current).find((d) => weekday(d) === usual.day && (!ahead || d < before));
  const first: Time[] = day && fits(day, usual!.minutes, minutes, 'project', window) ? [{ date: day, start: usual!.minutes, end: usual!.minutes + minutes, usual: true }] : [];
  const rest = (slots: Slot[]) => [...first, ...slots.filter((s) => !first.some((f) => f.date === s.date))].slice(0, 3);
  if (ahead) {
    // This week's days, then the next week's when what's planned starts after it, as a stretch can.
    const last = weekStart(addDays(before, -1));
    const weeks = last > current ? [current, last] : [current];
    const found = weeks.flatMap((wk) => offers(minutes, { kind: 'project' }, wk === current ? window : ctx(wk)).filter((o) => o.date < before));
    if (found.length > 0 || first.length > 0) return rest(found.map(slotOf));
    // Due the day before, so the first day's offer starts at its first open hour rather than the evening.
    return offers(minutes, { kind: 'project', due: addDays(before, -1) }, ctx(weekStart(before)))
      .filter((o) => o.date === before)
      .slice(0, 1)
      .map(slotOf);
  }
  return rest(
    offers(minutes, { kind: 'project' }, window)
      .sort((a, b) => a.date.localeCompare(b.date))
      .map(slotOf),
  );
}

/**
 * Review's next planning time: this session's start a week on, rounded down to the quarter hour, when it began before
 * the week it plans or on its first day and that time is free. Otherwise your usual time or the best free time before
 * the following week starts.
 */
export function nextPlanningTime(
  week: LocalDate,
  began: Instant | null,
  minutes: Minutes,
  input: TimesInput,
  usual: UsualTime | null = null,
): { slot: Slot; same: boolean } | null {
  const zone = input.clock.zone();
  const next = addWeeks(week, 1);
  if (began && localDate(began, zone) <= week) {
    const date = addDays(localDate(began, zone), 7);
    const start = Math.floor(localMinutes(began, zone) / GRID) * GRID;
    const ctx = slotContext({ ...input, week: weekStart(date), avoided: input.settings.avoided_slots, availability: input.settings.availability });
    if (fits(date, start, minutes, 'project', ctx)) return { slot: { date, start, end: start + minutes }, same: true };
  }
  const best = planningTimes(next, minutes, input, usual)[0];
  return best ? { slot: { date: best.date, start: best.start, end: best.end }, same: false } : null;
}

/** How long before the time the row offers the weekly reminder comes. */
const REMIND_BEFORE_MS = 3 * 60 * MINUTE_MS;

/**
 * The weekly reminder, while next week's planning has no time: one notification, 3 hours before the time its row will
 * offer, whose one action opens the app on the times. Null once that planning is scheduled, finished or deleted, with
 * the switch in Settings off, or on away dates. Each device works it out again whenever the app runs.
 */
export function planningReminder(
  next: WeekPlanning,
  input: TimesInput & { plans: readonly WeekPlan[]; inbox: number; on: boolean; away: readonly AwayPeriod[] },
): Reminder | null {
  const { clock } = input;
  if (!input.on || isPlanned(next) || next.task?.deleted_at || next.task?.done_at || blockAhead(next, clock)) return null;
  const estimate = weekEstimate(input.inbox, input.plans).minutes;
  const opens = addDays(next.week, -PLANNING_LEAD_DAYS);
  const slot = planningTimes(next.week, estimate, input, usualTime(input.plans, clock.zone())).find((s) => s.date >= opens);
  if (!slot || isAway(slot.date, input.away)) return null;
  const start = slotInstants(slot, clock.zone()).start;
  return {
    id: `reminder:planning:${next.week}`,
    kind: 'planning_unscheduled',
    block_id: weekPlanningId(next.week),
    at: toInstant(instantMs(start) - REMIND_BEFORE_MS),
    title: "Next week isn't planned yet",
    body: `About ${formatMinutes(estimate)}. ${formatWeekdayShort(slot.date)} ${formatTimeOfDay(slot.start)} is free.`,
    actions: [{ id: REMINDER_ACTION.choosePlanningTime, title: 'Choose a time', opens_app: true }],
  };
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
async function ensureTask(w: Writer, p: PlanningFor, fields: Fields<'task'>): Promise<RecordWrite[]> {
  const id = planningId(p);
  const task = await getRecord(w.sql, 'task', id);
  if (!task) {
    await w.create('task', { ...taskFields(p, fields.estimate_min ?? FIRST_GUESS_MIN), ...fields }, id);
    return [];
  }
  const back = { ...(task.deleted_at ? { deleted_at: null } : {}), ...(task.done_at ? { done_at: null } : {}), ...fields };
  return [{ type: 'task', id, fields: await w.set('task', id, back) }];
}

/**
 * Start: a started planning block from this minute, for the estimate unless given a length, made with the task if it
 * isn't there. A planning block already under way is never doubled; it's started if it wasn't. A week or stretch
 * already planned gets nothing: Start only opens planning. Returns the block's end, or null when no block was placed,
 * and the reverse, which takes the block away and leaves the task.
 */
export async function startPlanning(
  w: Writer,
  p: PlanningFor,
  length: Minutes | undefined,
  clock: Clock,
): Promise<{ reverse: PlanChange; until: Instant | null }> {
  const none = { reverse: { writes: [] }, until: null };
  const settings = await getSettings(w.sql);
  const planned = isWeek(p) ? !!(await getRecord(w.sql, 'week_plan', weekPlanId(p)))?.finished_at : settings.plan_stretch.last_planned === p.stretch.start;
  if (planned) return none;
  const estimate = isWeek(p) ? weekEstimate(await inboxCount(w.sql), await listRecords(w.sql, 'week_plan')) : stretchEstimate(settings, p.first);
  const minutes = length ?? estimate.minutes;
  const id = planningId(p);
  await ensureTask(w, p, {});
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
export async function schedulePlanning(w: Writer, p: PlanningFor, times: { start: Instant; end: Instant }, clock: Clock): Promise<PlanChange> {
  const restored = await ensureTask(w, p, { estimate_min: blockMinutes(times) });
  const placed = await placeBlock(w, planningId(p), times, clock);
  const estimate = restored.map((r) => ({ ...r, fields: 'estimate_min' in r.fields ? { estimate_min: r.fields.estimate_min } : {} }));
  return { writes: [...placed.writes, ...estimate.filter((r) => Object.keys(r.fields).length > 0)] };
}

/** Delete: the task goes on every device with its blocks not yet started. Undo puts both back. */
export async function deletePlanning(w: Writer, p: PlanningFor, clock: Clock): Promise<PlanChange> {
  const task = await getRecord(w.sql, 'task', planningId(p));
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
export async function finishWeek(
  w: Writer,
  week: LocalDate,
  clock: Clock,
): Promise<{ reverse: PlanChange; freed: Instant | null; minutes: Minutes | null }> {
  const planned = await setWeekPlan(w, week, { finished_at: nowInstant(clock) });
  const minutes = (await getRecord(w.sql, 'week_plan', weekPlanId(week)))?.planning_min ?? null;
  const closed = await closePlanning(w, weekPlanningId(week), clock);
  // Planned in the stretch's block, carried on from its Finish and plan the week: that block ends now too.
  const covering = await endCoveringBlocks(w, week, clock);
  return { reverse: { writes: [...covering, ...closed.reverse.writes, planned] }, freed: closed.freed, minutes };
}

/** The week whose planning a stretch's planning block covers too, when the two share one. */
export const coveredWeek = (task: Task | null): LocalDate | null => task?.plans?.find((x) => x.startsWith('week:'))?.slice('week:'.length) ?? null;

/** Both in one block for at most this long; past it, each plan gets its own row. */
export const BOTH_LONGEST_MIN = LONGEST_PLANNING_MIN;

/** The stretch's task takes the shared block and lists the week among its plans, which covers the week's own row. */
async function coverWeek(w: Writer, s: { stretch: Stretch; first: boolean }, week: LocalDate): Promise<RecordWrite> {
  const id = planningId(s);
  const title = `${stretchPlanningTitle(s.stretch)} and the week of ${formatDate(week)}`;
  return { type: 'task', id, fields: await w.set('task', id, { plans: [`stretch:${s.stretch.start}`, `week:${week}`], title }) };
}

/** Schedule both: one block, the stretch's, covering the week too. Undo takes it back and parts them again. */
export async function scheduleBoth(
  w: Writer,
  s: { stretch: Stretch; first: boolean },
  week: LocalDate,
  times: { start: Instant; end: Instant },
  clock: Clock,
): Promise<PlanChange> {
  const placed = await schedulePlanning(w, s, times, clock);
  return { writes: [...placed.writes, await coverWeek(w, s, week)] };
}

/** Start both: one block from now, the stretch's, covering the week too. */
export async function startBoth(
  w: Writer,
  s: { stretch: Stretch; first: boolean },
  week: LocalDate,
  minutes: Minutes,
  clock: Clock,
): Promise<{ reverse: PlanChange; until: Instant | null }> {
  const started = await startPlanning(w, s, minutes, clock);
  return { reverse: { writes: [...started.reverse.writes, await coverWeek(w, s, week)] }, until: started.until };
}

/** Delete on the shared row deletes both tasks, with one reverse. */
export async function deleteBoth(w: Writer, s: { stretch: Stretch; first: boolean }, week: LocalDate, clock: Clock): Promise<PlanChange> {
  const stretch = await deletePlanning(w, s, clock);
  const weekly = await deletePlanning(w, week, clock);
  return { writes: [...weekly.writes, ...stretch.writes] };
}

/** Ends the blocks under way of a stretch's planning task that covers this week, now that the week is planned too. */
async function endCoveringBlocks(w: Writer, week: LocalDate, clock: Clock): Promise<RecordWrite[]> {
  const covering = (await listRecords(w.sql, 'task')).filter((t) => t.kind === 'planning' && t.id.startsWith('planning:stretch:') && coveredWeek(t) === week);
  const now = clock.now();
  const minute = Math.floor(now / MINUTE_MS) * MINUTE_MS;
  const writes: RecordWrite[] = [];
  for (const t of covering) {
    for (const b of await taskBlocks(w.sql, { task_id: t.id })) {
      if (b.ended_at || instantMs(b.start) > now || instantMs(b.end) <= now) continue;
      writes.push({ type: 'time_block', id: b.id, fields: await w.set('time_block', b.id, { end: toInstant(Math.max(minute, instantMs(b.start))), ended_at: nowInstant(clock) }) });
    }
  }
  return writes;
}

/**
 * A planning task's plan is finished: its block under way ends at this minute, as Mark done now does, and any still to
 * come is freed. Returns the reverse and the start of the block freed.
 */
async function closePlanning(w: Writer, id: string, clock: Clock): Promise<{ reverse: PlanChange; freed: Instant | null }> {
  const task = await getRecord(w.sql, 'task', id);
  if (!isOpen(task ?? null)) return { reverse: { writes: [] }, freed: null };
  const now = clock.now();
  const live = (await taskBlocks(w.sql, { task_id: id })).filter((b) => !b.ended_at && instantMs(b.end) > now);
  const running = live.find((b) => instantMs(b.start) <= now);
  const freed = live.find((b) => instantMs(b.start) > now && !b.started_at)?.start ?? null;
  return { reverse: running ? await markDoneNow(w, running.id, clock) : await closeTask(w, id, 'done', clock), freed };
}

/**
 * Finishing a stretch's plan finishes its planning task, as finishWeek does, and keeps the minutes it took among the
 * last 3 the estimate learns from. With its week too (Finish and plan the week), a block shared with that week carries
 * on into weekly planning, which ends it. Finished alone, the week goes back to its own row. Returns the reverse, which
 * reopens the task and its block, and the block freed.
 */
export async function finishStretchPlanning(
  w: Writer,
  start: LocalDate,
  clock: Clock,
  andWeek = false,
): Promise<{ reverse: PlanChange; freed: Instant | null }> {
  const id = stretchPlanningId(start);
  const task = (await getRecord(w.sql, 'task', id)) ?? null;
  const week = coveredWeek(task);
  const parted: RecordWrite[] =
    week && !andWeek ? [{ type: 'task', id, fields: await w.set('task', id, { plans: [`stretch:${start}`], title: task!.title.replace(/ and the week of .*$/, '') }) }] : [];
  const closed =
    week && andWeek && isOpen(task)
      ? { reverse: await closeTask(w, id, 'done', clock), freed: null }
      : await closePlanning(w, id, clock);
  const held = (await getSettings(w.sql)).stretch_planning;
  if (held?.start === start) {
    const history = [...(held.history ?? []), ...(held.min ? [held.min] : [])].slice(-MEASURED_STRETCHES);
    await w.create('settings', { stretch_planning: { start, history } }, SETTINGS_ID);
  }
  return { reverse: { writes: [...closed.reverse.writes, ...parted] }, freed: closed.freed };
}

/**
 * Save and exit: planning blocks under way end at this minute, so the rest of their time is free; one stopped in its
 * first minute held no time, and goes. Two, when two devices each started it before syncing. The task stays open.
 */
export async function stopPlanning(w: Writer, p: PlanningFor, clock: Clock): Promise<void> {
  const now = clock.now();
  const minute = Math.floor(now / MINUTE_MS) * MINUTE_MS;
  const running = (await taskBlocks(w.sql, { task_id: planningId(p) })).filter(
    (b) => !b.ended_at && instantMs(b.start) <= now && instantMs(b.end) > now,
  );
  const writes: RecordWrite[] = running.map((b) => ({
    type: 'time_block',
    id: b.id,
    fields: minute > instantMs(b.start) ? { end: toInstant(minute), ended_at: nowInstant(clock) } : { cancelled: true },
  }));
  await applyPlanChange(w, { writes });
}

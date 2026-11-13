// When one offs come due, and what ticking and unticking them changes. Functions return the fields to write, for
// the caller to apply through records.ts: tick's completion goes to Writer.create with its id, so that two devices
// finishing one occurrence, or a re-tick after an untick, land on the same record.

import { RRule } from 'rrule';
import type { Options } from 'rrule';
import type { Clock } from './clock';
import { addDays, addMonths, diffDays, formatDate, formatMinutes, formatWeekday, instantMs, isDay, localDate, nowInstant, today, toInstant, weekStart } from './dates';
import { occurrenceId } from './records';
import type { Fields, Instant, LocalDate, RepeatUnit, Task, TaskCompletion, TaskSchedule, TimeBlock } from './types';

const FREQ: Record<RepeatUnit, Options['freq']> = { day: RRule.DAILY, week: RRule.WEEKLY, month: RRule.MONTHLY, year: RRule.YEARLY };
const ADJECTIVE: Record<RepeatUnit, string> = { day: 'Daily', week: 'Weekly', month: 'Monthly', year: 'Yearly' };

const isCount = (n: unknown): n is number => Number.isInteger(n) && (n as number) > 0;
const later = (a: LocalDate | null | undefined, b: LocalDate): LocalDate => (a && a > b ? a : b);

function addUnits(date: LocalDate, n: number, unit: RepeatUnit): LocalDate {
  if (unit === 'day') return addDays(date, n);
  if (unit === 'week') return addDays(date, n * 7);
  return addMonths(date, unit === 'month' ? n : n * 12);
}

type RuleSchedule = Extract<TaskSchedule, { type: 'recurring' | 'rule' }>;

/** rrule works on UTC dates throughout, so no zone can shift a day here. */
function toRRule(s: RuleSchedule): RRule {
  const dtstart = new Date(`${s.anchor}T00:00:00Z`);
  if (s.type === 'rule') {
    const parsed = RRule.parseString(s.rrule);
    if (parsed.freq === undefined || parsed.freq > RRule.DAILY) throw new Error('A rule repeats by the day or longer');
    if (parsed.interval !== undefined && !isCount(parsed.interval)) throw new Error('A rule needs a positive interval');
    return new RRule({ ...parsed, dtstart, tzid: null });
  }
  const options: Partial<Options> = { freq: FREQ[s.unit], interval: s.every, dtstart };
  const day = Number(s.anchor.slice(8));
  if (s.days?.length) options.byweekday = s.days;
  else if (day > 28 && (s.unit === 'month' || s.unit === 'year')) {
    // Takes the month's last day when the anchor day doesn't exist there. rrule alone would skip that month.
    options.bymonthday = Array.from({ length: day - 27 }, (_, i) => 28 + i);
    options.bysetpos = -1;
    if (s.unit === 'year') options.bymonth = Number(s.anchor.slice(5, 7));
  }
  return new RRule(options);
}

function ruleAfter(s: RuleSchedule, after: LocalDate): LocalDate | null {
  // shortcut: a rule that never matches, like Feb 30, blocks for seconds while rrule searches to year 9999, offer only rules that match if free text is ever allowed.
  const next = toRRule(s).after(new Date(`${after}T23:59:59Z`));
  return next ? next.toISOString().slice(0, 10) : null;
}

function seasonAfter(months: number[], after: LocalDate): LocalDate {
  const year = Number(after.slice(0, 4));
  const month = Number(after.slice(5, 7));
  const sorted = [...months].sort((a, b) => a - b);
  const coming = sorted.find((m) => m > month);
  return `${coming ? year : year + 1}-${String(coming ?? sorted[0]).padStart(2, '0')}-01`;
}

/** Why a schedule can't be used, or null. Schedules also arrive through sync, so bad ones just have no next date. */
export function validateSchedule(s: TaskSchedule): string | null {
  const repeatError = 'Choose how often it repeats.';
  const unitOk = (unit: RepeatUnit) => unit in FREQ;
  switch (s.type) {
    case 'once':
      if (!s.from && !s.to) return null;
      if (!isDay(s.from) || (s.to && !isDay(s.to))) return 'Pick a date.';
      return s.to && s.to < s.from ? 'The end date is before the start date.' : null;
    case 'recurring':
      return isCount(s.every) && unitOk(s.unit) && isDay(s.anchor) ? null : repeatError;
    case 'float':
      return isCount(s.every) && unitOk(s.unit) ? null : repeatError;
    case 'window':
      return isCount(s.min) && isCount(s.max) && s.max >= s.min && unitOk(s.unit) ? null : repeatError;
    case 'seasonal':
      return Array.isArray(s.months) && s.months.length > 0 && s.months.every((m) => isCount(m) && m <= 12) ? null : 'Pick a month.';
    case 'rule':
      try {
        if (!isDay(s.anchor)) throw new Error('No anchor');
        toRRule(s);
        return null;
      } catch {
        return 'That calendar rule does not work.';
      }
    default:
      return repeatError;
  }
}

/** The next_due to set when a task is created or its schedule changes. lastDone is its latest finish, if any. */
export function firstDue(s: TaskSchedule, day: LocalDate, lastDone?: LocalDate | null): LocalDate | null {
  if (validateSchedule(s)) return null;
  switch (s.type) {
    case 'once':
      return s.from ?? null;
    case 'recurring':
    case 'rule':
      return ruleAfter(s, addDays(day, -1));
    case 'float':
      return lastDone ? addUnits(lastDone, s.every, s.unit) : null;
    case 'window':
      return addUnits(lastDone ?? day, s.min, s.unit);
    case 'seasonal':
      return s.months.includes(Number(day.slice(5, 7))) ? day : seasonAfter(s.months, day);
  }
}

/**
 * The next_due after a finish on doneOn. Calendar schedules use up the occurrence that was due, so finishing early
 * doesn't bring it back, and finishing late skips past what was missed. The rest count from the finish.
 */
export function nextDue(s: TaskSchedule, occurrence: LocalDate | null | undefined, doneOn: LocalDate): LocalDate | null {
  if (validateSchedule(s)) return null;
  switch (s.type) {
    case 'once':
      return null;
    case 'recurring':
    case 'rule':
      return ruleAfter(s, later(occurrence, doneOn));
    case 'float':
      return addUnits(doneOn, s.every, s.unit);
    case 'window':
      return addUnits(doneOn, s.min, s.unit);
    case 'seasonal':
      return seasonAfter(s.months, later(occurrence, doneOn));
  }
}

/** The last day of a flexible window that opens on due. */
export function windowEnd(s: TaskSchedule, due: LocalDate | null | undefined): LocalDate | null {
  return s.type === 'window' && due ? addUnits(due, s.max - s.min, s.unit) : null;
}

export function isRepeating(task: Task): boolean {
  return !!task.schedule && task.schedule.type !== 'once';
}

/** The fields for new dates on a one-time task. Check them with validateSchedule first. */
export function setOnceDates(from: LocalDate | null, to: LocalDate | null): Fields<'task'> {
  return { schedule: { type: 'once', from, to: from && to && to !== from ? to : null }, next_due: from };
}

/** The fields for dragging a one-time task to a new start. A range keeps its length. */
export function moveOnce(s: Extract<TaskSchedule, { type: 'once' }>, from: LocalDate): Fields<'task'> {
  return setOnceDates(from, s.from && s.to ? addDays(from, diffDays(s.from, s.to)) : null);
}

/** Whether a dated one-time task still to do falls within these days. */
export function onceOverlaps(task: Task, start: LocalDate, end: LocalDate): boolean {
  const s = task.schedule;
  return s?.type === 'once' && !!s.from && !task.done_at && s.from <= end && (s.to || s.from) >= start;
}

/** Only a task dated to this one day is on Today, not a range that includes it. */
export function isOnToday(task: Task, day: LocalDate): boolean {
  const s = task.schedule;
  return s?.type === 'once' && s.from === day && (!s.to || s.to === day);
}

export interface TickResult {
  task: Fields<'task'>;
  completion: { id: string; fields: Omit<TaskCompletion, 'id'> };
}

/** A finish now, or at `done_at`, such as the end of a block answered later. */
export function tick(task: Task, clock: Clock, done_at: Instant = nowInstant(clock)): TickResult {
  const doneOn = localDate(done_at, clock.zone());
  const previous = task.next_due ?? null;
  return {
    task: isRepeating(task) ? { next_due: nextDue(task.schedule!, previous, doneOn) } : { done_at },
    completion: {
      id: occurrenceId(task.id, previous ?? doneOn),
      fields: { task_id: task.id, done_at, previous_next: previous, deleted_at: null },
    },
  };
}

function latest(completions: readonly TaskCompletion[], taskId: string): TaskCompletion | undefined {
  // Ticks within one second share a done_at, and the later one has used up the later date.
  const order = (c: TaskCompletion) => `${c.done_at} ${c.previous_next ?? ''}`;
  return completions
    .filter((c) => c.task_id === taskId && !c.deleted_at)
    .reduce<TaskCompletion | undefined>((best, c) => (!best || order(c) > order(best) ? c : best), undefined);
}

/** When a block's Done finished its work: the block's end, or now if that's still to come. */
export const blockFinish = (block: Pick<TimeBlock, 'end'>, clock: Clock): Instant => toInstant(Math.min(instantMs(block.end), clock.now()));

/**
 * A block's Done also finishes the task, at the block's end, so an answer given later counts for the day it was for. A
 * repeating one uses up that day, unless it was already finished or the task was ticked since the block began.
 */
export function tickFromBlock(task: Task, completions: readonly TaskCompletion[], block: Pick<TimeBlock, 'start' | 'end'>, clock: Clock): TickResult | null {
  const at = blockFinish(block, clock);
  if (!isRepeating(task)) return task.done_at ? null : tick(task, clock, at);
  const day = localDate(at, clock.zone());
  const done = completions.some(
    (c) => c.task_id === task.id && !c.deleted_at && (localDate(c.done_at, clock.zone()) === day || instantMs(c.done_at) >= instantMs(block.start)),
  );
  return done ? null : tick(task, clock, at);
}

export interface UntickResult {
  task: Fields<'task'>;
  completion: Fields<'task_completion'>;
}

/** Only the latest completion changes the task. An older one just removes that record. */
export function untick(task: Task, completion: TaskCompletion, completions: readonly TaskCompletion[], clock: Clock): UntickResult {
  const fields = { deleted_at: nowInstant(clock) };
  if (latest(completions, task.id)?.id !== completion.id) return { task: {}, completion: fields };
  const next_due = completion.previous_next ?? null;
  return { task: isRepeating(task) ? { next_due } : { done_at: null, next_due }, completion: fields };
}

/** Undoes an untick from the finished list, giving back what that finish set when it's the latest again. */
export function retick(task: Task, completion: TaskCompletion, completions: readonly TaskCompletion[], clock: Clock): UntickResult {
  const fields = { deleted_at: null };
  const revived = { ...completion, deleted_at: null };
  if (latest([...completions.filter((c) => c.id !== completion.id), revived], task.id)?.id !== completion.id) {
    return { task: {}, completion: fields };
  }
  if (!isRepeating(task)) return { task: { done_at: completion.done_at }, completion: fields };
  const doneOn = localDate(completion.done_at, clock.zone());
  return { task: { next_due: nextDue(task.schedule!, completion.previous_next, doneOn) }, completion: fields };
}

export interface OneOffRow {
  task: Task;
  checked: boolean;
  /** Today's latest finish, which unticking the row removes. */
  completion?: TaskCompletion;
}

/** The One offs list right now. Ticks stay until the local date changes, so Show completed can show them to untick. */
export function oneOffRows(tasks: readonly Task[], completions: readonly TaskCompletion[], clock: Clock): OneOffRow[] {
  const zone = clock.zone();
  const day = today(clock);
  const todays = completions.filter((c) => localDate(c.done_at, zone) === day);
  return tasks
    .filter((t) => t.kind === 'one_off' && !t.deleted_at && !t.cancelled_at && (!t.done_at || localDate(t.done_at, zone) === day))
    .sort((a, b) => (a.next_due ?? '9999').localeCompare(b.next_due ?? '9999'))
    .map((task) => {
      const completion = latest(todays, task.id);
      return { task, checked: isRepeating(task) ? !!completion : !!task.done_at, ...(completion ? { completion } : {}) };
    });
}

/**
 * The planned blocks a finish of a repeating task frees, given the task after its tick. A block from the task's new
 * date on belongs to a later occurrence, and one already past stays for its own prompt.
 */
export function blocksToRelease(blocks: readonly TimeBlock[], task: Task, clock: Clock): TimeBlock[] {
  if (!isRepeating(task)) return [];
  const now = nowInstant(clock);
  return blocks.filter(
    (b) =>
      b.task_id === task.id &&
      !b.cancelled &&
      !b.deleted_at &&
      !b.started_at &&
      b.start > now &&
      (!task.next_due || localDate(b.start, clock.zone()) < task.next_due),
  );
}

const units = (n: number, unit: RepeatUnit) => `${n} ${unit}${n === 1 ? '' : 's'}`;

function ordinal(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${n}${suffix}`;
}

const monthName = (month: number) => new Date(Date.UTC(2000, month - 1)).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });

/** How a repeating schedule reads on its row. */
export function scheduleLabel(s: TaskSchedule): string {
  switch (s.type) {
    case 'once':
      return 'Once';
    case 'recurring': {
      const every = s.every === 1 ? ADJECTIVE[s.unit] : `Every ${units(s.every, s.unit)}`;
      if (s.days?.length) {
        const days = [...new Set(s.days)].sort((a, b) => a - b);
        if (s.every === 1 && s.unit === 'week' && days.length === 7) return 'Daily';
        if (s.every === 1 && s.unit === 'week' && days.join() === '0,1,2,3,4') return 'Every weekday';
        return `${every} on ${new Intl.ListFormat('en-GB').format(days.map((d) => formatWeekday(addDays(weekStart(s.anchor), d))))}`;
      }
      return s.unit === 'month' ? `${every} on the ${ordinal(Number(s.anchor.slice(8)))}` : every;
    }
    case 'float':
      return `${units(s.every, s.unit)} after last done`;
    case 'window':
      return s.min === s.max ? `Every ${units(s.min, s.unit)}` : `Every ${s.min} to ${units(s.max, s.unit)}`;
    case 'seasonal': {
      const sorted = [...s.months].sort((a, b) => a - b);
      return `In ${new Intl.ListFormat('en-GB').format(sorted.map(monthName))}`;
    }
    case 'rule': {
      if (validateSchedule(s)) return 'Calendar rule';
      const rule = toRRule(s);
      const pos = [rule.origOptions.bysetpos ?? []].flat();
      // rrule's text leaves out a set position, so the last weekday would read as every weekday.
      const which = pos.length === 1 ? `the ${pos[0] === -1 ? 'last' : ordinal(pos[0]!)} weekday` : 'weekdays';
      const text = rule.toText().replace(/on weekdays$/, `on ${which}`).replace(/on the last$/, 'on the last day');
      return text.charAt(0).toUpperCase() + text.slice(1);
    }
  }
}

/** 'Nov 3 to Nov 6', 'Nov 3', or '' with no date. */
export function onceWhen(s: Extract<TaskSchedule, { type: 'once' }>): string {
  if (!s.from) return '';
  return s.to && s.to !== s.from ? `${formatDate(s.from)} to ${formatDate(s.to)}` : formatDate(s.from);
}

function nextText(s: TaskSchedule, due: LocalDate | null | undefined): string {
  if (!due) return s.type === 'float' ? 'next after first done' : 'no more dates';
  const date = formatDate(due);
  switch (s.type) {
    case 'recurring':
      return `next ${s.unit === 'day' || s.unit === 'week' ? `${formatWeekday(due)} ${date}` : date}`;
    case 'float':
      return `next about ${date}`;
    case 'window':
      return `next between ${date} and ${formatDate(windowEnd(s, due)!)}`;
    case 'seasonal':
      return `next in ${monthName(Number(due.slice(5, 7)))}`;
    default:
      return `next ${date}`;
  }
}

/** The line under a row's title. */
export function rowLine({ task, checked }: OneOffRow): string {
  const s = task.schedule ?? { type: 'once' as const };
  if (checked) return s.type === 'once' ? 'Done today' : `Done today, ${nextText(s, task.next_due)}`;
  const line = s.type === 'once' ? onceWhen(s) || 'No date' : `${scheduleLabel(s)}, ${nextText(s, task.next_due)}`;
  return task.estimate_min ? `${line}, ${formatMinutes(task.estimate_min)}` : line;
}

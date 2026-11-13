// Where work can go in a week: open time, suggested times, placing tasks and practices, and drag rules.
// Everything works on local dates and minutes after midnight, so evenings stay put across daylight saving.
// slotContext turns records into that form, and slotInstants turns a chosen time back into instants.

import type { Clock } from './clock';
import { addDays, formatTimeOfDay, instantMs, localDate, localMinutes, localToInstant, localToMs, today, weekday, weekDates } from './dates';
import { busyEvents } from './queue';
import { sessionDay } from './records';
import type {
  AvailabilityBlock,
  AvoidedSlot,
  BlockResult,
  CalendarSource,
  CalendarState,
  Instant,
  LocalDate,
  Minutes,
  Practice,
  TaskKind,
  TimeOfDay,
  Weekday,
} from './types';

/** Whose hours apply. Practices use project hours. */
export type WorkKind = 'project' | 'one_off';

export interface Slot {
  date: LocalDate;
  start: TimeOfDay;
  /** Up to 1440, the end of the day. */
  end: TimeOfDay;
}

/** An event or block, cut at midnight. */
export interface Span extends Slot {
  id?: string;
  title?: string | null;
  kind?: TaskKind | 'practice' | null;
  practice_id?: string | null;
  /** A practice session's day: the one in its id, else the day it starts. Moving it keeps the day it's for. */
  for?: LocalDate | null;
  /** A practice session answered Skipped, which a count no longer counts. */
  skipped?: boolean;
}

export interface SlotContext {
  /** The Monday of the week being placed. */
  week: LocalDate;
  availability: AvailabilityBlock[];
  /** Events on blocking calendars. */
  busy: Span[];
  /** Blocks already on the week. When moving a block, leave it out to offer times around it. */
  placed: Span[];
  avoided: AvoidedSlot[];
  /** Now: nothing earlier is offered. */
  earliest: { date: LocalDate; minutes: TimeOfDay };
  /** The zone the week is in, which tells a practice's time from one the clocks skip. */
  zone?: string;
}

export interface Work {
  kind: WorkKind;
  due?: LocalDate | null;
  /** The first date it can be done. */
  opens?: LocalDate | null;
}

export interface Offer extends Slot {
  /** Minutes already placed that day. */
  load: Minutes;
  tight: boolean;
  late: boolean;
  note: string;
}

/** Every drag and time slider moves in steps of this many minutes. */
export const GRID = 15;
const SNAP = 20;
const LONGEST_BLOCK = 120;
const WEEKDAY_FIRST = 17 * 60;
const WEEKEND_FIRST = 9 * 60;
const MORNING = 7 * 60;
/** The hours the week's timelines draw, on desktop and phone, and so where a drag can go. */
export const DRAWN_DAY = { from: 6 * 60, to: 23 * 60 };
/** A day counts as tight with less than this share of its open time free. */
export const TIGHT_SHARE = 0.15;

const onDay = (b: AvailabilityBlock, day: number) => b.days === 'all' || (b.days === 'weekdays') === (day < 5);

function blockedBy(b: AvailabilityBlock, day: Weekday, minute: TimeOfDay, kind: WorkKind): boolean {
  if (!(kind === 'one_off' ? b.one_offs : b.projects)) return false;
  if (b.from < b.to) return onDay(b, day) && minute >= b.from && minute < b.to;
  if (b.from === b.to) return false;
  return (onDay(b, day) && minute >= b.from) || (onDay(b, (day + 6) % 7) && minute < b.to);
}

export function isOpen(availability: AvailabilityBlock[], date: LocalDate, minute: TimeOfDay, kind: WorkKind): boolean {
  const day = weekday(date);
  return !availability.some((b) => blockedBy(b, day, minute, kind));
}

function overlaps(list: Slot[], date: LocalDate, start: TimeOfDay, end: TimeOfDay): boolean {
  return list.some((x) => x.date === date && x.start < end && start < x.end);
}

/** Before ctx.earliest: time that has gone by. */
export function isPast(date: LocalDate, start: TimeOfDay, ctx: SlotContext): boolean {
  return date < ctx.earliest.date || (date === ctx.earliest.date && start < ctx.earliest.minutes);
}

function isTaken(date: LocalDate, start: TimeOfDay, end: TimeOfDay, ctx: SlotContext): boolean {
  return overlaps(ctx.busy, date, start, end) || overlaps(ctx.placed, date, start, end);
}

function minutesWhere(test: (minute: TimeOfDay) => boolean): Minutes {
  let total = 0;
  for (let m = 0; m < 1440; m++) if (test(m)) total++;
  return total;
}

/** Open time from the unavailable list alone. */
export function dayBase(date: LocalDate, kind: WorkKind, availability: AvailabilityBlock[]): Minutes {
  return minutesWhere((m) => isOpen(availability, date, m, kind));
}

/** dayBase from ctx.earliest on, so a day gone by has none. */
export function dayBaseAhead(date: LocalDate, kind: WorkKind, ctx: SlotContext): Minutes {
  return minutesWhere((m) => !isPast(date, m, ctx) && isOpen(ctx.availability, date, m, kind));
}

/** Open time left after calendar events, from ctx.earliest on: time that has passed can't take work. */
export function dayAvail(date: LocalDate, kind: WorkKind, ctx: SlotContext): Minutes {
  return minutesWhere((m) => !isPast(date, m, ctx) && isOpen(ctx.availability, date, m, kind) && !overlaps(ctx.busy, date, m, m + 1));
}

/** The part of each span still to come, from ctx.earliest on. */
export function spansAhead(spans: readonly Span[], ctx: SlotContext): Span[] {
  const { date, minutes } = ctx.earliest;
  return spans.flatMap((s) => (s.date < date ? [] : s.date > date ? [s] : s.end > minutes ? [{ ...s, start: Math.max(s.start, minutes) }] : []));
}

/** Open time left after calendar events and placed blocks, from ctx.earliest on. A day counts as tight against dayBaseAhead. */
export function dayFree(date: LocalDate, kind: WorkKind, ctx: SlotContext): Minutes {
  return minutesWhere((m) => !isPast(date, m, ctx) && isOpen(ctx.availability, date, m, kind) && !isTaken(date, m, m + 1, ctx));
}

/** Whether new work can go here without a note: open hours, nothing in the way, not past. */
export function fits(date: LocalDate, start: TimeOfDay, minutes: Minutes, kind: WorkKind, ctx: SlotContext): boolean {
  const end = start + minutes;
  if (end > 1440 || isPast(date, start, ctx) || isTaken(date, start, end, ctx)) return false;
  for (let m = start; m < end; m++) if (!isOpen(ctx.availability, date, m, kind)) return false;
  return true;
}

function isOverdue(work: Work, ctx: SlotContext): boolean {
  return !!work.due && work.due < (ctx.earliest.date > ctx.week ? ctx.earliest.date : ctx.week);
}

const isLate = (date: LocalDate, work: Work, ctx: SlotContext) => !!work.due && date > work.due && !isOverdue(work, ctx);

function offerNote(o: Omit<Offer, 'note'>, index: number, work: Work, ctx: SlotContext, inWeek: boolean): string {
  if (o.late) return 'After due date';
  if (o.tight) return 'Tight day';
  if (index > 0) return '';
  if (!inWeek) return 'Lightest day';
  return isOverdue(work, ctx) ? 'Earliest open' : "Before it's due";
}

/** The best open start on one day: from the evening on weekdays and 9am at weekends, around the clock. */
export function dayOffer(date: LocalDate, minutes: Minutes, work: Work, ctx: SlotContext): TimeOfDay | null {
  const day = weekday(date);
  const first = isOverdue(work, ctx) ? 0 : day < 5 ? WEEKDAY_FIRST : WEEKEND_FIRST;
  for (let i = 0; i < 1440; i += GRID) {
    const start = (first + i) % 1440;
    if (ctx.avoided.some((a) => a.day === day && start >= a.from && start < a.to)) continue;
    if (fits(date, start, minutes, work.kind, ctx)) return start;
  }
  return null;
}

/**
 * The best open time on each day, best first. Days before a due date come first, and the earliest day leads
 * when a due date is set this week. Otherwise the emptiest day leads.
 */
export function offers(minutes: Minutes, work: Work, ctx: SlotContext): Offer[] {
  const last = addDays(ctx.week, 6);
  const inWeek = !!work.due && work.due <= last;
  const found: Omit<Offer, 'note'>[] = [];
  for (const date of weekDates(ctx.week)) {
    if (work.opens && date < work.opens && work.opens <= last) continue;
    const start = dayOffer(date, minutes, work, ctx);
    if (start === null) continue;
    found.push({
      date,
      start,
      end: start + minutes,
      load: ctx.placed.filter((p) => p.date === date).reduce((a, p) => a + p.end - p.start, 0),
      tight: dayFree(date, work.kind, ctx) - minutes < dayBaseAhead(date, work.kind, ctx) * TIGHT_SHARE,
      late: isLate(date, work, ctx),
    });
  }
  return found
    .sort(
      (a, b) =>
        Number(a.late) - Number(b.late) ||
        Number(a.tight) - Number(b.tight) ||
        (inWeek ? 0 : a.load - b.load) ||
        a.date.localeCompare(b.date),
    )
    .slice(0, 5)
    .map((o, i) => ({ ...o, note: offerNote(o, i, work, ctx, inWeek) }));
}

/** Block lengths to try, longest first. */
function lengths(minutes: Minutes): Minutes[] {
  const longest = Math.min(minutes, LONGEST_BLOCK);
  return [longest, ...[90, 60, 30].filter((x) => x < longest)];
}

/**
 * The time a task starts at. It never overlaps an event or block: a shorter block first, then any free time
 * in the drawn day, even outside available hours. Null when even that is full.
 */
export function defaultSlot(minutes: Minutes, work: Work, ctx: SlotContext): Slot | null {
  if (minutes <= 0) return null;
  for (const length of lengths(minutes)) {
    const best = offers(length, work, ctx)[0];
    if (best) return { date: best.date, start: best.start, end: best.end };
  }
  const length = Math.min(minutes, 30);
  for (const date of weekDates(ctx.week)) {
    for (let start = DRAWN_DAY.from; start + length <= DRAWN_DAY.to; start += GRID) {
      if (!isPast(date, start, ctx) && !isTaken(date, start, start + length, ctx)) return { date, start, end: start + length };
    }
  }
  return null;
}

/** Up to four other suggestions at the current block's length. */
export function otherOffers(current: Slot, work: Work, ctx: SlotContext): Offer[] {
  return offers(current.end - current.start, work, ctx)
    .filter((o) => !(o.date === current.date && o.start === current.start))
    .slice(0, 4);
}

/**
 * Where a drag lands: a 15-minute grid, snapping to a suggested time within 20 minutes. Dragging the bottom edge
 * changes the length. Any spot is allowed, and slotNotes says what's wrong with it.
 */
export function dragResult(
  slot: Slot,
  mode: 'move' | 'resize',
  dayDelta: number,
  minuteDelta: Minutes,
  targets: { date: LocalDate; start: TimeOfDay }[],
  range = DRAWN_DAY,
): Slot {
  const { date, start, end } = slot;
  const onGrid = (x: number) => Math.round(x / GRID) * GRID;
  if (dayDelta === 0 && Math.abs(minuteDelta) < GRID / 2) return { date, start, end };
  // A block under way starts before the range, and still can't end in time gone by.
  if (mode === 'resize') return { date, start, end: Math.min(range.to, Math.max(start + GRID, range.from, onGrid(end + minuteDelta))) };
  const day = weekday(date);
  const toDate = addDays(date, Math.max(0, Math.min(6, day + dayDelta)) - day);
  const length = end - start;
  const moved = Math.max(range.from, Math.min(range.to - length, onGrid(start + minuteDelta)));
  const hit = targets.find((t) => t.date === toDate && Math.abs(t.start - moved) <= SNAP);
  const toStart = hit ? hit.start : moved;
  return { date: toDate, start: toStart, end: toStart + length };
}

/**
 * Where work dropped at a minute of a day lands: the 15-minute grid within the drawn day, snapping to a suggested time
 * within 20 minutes. Null on a day gone by, or when no time is left in it.
 */
export function dropSlot(date: LocalDate, minute: number, length: Minutes, ctx: SlotContext, targets: readonly { date: LocalDate; start: TimeOfDay }[] = []): Slot | null {
  if (date < ctx.earliest.date) return null;
  const floor = Math.max(DRAWN_DAY.from, date === ctx.earliest.date ? Math.ceil(ctx.earliest.minutes / GRID) * GRID : 0);
  if (floor + length > DRAWN_DAY.to) return null;
  const at = Math.max(floor, Math.min(DRAWN_DAY.to - length, Math.round(minute / GRID) * GRID));
  const hit = targets.find((t) => t.date === date && t.start >= floor && Math.abs(t.start - at) <= SNAP);
  const start = hit ? hit.start : at;
  return { date, start, end: start + length };
}

/** The nearest time to `want` on that day where the work fits, or null. */
export function closestFit(date: LocalDate, want: TimeOfDay, minutes: Minutes, kind: WorkKind, ctx: SlotContext): TimeOfDay | null {
  let best: TimeOfDay | null = null;
  for (let start = 0; start + minutes <= 1440; start += GRID) {
    if (fits(date, start, minutes, kind, ctx) && (best === null || Math.abs(start - want) < Math.abs(best - want))) best = start;
  }
  return best;
}

/** What to say about a spot. Nothing here stops the user putting work there. */
export function slotNotes(span: Span, work: Work, ctx: SlotContext): string[] {
  const { date, start, end } = span;
  const notes: string[] = [];
  for (let m = start; m < end; m++) {
    if (!isOpen(ctx.availability, date, m, work.kind)) {
      notes.push("That's outside your available hours.");
      break;
    }
  }
  if (overlaps(ctx.busy, date, start, end)) notes.push('That overlaps busy time on your calendar.');
  for (const other of ctx.placed) {
    if (other.id !== span.id && overlaps([other], date, start, end)) notes.push(`That overlaps ${other.title}.`);
  }
  if (isLate(date, work, ctx)) notes.push("That's after it's due.");
  if (work.opens && date < work.opens) notes.push("That's before its date.");
  return notes;
}

interface PlaceRef {
  id: string;
  title: string;
  kind: WorkKind;
}

export interface PlaceItem extends Work {
  id: string;
  title: string;
  minutes: Minutes;
}

/** Place the rest at suggested times, in the order given. What doesn't fit is handed back, and stays to place. */
export function placeRest(
  items: PlaceItem[],
  ctx: SlotContext,
): { placed: (Slot & PlaceRef)[]; left: { id: string; minutes: Minutes }[] } {
  const placed: (Slot & PlaceRef)[] = [];
  const left: { id: string; minutes: Minutes }[] = [];
  for (const item of items) {
    let remaining = item.minutes;
    while (remaining > 0) {
      const within = { ...ctx, placed: [...ctx.placed, ...placed] };
      const best = lengths(remaining).map((length) => offers(length, item, within)[0]).find(Boolean);
      if (!best) {
        left.push({ id: item.id, minutes: remaining });
        break;
      }
      placed.push({ id: item.id, title: item.title, kind: item.kind, date: best.date, start: best.start, end: best.end });
      remaining -= best.end - best.start;
    }
  }
  return { placed, left };
}

export interface PracticeSession extends Slot {
  practice_id: string;
  /** Why it isn't at the day's time, such as '9:30am is taken, so 10am'. */
  note?: string;
}

const EVERY_DAY: Weekday[] = [0, 1, 2, 3, 4, 5, 6];
/** A weekly target with no count of sessions works out to sessions of up to this long. */
const LONGEST_SESSION = 60;
const isTime = (t: unknown): t is TimeOfDay => Number.isInteger(t) && (t as number) >= 0 && (t as number) < 1440;

/** How week_plan.skipped_sessions names one session. */
export const skippedSessionKey = (practiceId: string, date: LocalDate) => `${practiceId}:${date}`;

/** The days a practice is on, or for a weekly one the days its sessions go on first. */
export const practiceDays = (p: Practice): Weekday[] => p.days ?? EVERY_DAY;

/** A weekly practice's stored count of sessions, or null for none, or one that isn't a whole number from 1 to 7. */
export function storedSessions(p: Practice): number | null {
  const n = p.sessions;
  return p.per === 'week' && Number.isInteger(n) && n! >= 1 && n! <= 7 ? n! : null;
}

/** The days' own times, or null unless they're seven entries of null or a time of day. They arrive through sync. */
export function storedDayTimes(p: Practice): (TimeOfDay | null)[] | null {
  const t = p.day_times;
  return Array.isArray(t) && t.length === 7 && t.every((x) => x === null || isTime(x)) ? t : null;
}

/** Sessions a week: one on each of a daily practice's days, or a weekly one's count, else hour-long sessions, one a day at most. */
export function weeklySessions(p: Practice): number {
  if (p.per === 'day') return practiceDays(p).length;
  return storedSessions(p) ?? Math.min(7, Math.max(1, Math.ceil(p.target_min / LONGEST_SESSION)));
}

/** A session's length: a daily target, or a weekly one shared equally among its sessions, to the nearest 5 minutes. */
export function sessionLength(p: Practice): Minutes {
  return p.per === 'day' ? p.target_min : Math.max(5, Math.round(p.target_min / weeklySessions(p) / 5) * 5);
}

/** The time a practice aims for on a weekday: that day's own, on one of its days, else the usual time; null for any time. */
export function practiceTime(p: Practice, day: Weekday): TimeOfDay | null {
  const own = practiceDays(p).includes(day) ? storedDayTimes(p)?.[day] : null;
  return own ?? p.preferred_times?.[0] ?? null;
}

/** A time the clocks skip that night becomes the first that exists, 3am for 2:30am. */
function existingTime(date: LocalDate, minute: TimeOfDay, zone: string | undefined): TimeOfDay {
  if (!zone) return minute;
  for (let m = minute; m < 1440; m++) if (localMinutes(localToMs(date, m, zone), zone) === m) return m;
  return minute;
}

/**
 * Where a practice's session goes on a day: its time for that day if open, then its other preferred times, then the
 * nearest open time in 15-minute steps, earlier or later, with a note saying why. With no time, the first open time from
 * the morning. Null when the day has no room.
 */
function sessionStart(p: Practice, date: LocalDate, length: Minutes, ctx: SlotContext): { start: TimeOfDay; note?: string } | null {
  const works = (start: TimeOfDay) => start >= 0 && fits(date, start, length, 'project', ctx);
  const aim = practiceTime(p, weekday(date));
  if (aim === null) {
    for (let m = MORNING; m < 1440; m += GRID) if (works(m)) return { start: m };
    return null;
  }
  const want = existingTime(date, aim, ctx.zone);
  let start = [want, ...(p.preferred_times ?? []).slice(1)].find(works);
  for (let step = GRID; start === undefined && step < 1440; step += GRID) start = [want + step, want - step].find(works);
  if (start === undefined) return null;
  if (start === want) return { start };
  const closed = Array.from({ length }, (_, i) => want + i).some((m) => !isOpen(ctx.availability, date, m, 'project'));
  const why = isPast(date, want, ctx) ? 'has passed' : closed ? 'is outside your available hours' : 'is taken';
  return { start, note: `${formatTimeOfDay(want)} ${why}, so ${formatTimeOfDay(start)}` };
}

export interface PracticeLeft {
  practice: Practice;
  /** Each session's length. */
  length: Minutes;
  /** Sessions still to place. */
  sessions: number;
  minutes: Minutes;
  /** Set days: the days still waiting for their session, one each. */
  dates?: LocalDate[];
  /** A count: sessions the days left this week can no longer hold. */
  missed?: number;
}

const isLive = (p: Practice, skipped: readonly string[]) => p.state === 'active' && !p.deleted_at && p.target_min > 0 && !skipped.includes(p.id);

/** The days a practice's sessions are on or for. The part of a late session after midnight belongs to the day it started. */
function sessionDays(own: readonly Span[]): Set<LocalDate> {
  return new Set(own.flatMap((s) => (s.start === 0 && s.for && s.for !== s.date ? [s.for] : [s.for ?? s.date, s.date])));
}

/**
 * What a practice still needs this week. Set days: each of its days still to come with no session on or for it, and
 * not skipped. A count: its sessions less those placed this week, answered Skipped aside, on days still to come that
 * have none, one a day; what those days can't hold is missed.
 */
function practiceNeed(p: Practice, ctx: SlotContext, skippedSessions: readonly string[]) {
  const own = ctx.placed.filter((s) => s.practice_id === p.id);
  const taken = sessionDays(own);
  const free = weekDates(ctx.week).filter((d) => d >= ctx.earliest.date && !taken.has(d));
  const length = sessionLength(p);
  if (p.per === 'day') {
    const dates = free.filter((d) => practiceDays(p).includes(weekday(d)) && !skippedSessions.includes(skippedSessionKey(p.id, d)));
    return { length, dates, left: dates.length, missed: 0 };
  }
  const counted = new Set(own.filter((s) => !s.skipped && (s.for ?? s.date) >= ctx.week).map((s) => s.id ?? `${s.date} ${s.start}`));
  const want = Math.max(0, weeklySessions(p) - counted.size);
  const left = Math.min(want, free.length);
  return { length, dates: free, left, missed: want - left };
}

/** What each practice still needs this week. Skipped, paused and ended practices need nothing, nor does a week gone by. */
export function practicesLeft(
  practices: readonly Practice[],
  ctx: SlotContext,
  skipped: readonly string[] = [],
  skippedSessions: readonly string[] = [],
): PracticeLeft[] {
  if (addDays(ctx.week, 6) < ctx.earliest.date) return [];
  return practices
    .filter((p) => isLive(p, skipped))
    .flatMap((p) => {
      const { length, dates, left, missed } = practiceNeed(p, ctx, skippedSessions);
      if (left === 0) return [];
      return [{ practice: p, length, sessions: left, minutes: left * length, ...(p.per === 'day' ? { dates } : { missed }) }];
    });
}

/** k of the sessions, evenly spread: on the practice's days first, then the others. */
function spread(found: PracticeSession[], k: number, p: Practice): PracticeSession[] {
  const pick = (xs: PracticeSession[], n: number) => (n >= xs.length ? xs : Array.from({ length: n }, (_, i) => xs[Math.floor(((i + 0.5) * xs.length) / n)]!));
  const first = found.filter((s) => practiceDays(p).includes(weekday(s.date)));
  const rest = found.filter((s) => !first.includes(s));
  return [...pick(first, k), ...pick(rest, Math.max(0, k - first.length))].sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * A week's practice sessions still missing, at sessionStart's time. Set days get one on each day waiting that has room; a
 * count's are spread over the days left that have room, never two on a day. Sessions already placed stay as they are,
 * count toward the week, and the rest work around them.
 */
export function placePractices(
  practices: Practice[],
  ctx: SlotContext,
  { skipped = [], skippedSessions = [] }: { skipped?: readonly string[]; skippedSessions?: readonly string[] } = {},
): PracticeSession[] {
  const sessions: PracticeSession[] = [];
  for (const p of practices) {
    if (!isLive(p, skipped)) continue;
    const { length, dates, left } = practiceNeed(p, ctx, skippedSessions);
    if (left === 0) continue;
    const within = { ...ctx, placed: [...ctx.placed, ...sessions] };
    const found = dates.flatMap((date) => {
      const at = sessionStart(p, date, length, within);
      return at ? [{ practice_id: p.id, date, start: at.start, end: at.start + length, ...(at.note ? { note: at.note } : {}) }] : [];
    });
    sessions.push(...(p.per === 'day' ? found : spread(found, left, p)));
  }
  return sessions;
}

/** Where a practice's next sessions would go, as Place the rest puts them. */
export function practiceSlots(p: Practice, ctx: SlotContext, skippedSessions: readonly string[] = []): PracticeSession[] {
  return placePractices([p], ctx, { skippedSessions });
}

/** Cuts a time range at each local midnight, keeping only what falls in the week. */
function daySpans(startAt: Instant, endAt: Instant, week: LocalDate, zone: string): Slot[] {
  const end = Math.min(instantMs(endAt), localToMs(addDays(week, 7), 0, zone));
  const spans: Slot[] = [];
  let at = Math.max(instantMs(startAt), localToMs(week, 0, zone));
  while (at < end) {
    const date = localDate(at, zone);
    const midnight = localToMs(addDays(date, 1), 0, zone);
    const stop = Math.min(end, midnight);
    spans.push({ date, start: localMinutes(at, zone), end: stop === midnight ? 1440 : localMinutes(stop, zone) });
    at = stop;
  }
  return spans;
}

export interface PlacedBlock {
  id: string;
  start: Instant;
  end: Instant;
  title?: string | null;
  task_kind?: TaskKind | null;
  practice_id?: string | null;
  cancelled?: boolean;
  deleted_at?: Instant | null;
  result?: BlockResult | null;
}

/** Builds the context from records. Busy time is busyEvents, the same events that raise conflicts. */
export function slotContext(input: {
  week: LocalDate;
  availability: AvailabilityBlock[];
  avoided: AvoidedSlot[];
  sources: CalendarSource[];
  calendar: CalendarState | null;
  blocks: PlacedBlock[];
  clock: Clock;
}): SlotContext {
  const { week, availability, avoided, sources, calendar, blocks, clock } = input;
  const zone = clock.zone();
  const live = blocks.filter((b) => !b.cancelled && !b.deleted_at);
  const session = (b: PlacedBlock) =>
    b.practice_id ? { for: sessionDay(b.id, b.practice_id) ?? localDate(b.start, zone), ...(b.result === 'not' ? { skipped: true } : {}) } : {};
  return {
    week,
    availability,
    avoided,
    // Planning is busy time, as an event is: it takes open time rather than counting as work.
    busy: [
      ...busyEvents(calendar ?? undefined, sources).flatMap((e) => daySpans(e.start, e.end, week, zone).map((s) => ({ ...s, id: e.id, title: e.title }))),
      ...live.filter((b) => b.task_kind === 'planning').flatMap((b) => daySpans(b.start, b.end, week, zone).map((s) => ({ ...s, id: b.id, title: b.title }))),
    ],
    placed: live.flatMap((b) =>
      daySpans(b.start, b.end, week, zone).map((s) => ({
        ...s,
        id: b.id,
        title: b.title,
        kind: b.practice_id ? ('practice' as const) : b.task_kind,
        practice_id: b.practice_id ?? null,
        ...session(b),
      })),
    ),
    earliest: { date: today(clock), minutes: localMinutes(clock.now(), zone) },
    zone,
  };
}

/** Events on information-only calendars, for the Week view. Planning leaves them out, and work can go over them. */
export function infoSpans(input: { week: LocalDate; calendar: CalendarState | null; sources: CalendarSource[]; clock: Clock }): Span[] {
  const info = new Set(input.sources.filter((s) => !s.deleted_at && s.mode === 'info').map((s) => s.google_id));
  return (input.calendar?.events ?? [])
    .filter((e) => !e.all_day && info.has(e.calendar))
    .flatMap((e) => daySpans(e.start, e.end, input.week, input.clock.zone()).map((s) => ({ ...s, id: e.id, title: e.title })));
}

/** A slot as the start and end a time block stores. */
export function slotInstants({ date, start, end }: Slot, zone: string): { start: Instant; end: Instant } {
  return {
    start: localToInstant(date, start, zone),
    end: end >= 1440 ? localToInstant(addDays(date, 1), 0, zone) : localToInstant(date, end, zone),
  };
}

// Where work can go in a week: open time, suggested times, placing tasks and practices, and drag rules.
// Everything works on local dates and minutes after midnight, so evenings stay put across daylight saving.
// slotContext turns records into that form, and slotInstants turns a chosen time back into instants.

import type { Clock } from './clock';
import { addDays, instantMs, localDate, localMinutes, localToInstant, localToMs, today, weekday, weekDates } from './dates';
import { busyEvents } from './queue';
import type {
  AvailabilityBlock,
  AvoidedSlot,
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
}

const EVERY_DAY: Weekday[] = [0, 1, 2, 3, 4, 5, 6];

/**
 * A week's practice sessions: the first preferred time that's open, otherwise the first open slot that day. A daily
 * practice has no session on a day with no room; a weekly one's sessions go on its next days that have room, so one
 * placed midweek still gets them all. Sessions edited for this week stay as they are and count toward the week: pass
 * them in `edited`, and keep them in ctx.placed so that the rest work around them.
 */
export function placePractices(
  practices: Practice[],
  ctx: SlotContext,
  { skipped = [], edited = [] }: { skipped?: string[]; edited?: { practice_id: string; date: LocalDate }[] } = {},
): PracticeSession[] {
  const sessions: PracticeSession[] = [];
  for (const p of practices) {
    if (p.state !== 'active' || p.deleted_at || p.target_min <= 0 || skipped.includes(p.id)) continue;
    const length = p.per === 'day' ? p.target_min : Math.min(p.target_min, 60);
    const kept = edited.filter((e) => e.practice_id === p.id);
    let wanted = p.per === 'day' ? Infinity : Math.ceil(p.target_min / length) - kept.length;
    for (const day of p.days ?? EVERY_DAY) {
      if (wanted <= 0) break;
      const date = addDays(ctx.week, day);
      if (kept.some((e) => e.date === date)) continue;
      const within = { ...ctx, placed: [...ctx.placed, ...sessions] };
      const works = (start: TimeOfDay) => fits(date, start, length, 'project', within);
      let start = (p.preferred_times ?? []).find(works);
      for (let m = MORNING; start === undefined && m < 1440; m += GRID) if (works(m)) start = m;
      if (start === undefined) continue;
      sessions.push({ practice_id: p.id, date, start, end: start + length });
      wanted--;
    }
  }
  return sessions;
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
  return {
    week,
    availability,
    avoided,
    busy: busyEvents(calendar ?? undefined, sources).flatMap((e) => daySpans(e.start, e.end, week, zone).map((s) => ({ ...s, id: e.id, title: e.title }))),
    placed: blocks
      .filter((b) => !b.cancelled && !b.deleted_at)
      .flatMap((b) =>
        daySpans(b.start, b.end, week, zone).map((s) => ({
          ...s,
          id: b.id,
          title: b.title,
          kind: b.practice_id ? ('practice' as const) : b.task_kind,
        })),
      ),
    earliest: { date: today(clock), minutes: localMinutes(clock.now(), zone) },
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

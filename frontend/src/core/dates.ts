// Local dates, weeks and instants. No function reads the system clock or zone: pass a Clock or a zone.
// Weeks start on Monday. Local dates are plain strings and their arithmetic is zone-free; only converting
// between a local date and an instant needs a zone, which is what keeps evenings still across daylight saving.

import type { Clock } from './clock';
import type { Instant, LocalDate, Minutes, TimeOfDay, Weekday } from './types';

const DAY_MS = 86_400_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
const WEEKDAYS_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** The one instant format: UTC to the second. Queries compare instants as text, so it must never vary. */
export function toInstant(ms: number): Instant {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');
}

/** A 'YYYY-MM-DD' that names a real day, for checking what a date field or a synced record holds. */
export const isDay = (d: unknown): d is LocalDate => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d));

export function instantMs(instant: Instant): number {
  return Date.parse(instant);
}

/** A block's planned length in whole minutes. */
export const blockMinutes = (b: { start: Instant; end: Instant }): Minutes => Math.round((instantMs(b.end) - instantMs(b.start)) / 60_000);

export function nowInstant(clock: Clock): Instant {
  return toInstant(clock.now());
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(zone, f);
  }
  return f;
}

interface WallTime {
  date: LocalDate;
  minutes: TimeOfDay;
  seconds: number;
}

function wallTime(ms: number, zone: string): WallTime {
  const parts: Record<string, number> = {};
  for (const p of formatter(zone).formatToParts(ms)) if (p.type !== 'literal') parts[p.type] = Number(p.value);
  return {
    date: `${pad(parts.year!, 4)}-${pad(parts.month!)}-${pad(parts.day!)}`,
    minutes: parts.hour! * 60 + parts.minute!,
    seconds: parts.second!,
  };
}

/** The local date at an instant. */
export function localDate(at: number | Instant, zone: string): LocalDate {
  return wallTime(typeof at === 'number' ? at : instantMs(at), zone).date;
}

/** Minutes after local midnight at an instant. */
export function localMinutes(at: number | Instant, zone: string): TimeOfDay {
  return wallTime(typeof at === 'number' ? at : instantMs(at), zone).minutes;
}

export function today(clock: Clock): LocalDate {
  return localDate(clock.now(), clock.zone());
}

function offsetMs(ms: number, zone: string): number {
  const w = wallTime(ms, zone);
  const asUtc = dayNumber(w.date) * DAY_MS + w.minutes * 60_000 + w.seconds * 1000;
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * The instant of a local date and time. A time skipped by daylight saving lands the same distance after the
 * jump, and a time that happens twice gives the earlier one.
 */
export function localToMs(date: LocalDate, minutes: TimeOfDay, zone: string): number {
  const asUtc = dayNumber(date) * DAY_MS + minutes * 60_000;
  // A zone's offset changes at most once either side of a date, so these two guesses cover every case.
  const offsets = [offsetMs(asUtc - DAY_MS, zone), offsetMs(asUtc + DAY_MS, zone)];
  const before = offsets[0]!;
  const after = offsets[1]!;
  const candidates = [asUtc - before, asUtc - after].sort((a, b) => a - b);
  for (const c of candidates) {
    const w = wallTime(c, zone);
    if (w.date === date && w.minutes === minutes) return c;
  }
  return asUtc - before;
}

export function localToInstant(date: LocalDate, minutes: TimeOfDay, zone: string): Instant {
  return toInstant(localToMs(date, minutes, zone));
}

/** A half-open UTC range, in the parameter names block queries take. */
export interface UtcRange {
  from_utc: Instant;
  to_utc: Instant;
}

export function dayRange(date: LocalDate, zone: string): UtcRange {
  return { from_utc: localToInstant(date, 0, zone), to_utc: localToInstant(addDays(date, 1), 0, zone) };
}

export function weekRange(weekStartDate: LocalDate, zone: string): UtcRange {
  return { from_utc: localToInstant(weekStartDate, 0, zone), to_utc: localToInstant(addDays(weekStartDate, 7), 0, zone) };
}

/** Days since 1970-01-01. Subtract two to count days between dates. */
export function dayNumber(date: LocalDate): number {
  return Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) / DAY_MS;
}

export function fromDayNumber(n: number): LocalDate {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

export function addDays(date: LocalDate, days: number): LocalDate {
  return fromDayNumber(dayNumber(date) + days);
}

/** Whole days from a to b. */
export function diffDays(a: LocalDate, b: LocalDate): number {
  return dayNumber(b) - dayNumber(a);
}

export function weekday(date: LocalDate): Weekday {
  return ((((dayNumber(date) + 3) % 7) + 7) % 7) as Weekday;
}

/** The Monday of a date's week. */
export function weekStart(date: LocalDate): LocalDate {
  return addDays(date, -weekday(date));
}

export function addWeeks(date: LocalDate, weeks: number): LocalDate {
  return addDays(date, weeks * 7);
}

export function weekDates(weekStartDate: LocalDate): LocalDate[] {
  return Array.from({ length: 7 }, (_, i) => addDays(weekStartDate, i));
}

export function thisWeek(clock: Clock): LocalDate {
  return weekStart(today(clock));
}

/** Adds months, landing on the month's last day when the day doesn't exist there. */
export function addMonths(date: LocalDate, months: number): LocalDate {
  const total = Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1 + months;
  const year = Math.floor(total / 12);
  const month = total - year * 12 + 1;
  const first = `${pad(year, 4)}-${pad(month)}-01`;
  return `${first.slice(0, 8)}${pad(Math.min(Number(date.slice(8, 10)), Number(monthEnd(first).slice(8, 10))))}`;
}

export function monthStart(date: LocalDate): LocalDate {
  return `${date.slice(0, 8)}01`;
}

export function monthEnd(date: LocalDate): LocalDate {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

export function quarterStart(date: LocalDate): LocalDate {
  const month = Number(date.slice(5, 7));
  return `${date.slice(0, 5)}${pad(month - ((month - 1) % 3))}-01`;
}

export function quarterEnd(date: LocalDate): LocalDate {
  return addDays(addMonths(quarterStart(date), 3), -1);
}

/** 'Nov 2' */
export function formatDate(date: LocalDate): string {
  return `${MONTHS[Number(date.slice(5, 7)) - 1]} ${Number(date.slice(8, 10))}`;
}

/** 'Nov' */
export function formatMonth(date: LocalDate): string {
  return MONTHS[Number(date.slice(5, 7)) - 1]!;
}

/** 'Mon' */
export function formatWeekday(date: LocalDate): string {
  return WEEKDAYS[weekday(date)]!;
}

/** 'Monday, Nov 2' */
export function formatDayLong(date: LocalDate): string {
  return `${WEEKDAYS_LONG[weekday(date)]}, ${formatDate(date)}`;
}

/** 'Nov 2 to 8', or 'Oct 26 to Nov 1' across months. */
export function formatWeekRange(weekStartDate: LocalDate): string {
  const end = addDays(weekStartDate, 6);
  return `${formatDate(weekStartDate)} to ${end.slice(5, 7) === weekStartDate.slice(5, 7) ? Number(end.slice(8, 10)) : formatDate(end)}`;
}

/** '8pm', '8:30am', '12pm'. */
export function formatTimeOfDay(minutes: TimeOfDay): string {
  const m = ((minutes % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  const hour = h % 12 || 12;
  const mins = m % 60;
  return `${hour}${mins ? `:${pad(mins)}` : ''}${h < 12 ? 'am' : 'pm'}`;
}

/** An instant as a local time, such as '8:30pm'. */
export function formatTime(at: number | Instant, zone: string): string {
  return formatTimeOfDay(localMinutes(at, zone));
}

/** '45m', '2h', '1h 30m'. */
export function formatMinutes(minutes: Minutes): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h && m ? `${h}h ${m}m` : h ? `${h}h` : `${m}m`;
}

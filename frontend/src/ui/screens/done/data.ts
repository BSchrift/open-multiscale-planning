// What Done reads, and Today's line, Week's day headings and More with it, all from core/done.ts.

import type { Clock } from '../../../core/clock';
import { formatMinutes, today, weekDates } from '../../../core/dates';
import type { Sql } from '../../../core/db';
import { doneOn, loadDone } from '../../../core/done';
import type { DoneDay } from '../../../core/done';
import type { LocalDate } from '../../../core/types';

export async function loadDoneDay(sql: Sql, clock: Clock, day: LocalDate): Promise<DoneDay> {
  return doneOn(day, await loadDone(sql, clock, day), clock);
}

/** How many things were finished on each day of a week, up to today, which is as far as Done goes. */
export async function loadDoneWeek(sql: Sql, clock: Clock, week: LocalDate): Promise<Record<LocalDate, number>> {
  const days = weekDates(week).filter((d) => d <= today(clock));
  if (!days.length) return {};
  const records = await loadDone(sql, clock, days[0]!, days.at(-1)!);
  return Object.fromEntries(days.map((d) => [d, doneOn(d, records, clock).total.finished]));
}

/** Today's line after the first finish, '· 4 · 4h 30m', or null before it. */
export function todayLine(day: DoneDay): string | null {
  const { finished, worked_min } = day.total;
  if (!finished) return null;
  return worked_min ? `· ${finished} · ${formatMinutes(worked_min)}` : `· ${finished}`;
}

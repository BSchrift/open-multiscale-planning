import type { Clock } from '../../../core/clock';
import { dayRange, today } from '../../../core/dates';
import type { Sql } from '../../../core/db';
import { completionsSince, oneOffTasks } from '../../../core/queries';
import { oneOffRows } from '../../../core/schedule';
import type { OneOffRow } from '../../../core/schedule';

/** The One offs list as it stands today, with today's ticks. */
export async function oneOffList(sql: Sql, clock: Clock): Promise<OneOffRow[]> {
  const since = dayRange(today(clock), clock.zone()).from_utc;
  const tasks = await oneOffTasks(sql, { since });
  const done = await completionsSince(sql, { since });
  return oneOffRows(tasks, done, clock);
}

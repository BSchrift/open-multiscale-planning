import type { Clock } from '../../../core/clock';
import { formatMinutes, today } from '../../../core/dates';
import type { Sql } from '../../../core/db';
import { loadDoneDay } from './data';

/** Done's row under More: '4 finished today, 4h 30m worked'. */
export async function moreLine(sql: Sql, clock: Clock): Promise<string | null> {
  const { finished, worked_min } = (await loadDoneDay(sql, clock, today(clock))).total;
  if (!finished) return 'Nothing finished yet today';
  return worked_min ? `${finished} finished today, ${formatMinutes(worked_min)} worked` : `${finished} finished today`;
}

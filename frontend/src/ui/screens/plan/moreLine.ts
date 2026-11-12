import type { Clock } from '../../../core/clock';
import { today } from '../../../core/dates';
import type { Sql } from '../../../core/db';
import { getSettings } from '../../../core/records';
import { readFlow, withProgress } from './flowState';
import { whereNow } from './model';

/** The live line under this area's row on the phone's More page. */
export async function moreLine(sql: Sql, clock: Clock): Promise<string | null> {
  // shortcut: the line re-reads on data changes, so starting the flow without writing anything shows on the next one.
  const settings = await getSettings(sql);
  const on = today(clock);
  return whereNow(settings, on, withProgress(readFlow(), settings, on)).moreLine;
}

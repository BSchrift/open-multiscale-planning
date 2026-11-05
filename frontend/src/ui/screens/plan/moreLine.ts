import type { Clock } from '../../../core/clock';
import { today } from '../../../core/dates';
import type { Sql } from '../../../core/db';
import { getSettings } from '../../../core/records';
import { readFlow } from './flowState';
import { whereNow } from './model';

/** The live line under this area's row on the phone's More page. */
export async function moreLine(sql: Sql, clock: Clock): Promise<string | null> {
  // shortcut: the line re-reads on data changes, so starting the flow without writing anything shows on the next one.
  return whereNow(await getSettings(sql), today(clock), readFlow()).moreLine;
}

import type { Clock } from '../../../core/clock';
import type { Sql } from '../../../core/db';
import { oneOffList } from './rows';

/** The live line under this area's row on the phone's More page. */
export async function moreLine(sql: Sql, clock: Clock): Promise<string | null> {
  const open = (await oneOffList(sql, clock)).filter((r) => !r.checked).length;
  return open ? `${open} to do` : null;
}

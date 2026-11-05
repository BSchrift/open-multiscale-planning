import { availableHours } from '../../../core/capacity';
import type { Clock } from '../../../core/clock';
import { formatMinutes, thisWeek } from '../../../core/dates';
import type { Sql } from '../../../core/db';
import { getSettings } from '../../../core/records';

/** The live line under this area's row on the phone's More page. */
export async function moreLine(sql: Sql, clock: Clock): Promise<string | null> {
  const settings = await getSettings(sql);
  const hours = availableHours(settings.availability, thisWeek(clock));
  const aim = settings.one_offs_weekly_aim ? `${formatMinutes(settings.one_offs_weekly_aim)} One offs aim` : 'no One offs aim';
  return `${formatMinutes(hours.project)} a week for projects, ${aim}`;
}

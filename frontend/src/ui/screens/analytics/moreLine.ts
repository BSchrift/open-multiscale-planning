import { loadAnalyticsData, weekAnalytics } from '../../../core/analytics';
import type { Clock } from '../../../core/clock';
import { formatMinutes, thisWeek } from '../../../core/dates';
import type { Sql } from '../../../core/db';

/** The live line under this area's row on the phone's More page, such as "75% reliable this week, 7h of 13h so far". */
export async function moreLine(sql: Sql, clock: Clock): Promise<string | null> {
  const { reliability, time } = weekAnalytics(await loadAnalyticsData(sql), clock, thisWeek(clock));
  const parts: string[] = [];
  if (reliability.project.total) parts.push(`${reliability.project.pct}% reliable this week`);
  if (time.planned_min) parts.push(`${formatMinutes(time.delivered_min)} of ${formatMinutes(time.planned_min)} so far`);
  return parts.join(', ') || null;
}

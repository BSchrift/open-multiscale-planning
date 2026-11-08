// Everything Today reads, in one query that re-runs on every change.

import type { Clock } from '../../../core/clock';
import { dayRange, instantMs, thisWeek, toInstant, today } from '../../../core/dates';
import type { Sql } from '../../../core/db';
import { blocksInRange, completionsSince, inboxCount, needsNewTime } from '../../../core/queries';
import { busyEvents, queueItems } from '../../../core/queue';
import { CALENDAR_ID, getRecord, getSettings, listRecords } from '../../../core/records';
import { listProjects } from '../../../core/slipLog';
import { isSignedIn, syncStatus } from '../../../core/sync';

const DAY_MS = 86_400_000;
/** Welcome back looks this far back for missed blocks. */
const RECENT_DAYS = 90;

export async function loadToday(sql: Sql, clock: Clock) {
  const date = today(clock);
  const day = dayRange(date, clock.zone());
  const recent = await blocksInRange(sql, { from_utc: toInstant(clock.now() - RECENT_DAYS * DAY_MS), to_utc: day.to_utc });
  const calendar = await getRecord(sql, 'calendar', CALENDAR_ID);
  const sources = await listRecords(sql, 'calendar_source');
  const plans = await listRecords(sql, 'week_plan');
  const picks = await listRecords(sql, 'week_pick');
  const [from, to] = [instantMs(day.from_utc), instantMs(day.to_utc)];
  return {
    date,
    recent,
    blocks: recent.filter((b) => b.start >= day.from_utc),
    settings: await getSettings(sql),
    // shortcut: whole tables for lookups and Welcome back's options, fine for one person's records; narrow with queries if Today slows.
    tasks: await listRecords(sql, 'task'),
    projects: await listProjects(sql),
    milestones: await listRecords(sql, 'milestone'),
    objectives: await listRecords(sql, 'objective'),
    practices: await listRecords(sql, 'practice'),
    away: await listRecords(sql, 'away_period'),
    completions: await completionsSince(sql, { since: day.from_utc }),
    planned: plans.some((p) => p.week_start === thisWeek(clock) && !!p.finished_at),
    events: busyEvents(calendar, sources).filter((e) => instantMs(e.start) < to && from < instantMs(e.end)),
    // For the timeline's suggested time and its notes on a moved block.
    calendar: calendar ?? null,
    sources,
    connected: !!calendar?.connected,
    signedIn: isSignedIn(await syncStatus(sql)),
    queue: queueItems(await needsNewTime(sql), plans, picks, clock),
    inbox: await inboxCount(sql),
  };
}

export type TodayData = Awaited<ReturnType<typeof loadToday>>;

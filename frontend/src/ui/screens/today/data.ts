// Everything Today reads, in one query that re-runs on every change.

import type { Clock } from '../../../core/clock';
import { addWeeks, dayRange, instantMs, thisWeek, toInstant, today } from '../../../core/dates';
import { loadTaskPlanning, loadWeekPlanning, planningId, stretchPlanningDue } from '../../../core/planning';
import type { Sql } from '../../../core/db';
import { activeMilestones, blocksInRange, completionsSince, inboxCount, needsNewTime, shownTasks, todayPlans, weekPicks } from '../../../core/queries';
import { busyEvents, lastPlan, queueItems } from '../../../core/queue';
import { CALENDAR_ID, getRecord, getSettings, listRecords } from '../../../core/records';
import { isSignedIn, syncStatus } from '../../../core/sync';
import type { LocalDate } from '../../../core/types';
import type { WeekData } from '../week/data';

const DAY_MS = 86_400_000;
/** Welcome back looks this far back for missed blocks. */
const RECENT_DAYS = 90;

export async function loadToday(sql: Sql, clock: Clock) {
  const date = today(clock);
  const day = dayRange(date, clock.zone());
  const recent = await blocksInRange(sql, { from_utc: toInstant(clock.now() - RECENT_DAYS * DAY_MS), to_utc: day.to_utc });
  const calendar = await getRecord(sql, 'calendar', CALENDAR_ID);
  const sources = await listRecords(sql, 'calendar_source');
  // The weeks of plans and picks the queue and the prompt to plan look at, not every week's.
  const plans = await todayPlans(sql, thisWeek(clock));
  const picks = await weekPicks(sql, lastPlan(plans)?.week_start ?? null);
  const [from, to] = [instantMs(day.from_utc), instantMs(day.to_utc)];
  return {
    date,
    recent,
    blocks: recent.filter((b) => b.start >= day.from_utc),
    settings: await getSettings(sql),
    // Open tasks, every task of an active project, those finished today and those today's blocks name, and the active
    // projects' milestones: what Pick one thing, Next up, One offs, the timeline, the queue and the prompt to plan look
    // up, not five years of finished work.
    tasks: await shownTasks(sql, { doneFrom: day.from_utc, blocks: day }),
    projects: await listRecords(sql, 'project'),
    milestones: await activeMilestones(sql),
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
    // This week's planning, for the prompt to plan it, and next week's, for its row.
    planning: {
      this: await loadWeekPlanning(sql, thisWeek(clock)),
      next: await loadWeekPlanning(sql, addWeeks(thisWeek(clock), 1)),
      stretch: await stretchPlanning(sql, date),
    },
  };
}

/** The stretch whose planning is due, with its task and blocks. */
async function stretchPlanning(sql: Sql, date: string) {
  const due = stretchPlanningDue(await getSettings(sql), date);
  return due ? { ...due, ...(await loadTaskPlanning(sql, planningId(due))) } : null;
}

export type TodayData = Awaited<ReturnType<typeof loadToday>>;

/** What a day's timeline reads: today's, from loadToday, or another day of a week, from dayOfWeek. */
export type DayData = Pick<TodayData, 'date' | 'blocks' | 'events' | 'tasks' | 'projects' | 'objectives' | 'practices' | 'settings' | 'sources' | 'calendar' | 'away' | 'planned'>;

/** A day of a week Week's query read, for the phone's Today to draw any day of the week as it draws today. */
export function dayOfWeek(week: WeekData, date: LocalDate, zone: string): DayData {
  const day = dayRange(date, zone);
  const [from, to] = [instantMs(day.from_utc), instantMs(day.to_utc)];
  const { records } = week;
  return {
    date,
    blocks: week.blocks.filter((b) => b.start >= day.from_utc && b.start < day.to_utc),
    events: busyEvents(week.calendar ?? undefined, week.sources).filter((e) => instantMs(e.start) < to && from < instantMs(e.end)),
    tasks: records.tasks,
    projects: records.projects,
    objectives: records.objectives,
    practices: records.practices,
    settings: week.settings,
    sources: week.sources,
    calendar: week.calendar,
    away: records.away,
    planned: week.weekPlans.some((p) => p.week_start === week.week && !!p.finished_at),
  };
}

// How full a week is: open time, planned time, weekly aims, congestion and wiggle room. Open time is the hours
// outside the unavailable list, minus calendar events. Aims are soft, so nothing here ever blocks.

import { weekAnalytics } from './analytics';
import type { AnalyticsData } from './analytics';
import type { Clock } from './clock';
import { formatDate, formatMinutes, formatWeekday, thisWeek, weekDates } from './dates';
import { dayAvail, dayBase, dayBaseAhead, dayFree, spansAhead, TIGHT_SHARE } from './slots';
import type { SlotContext, Span, WorkKind } from './slots';
import { ONE_OFFS_BUCKET } from './types';
import type { AvailabilityBlock, LocalDate, Minutes, Project, WeekPlan } from './types';

/** Weekly hours per kind of work, from the unavailable list alone. */
export function availableHours(availability: AvailabilityBlock[], week: LocalDate): Record<WorkKind, Minutes> {
  const sum = (kind: WorkKind) => weekDates(week).reduce((a, d) => a + dayBase(d, kind, availability), 0);
  return { project: sum('project'), one_off: sum('one_off') };
}

/** The week's open time still to come: available hours minus calendar events, from ctx.earliest on. */
export function openTime(ctx: SlotContext, kind: WorkKind = 'project'): Minutes {
  return weekDates(ctx.week).reduce((a, d) => a + dayAvail(d, kind, ctx), 0);
}

export function plannedByKind(spans: Span[]): { project: Minutes; one_off: Minutes; practice: Minutes; total: Minutes } {
  const out = { project: 0, one_off: 0, practice: 0, total: 0 };
  for (const s of spans) {
    // Planning is busy time, already out of the open time.
    if (s.kind === 'planning') continue;
    const length = s.end - s.start;
    out[s.kind === 'one_off' || s.kind === 'practice' ? s.kind : 'project'] += length;
    out.total += length;
  }
  return out;
}

/** What gets pushed back in a usual week: average planned minus done over finished weeks, to the nearest 30 minutes. */
export function recentPushback(weeks: { planned: Minutes; done: Minutes }[]): Minutes {
  if (!weeks.length) return 0;
  const average = weeks.reduce((a, w) => a + w.planned - w.done, 0) / weeks.length;
  return Math.max(0, Math.round(average / 30) * 30);
}

/** recentPushback over the last four weeks planned and finished before this one, the same for Week and planning. */
export function pushbackLately(weekPlans: readonly WeekPlan[], data: AnalyticsData, clock: Clock): Minutes {
  const finished = weekPlans
    .filter((p) => p.finished_at && p.week_start < thisWeek(clock))
    .map((p) => p.week_start)
    .sort()
    .slice(-4);
  return recentPushback(
    finished.map((w) => {
      const { time } = weekAnalytics(data, clock, w);
      return { planned: time.planned_min, done: time.delivered_min };
    }),
  );
}

/** `placed` is time placed that wasn't picked, from placedMinutes. Share is what the capacity ring draws. */
export function weekUse({ open, placed, picked }: { open: Minutes; placed: Minutes; picked: Minutes }) {
  const used = placed + picked;
  return { used, free: open - used, over: Math.max(0, used - open), share: used / (open || 1) };
}

/** The theme's blue to its red, squared so that a half-full ring still looks calm. */
export function ringColor(share: number): string {
  const t = Math.max(0, Math.min(1, share)) ** 2;
  return `color-mix(in srgb, var(--red) ${Math.round(t * 100)}%, var(--blue))`;
}

/** The line under Pick tasks, when what's left is less than what usually gets pushed back. */
export function pickWarning(free: Minutes, pushback: Minutes): string | null {
  if (free >= pushback) return null;
  return free < 0
    ? "What doesn't fit stays on its project or in One offs."
    : `That leaves ${formatMinutes(free)} free. You've pushed back about ${formatMinutes(pushback)} a week lately.`;
}

export interface AimRow {
  /** A project id, or ONE_OFFS_BUCKET. */
  bucket: string;
  aim: Minutes;
  got: Minutes;
  short: Minutes;
  skipped: boolean;
  met: boolean;
  /** Bar and tick positions on a shared scale. */
  pct: number;
  tickPct: number;
}

/** A row per active project with an aim this week, then One offs. `got` is minutes by bucket. */
export function weeklyAims(input: {
  projects: Project[];
  oneOffsAim: Minutes | null | undefined;
  weekPlan: Pick<WeekPlan, 'aims' | 'skipped_aims'> | null;
  got: Record<string, Minutes>;
}): AimRow[] {
  const { projects, oneOffsAim, weekPlan, got } = input;
  const row = (bucket: string, usual: Minutes | null | undefined): AimRow => {
    const aim = weekPlan?.aims?.[bucket] ?? usual ?? 0;
    const value = got[bucket] ?? 0;
    const skipped = !!weekPlan?.skipped_aims?.includes(bucket);
    const scale = Math.max(aim, value, 1);
    return {
      bucket,
      aim,
      got: value,
      short: skipped ? 0 : Math.max(0, aim - value),
      skipped,
      met: value >= aim,
      pct: Math.round((value / scale) * 100),
      tickPct: Math.round((aim / scale) * 100),
    };
  };
  const rows = projects.filter((p) => p.state === 'active' && !p.deleted_at).map((p) => row(p.id, p.weekly_aim));
  return [...rows.filter((r) => r.aim > 0), row(ONE_OFFS_BUCKET, oneOffsAim)];
}

export interface DayLoad {
  date: LocalDate;
  base: Minutes;
  free: Minutes;
  tight: boolean;
}

/** Congestion: each day's open hours, what's free after events and blocks, and whether it's packed, from ctx.earliest on. */
export function dayLoads(ctx: SlotContext): DayLoad[] {
  return weekDates(ctx.week).map((date) => {
    const base = dayBaseAhead(date, 'project', ctx);
    const free = dayFree(date, 'project', ctx);
    return { date, base, free, tight: free < base * TIGHT_SHARE };
  });
}

/** Warnings for the week as placed in ctx. Wiggle room is the open time left minus the placed time still ahead. */
export function weekAlerts(ctx: SlotContext, aims: AimRow[], pushback: Minutes): { title: string; text: string }[] {
  const alerts: { title: string; text: string }[] = [];
  const wiggle = openTime(ctx) - plannedByKind(spansAhead(ctx.placed, ctx)).total;
  if (wiggle < pushback) {
    const full = wiggle <= 0;
    alerts.push({
      title: full ? 'No room left this week' : 'Little room to spare',
      text: `${full ? 'The plan fills all your available time.' : `Only ${formatMinutes(wiggle)} is free.`} You've pushed back about ${formatMinutes(pushback)} a week lately, so unfinished work may not fit.`,
    });
  }
  // Aims are for the whole week, so they're weighed against all of it.
  const weekOpen = openTime({ ...ctx, earliest: { date: ctx.week, minutes: 0 } });
  if (aims.reduce((a, r) => a + (r.skipped ? 0 : r.aim), 0) > weekOpen) {
    alerts.push({ title: "Aims don't fit", text: 'Your weekly aims add up to more than the time available.' });
  }
  const oneOffs = aims.find((r) => r.bucket === ONE_OFFS_BUCKET);
  const short = aims.filter((r) => r.bucket !== ONE_OFFS_BUCKET && r.short > 0).length;
  if (oneOffs && oneOffs.got > oneOffs.aim && short > 0) {
    alerts.push({
      title: 'One offs are crowding out projects',
      text: `They're ${formatMinutes(oneOffs.got - oneOffs.aim)} over their aim while ${short} ${short === 1 ? 'project is' : 'projects are'} short.`,
    });
  }
  for (const day of dayLoads(ctx)) {
    if (day.tight) {
      alerts.push({
        title: `${formatWeekday(day.date)} ${formatDate(day.date)} is packed`,
        text: `${formatMinutes(day.free)} free of ${formatMinutes(day.base)} available that day.`,
      });
    }
  }
  return alerts;
}

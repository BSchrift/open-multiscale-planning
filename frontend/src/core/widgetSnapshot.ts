// What the iPhone's widgets draw from. The widget extension runs in its own process and can't read the database or the
// web view, so the app writes this small snapshot of today and tomorrow into the App Group, and the widgets read only
// it (frontend/ios/App/MultiscaleWidgets). Built here by a pure function from the same queries Today uses, beside the
// reminders. The shape is a contract with the Swift side: widgetFixtures.test.ts writes the JSON both sides test against.

import { plannedByKind, weeklyAims } from './capacity';
import type { Clock } from './clock';
import { addDays, dayRange, instantMs, toInstant, today, weekDates, weekRange, weekStart } from './dates';
import { getMeta, META } from './db';
import type { Sql } from './db';
import { gatherPlans, plannable } from './plan';
import type { PlanContext } from './plan';
import { blocksInRange, inboxCount } from './queries';
import type { BlockRow } from './queries';
import { busyEvents } from './queue';
import { CALENDAR_ID, getRecord, getSettings, listRecords } from './records';
import { isLive, slotContext, weeklySessions } from './slots';
import { status } from './status';
import type { StatusTone } from './status';
import { isSignedOut, syncStatus } from './sync';
import { ONE_OFFS_BUCKET } from './types';
import type { BlockResult, CalendarEvent, Instant, LocalDate, Minutes, WeekPlan } from './types';

/** Bumped only for a change an older widget would misread. A widget that finds a newer one says "Open Multiscale". */
export const WIDGET_SNAPSHOT_VERSION = 1;
/** The App Group file stays small whatever the plan: titles are cut and blocks and events capped, then the rest dropped. */
export const WIDGET_SNAPSHOT_MAX_BYTES = 64 * 1024;
export const WIDGET_TITLE_MAX = 120;
export const WIDGET_MAX_BLOCKS = 60;
export const WIDGET_MAX_EVENTS = 60;
/** More than the large This week widget draws, so the widget picks what fits. */
export const WIDGET_MAX_AIMS = 10;
export const WIDGET_MAX_PRACTICES = 10;
/** How long the widget offers Undo after a start made from it. */
export const WIDGET_UNDO_MS = 5 * 60_000;

export type WidgetBlockKind = 'project' | 'practice' | 'oneoff' | 'planning' | 'inbox';

/** A space's name, which is all a widget may show of a block in an encrypted space. */
export interface WidgetSpace {
  name: string;
  encrypted: boolean;
}

export interface WidgetBlock {
  id: string;
  /** Changes whenever anything a widget button depends on changes, so a queued action can tell it's out of date. */
  rev: string;
  start: Instant;
  end: Instant;
  kind: WidgetBlockKind;
  /** Null for a block in an encrypted space: its task's name never leaves the app. */
  title: string | null;
  space: WidgetSpace | null;
  startedAt: Instant | null;
  pausedAt: Instant | null;
  pausedMin: Minutes | null;
  endedAt: Instant | null;
  answer: BlockResult | null;
}

export interface WidgetEvent {
  start: Instant;
  end: Instant;
  title: string | null;
}

/** A weekly aim: a project's, or One offs'. Its planned time is the week's blocks for it, as planning's aim meter counts. */
export interface WidgetAim {
  /** Null for a project in an encrypted space, as a block's title is. */
  name: string | null;
  space: WidgetSpace | null;
  kind: 'project' | 'oneoff';
  plannedMinutes: Minutes;
  aimMinutes: Minutes;
  /** The project's status pill, as on its card (core/status.ts). One offs have none. */
  status: { pill: string; tone: StatusTone } | null;
}

/** A practice's sessions this week: those answered Done or Partly, of the sessions it wants. */
export interface WidgetPractice {
  name: string | null;
  space: WidgetSpace | null;
  done: number;
  of: number;
}

/** What the This week widget draws, for the week today is in. Whether it's planned is in days[0].weekPlanned. */
export interface WidgetWeek {
  /** Its Monday. */
  start: LocalDate;
  /** Each day's blocks, Monday first, planning left out, as Week counts planned time. */
  plannedMinutes: Minutes[];
  /** In planning's order, soonest date first, then One offs. Only aims set and not skipped this week. */
  aims: WidgetAim[];
  /** By name. Only practices under way and not skipped this week. */
  practices: WidgetPractice[];
}

/** A start made from the widget in the last few minutes, which the widget still offers to undo. */
export interface WidgetRecent {
  id: string;
  kind: 'start' | 'startEarly';
  blockId: string;
  at: Instant;
  /** Where Start early moved the block from. */
  before: { start: Instant; end: Instant } | null;
}

export interface WidgetSnapshot {
  v: number;
  writtenAt: Instant;
  syncedAt: Instant | null;
  zone: string;
  signedIn: boolean;
  /** Today, then tomorrow. */
  days: { date: LocalDate; weekPlanned: boolean }[];
  /** Today's and tomorrow's blocks by start. */
  blocks: WidgetBlock[];
  events: WidgetEvent[];
  inbox: { count: number } | null;
  fromWidget: WidgetRecent[];
  /** Added after the first widgets, which ignore it, so the version stays 1. None once signed out. */
  week?: WidgetWeek;
}

/** Everything the snapshot is built from, read by loadWidgetData. */
export interface WidgetData {
  signedIn: boolean;
  syncedAt: Instant | null;
  days: { date: LocalDate; weekPlanned: boolean }[];
  /** Each with its space, once spaces exist. */
  blocks: (BlockRow & { space?: WidgetSpace | null })[];
  events: (CalendarEvent & { space?: WidgetSpace | null })[];
  inbox: number;
  /** Names in full, each aim and practice with its space once spaces exist; the builder cuts and hides them. */
  week: Omit<WidgetWeek, 'aims' | 'practices'> & {
    aims: (Omit<WidgetAim, 'name' | 'space'> & { name: string; space?: WidgetSpace | null })[];
    practices: (Omit<WidgetPractice, 'name' | 'space'> & { name: string; space?: WidgetSpace | null })[];
  };
}

/** Today's and tomorrow's blocks and events, the Inbox count, whether each day's week is planned, and sign-in. */
export async function loadWidgetData(sql: Sql, clock: Clock): Promise<WidgetData> {
  const date = today(clock);
  const tomorrow = addDays(date, 1);
  const range = { from_utc: dayRange(date, clock.zone()).from_utc, to_utc: dayRange(tomorrow, clock.zone()).to_utc };
  const [from, to] = [instantMs(range.from_utc), instantMs(range.to_utc)];
  const plans = await listRecords(sql, 'week_plan');
  const planned = (day: LocalDate) => plans.some((p) => p.week_start === weekStart(day) && !!p.finished_at);
  const status = await syncStatus(sql);
  const calendar = await getRecord(sql, 'calendar', CALENDAR_ID);
  return {
    // Only a device that was signed in and no longer is, or whose account was deleted, shows the sign-in message. One
    // that never signed in still shows its own plan, though its syncs, finding no sign-in, record it as signed out.
    signedIn: !isSignedOut(status) || (!(await getMeta(sql, META.account)) && status.lastError !== 'account_deleted'),
    syncedAt: status.lastSyncAt,
    days: [date, tomorrow].map((d) => ({ date: d, weekPlanned: planned(d) })),
    blocks: await blocksInRange(sql, range),
    events: busyEvents(calendar, await listRecords(sql, 'calendar_source')).filter((e) => instantMs(e.start) < to && from < instantMs(e.end)),
    inbox: await inboxCount(sql),
    week: await loadWeek(sql, clock, plans),
  };
}

// shortcut: reads every project, milestone and task on each change, as Week does; add narrower queries if it slows.
async function loadWeek(sql: Sql, clock: Clock, plans: readonly WeekPlan[]): Promise<WidgetData['week']> {
  const week = weekStart(today(clock));
  const [blocks, settings, projects, milestones, tasks, practices, away] = await Promise.all([
    blocksInRange(sql, weekRange(week, clock.zone())),
    getSettings(sql),
    listRecords(sql, 'project'),
    listRecords(sql, 'milestone'),
    listRecords(sql, 'task'),
    listRecords(sql, 'practice'),
    listRecords(sql, 'away_period'),
  ]);
  // Blocks cut at midnight, as Week places them. Only the blocks are wanted, so no hours or calendars.
  const { placed } = slotContext({ week, availability: [], avoided: [], sources: [], calendar: null, blocks, clock });
  const weekPlan = plans.find((p) => p.week_start === week) ?? null;

  // Planned time by aim, as planning's aim meter counts it: each block's minutes go to its task's project, else One offs.
  const taskOf = new Map(blocks.map((b) => [b.id, b.task_id]));
  const bucketOf = new Map(tasks.map((t) => [t.id, t.project_id ?? ONE_OFFS_BUCKET]));
  const got: Record<string, Minutes> = {};
  for (const s of placed) {
    const bucket = bucketOf.get(taskOf.get(s.id!) ?? '');
    if (bucket) got[bucket] = (got[bucket] ?? 0) + s.end - s.start;
  }
  const ctx: PlanContext = { settings, clock, away };
  const ranked = plannable(gatherPlans(projects, milestones, tasks), ctx);
  const plan = new Map(ranked.map((p) => [p.project.id, p]));
  const aims = weeklyAims({ projects: ranked.map((p) => p.project), oneOffsAim: settings.one_offs_weekly_aim, weekPlan, got })
    .filter((r) => r.aim > 0 && !r.skipped)
    .map((r) => {
      const p = plan.get(r.bucket);
      const st = p ? status(p, ctx) : null;
      return {
        name: p ? p.project.title : 'One offs',
        kind: p ? ('project' as const) : ('oneoff' as const),
        plannedMinutes: r.got,
        aimMinutes: r.aim,
        status: st ? { pill: st.pill, tone: st.tone } : null,
      };
    });

  // A session counts once answered Done or Partly, as analytics counts delivered time.
  const answered = blocks.filter((b) => b.practice_id && (b.result === 'done' || b.result === 'partly'));
  const skipped = weekPlan?.skipped_practices ?? [];
  return {
    start: week,
    plannedMinutes: weekDates(week).map((d) => plannedByKind(placed.filter((s) => s.date === d)).total),
    aims,
    practices: practices
      .filter((p) => isLive(p, skipped))
      .sort((a, b) => a.title.localeCompare(b.title))
      .map((p) => ({ name: p.title, done: answered.filter((b) => b.practice_id === p.id).length, of: weeklySessions(p) })),
  };
}

const KINDS: Record<string, WidgetBlockKind> = { project: 'project', one_off: 'oneoff', planning: 'planning', inbox: 'inbox' };

function kindOf(b: BlockRow): WidgetBlockKind {
  if (b.practice_id) return 'practice';
  return KINDS[b.task_kind ?? ''] ?? 'project';
}

/** By characters rather than UTF-16 units, so an emoji is never cut in half. */
function cut(text: string | null): string | null {
  if (text === null) return null;
  const chars = Array.from(text);
  return chars.length > WIDGET_TITLE_MAX ? chars.slice(0, WIDGET_TITLE_MAX).join('') : text;
}

/** FNV-1a over the fields a widget button depends on: its times, its work, and whether it's started, paused or over. */
export function blockRev(b: BlockRow): string {
  const fields = [b.start, b.end, b.started_at, b.paused_at, b.paused_min, b.ended_at, b.result, b.task_id, b.practice_id];
  const text = fields.map((f) => f ?? '').join('|');
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** A name a widget may show: none for anything in an encrypted space, whose names never reach the snapshot. */
const shownTitle = (title: string | null, space: WidgetSpace | null | undefined) => (space?.encrypted ? null : cut(title));
const shownSpace = (space: WidgetSpace | null | undefined): WidgetSpace | null => (space ? { name: cut(space.name)!, encrypted: space.encrypted } : null);

export function buildWidgetSnapshot(data: WidgetData, options: { clock: Clock; fromWidget?: readonly WidgetRecent[] }): WidgetSnapshot {
  const { clock } = options;
  const writtenAt = toInstant(clock.now());
  if (!data.signedIn) {
    // Signed out, nothing of the account stays in the App Group: the widgets say to sign in.
    return { v: WIDGET_SNAPSHOT_VERSION, writtenAt, syncedAt: null, zone: clock.zone(), signedIn: false, days: [], blocks: [], events: [], inbox: null, fromWidget: [] };
  }
  const blocks = [...data.blocks]
    .sort((a, b) => instantMs(a.start) - instantMs(b.start))
    .slice(0, WIDGET_MAX_BLOCKS)
    .map(
      (b): WidgetBlock => ({
        id: b.id,
        rev: blockRev(b),
        start: b.start,
        end: b.end,
        kind: kindOf(b),
        title: shownTitle(b.title, b.space),
        space: shownSpace(b.space),
        startedAt: b.started_at,
        pausedAt: b.paused_at ?? null,
        pausedMin: b.paused_min ?? null,
        endedAt: b.ended_at,
        answer: b.result,
      }),
    );
  const started = new Map(blocks.map((b) => [b.id, b.startedAt]));
  const snapshot: WidgetSnapshot = {
    v: WIDGET_SNAPSHOT_VERSION,
    writtenAt,
    syncedAt: data.syncedAt,
    zone: clock.zone(),
    signedIn: true,
    days: data.days,
    blocks,
    events: [...data.events]
      .sort((a, b) => instantMs(a.start) - instantMs(b.start))
      .slice(0, WIDGET_MAX_EVENTS)
      .map((e) => ({ start: e.start, end: e.end, title: shownTitle(e.title, e.space) })),
    inbox: { count: data.inbox },
    week: {
      ...data.week,
      aims: data.week.aims.slice(0, WIDGET_MAX_AIMS).map(({ space, ...a }) => ({ ...a, name: shownTitle(a.name, space), space: shownSpace(space) })),
      practices: data.week.practices.slice(0, WIDGET_MAX_PRACTICES).map(({ space, ...p }) => ({ ...p, name: shownTitle(p.name, space), space: shownSpace(space) })),
    },
    // Only while Undo is still offered, and only for a block still started as the widget started it.
    fromWidget: (options.fromWidget ?? []).filter((r) => started.get(r.blockId) === r.at && instantMs(r.at) + WIDGET_UNDO_MS > clock.now()),
  };
  // Titles at their longest, in a script that takes four bytes a character, could pass the cap: the latest go first.
  while (widgetSnapshotBytes(snapshot) > WIDGET_SNAPSHOT_MAX_BYTES && (snapshot.events.length || snapshot.blocks.length)) {
    if (snapshot.events.length >= snapshot.blocks.length) snapshot.events.pop();
    else snapshot.blocks.pop();
  }
  return snapshot;
}

export const widgetSnapshotBytes = (snapshot: WidgetSnapshot) => new TextEncoder().encode(JSON.stringify(snapshot)).length;

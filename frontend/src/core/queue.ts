// What needs attention after plans meet the day: Needs a new time, Still want this?, Welcome back, and Shift rest of
// today. All computed from records and never stored, so they can't drift from what happened.

import { addDays, blockMinutes, formatDate, formatMinutes, instantMs, localDate, localToMs, nowInstant, today, toInstant, weekday } from './dates';
import type { Clock } from './clock';
import { applyPlanChange } from './plan';
import type { PlanChange } from './plan';
import type { BlockRow, QueueRow } from './queries';
import { getRecord, outcomeId } from './records';
import type { Writer } from './records';
import { isRepeating } from './schedule';
import { closeTask } from './tasks';
import { ONE_OFFS_BUCKET } from './types';
import type {
  AvailabilityBlock,
  AwayPeriod,
  CalendarEvent,
  CalendarSource,
  CalendarState,
  Instant,
  LocalDate,
  Milestone,
  Minutes,
  Project,
  Task,
  TimeOfDay,
  WeekPick,
  WeekPlan,
} from './types';

const MINUTE_MS = 60_000;
const DAY_MS = 1440 * MINUTE_MS;

/** Unanswered blocks older than this, with nothing answered since, mean time away rather than a bad day. */
const WELCOME_BACK_DAYS = 7;
const WELCOME_OPTIONS = 3;

export interface QueueItem extends QueueRow {
  /** The time left to place. */
  minutes: Minutes;
  /** A project id, or ONE_OFFS_BUCKET: the queue is never a place of its own. */
  bucket: string;
  /** Passed over at the last planning, so ask "Still want this?" before offering a time. */
  stale: boolean;
  reason: string;
}

/** Turns the needsNewTime rows into queue rows, oldest first. Pass every week plan and the picks to check against. */
export function queueItems(rows: readonly QueueRow[], plans: readonly WeekPlan[], picks: readonly WeekPick[], clock: Clock): QueueItem[] {
  const lastPlan = plans.reduce<WeekPlan | null>(
    (last, p) => (p.finished_at && !p.deleted_at && (!last || p.finished_at > last.finished_at!) ? p : last),
    null,
  );
  const added = new Set(picks.filter((k) => k.week_start === lastPlan?.week_start && !k.deleted_at && !k.skipped).map((k) => k.task_id));
  const date = today(clock);

  return rows
    .map((row) => {
      const minutes = row.remaining_min ?? blockMinutes({ start: row.block_start, end: row.block_end });
      const stale = !!lastPlan && lastPlan.finished_at! > row.answered_at && !added.has(row.id);
      const blockDate = localDate(row.block_start, clock.zone());
      const when = blockDate === date ? 'today' : formatDate(blockDate);
      const reason = stale
        ? 'Ignored at last planning'
        : row.result === 'partly'
          ? `Partly done ${when}, ${formatMinutes(minutes)} left`
          : `Not done ${when}`;
      return { ...row, minutes, bucket: row.project_id ?? ONE_OFFS_BUCKET, stale, reason };
    })
    .sort((a, b) => (a.block_start < b.block_start ? -1 : a.block_start > b.block_start ? 1 : 0));
}

/** Answers "Still want this?" with yes: the answer is newer than the last plan, so the work reads as fresh again. */
export async function keepWork(w: Writer, item: QueueItem, clock: Clock): Promise<void> {
  await w.set('block_outcome', outcomeId(item.block_id), { answered_at: nowInstant(clock) });
}

/**
 * Delete on a row. A repeating one off drops just this missed time: the task, its schedule and the answer stay, so
 * analytics still counts the miss, and a Partly answer's time left goes with it so the next occurrence is its estimate.
 * Other work is deleted. Returns the exact reverse, for Undo.
 */
export async function deleteWork(w: Writer, item: QueueItem, clock: Clock): Promise<PlanChange> {
  const task = await getRecord(w.sql, 'task', item.id);
  if (!task || !isRepeating(task)) return closeTask(w, item.id, 'deleted', clock);
  return applyPlanChange(w, {
    writes: [
      { type: 'block_outcome', id: outcomeId(item.block_id), fields: { dropped_at: nowInstant(clock) } },
      ...(item.result === 'partly' ? [{ type: 'task' as const, id: item.id, fields: { remaining_min: null } }] : []),
    ],
  });
}

export function isAway(date: LocalDate, periods: readonly AwayPeriod[]): boolean {
  return periods.some((p) => !p.deleted_at && p.start <= date && date <= p.end);
}

/** Events that conflict with work: not those on information or ignored calendars. A calendar with no source yet blocks. */
export function busyEvents(calendar: CalendarState | undefined, sources: readonly CalendarSource[]): CalendarEvent[] {
  const open = new Set(sources.filter((s) => !s.deleted_at && s.mode !== 'block').map((s) => s.google_id));
  // An all-day event, such as a birthday, would otherwise conflict with the whole day.
  return (calendar?.events ?? []).filter((e) => !e.all_day && !open.has(e.calendar));
}

const hitOf = (fromMs: number, toMs: number, events: readonly CalendarEvent[]) =>
  events
    .filter((e) => instantMs(e.start) < toMs && fromMs < instantMs(e.end))
    .sort((a, b) => instantMs(a.start) - instantMs(b.start))[0];

export interface BlockConflict {
  block: BlockRow;
  event: CalendarEvent;
}

/** Each block's first overlapping event. Pass busyEvents. */
export function blockConflicts(blocks: readonly BlockRow[], events: readonly CalendarEvent[]): BlockConflict[] {
  return blocks.flatMap((block) => {
    const event = hitOf(instantMs(block.start), instantMs(block.end), events);
    return event ? [{ block, event }] : [];
  });
}

export interface ShiftMove {
  block: BlockRow;
  start: Instant;
  end: Instant;
}

export interface ShiftPlan {
  conflict: BlockConflict;
  /** Only the blocks that move. */
  moves: ShiftMove[];
  /** When the result runs into closed hours, the time they begin: "That runs past 10pm." */
  runs_past: TimeOfDay | null;
}

function closedToday(block: AvailabilityBlock, date: LocalDate): boolean {
  if (!block.projects && !block.one_offs) return false;
  const weekend = weekday(date) >= 5;
  return block.days === 'all' || (block.days === 'weekends') === weekend;
}

/**
 * A repair to preview when work ahead conflicts with an event: later blocks keep their order and length, each
 * starting once the last one and any event are clear. Pass today's blocks and busyEvents. Null when nothing conflicts.
 */
export function shiftRestOfToday(
  blocks: readonly BlockRow[],
  events: readonly CalendarEvent[],
  availability: readonly AvailabilityBlock[],
  clock: Clock,
): ShiftPlan | null {
  const now = clock.now();
  const open = blocks.filter((b) => !b.result && !b.ended_at);
  const running = (b: BlockRow) => instantMs(b.end) > now && (instantMs(b.start) <= now || !!b.started_at);
  const rest = open.filter((b) => instantMs(b.start) > now && !b.started_at).sort((a, b) => instantMs(a.start) - instantMs(b.start));

  const conflict = blockConflicts(rest, events)[0];
  if (!conflict) return null;

  let after = Math.max(now, ...open.filter(running).map((b) => instantMs(b.end)));
  const moves: ShiftMove[] = [];
  for (const block of rest) {
    const length = instantMs(block.end) - instantMs(block.start);
    let start = Math.max(instantMs(block.start), after);
    for (let hit = hitOf(start, start + length, events); hit; hit = hitOf(start, start + length, events)) start = instantMs(hit.end);
    after = start + length;
    if (start !== instantMs(block.start)) moves.push({ block, start: toInstant(start), end: toInstant(after) });
  }

  const date = today(clock);
  const zone = clock.zone();
  const closed = availability
    .filter((a) => closedToday(a, date))
    .filter((a) => {
      const from = localToMs(date, a.from, zone);
      const to = a.to <= a.from ? localToMs(addDays(date, 1), a.to, zone) : localToMs(date, a.to, zone);
      return moves.some((m) => instantMs(m.end) > from && instantMs(m.start) < to);
    })
    .map((a) => a.from);
  return { conflict, moves, runs_past: closed.length ? Math.min(...closed) : null };
}

/** Moves the blocks, and returns the exact reverse, for Undo. */
export function applyShift(w: Writer, moves: readonly ShiftMove[]): Promise<PlanChange> {
  return applyPlanChange(w, {
    // edited tells re-placing to leave a practice session's one-week change alone.
    writes: moves.map(({ block, start, end }) => ({ type: 'time_block', id: block.id, fields: block.practice_id ? { start, end, edited: true } : { start, end } })),
  });
}

/**
 * The missed blocks to return, when you've been gone: oldest first, or null if this isn't time away. Pass recent
 * blocks, such as the last 90 days. Waits until away dates have passed, so opening the app on holiday doesn't nag.
 */
export function welcomeBack(blocks: readonly BlockRow[], away: readonly AwayPeriod[], clock: Clock): { blocks: BlockRow[] } | null {
  const now = clock.now();
  if (isAway(today(clock), away)) return null;

  const unanswered = blocks
    .filter((b) => b.task_id && !b.result && !b.ended_at && instantMs(b.end) <= now)
    .sort((a, b) => instantMs(a.start) - instantMs(b.start));
  // Records, not a last-opened time, so using the app on one device counts on the other.
  const lastActive = Math.max(0, ...blocks.filter((b) => b.result || b.started_at || b.ended_at).map((b) => instantMs(b.end)));
  const firstMissed = unanswered.find((b) => instantMs(b.end) > lastActive);
  if (!firstMissed || now - instantMs(firstMissed.end) < WELCOME_BACK_DAYS * DAY_MS) return null;
  return { blocks: unanswered };
}

/** Sends missed blocks back: the work stays open in its project or One offs, and they aren't counted in analytics. */
export async function returnMissedBlocks(w: Writer, blocks: readonly BlockRow[]): Promise<void> {
  for (const block of blocks) await w.set('time_block', block.id, { cancelled: true });
}

/** The few things to offer as "Pick one thing for today": soonest date first, one from each project or One offs. */
export function welcomeOptions(tasks: readonly Task[], milestones: readonly Milestone[], projects: readonly Project[], clock: Clock): Task[] {
  const date = today(clock);
  const running = new Set(projects.filter((p) => p.state === 'active' && !p.deleted_at && p.start <= date).map((p) => p.id));
  const dueOf = new Map(milestones.filter((m) => !m.met_at && !m.dropped_at && !m.deleted_at).map((m) => [m.id, m.due]));

  const once = (t: Task) => (t.schedule?.type === 'once' ? t.schedule : null);
  const dateOf = (t: Task) => (t.kind === 'project' ? dueOf.get(t.milestone_id ?? '') : t.next_due ?? once(t)?.to ?? once(t)?.from) ?? '9999';

  const open = tasks.filter((t) => {
    if (t.done_at || t.cancelled_at || t.deleted_at || (t.waiting_until && t.waiting_until > date)) return false;
    if (t.kind === 'project') return running.has(t.project_id ?? '');
    const opens = t.next_due ?? once(t)?.from;
    // A one off that opens later, or a repeat not due yet, isn't for today.
    return t.kind === 'one_off' && !(t.schedule && opens && opens > date);
  });

  const seen = new Set<string>();
  return open
    .sort((a, b) => (dateOf(a) < dateOf(b) ? -1 : dateOf(a) > dateOf(b) ? 1 : 0))
    .filter((t) => {
      const bucket = t.project_id ?? ONE_OFFS_BUCKET;
      if (seen.has(bucket)) return false;
      seen.add(bucket);
      return true;
    })
    .slice(0, WELCOME_OPTIONS);
}

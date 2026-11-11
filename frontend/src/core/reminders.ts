// Which notifications to schedule. The platform fires them; a sync or opening the app replaces the whole list, so
// answering on another device clears the prompt here at this device's next sync.

import { isPaused, spentLine, timeLeftMs, workMinutes } from './blocks';
import { formatMinutes, formatTime, instantMs, localDate, toInstant } from './dates';
import type { UtcRange } from './dates';
import type { Clock } from './clock';
import type { BlockRow } from './queries';
import { isAway } from './queue';
import type { AwayPeriod, Instant, Reminder, ReminderAction, ReminderSettings } from './types';

/** iOS keeps only the soonest 64 pending notifications per app. */
export const REMINDER_LIMIT = 64;

const SNOOZE_MIN = 10;
/** How long a pause runs before one reminder that the block is still paused. */
export const PAUSE_REMINDER_MIN = 15;
const MINUTE_MS = 60_000;
const DAY_MS = 1440 * MINUTE_MS;
/** Comfortably more than 64 reminders' worth of a normal plan, and the list is rebuilt at every open and sync. */
const HORIZON_DAYS = 28;

export const REMINDER_ACTION = {
  start: 'start',
  nextBlock: 'next_block',
  started: 'started',
  snooze: 'snooze',
  skip: 'skip',
  done: 'done',
  partly: 'partly',
  notDone: 'not_done',
  stillGoing: 'still_going',
  resume: 'resume',
  logAll: 'log_all',
  /** A planning block's Start, which opens planning where it was left. */
  startPlanning: 'start_planning',
} as const;

const A = REMINDER_ACTION;
const START_ACTIONS: ReminderAction[] = [
  { id: A.start, title: 'Start' },
  { id: A.nextBlock, title: 'Do next block instead' },
];
const CHECK_IN_ACTIONS: ReminderAction[] = [
  { id: A.started, title: 'Yes, started' },
  { id: A.snooze, title: `Ask again in ${SNOOZE_MIN} minutes` },
  { id: A.nextBlock, title: 'Do next block instead' },
  { id: A.skip, title: 'Skip, choose a new time later' },
];
// No Done here: a task finishes only when someone says so in the app. On the Mac the first action shows as a button
// beside Close, where Done read as dismissing the notification and finished tasks unasked.
const END_ACTIONS: ReminderAction[] = [
  { id: A.stillGoing, title: 'Still going' },
  { id: A.partly, title: 'Partly', opens_app: true },
  { id: A.notDone, title: 'Not done' },
];

// Planning asks nothing during or after its block: the app can see whether the plan was finished.
const PLANNING_ACTIONS: ReminderAction[] = [
  { id: A.startPlanning, title: 'Start', opens_app: true },
  { id: A.nextBlock, title: 'Do next block instead' },
];
const isPlanning = (b: BlockRow) => b.task_kind === 'planning';

const startId = (blockId: string) => `reminder:${blockId}:start`;
const checkInId = (blockId: string) => `reminder:${blockId}:check_in`;
const endId = (blockId: string) => `reminder:${blockId}:end`;
const pausedId = (blockId: string) => `reminder:${blockId}:still_paused`;

/** The blocks to pass to remindersToSchedule, through blocksInRange. Starts in the past to catch a running block. */
export function reminderRange(clock: Clock): UtcRange {
  const now = clock.now();
  return { from_utc: toInstant(now - DAY_MS), to_utc: toInstant(now + HORIZON_DAYS * DAY_MS) };
}

/** When "Ask again" should ask, for the snoozed argument of remindersToSchedule. */
export function snoozeUntil(clock: Clock): Instant {
  return toInstant(clock.now() + SNOOZE_MIN * MINUTE_MS);
}

/** When "Have you started?" asks. Every block keeps its check-in, so one shorter than the delay asks halfway through. */
function checkInAt(block: BlockRow, settings: ReminderSettings, snoozedTo: Instant | undefined): Instant {
  const start = instantMs(block.start);
  return snoozedTo ?? toInstant(Math.min(start + settings.check_in_delay_min * MINUTE_MS, (start + instantMs(block.end)) / 2));
}

/** The block to ask "Have you started?" about in the app right now, on the notification's timing. */
export function checkInDue(
  blocks: readonly BlockRow[],
  settings: ReminderSettings,
  away: readonly AwayPeriod[],
  clock: Clock,
  snoozed: Readonly<Record<string, Instant>> = {},
): BlockRow | undefined {
  const now = clock.now();
  if (!settings.check_in) return undefined;
  return blocks.find(
    (b) =>
      !b.started_at &&
      !isPlanning(b) &&
      !b.result &&
      !b.ended_at &&
      now < instantMs(b.end) &&
      now >= instantMs(checkInAt(b, settings, snoozed[b.id])) &&
      !isAway(localDate(b.start, clock.zone()), away),
  );
}

function remindersFor(block: BlockRow, settings: ReminderSettings, snoozedTo: Instant | undefined, zone: string, inbox: number): Reminder[] {
  const name = block.title ?? 'Time block';
  const end = instantMs(block.end);
  const out: Reminder[] = [];
  if (isPlanning(block)) {
    if (block.started_at || !settings.block_start) return [];
    const body = `${formatTime(block.start, zone)} to ${formatTime(end, zone)}.${inbox ? ` ${inbox} in your Inbox.` : ''}`;
    return [{ id: startId(block.id), kind: 'block_start', block_id: block.id, at: block.start, title: name, body, actions: PLANNING_ACTIONS }];
  }

  if (!block.started_at) {
    if (settings.block_start) {
      out.push({ id: startId(block.id), kind: 'block_start', block_id: block.id, at: block.start, title: name, actions: START_ACTIONS });
    }
    if (settings.check_in) {
      const at = checkInAt(block, settings, snoozedTo);
      if (instantMs(at) < end) {
        out.push({ id: checkInId(block.id), kind: 'check_in', block_id: block.id, at, title: 'Have you started?', body: name, actions: CHECK_IN_ACTIONS });
      }
    }
  }
  // A check-in on a pause: once, partway through it, unless the block's end, which asks anyway, comes first.
  if (settings.check_in && isPaused(block)) {
    const at = instantMs(block.paused_at!) + PAUSE_REMINDER_MIN * MINUTE_MS;
    if (at < end) {
      out.push({
        id: pausedId(block.id),
        kind: 'still_paused',
        block_id: block.id,
        at: toInstant(at),
        title: `Still paused: ${name}`,
        body: `Paused since ${formatTime(block.paused_at!, zone)}. It ends at ${formatTime(end, zone)} unless you resume.`,
        actions: [{ id: A.resume, title: 'Resume' }],
      });
    }
  }
  if (settings.block_end) {
    const practice = !!block.practice_id;
    // As it will stand when it fires. Pausing reschedules it, and a pause running to the end offers Resume.
    const spent = spentLine(block, zone, end);
    const resume: ReminderAction = { id: A.resume, title: `Resume, ${formatMinutes(Math.round(timeLeftMs(block, end) / MINUTE_MS))} left` };
    out.push({
      id: endId(block.id),
      kind: 'block_end',
      block_id: block.id,
      at: block.end,
      title: 'Block ended',
      body: practice ? name : [spent, `Did you finish ${name}?`].filter(Boolean).join(' '),
      // Practice time is logged rather than judged. Tapping the notification opens the slider for a part of it.
      actions: practice
        ? [
            { id: A.logAll, title: `All ${formatMinutes(workMinutes(block))}` },
            { id: A.skip, title: 'Skip' },
          ]
        : isPaused(block)
          ? [resume, ...END_ACTIONS.slice(1)]
          : END_ACTIONS,
    });
  }
  return out;
}

/**
 * The full list for Notifications.replaceAll: soonest first and at most REMINDER_LIMIT. A block that's answered or
 * ended gets nothing, and a started one only its end, so a reschedule always agrees with cancelling straight away.
 * snoozed maps a block id to when "Ask again" should ask. Keep it on this device, and drop it when you like: at
 * worst one snoozed question isn't asked again. inbox is the Inbox count a planning block's start mentions.
 */
export function remindersToSchedule(
  blocks: readonly BlockRow[],
  settings: ReminderSettings,
  away: readonly AwayPeriod[],
  clock: Clock,
  snoozed: Readonly<Record<string, Instant>> = {},
  inbox = 0,
): Reminder[] {
  const now = clock.now();
  const zone = clock.zone();
  return blocks
    .filter((b) => !b.result && !b.ended_at && !isAway(localDate(b.start, zone), away))
    .flatMap((b) => remindersFor(b, settings, snoozed[b.id], zone, inbox))
    .filter((r) => instantMs(r.at) > now)
    .sort((a, b) => instantMs(a.at) - instantMs(b.at))
    .slice(0, REMINDER_LIMIT);
}

/**
 * Work blocks that ended with no answer, oldest first. A practice just passes, away dates were muted, and planning
 * comes back as its row instead.
 */
export function missedBlocks(blocks: readonly BlockRow[], away: readonly AwayPeriod[], clock: Clock): BlockRow[] {
  const now = clock.now();
  const zone = clock.zone();
  return blocks
    .filter((b) => b.task_id && !isPlanning(b) && !b.result && !b.ended_at && instantMs(b.end) <= now && !isAway(localDate(b.start, zone), away))
    .sort((a, b) => instantMs(a.start) - instantMs(b.start));
}

/** Practice blocks that ended today with no answer, oldest first. A missed practice from an earlier day just passes. */
export function practicesToLog(blocks: readonly BlockRow[], away: readonly AwayPeriod[], clock: Clock): BlockRow[] {
  const now = clock.now();
  const zone = clock.zone();
  const date = localDate(now, zone);
  return blocks
    .filter((b) => b.practice_id && !b.result && !b.ended_at && instantMs(b.end) <= now && localDate(b.start, zone) === date && !isAway(date, away))
    .sort((a, b) => instantMs(a.start) - instantMs(b.start));
}

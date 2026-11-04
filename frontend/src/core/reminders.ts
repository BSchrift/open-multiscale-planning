// Which notifications to schedule. The platform fires them; a sync or opening the app replaces the whole list, so
// answering on another device clears the prompt here at this device's next sync.

import { formatMinutes, instantMs, localDate, toInstant } from './dates';
import type { UtcRange } from './dates';
import type { Clock } from './clock';
import type { BlockRow } from './queries';
import { isAway } from './queue';
import type { AwayPeriod, Instant, Reminder, ReminderAction, ReminderSettings } from './types';

/** iOS keeps only the soonest 64 pending notifications per app. */
export const REMINDER_LIMIT = 64;

const SNOOZE_MIN = 10;
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
  logAll: 'log_all',
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
const END_ACTIONS: ReminderAction[] = [
  { id: A.done, title: 'Done' },
  { id: A.partly, title: 'Partly', opens_app: true },
  { id: A.notDone, title: 'Not done' },
  { id: A.stillGoing, title: 'Still going' },
];

const startId = (blockId: string) => `reminder:${blockId}:start`;
const checkInId = (blockId: string) => `reminder:${blockId}:check_in`;
const endId = (blockId: string) => `reminder:${blockId}:end`;

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
      !b.result &&
      !b.ended_at &&
      now < instantMs(b.end) &&
      now >= instantMs(checkInAt(b, settings, snoozed[b.id])) &&
      !isAway(localDate(b.start, clock.zone()), away),
  );
}

function remindersFor(block: BlockRow, settings: ReminderSettings, snoozedTo: Instant | undefined): Reminder[] {
  const name = block.title ?? 'Time block';
  const start = instantMs(block.start);
  const end = instantMs(block.end);
  const out: Reminder[] = [];

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
  if (settings.block_end) {
    const practice = !!block.practice_id;
    out.push({
      id: endId(block.id),
      kind: 'block_end',
      block_id: block.id,
      at: block.end,
      title: 'Block ended',
      body: practice ? name : `Did you finish ${name}?`,
      // Practice time is logged rather than judged. Tapping the notification opens the slider for a part of it.
      actions: practice
        ? [
            { id: A.logAll, title: `All ${formatMinutes(Math.round((end - start) / MINUTE_MS))}` },
            { id: A.skip, title: 'Skip' },
          ]
        : END_ACTIONS,
    });
  }
  return out;
}

/**
 * The full list for Notifications.replaceAll: soonest first and at most REMINDER_LIMIT. A block that's answered or
 * ended gets nothing, and a started one only its end, so a reschedule always agrees with cancelling straight away.
 * snoozed maps a block id to when "Ask again" should ask. Keep it on this device, and drop it when you like: at
 * worst one snoozed question isn't asked again.
 */
export function remindersToSchedule(
  blocks: readonly BlockRow[],
  settings: ReminderSettings,
  away: readonly AwayPeriod[],
  clock: Clock,
  snoozed: Readonly<Record<string, Instant>> = {},
): Reminder[] {
  const now = clock.now();
  const zone = clock.zone();
  return blocks
    .filter((b) => !b.result && !b.ended_at && !isAway(localDate(b.start, zone), away))
    .flatMap((b) => remindersFor(b, settings, snoozed[b.id]))
    .filter((r) => instantMs(r.at) > now)
    .sort((a, b) => instantMs(a.at) - instantMs(b.at))
    .slice(0, REMINDER_LIMIT);
}

/** Work blocks that ended with no answer, oldest first. A practice just passes, and away dates were muted. */
export function missedBlocks(blocks: readonly BlockRow[], away: readonly AwayPeriod[], clock: Clock): BlockRow[] {
  const now = clock.now();
  const zone = clock.zone();
  return blocks
    .filter((b) => b.task_id && !b.result && !b.ended_at && instantMs(b.end) <= now && !isAway(localDate(b.start, zone), away))
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

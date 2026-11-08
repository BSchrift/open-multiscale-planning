// Keeps this device's notifications in step with the plan, and answers them with the same writes the in-app
// prompts make. useReminders is mounted once, in the Shell. The list is rebuilt from records whenever they change
// (including a sync), when the app comes to the front, and after "Ask again", so an answer given on another device
// clears the prompt here at this device's next sync. An answer to a notification syncs first, and acts only if the
// block is still the one the notification was about.

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { answerBlock, extendBlock, nextBlock, startBlock, swapBlocks, unscheduleBlock } from '../../core/blocks';
import type { Clock } from '../../core/clock';
import { blockMinutes, dayRange, instantMs, localDate, today, weekStart } from '../../core/dates';
import { blocksInRange } from '../../core/queries';
import type { BlockRow } from '../../core/queries';
import { getRecord, getSettings, listRecords, outcomeId } from '../../core/records';
import { REMINDER_ACTION, reminderRange, remindersToSchedule, snoozeUntil } from '../../core/reminders';
import type { Instant, Reminder, TimeBlock } from '../../core/types';
import type { ReminderResponse } from '../../platform/types';
import { useNav } from './nav';
import { useApp, useMutation, useQuery } from './store';

/** What Still going adds, from a notification or the end-of-block prompt. */
export const STILL_GOING_MIN = 30;

// "Ask again in 10 minutes", by block id. Kept on this device only: at worst one snoozed question isn't asked again.
const SNOOZE_KEY = 'multiscale.snoozes';
const snoozeListeners = new Set<() => void>();
let snoozeCache: { raw: string; value: Readonly<Record<string, Instant>> } = { raw: '{}', value: {} };

function readSnoozes(): Readonly<Record<string, Instant>> {
  let raw = '{}';
  try {
    raw = localStorage.getItem(SNOOZE_KEY) ?? '{}';
  } catch {
    // Storage can be blocked; nothing is snoozed then.
  }
  if (raw !== snoozeCache.raw) {
    try {
      snoozeCache = { raw, value: JSON.parse(raw) as Record<string, Instant> };
    } catch {
      snoozeCache = { raw, value: {} };
    }
  }
  return snoozeCache.value;
}

export function snoozeBlock(blockId: string, until: Instant): void {
  // Snoozes more than a day older than this one are dropped as it's added, so the list never grows.
  const cutoff = instantMs(until) - 86_400_000;
  const kept = Object.entries(readSnoozes()).filter(([, at]) => instantMs(at) > cutoff);
  try {
    localStorage.setItem(SNOOZE_KEY, JSON.stringify({ ...Object.fromEntries(kept), [blockId]: until }));
  } catch {
    // The snooze still holds for this session through the cache below.
    snoozeCache = { raw: snoozeCache.raw, value: { ...snoozeCache.value, [blockId]: until } };
  }
  for (const notify of snoozeListeners) notify();
}

export function useSnoozes(): Readonly<Record<string, Instant>> {
  return useSyncExternalStore((notify) => {
    snoozeListeners.add(notify);
    return () => void snoozeListeners.delete(notify);
  }, readSnoozes);
}

// A notification is scheduled from this device's copy of the plan, and once delivered it stays showing whatever is
// scheduled after it, while syncs and edits change its block. Native code hands back only the id of the one answered,
// so the id carries the block as it was scheduled: the reminder's kind, and the block's times and work. Record ids never
// hold a space, so spaces set these apart. A block moved, lengthened or given other work gets new ids, and its old
// pending notifications still go, since every platform's replaceAll replaces its whole list.
const workOf = (block: { task_id?: string | null; practice_id?: string | null }) => block.task_id ?? block.practice_id ?? '';
const withBlock = (reminder: Reminder, block: BlockRow): Reminder => ({
  ...reminder,
  id: [reminder.id, reminder.kind, block.start, block.end, workOf(block)].join(' '),
});

/**
 * Whether the block has changed since the notification with this id was scheduled: moved, lengthened or given other
 * work, or for a start or check-in, started. One scheduled before ids carried the block can't tell, so it has.
 */
function changedSince(reminderId: string, block: TimeBlock): boolean {
  const [, kind, start, end, work] = reminderId.split(' ');
  if (work === undefined) return true;
  return start !== block.start || end !== block.end || work !== workOf(block) || (kind !== 'block_end' && !!block.started_at);
}

const STALE = 'stale';
/** How long an answer waits for a sync, which a weak network can stretch past the time iOS gives a background action. */
const SYNC_WAIT_MS = 2000;

// A notification's Partly needs the app to ask for the time left, so it asks Today to open that block's prompt.
let promptRequest: string | null = null;
const requestListeners = new Set<() => void>();

export function requestPrompt(blockId: string | null): void {
  promptRequest = blockId;
  for (const notify of requestListeners) notify();
}

/** The block a notification asked to answer in the app, if any. Clear it with requestPrompt(null). */
export function usePromptRequest(): string | null {
  return useSyncExternalStore(
    (notify) => {
      requestListeners.add(notify);
      return () => void requestListeners.delete(notify);
    },
    () => promptRequest,
  );
}

export function useReminders(): void {
  const { platform, clock, sync } = useApp();
  const nav = useNav();
  const snoozed = useSnoozes();
  const [wake, setWake] = useState(0);
  useEffect(() => platform.lifecycle.onForeground(() => setWake((n) => n + 1)), [platform]);

  const { data } = useQuery(
    async (sql, c) => ({
      blocks: await blocksInRange(sql, reminderRange(c)),
      settings: (await getSettings(sql)).reminders,
      away: await listRecords(sql, 'away_period'),
    }),
    [wake],
  );

  // One at a time and in order, so an older list can never land after a newer one.
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const asked = useRef(false);
  useEffect(() => {
    if (!data) return;
    const blocks = new Map(data.blocks.map((b) => [b.id, b]));
    const list = remindersToSchedule(data.blocks, data.settings, data.away, clock, snoozed).map((r) => withBlock(r, blocks.get(r.block_id)!));
    chain.current = chain.current
      .then(async () => {
        // Asked once there's something to remind about, rather than at first launch with an empty plan.
        if (list.length > 0 && !asked.current) {
          asked.current = true;
          await platform.notifications.requestPermission();
        }
        await platform.notifications.replaceAll(list);
      })
      .catch((error: unknown) => console.error('Scheduling reminders failed', error));
  }, [data, snoozed, platform, clock]);

  // tap is the clock as of the answer, which a sync came between.
  const answer = useMutation(async (w, { reminder_id, block_id: id, action_id: action }: ReminderResponse, tap: Clock) => {
    const block = await getRecord(w.sql, 'time_block', id);
    if (!block || block.cancelled || block.deleted_at || changedSince(reminder_id, block)) return STALE;
    // A delivered notification stays in Notification Center after the block is answered elsewhere, so it's stale.
    const outcome = await getRecord(w.sql, 'block_outcome', outcomeId(id));
    if (outcome && !outcome.deleted_at) return STALE;
    const A = REMINDER_ACTION;
    switch (action) {
      case A.start:
      case A.started:
        return startBlock(w, id, tap);
      case A.notDone:
        return answerBlock(w, id, { result: 'not' }, tap);
      case A.skip:
        // Before it's over, Skip takes it off the calendar into To schedule; a practice's Skip at its end logs nothing.
        if (instantMs(block.end) > tap.now()) return unscheduleBlock(w, id, weekStart(localDate(block.start, tap.zone())), tap);
        return answerBlock(w, id, block.practice_id ? { result: 'not', logged_min: 0 } : { result: 'not' }, tap);
      case A.logAll:
        // Only a practice's notification offers it, and on a block holding a task it would finish the task.
        if (!block.practice_id) return STALE;
        return answerBlock(w, id, { result: 'done', logged_min: blockMinutes(block) }, tap);
      case A.stillGoing:
        return extendBlock(w, id, STILL_GOING_MIN);
      case A.nextBlock: {
        const blocks = await blocksInRange(w.sql, dayRange(today(tap), tap.zone()));
        const next = nextBlock(blocks.filter((b) => b.id !== id), tap);
        return next ? swapBlocks(w, id, next.id) : undefined;
      }
    }
    return undefined;
  });

  const respond = async (response: ReminderResponse) => {
    if (response.action_id === REMINDER_ACTION.snooze) return snoozeBlock(response.block_id, snoozeUntil(clock));
    // Done from a notification delivered before it was taken off opens the app to ask, rather than finishing the task.
    if (response.action_id === null || response.action_id === REMINDER_ACTION.partly || response.action_id === REMINDER_ACTION.done) {
      nav.go('today');
      if (response.action_id === REMINDER_ACTION.partly) requestPrompt(response.block_id);
      return;
    }
    const at = clock.now();
    const tap: Clock = { now: () => at, zone: clock.zone };
    // What other devices changed, if it comes quickly.
    await Promise.race([sync?.syncNow(), new Promise((resolve) => setTimeout(resolve, SYNC_WAIT_MS))]);
    // Rather than act on a block that's no longer what the notification said, show the day as it is.
    if ((await answer.run(response, tap)) === STALE) nav.go('today');
  };
  const latest = useRef(respond);
  latest.current = respond;
  useEffect(() => platform.notifications.onResponse((response) => void latest.current(response)), [platform]);
}

// Keeps this device's notifications in step with the plan, and answers them with the same writes the in-app
// prompts make. useReminders is mounted once, in the Shell. The list is rebuilt from records whenever they change
// (including a sync), when the app comes to the front, and after "Ask again", so an answer given on another device
// clears the prompt here at this device's next sync.

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { answerBlock, extendBlock, nextBlock, startBlock, swapBlocks } from '../../core/blocks';
import { blockMinutes, dayRange, instantMs, today } from '../../core/dates';
import { blocksInRange } from '../../core/queries';
import { getRecord, getSettings, listRecords, outcomeId } from '../../core/records';
import { REMINDER_ACTION, reminderRange, remindersToSchedule, snoozeUntil } from '../../core/reminders';
import type { Instant } from '../../core/types';
import type { ReminderResponse } from '../../platform/types';
import { useNav } from './nav';
import { useApp, useMutation, useQuery } from './store';

const STILL_GOING_MIN = 30;

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
  const { platform, clock } = useApp();
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
    const list = remindersToSchedule(data.blocks, data.settings, data.away, clock, snoozed);
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

  const answer = useMutation(async (w, { block_id: id, action_id: action }: ReminderResponse) => {
    const block = await getRecord(w.sql, 'time_block', id);
    if (!block || block.cancelled || block.deleted_at) return;
    // A delivered notification stays in Notification Center after the block is answered elsewhere, so it's stale.
    const outcome = await getRecord(w.sql, 'block_outcome', outcomeId(id));
    if (outcome && !outcome.deleted_at) return;
    const A = REMINDER_ACTION;
    switch (action) {
      case A.start:
      case A.started:
        return startBlock(w, id, clock);
      case A.done:
        return answerBlock(w, id, { result: 'done' }, clock);
      case A.notDone:
        return answerBlock(w, id, { result: 'not' }, clock);
      case A.skip:
        return answerBlock(w, id, block.practice_id ? { result: 'not', logged_min: 0 } : { result: 'not' }, clock);
      case A.logAll:
        return answerBlock(w, id, { result: 'done', logged_min: blockMinutes(block) }, clock);
      case A.stillGoing:
        return extendBlock(w, id, STILL_GOING_MIN);
      case A.nextBlock: {
        const blocks = await blocksInRange(w.sql, dayRange(today(clock), clock.zone()));
        const next = nextBlock(blocks.filter((b) => b.id !== id), clock);
        return next ? swapBlocks(w, id, next.id) : undefined;
      }
    }
    return undefined;
  });

  const respond = (response: ReminderResponse) => {
    if (response.action_id === REMINDER_ACTION.snooze) return snoozeBlock(response.block_id, snoozeUntil(clock));
    if (response.action_id === null || response.action_id === REMINDER_ACTION.partly) {
      nav.go('today');
      if (response.action_id === REMINDER_ACTION.partly) requestPrompt(response.block_id);
      return;
    }
    void answer.run(response);
  };
  const latest = useRef(respond);
  latest.current = respond;
  useEffect(() => platform.notifications.onResponse((response) => latest.current(response)), [platform]);
}

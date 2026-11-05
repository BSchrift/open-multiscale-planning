// Fires reminders from main-process timers, since macOS has nothing like iOS's scheduled notifications for us.

import type { Reminder } from '../src/core/types';

/** setTimeout fires at once beyond this, and a reminder can be 28 days out. */
const MAX_DELAY_MS = 2 ** 31 - 1;
/** Older than this on waking and it's no longer useful: the app asks about missed blocks itself. */
const LATE_LIMIT_MS = 5 * 60_000;

export interface ShownReminder {
  close(): void;
}

export function createReminderTimers(show: (reminder: Reminder) => ShownReminder) {
  const pending = new Map<string, { reminder: Reminder; timer: ReturnType<typeof setTimeout> }>();
  // Also keeps each notification alive: a collected one stops reporting clicks.
  const showing = new Map<string, ShownReminder>();

  const fire = (reminder: Reminder) => {
    pending.delete(reminder.id);
    try {
      showing.set(reminder.id, show(reminder));
    } catch (err) {
      console.error('Showing a reminder failed', err);
    }
  };

  const arm = (reminder: Reminder) => {
    const delay = Date.parse(reminder.at) - Date.now();
    if (delay < -LATE_LIMIT_MS) return void pending.delete(reminder.id);
    const timer = setTimeout(() => (delay > MAX_DELAY_MS ? arm(reminder) : fire(reminder)), Math.min(Math.max(delay, 0), MAX_DELAY_MS));
    pending.set(reminder.id, { reminder, timer });
  };

  const clear = () => {
    for (const { timer } of pending.values()) clearTimeout(timer);
    const reminders = [...pending.values()].map((p) => p.reminder);
    pending.clear();
    return reminders;
  };

  return {
    replaceAll(reminders: readonly Reminder[]) {
      clear();
      reminders.forEach(arm);
    },
    cancel(ids: readonly string[]) {
      for (const id of ids) {
        const entry = pending.get(id);
        if (entry) clearTimeout(entry.timer);
        pending.delete(id);
        showing.get(id)?.close();
        showing.delete(id);
      }
    },
    scheduled: () => [...pending.values()].map((p) => p.reminder),
    /** Timers stop while the machine sleeps, so call this on waking. */
    rearm() {
      clear().forEach(arm);
    },
  };
}

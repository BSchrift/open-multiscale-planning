// In-memory stand-ins for device services, used by the browser build and by tests.
// The extra methods on each let a test act as the OS.

import type { Reminder } from '../core/types';
import type { Lifecycle, Notifications, ReminderResponse, SecureTokens } from './types';

function listeners<T extends unknown[]>() {
  const set = new Set<(...args: T) => void>();
  return {
    add(listener: (...args: T) => void) {
      set.add(listener);
      return () => void set.delete(listener);
    },
    emit: (...args: T) => {
      for (const listener of [...set]) listener(...args);
    },
  };
}

export interface MemoryNotifications extends Notifications {
  respond(response: ReminderResponse): void;
}

export function memoryNotifications(): MemoryNotifications {
  let current: Reminder[] = [];
  const responses = listeners<[ReminderResponse]>();
  return {
    requestPermission: async () => true,
    replaceAll: async (reminders) => {
      current = [...reminders];
    },
    cancel: async (ids) => {
      current = current.filter((r) => !ids.includes(r.id));
    },
    scheduled: async () => [...current],
    onResponse: responses.add,
    respond: responses.emit,
  };
}

export function memoryTokens(): SecureTokens {
  const values = new Map<string, string>();
  return {
    get: async (key) => values.get(key) ?? null,
    set: async (key, value) => void values.set(key, value),
    remove: async (key) => void values.delete(key),
  };
}

export interface MemoryLifecycle extends Lifecycle {
  foreground(): void;
  background(): void;
}

export function memoryLifecycle(): MemoryLifecycle {
  const fg = listeners<[]>();
  const bg = listeners<[]>();
  return { onForeground: fg.add, onBackground: bg.add, foreground: fg.emit, background: bg.emit };
}

export function deepLinks() {
  const links = listeners<[string]>();
  return { onDeepLink: links.add, open: links.emit };
}

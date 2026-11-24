// In-memory stand-ins for device services, used by the browser build and by tests.
// The extra methods on each let a test act as the OS.

import type { Reminder } from '../core/types';
import type { AppLink } from '../core/appLinks';
import type { FileStore, Lifecycle, Notifications, ReminderResponse, SecureTokens, Widgets } from './types';

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

/** Attachments' bytes, in memory: the fake for tests. */
export function memoryFiles(): FileStore & { readonly kept: Map<string, Blob> } {
  const kept = new Map<string, Blob>();
  return {
    kept,
    get: async (id) => kept.get(id) ?? null,
    put: async (id, file) => void kept.set(id, file),
    remove: async (id) => void kept.delete(id),
    clear: async () => kept.clear(),
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
  leave(): void;
}

export function memoryLifecycle(): MemoryLifecycle {
  const fg = listeners<[]>();
  const bg = listeners<[]>();
  const lv = listeners<[]>();
  return { onForeground: fg.add, onBackground: bg.add, onLeave: lv.add, foreground: fg.emit, background: bg.emit, leave: lv.emit };
}

export function deepLinks() {
  const links = listeners<[string]>();
  return { onDeepLink: links.add, open: links.emit };
}

export function appLinks() {
  const links = listeners<[AppLink]>();
  return { onAppLink: links.add, open: links.emit };
}

export interface MemoryWidgets extends Widgets {
  /** Every snapshot written, oldest first, as JSON. */
  readonly written: string[];
  /** The queue, as the widget's buttons leave it. */
  readonly queued: Map<string, string>;
  /** Acts as iOS waking the app to refresh the widgets. Resolves once the listener has. */
  refresh(): Promise<void>;
}

/** The App Group as a test sees it: what the app wrote, and a queue a test fills as the widget's intents would. */
export function memoryWidgets(): MemoryWidgets {
  const written: string[] = [];
  const queued = new Map<string, string>();
  let refresh: (() => Promise<void>) | null = null;
  return {
    written,
    queued,
    write: async (json) => void written.push(json),
    clear: async () => {
      written.push('');
      queued.clear();
    },
    actions: async () => [...queued].sort(([a], [b]) => a.localeCompare(b)).map(([id, text]) => ({ id, text })),
    remove: async (ids) => ids.forEach((id) => queued.delete(id)),
    onRefresh(listener) {
      refresh = listener;
      return () => {
        if (refresh === listener) refresh = null;
      };
    },
    refresh: async () => refresh?.(),
  };
}

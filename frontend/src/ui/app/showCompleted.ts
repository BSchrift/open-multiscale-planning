// Whether task lists show completed tasks among the open ones. Hidden by default; one choice for every list, kept on
// this device only, like the appearance.

import { useSyncExternalStore } from 'react';

export const SHOW_COMPLETED_KEY = 'multiscale.showCompleted';
const listeners = new Set<() => void>();
let current = false;

function read(): boolean {
  try {
    current = localStorage.getItem(SHOW_COMPLETED_KEY) === 'true';
  } catch {
    // Storage can be blocked; the choice still holds for this session.
  }
  return current;
}

export function setShowCompleted(next: boolean): void {
  current = next;
  try {
    if (next) localStorage.setItem(SHOW_COMPLETED_KEY, 'true');
    else localStorage.removeItem(SHOW_COMPLETED_KEY);
  } catch {
    // As above.
  }
  for (const notify of listeners) notify();
}

const subscribe = (notify: () => void) => {
  listeners.add(notify);
  return () => void listeners.delete(notify);
};

export function useShowCompleted(): boolean {
  return useSyncExternalStore(subscribe, read);
}

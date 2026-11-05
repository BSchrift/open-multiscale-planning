// Light or dark, from Settings, kept on this device only. System leaves it to prefers-color-scheme in tokens.css, so
// it follows the system live; Light or Dark marks the root with data-theme, which wins. public/appearance.js marks it
// before the first paint from the same key, and this keeps it in step after that.

import { useEffect, useSyncExternalStore } from 'react';
import type { Appearance } from '../../platform/types';
import { useApp } from './store';

export const APPEARANCE_KEY = 'multiscale.appearance';
const listeners = new Set<() => void>();
let current: Appearance = 'system';

function read(): Appearance {
  try {
    const stored = localStorage.getItem(APPEARANCE_KEY);
    current = stored === 'light' || stored === 'dark' ? stored : 'system';
  } catch {
    // Storage can be blocked; the choice still holds for this session.
  }
  return current;
}

export function setAppearance(next: Appearance): void {
  current = next;
  try {
    if (next === 'system') localStorage.removeItem(APPEARANCE_KEY);
    else localStorage.setItem(APPEARANCE_KEY, next);
  } catch {
    // As above.
  }
  if (next === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = next;
  for (const notify of listeners) notify();
}

const subscribe = (notify: () => void) => {
  listeners.add(notify);
  return () => void listeners.delete(notify);
};

export function useAppearance(): Appearance {
  return useSyncExternalStore(subscribe, read);
}

/** Passes the choice to the native window or status bar, where there is one, at launch and on each change. */
export function useNativeAppearance(): void {
  const { platform } = useApp();
  const appearance = useAppearance();
  useEffect(() => void platform.setAppearance?.(appearance), [platform, appearance]);
}

// The global capture shortcut: the one saved in the data folder, else the default. A new one replaces the old only once
// it's registered, so a shortcut another app holds leaves the working one in place.

import { readFileSync, writeFileSync } from 'node:fs';
import { DEFAULT_SHORTCUT, isAccelerator } from '../src/platform/shortcut';

/** The part of Electron's globalShortcut this uses. */
export interface Shortcuts {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
  isRegistered(accelerator: string): boolean;
}

export function captureHotkey(file: string, shortcuts: Shortcuts, fire: () => void) {
  let current = DEFAULT_SHORTCUT;
  try {
    const saved: unknown = JSON.parse(readFileSync(file, 'utf8')).accelerator;
    if (isAccelerator(saved)) current = saved;
  } catch {
    // None saved yet, or unreadable: the default.
  }
  if (!shortcuts.register(current, fire)) console.error(`${current} is taken by another app`);

  return {
    /** The shortcut, and whether it works: another app may have held it at launch. */
    get: () => ({ accelerator: current, registered: shortcuts.isRegistered(current) }),
    /** False when it isn't a shortcut, or another app holds it. */
    set(next: unknown): boolean {
      if (!isAccelerator(next)) return false;
      if (!shortcuts.isRegistered(next) && !shortcuts.register(next, fire)) return false;
      if (next !== current) shortcuts.unregister(current);
      current = next;
      writeFileSync(file, JSON.stringify({ accelerator: next }));
      return true;
    },
  };
}

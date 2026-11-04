// Where planning ahead is up to, kept on this device only: the step, the note, and what changed so far. The Plan page,
// the flow and the More line all read it, so it's one store rather than per-component state.

import { useSyncExternalStore } from 'react';
import type { LocalDate } from '../../../core/types';

export interface Change {
  /** One line per thing changed: a later change to the same thing replaces it. */
  key: string;
  text: string;
}

export interface PlanFlow {
  begun: boolean;
  step: number;
  note: string;
  changes: Change[];
  /** Started again after ending a plan early, so there's a stretch to look back on rather than a first one. */
  restart: boolean;
  /** The day this planning began, which a first plan's stretch starts on. */
  begunOn: LocalDate | null;
}

const KEY = 'multiscale.plan.flow';
const EMPTY: PlanFlow = { begun: false, step: 0, note: '', changes: [], restart: false, begunOn: null };
const listeners = new Set<() => void>();
let lastRaw: string | null = null;
let last: PlanFlow = EMPTY;

function raw(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return lastRaw;
  }
}

export function readFlow(): PlanFlow {
  const now = raw();
  if (now !== lastRaw) {
    lastRaw = now;
    try {
      last = { ...EMPTY, ...(now ? (JSON.parse(now) as Partial<PlanFlow>) : {}) };
    } catch {
      last = EMPTY;
    }
  }
  return last;
}

export function writeFlow(patch: Partial<PlanFlow>): void {
  const next = JSON.stringify({ ...readFlow(), ...patch });
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // Storage can be blocked; the flow still works for this session.
  }
  lastRaw = next;
  last = JSON.parse(next) as PlanFlow;
  for (const notify of listeners) notify();
}

/** Notes a change for Finish's "What changed". */
export function logChange(key: string, text: string): void {
  writeFlow({ changes: [...readFlow().changes.filter((c) => c.key !== key), { key, text }] });
}

/** Back to nothing begun, once a plan is finished. */
export const resetFlow = () => writeFlow(EMPTY);

const subscribe = (notify: () => void) => {
  listeners.add(notify);
  return () => listeners.delete(notify);
};

export function usePlanFlow(): PlanFlow {
  return useSyncExternalStore(subscribe, readFlow);
}

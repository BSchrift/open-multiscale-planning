// Where planning ahead is up to, kept on this device only: the step, the steps continued from and opened, the note, and
// what changed so far with each change's reverse. The Plan page, the flow and the More line all read it, so it's one
// store rather than per-component state.
//
// Released apps read the same key on the same origin, and know the step only as a number over their own steps: Look
// back or Start, Practices, Projects, Time and Finish. So that number is still written beside the step's key, and a
// number one of them has moved since wins over the key.

import { useSyncExternalStore } from 'react';
import type { PlanChange } from '../../../core/plan';
import type { LocalDate } from '../../../core/types';

export type StepKey = 'start' | 'goals' | 'practices' | 'projects' | 'inbox' | 'finish';

/** Each step as a released app numbers it. The Inbox is new, so it reads as Projects, the step before it. */
const OLD_NUMBER: Record<StepKey, number> = { start: 0, goals: 0, practices: 1, projects: 2, inbox: 2, finish: 4 };

export interface Change {
  /** One line per thing changed: a later change to the same thing replaces it. */
  key: string;
  text: string;
  /** What takes this change back. Lines a released app wrote have none. */
  reverse?: PlanChange;
  /** The line this one replaced, which its Undo puts back. */
  prev?: Change | null;
}

export interface PlanFlow {
  begun: boolean;
  /** The step in a released app's numbering. */
  step: number;
  stepKey: StepKey | null;
  /** Steps continued from. */
  done: StepKey[];
  /** Steps opened, so Finish can name any never looked at. */
  seen: StepKey[];
  note: string;
  changes: Change[];
  /** Started again after ending a plan early, so there's a stretch to look back on rather than a first one. */
  restart: boolean;
  /** The day this planning began, which a first plan's stretch starts on. */
  begunOn: LocalDate | null;
  /** The Inbox's items when its step was continued from, so weekly planning can tell whether any came in since. */
  inbox: string[] | null;
}

const KEY = 'multiscale.plan.flow';
const EMPTY: PlanFlow = { begun: false, step: 0, stepKey: null, done: [], seen: [], note: '', changes: [], restart: false, begunOn: null, inbox: null };
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

/**
 * Planning starts over at its first step. A released app's Finish resets only the fields it knows, so this clears the
 * rest too.
 */
export function beginFlow(patch: Partial<PlanFlow> = {}): void {
  writeFlow({ begun: true, step: 0, stepKey: null, done: [], seen: [], inbox: null, ...patch });
}

/** The step to show, of those on offer: its key, unless a released app has moved the step since. */
export function stepOf(flow: PlanFlow, steps: readonly StepKey[]): StepKey {
  if (flow.stepKey && OLD_NUMBER[flow.stepKey] === flow.step && steps.includes(flow.stepKey)) return flow.stepKey;
  const n = Math.trunc(Number(flow.step)) || 0;
  return n <= 0 ? steps[0]! : n === 1 ? 'practices' : n === 2 ? 'projects' : 'finish';
}

export function goToStep(key: StepKey): void {
  const { seen } = readFlow();
  writeFlow({ stepKey: key, step: OLD_NUMBER[key], seen: seen.includes(key) ? seen : [...seen, key] });
}

export function markDone(key: StepKey): void {
  const { done } = readFlow();
  if (!done.includes(key)) writeFlow({ done: [...done, key] });
}

/**
 * Notes a change for Finish's "What changed", with what takes it back. Going on, as a slider does, keeps the first
 * reverse, so its Undo goes back to before it began.
 */
export function logChange(key: string, text: string, reverse?: PlanChange, goingOn = false): void {
  const { changes } = readFlow();
  const before = changes.find((c) => c.key === key) ?? null;
  const entry: Change = goingOn && before?.reverse ? { ...before, text } : reverse ? { key, text, reverse, prev: before } : { key, text };
  writeFlow({ changes: [...changes.filter((c) => c.key !== key), entry] });
}

/** Takes a change's line off once its Undo has run, putting back the line it replaced. */
export function unlogChange(key: string): void {
  const { changes } = readFlow();
  const entry = changes.find((c) => c.key === key);
  writeFlow({ changes: [...changes.filter((c) => c.key !== key), ...(entry?.prev ? [entry.prev] : [])] });
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

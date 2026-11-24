// What the iPhone widget's buttons ask for, and the app applying it. A button can't write to the database: its App Intent
// adds a file to the App Group's widget-actions folder (frontend/ios/App/MultiscaleWidgets, ActionQueue.swift), and the
// app applies the queue when it next comes to the front, after a sync, with the same writes as the Now card's buttons,
// timed at the tap. Nothing is forced: an action whose block has changed since the widget saw it, other than by this
// device's own earlier actions, is dropped and the toast says why. Each one applied can be undone.

import { pauseBlock, resumeBlock, startBlock, startEarly } from './blocks';
import type { Clock } from './clock';
import { formatTime, instantMs, toInstant } from './dates';
import { applyPlanChange } from './plan';
import type { PlanChange } from './plan';
import { blocksInRange } from './queries';
import type { BlockRow } from './queries';
import { getRecord } from './records';
import type { Writer } from './records';
import type { Instant } from './types';
import { blockRev, WIDGET_UNDO_MS } from './widgetSnapshot';
import type { WidgetRecent } from './widgetSnapshot';

export const WIDGET_ACTION_VERSION = 1;
export type WidgetActionKind = 'start' | 'startEarly' | 'pause' | 'resume' | 'undo';
const KINDS: readonly WidgetActionKind[] = ['start', 'startEarly', 'pause', 'resume', 'undo'];

export interface WidgetAction {
  v: number;
  /** The file's name, which also orders the queue: the tap's epoch ms, then a UUID. */
  id: string;
  kind: WidgetActionKind;
  blockId: string;
  /** The block's rev in the snapshot the widget drew from. */
  rev: string;
  /** The tap, which the change is timed at, however much later the app applies it. */
  at: Instant;
  /** For undo, the start it takes back. */
  target: string | null;
}

/** An action applied on this device, kept a day so a file seen twice applies once and Undo can find its reverse. */
export interface AppliedWidgetAction {
  id: string;
  kind: WidgetActionKind;
  blockId: string;
  /**
   * The rev of the drawing the action was tapped on, and the block's rev after it applied. A later action tapped on that
   * same drawing follows it, since the only change since is this device's own.
   */
  baseRev: string;
  afterRev: string;
  at: Instant;
  reverse: PlanChange;
  before: { start: Instant; end: Instant } | null;
  /** Set once undone, so its start no longer shows in the widget. */
  undone?: true;
}

export type WidgetActionOutcome =
  | { kind: 'applied'; action: WidgetAction; message: string; applied: AppliedWidgetAction }
  | { kind: 'dropped'; action: WidgetAction; message: string }
  | { kind: 'duplicate'; action: WidgetAction };

const ID = /^\d{13}-[0-9A-Fa-f-]{36}\.json$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const MAX_ACTION_BYTES = 4096;

/**
 * Reads a queued file, refusing anything that isn't exactly what an intent writes. The App Group is this app's own, but a
 * file there is still outside the database, so it's checked as carefully as anything synced.
 */
export function parseWidgetAction(id: string, text: string): WidgetAction | null {
  if (!ID.test(id) || text.length > MAX_ACTION_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const a = value as Record<string, unknown>;
  const str = (v: unknown, max = 200): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
  if (a.v !== WIDGET_ACTION_VERSION || a.id !== id || !KINDS.includes(a.kind as WidgetActionKind)) return null;
  if (!str(a.blockId) || !str(a.rev, 32) || !str(a.at) || !INSTANT.test(a.at) || Number.isNaN(Date.parse(a.at))) return null;
  const target = typeof a.target === 'string' ? a.target : a.target === null || a.target === undefined ? null : undefined;
  if (target === undefined || (a.kind === 'undo' ? !(target && ID.test(target)) : target !== null)) return null;
  return { v: WIDGET_ACTION_VERSION, id, kind: a.kind as WidgetActionKind, blockId: a.blockId, rev: a.rev, at: a.at, target };
}

const VERB: Record<WidgetActionKind, string> = { start: 'start', startEarly: 'start', pause: 'pause', resume: 'resume', undo: 'undo the start of' };

async function readBlock(w: Writer, id: string): Promise<BlockRow | undefined> {
  const record = await getRecord(w.sql, 'time_block', id);
  if (!record || record.deleted_at || record.cancelled) return undefined;
  // The row Today and the snapshot read, with its title and answer.
  const from = instantMs(record.start);
  return (await blocksInRange(w.sql, { from_utc: toInstant(from), to_utc: toInstant(from + 1000) })).find((b) => b.id === id);
}

/**
 * Applies one queued action, as the Now card's button would have at the moment of the tap. history is what this device
 * applied before, newest last; applied actions are added to it by the caller.
 */
export async function applyWidgetAction(w: Writer, action: WidgetAction, history: readonly AppliedWidgetAction[], zone: string): Promise<WidgetActionOutcome> {
  if (history.some((h) => h.id === action.id)) return { kind: 'duplicate', action };
  const tap: Clock = { now: () => instantMs(action.at), zone: () => zone };
  const block = await readBlock(w, action.blockId);
  const name = block?.title ?? 'the block';
  const drop = (why: string): WidgetActionOutcome => ({ kind: 'dropped', action, message: `Didn't ${VERB[action.kind]} ${name} from the widget. ${why}` });
  if (!block) return drop("It's no longer on your calendar.");
  const rev = blockRev(block);
  // Unchanged since the widget drew it, or changed only by this device's own actions from that same drawing.
  const own = history.findLast((h) => h.blockId === block.id && !h.undone && h.afterRev === rev);
  const current = rev === action.rev || own?.baseRev === action.rev;

  if (action.kind === 'undo') {
    const target = history.find((h) => h.id === action.target && !h.undone);
    if (!target || target.blockId !== block.id) return drop('Its start is no longer there to take back.');
    if (target.afterRev !== rev) return drop('It changed since.');
    const reverse = await applyPlanChange(w, target.reverse);
    return applied(w, action, block, reverse, null, `Took back the start of ${name} from the widget.`);
  }

  if (block.result) return drop('It was already answered.');
  if (block.ended_at) return drop('It had already ended.');
  const tapMs = instantMs(action.at);
  if (!current) {
    if (block.started_at && (action.kind === 'start' || action.kind === 'startEarly')) return drop('It had already started.');
    return drop(`It changed since. It's now ${formatTime(block.start, zone)} to ${formatTime(block.end, zone)}.`);
  }
  switch (action.kind) {
    case 'start':
      if (block.started_at) return drop('It had already started.');
      if (tapMs >= instantMs(block.end)) return drop('It had already ended.');
      return applied(w, action, block, await startBlock(w, block.id, tap), null, `Started ${name} at ${formatTime(tapMs, zone)} from the widget.`);
    case 'startEarly': {
      if (block.started_at) return drop('It had already started.');
      const before = { start: block.start, end: block.end };
      return applied(w, action, block, await startEarly(w, block.id, tap), before, `Started ${name} early, at ${formatTime(tapMs, zone)}, from the widget.`);
    }
    case 'pause': {
      if (!block.started_at || block.paused_at) return drop(block.paused_at ? 'It was already paused.' : "It hadn't started.");
      if (tapMs >= instantMs(block.end)) return drop('It had already ended.');
      const change = await pauseBlock(w, block.id, tap);
      return applied(w, action, block, change, null, `Paused ${name} at ${formatTime(tapMs, zone)} from the widget.`);
    }
    case 'resume': {
      if (!block.paused_at) return drop("It wasn't paused.");
      const change = await resumeBlock(w, block.id, tap);
      return applied(w, action, block, change, null, `Resumed ${name} from the widget. It now ends at ${formatTime(change.end, zone)}.`);
    }
  }
}

async function applied(
  w: Writer,
  action: WidgetAction,
  block: BlockRow,
  reverse: PlanChange,
  before: AppliedWidgetAction['before'],
  message: string,
): Promise<WidgetActionOutcome> {
  const after = await readBlock(w, block.id);
  return {
    kind: 'applied',
    action,
    message,
    applied: { id: action.id, kind: action.kind, blockId: block.id, baseRev: action.rev, afterRev: after ? blockRev(after) : '', at: action.at, reverse, before },
  };
}

/** The history a new outcome leaves: the action added, its target marked undone, and anything over a day old gone. */
export function recordOutcome(history: readonly AppliedWidgetAction[], outcome: WidgetActionOutcome, now: number): AppliedWidgetAction[] {
  const kept = history.filter((h) => instantMs(h.at) > now - 86_400_000);
  if (outcome.kind !== 'applied') return kept;
  const undone = outcome.action.kind === 'undo' ? outcome.action.target : null;
  return [...kept.map((h) => (h.id === undone ? { ...h, undone: true as const } : h)), outcome.applied];
}

/** Starts from the widget that it still offers to undo, for the snapshot. */
export function recentStarts(history: readonly AppliedWidgetAction[], now: number): WidgetRecent[] {
  return history
    .filter((h) => (h.kind === 'start' || h.kind === 'startEarly') && !h.undone && instantMs(h.at) + WIDGET_UNDO_MS > now)
    .map((h) => ({ id: h.id, kind: h.kind as 'start' | 'startEarly', blockId: h.blockId, at: h.at, before: h.before }));
}

// What the planning row, the prompt to plan and the times sheet read, and every change they make, each one
// transaction with its message and Undo.

import { useSyncExternalStore } from 'react';
import type { Clock } from '../../../core/clock';
import { formatDate, formatDayLong, formatTime, formatTimeOfDay, formatWeekday, thisWeek, weekRange, weekStart } from '../../../core/dates';
import type { Sql } from '../../../core/db';
import { applyPlanChange } from '../../../core/plan';
import type { PlanChange } from '../../../core/plan';
import {
  deletePlanning,
  isWeek,
  nowSlot,
  planningId,
  planningTimes,
  schedulePlanning,
  skipWeek,
  startPlanning,
  stretchEstimate,
  usualTime,
  weekEstimate,
} from '../../../core/planning';
import type { Estimate, PlanningFor } from '../../../core/planning';
import { blocksInRange, inboxCount } from '../../../core/queries';
import { CALENDAR_ID, getRecord, getSettings, listRecords } from '../../../core/records';
import type { Writer } from '../../../core/records';
import { slotInstants } from '../../../core/slots';
import type { Slot } from '../../../core/slots';
import type { LocalDate, Minutes } from '../../../core/types';
import { useNav } from '../../app/nav';
import { useApp, useMutation, useQuery } from '../../app/store';
import { useToast } from '../Toast';

// The weekly reminder's Choose a time asks Today's row to open its times, as a notification's Partly asks for its
// prompt.
let planningRequest: LocalDate | null = null;
const requestListeners = new Set<() => void>();

export function requestPlanningTimes(week: LocalDate | null): void {
  planningRequest = week;
  for (const notify of requestListeners) notify();
}

/** The week whose times a notification asked to open, if any. Clear it with requestPlanningTimes(null). */
export function usePlanningRequest(): LocalDate | null {
  return useSyncExternalStore(
    (notify) => {
      requestListeners.add(notify);
      return () => void requestListeners.delete(notify);
    },
    () => planningRequest,
  );
}

/** 'Fri 5pm' */
export const shortTime = (s: Slot) => `${formatWeekday(s.date)} ${formatTimeOfDay(s.start)}`;
/** 'Friday, Nov 6 at 5pm', for a control's name. */
export const longTime = (s: Slot) => `${formatDayLong(s.date)} at ${formatTimeOfDay(s.start)}`;

/** '30 minutes', '1 hour 15 minutes': what a screen reader says for '1h 15m'. */
export function spokenMinutes(minutes: Minutes): string {
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return [h ? unit(h, 'hour') : '', m || !h ? unit(m, 'minute') : ''].filter(Boolean).join(' ');
}

async function loadInput(sql: Sql, clock: Clock, p: PlanningFor) {
  const current = thisWeek(clock);
  const zone = clock.zone();
  // The week the times can reach: a week's own, or the one a stretch starts in.
  const week = isWeek(p) ? p : weekStart(p.stretch.start);
  return {
    settings: await getSettings(sql),
    calendar: (await getRecord(sql, 'calendar', CALENDAR_ID)) ?? null,
    sources: await listRecords(sql, 'calendar_source'),
    // This week's blocks, and next week's too when planning it, so times offered go around them.
    blocks: await blocksInRange(sql, { from_utc: weekRange(current, zone).from_utc, to_utc: weekRange(week > current ? week : current, zone).to_utc }),
    inbox: await inboxCount(sql),
    // What the estimate and your usual time learn from.
    plans: await listRecords(sql, 'week_plan'),
  };
}

/** The estimate, your usual time, and the times to offer for planning a week or a stretch at a length. Null until loaded. */
export function usePlanningTimes(p: PlanningFor) {
  const { clock } = useApp();
  const key = planningId(p);
  const data = useQuery((sql, c) => loadInput(sql, c, p), [key]).data;
  if (!data) return null;
  const estimate = isWeek(p) ? weekEstimate(data.inbox, data.plans) : stretchEstimate(data.settings, p.first);
  // Your usual time is the weekly habit; a stretch comes too seldom for one.
  const usual = isWeek(p) ? usualTime(data.plans, clock.zone()) : null;
  const input = { ...data, clock };
  return {
    estimate,
    inbox: data.inbox,
    input,
    usual,
    times: (minutes: Minutes) => planningTimes(p, minutes, input, usual),
    now: (minutes: Minutes) => nowSlot(minutes, data.blocks, clock),
  };
}

/** 'About 30m, a first guess.', 'About 30m, from your last 4 plans.' */
export const estimateSource = (e: Estimate) => (e.guess ? ', a first guess.' : `, from your last ${e.from === 1 ? 'plan' : `${e.from} plans`}.`);

export function usePlanningActions() {
  const { clock } = useApp();
  const nav = useNav();
  const toast = useToast();
  const { run, pending } = useMutation((w, fn: (w: Writer) => Promise<PlanChange>) => fn(w));
  const zone = clock.zone();
  const undoable = async (fn: (w: Writer) => Promise<PlanChange>, message: string) => {
    const reverse = await run(fn);
    if (reverse) toast.show(message, { undo: () => run((w) => applyPlanChange(w, reverse)) });
    return reverse;
  };

  return {
    pending,
    schedule: (p: PlanningFor, slot: Slot) =>
      undoable((w) => schedulePlanning(w, p, slotInstants(slot, zone), clock), `Planning scheduled for ${shortTime(slot)}.`),
    remove: (p: PlanningFor) =>
      undoable(
        (w) => deletePlanning(w, p, clock),
        `Planning for ${isWeek(p) ? `the week of ${formatDate(p)}` : `${formatDate(p.stretch.start)} to ${formatDate(p.stretch.end)}`} deleted.`,
      ),
    skip: (week: LocalDate) => undoable((w) => skipWeek(w, week, clock), 'Skipped planning this week.'),
    /**
     * Places a block from now, for the estimate unless given a length, unless one is under way, there's no time or the
     * week or stretch is planned already. Then opens planning on it.
     */
    start: async (p: PlanningFor, minutes?: Minutes) => {
      let until: string | null = null;
      const reverse = await run(async (w) => {
        const started = await startPlanning(w, p, minutes, clock);
        until = started.until;
        return started.reverse;
      });
      if (reverse && until) toast.show(`Planning until ${formatTime(until, zone)}.`, { undo: () => run((w) => applyPlanChange(w, reverse)) });
      if (isWeek(p)) nav.openFlow('planning', { week: p });
      else nav.openFlow('plan');
    },
  };
}

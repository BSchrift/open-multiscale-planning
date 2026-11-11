// What the planning row, the prompt to plan and the times sheet read, and every change they make, each one
// transaction with its message and Undo.

import type { Clock } from '../../../core/clock';
import { formatDate, formatDayLong, formatTime, formatTimeOfDay, formatWeekday, thisWeek, weekRange } from '../../../core/dates';
import type { Sql } from '../../../core/db';
import { applyPlanChange } from '../../../core/plan';
import type { PlanChange } from '../../../core/plan';
import { deletePlanning, nowSlot, planningTimes, schedulePlanning, skipWeek, startPlanning, usualTime, weekEstimate } from '../../../core/planning';
import type { Estimate } from '../../../core/planning';
import { blocksInRange, inboxCount } from '../../../core/queries';
import { CALENDAR_ID, getRecord, getSettings, listRecords } from '../../../core/records';
import type { Writer } from '../../../core/records';
import { slotInstants } from '../../../core/slots';
import type { Slot } from '../../../core/slots';
import type { LocalDate, Minutes } from '../../../core/types';
import { useNav } from '../../app/nav';
import { useApp, useMutation, useQuery } from '../../app/store';
import { useToast } from '../Toast';

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

async function loadInput(sql: Sql, clock: Clock, week: LocalDate) {
  const current = thisWeek(clock);
  const zone = clock.zone();
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

/** The estimate, your usual time, and the times to offer for planning a week at a length. Null until loaded. */
export function usePlanningTimes(week: LocalDate) {
  const { clock } = useApp();
  const data = useQuery((sql, c) => loadInput(sql, c, week), [week]).data;
  if (!data) return null;
  const estimate = weekEstimate(data.inbox, data.plans);
  const usual = usualTime(data.plans, clock.zone());
  const input = { ...data, clock };
  return {
    estimate,
    inbox: data.inbox,
    input,
    usual,
    times: (minutes: Minutes) => planningTimes(week, minutes, input, usual),
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
    schedule: (week: LocalDate, slot: Slot) =>
      undoable((w) => schedulePlanning(w, week, slotInstants(slot, zone), clock), `Planning scheduled for ${shortTime(slot)}.`),
    remove: (week: LocalDate) => undoable((w) => deletePlanning(w, week, clock), `Planning for the week of ${formatDate(week)} deleted.`),
    skip: (week: LocalDate) => undoable((w) => skipWeek(w, week, clock), 'Skipped planning this week.'),
    /**
     * Places a block from now, for the estimate unless given a length, unless one is under way, there's no time or the
     * week is planned already. Then opens planning on the week.
     */
    start: async (week: LocalDate, minutes?: Minutes) => {
      let until: string | null = null;
      const reverse = await run(async (w) => {
        const started = await startPlanning(w, week, minutes, clock);
        until = started.until;
        return started.reverse;
      });
      if (reverse && until) toast.show(`Planning until ${formatTime(until, zone)}.`, { undo: () => run((w) => applyPlanChange(w, reverse)) });
      nav.openFlow('planning', { week });
    },
  };
}

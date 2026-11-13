// Every change Week makes, as one transaction each with its message and Undo. Both layouts share it.

import { keepPracticeChange, moveBlock, placeBlock, placeSession, removeBlock, skipPractice, skipSession, unscheduleBlock } from '../../../core/blocks';
import { formatTimeOfDay, formatWeekday, nowInstant, weekday } from '../../../core/dates';
import { applyPlanChange } from '../../../core/plan';
import type { PlanChange } from '../../../core/plan';
import { sessionDay, weekPickId } from '../../../core/records';
import type { Writer } from '../../../core/records';
import { slotInstants } from '../../../core/slots';
import type { Slot } from '../../../core/slots';
import { closeTask, tickOneOff } from '../../../core/tasks';
import type { LocalDate, Task } from '../../../core/types';
import { useApp, useMutation } from '../../app/store';
import { DAY_NAMES } from '../../components/editors/PracticeSchedule';
import type { KeepChoice } from '../../components/editors/PracticeSchedule';
import { useToast } from '../../components/Toast';
import { dayName } from '../../components/weekgrid';
import type { Placeable } from './data';

/** A placed block as both layouts hold it. */
interface Placed extends Slot {
  id: string;
  title: string;
  practice_id?: string | null;
}

export function useWeekActions() {
  const { clock } = useApp();
  const toast = useToast();
  const { run } = useMutation((w, fn: (w: Writer) => Promise<PlanChange>) => fn(w));
  const zone = clock.zone();

  const withUndo = async (fn: (w: Writer) => Promise<PlanChange>, message: string, focusUndo = false) => {
    const reverse = await run(fn);
    if (reverse) toast.show(message, { undo: () => run((w) => applyPlanChange(w, reverse)), focusUndo });
    return reverse;
  };
  const at = (slot: Slot) => `${dayName(slot.date)}, ${formatTimeOfDay(slot.start)}`;
  const already = (title: string, date: LocalDate) => toast.show(`${title} is already on ${DAY_NAMES[weekday(date)]}.`);

  return {
    /** Saves as you go, with no message: the block shows where it landed. */
    move: (id: string, slot: Slot) => run((w) => moveBlock(w, id, slotInstants(slot, zone))),
    moveWithUndo: (id: string, title: string, slot: Slot) => withUndo((w) => moveBlock(w, id, slotInstants(slot, zone)), `Moved ${title} to ${at(slot)}`),
    /**
     * A practice session moved to another day: this week only, and it stays the session of the day it's for. A day that
     * has another of its sessions refuses it. Resolves to whether it moved.
     */
    moveSessionDay: async (b: Placed, slot: Slot, blocks: readonly Placed[]) => {
      if (blocks.some((x) => x.id !== b.id && x.practice_id === b.practice_id && x.date === slot.date)) {
        already(b.title, slot.date);
        return false;
      }
      const day = sessionDay(b.id, b.practice_id ?? '') ?? b.date;
      const to = `${formatWeekday(slot.date)} ${formatTimeOfDay(slot.start)}`;
      return !!(await withUndo((w) => moveBlock(w, b.id, slotInstants(slot, zone)), `Moved ${DAY_NAMES[weekday(day)]}'s ${b.title} to ${to}, this week only.`));
    },
    /** The control that removed it goes with the block, so focus moves to Undo. */
    remove: (id: string, title: string) => withUndo((w) => removeBlock(w, id), `Removed ${title}`, true),
    /** A set day's session is placed for its own day, wherever it lands; a day with one of its sessions refuses another. */
    place: async (item: Placeable, slot: Slot) => {
      const times = slotInstants(slot, zone);
      const reverse = await run((w) => (item.practice ? placeSession(w, item.practice.id, times, clock, item.dates?.from) : placeBlock(w, item.id, times, clock)));
      if (!reverse) return undefined;
      if (!reverse.writes.length) return void already(item.title, slot.date);
      toast.show(`Placed ${item.title}, ${at(slot)}`, { undo: () => run((w) => applyPlanChange(w, reverse)) });
      return reverse;
    },
    /** Off the calendar and back to schedule, still in the week. */
    unschedule: (id: string, title: string, week: LocalDate) => withUndo((w) => unscheduleBlock(w, id, week, clock), `Took ${title} off the calendar`, true),
    /** A pick comes out of the week; a practice is skipped this week. */
    takeOut: (item: Placeable, week: LocalDate) =>
      withUndo(async (w) => {
        if (item.practice) return skipPractice(w, week, item.practice.id, true, clock);
        const id = weekPickId(week, item.id);
        return { writes: [{ type: 'week_pick', id, fields: await w.set('week_pick', id, { deleted_at: nowInstant(clock) }) }] };
      }, `Took ${item.title} out of this week`),
    /** Skips one set day's session this week; the practice's other days stay. */
    skipDay: (item: Placeable, week: LocalDate) =>
      withUndo((w) => skipSession(w, week, item.practice!.id, item.dates!.from, true, clock), `Skipped ${item.title} on ${DAY_NAMES[weekday(item.dates!.from)]} this week.`),
    markDone: (task: Task) => withUndo((w) => (task.kind === 'one_off' ? tickOneOff(w, task.id, clock) : closeTask(w, task.id, 'done', clock)), `${task.title} done`),
    keepPractice: (blockId: string, choice: KeepChoice) => withUndo((w) => keepPracticeChange(w, blockId, choice.keep, clock), choice.done),
  };
}

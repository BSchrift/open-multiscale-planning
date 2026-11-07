// Every change Week makes, as one transaction each with its message and Undo. Both layouts share it.

import { keepPracticeChange, moveBlock, placeBlock, placeSession, removeBlock, skipPractice, unscheduleBlock } from '../../../core/blocks';
import { formatTimeOfDay, nowInstant } from '../../../core/dates';
import { applyPlanChange } from '../../../core/plan';
import type { PlanChange } from '../../../core/plan';
import { weekPickId } from '../../../core/records';
import type { Writer } from '../../../core/records';
import { slotInstants } from '../../../core/slots';
import type { Slot } from '../../../core/slots';
import { closeTask, tickOneOff } from '../../../core/tasks';
import type { LocalDate, Minutes, Task } from '../../../core/types';
import { useApp, useMutation } from '../../app/store';
import { useToast } from '../../components/Toast';
import { dayName } from './data';
import type { Placeable } from './data';

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

  return {
    /** Saves as you go, with no message: the block shows where it landed. */
    move: (id: string, slot: Slot) => run((w) => moveBlock(w, id, slotInstants(slot, zone))),
    moveWithUndo: (id: string, title: string, slot: Slot) => withUndo((w) => moveBlock(w, id, slotInstants(slot, zone)), `Moved ${title} to ${at(slot)}`),
    /** The control that removed it goes with the block, so focus moves to Undo. */
    remove: (id: string, title: string) => withUndo((w) => removeBlock(w, id), `Removed ${title}`, true),
    place: (item: Placeable, slot: Slot) =>
      withUndo(
        (w) => (item.practice ? placeSession(w, item.id, slotInstants(slot, zone), clock) : placeBlock(w, item.id, slotInstants(slot, zone), clock)),
        `Placed ${item.title}, ${at(slot)}`,
      ),
    /** Off the calendar and back to schedule, still in the week. */
    unschedule: (id: string, title: string, week: LocalDate) => withUndo((w) => unscheduleBlock(w, id, week, clock), `Took ${title} off the calendar`, true),
    /** A pick comes out of the week; a practice is skipped this week. */
    takeOut: (item: Placeable, week: LocalDate) =>
      withUndo(async (w) => {
        if (item.practice) return skipPractice(w, week, item.id, true, clock);
        const id = weekPickId(week, item.id);
        return { writes: [{ type: 'week_pick', id, fields: await w.set('week_pick', id, { deleted_at: nowInstant(clock) }) }] };
      }, `Took ${item.title} out of this week`),
    markDone: (task: Task) => withUndo((w) => (task.kind === 'one_off' ? tickOneOff(w, task.id, clock) : closeTask(w, task.id, 'done', clock)), `${task.title} done`),
    keepPractice: async (blockId: string, wasMin: Minutes, title: string) => {
      if (await run((w) => keepPracticeChange(w, blockId, wasMin, clock))) toast.show(`${title} changed for every week. Edit it any time in Goals.`);
    },
  };
}

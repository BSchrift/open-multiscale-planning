// Every change Week makes, as one transaction each with its message and Undo. Both layouts share it.

import { keepPracticeChange, moveBlock, placeBlock, removeBlock } from '../../../core/blocks';
import { formatTimeOfDay } from '../../../core/dates';
import { applyPlanChange } from '../../../core/plan';
import type { PlanChange } from '../../../core/plan';
import type { Writer } from '../../../core/records';
import { slotInstants } from '../../../core/slots';
import type { Slot } from '../../../core/slots';
import { tickOneOff } from '../../../core/tasks';
import type { Minutes, Task } from '../../../core/types';
import { useApp, useMutation } from '../../app/store';
import { useToast } from '../../components/Toast';
import { dayName } from './data';

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
    place: (task: Task, slot: Slot) => withUndo((w) => placeBlock(w, task.id, slotInstants(slot, zone), clock), `Placed ${task.title}, ${at(slot)}`),
    markDone: (task: Task) => withUndo((w) => tickOneOff(w, task.id, clock), `${task.title} done`),
    keepPractice: async (blockId: string, wasMin: Minutes, title: string) => {
      if (await run((w) => keepPracticeChange(w, blockId, wasMin, clock))) toast.show(`${title} changed for every week. Edit it any time in Goals.`);
    },
  };
}

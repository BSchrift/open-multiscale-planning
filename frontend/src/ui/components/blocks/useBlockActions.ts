// What a person can do to a block, as one transaction each with the message that follows. Today and Week share it.

import { useCallback } from 'react';
import { answerBlock, extendBlock, markDoneNow, startBlock, startEarly, swapBlocks } from '../../../core/blocks';
import type { BlockAnswer } from '../../../core/blocks';
import { formatMinutes, formatTime } from '../../../core/dates';
import { applyPlanChange } from '../../../core/plan';
import type { PlanChange } from '../../../core/plan';
import type { BlockRow } from '../../../core/queries';
import type { Writer } from '../../../core/records';
import { snoozeUntil } from '../../../core/reminders';
import { snoozeBlock } from '../../app/reminders';
import { useApp, useMutation } from '../../app/store';
import { useToast } from '../Toast';

export const STILL_GOING_MIN = 30;
const QUEUED = 'Added to Needs a new time. No need to decide now.';

export function useBlockActions() {
  const { clock } = useApp();
  const toast = useToast();
  const write = useMutation((w, fn: (w: Writer) => Promise<PlanChange | void>) => fn(w));
  const { run } = write;

  const withUndo = useCallback(
    async (fn: (w: Writer) => Promise<PlanChange>, message: string, focusUndo = false) => {
      const reverse = await run(fn);
      if (reverse) toast.show(message, { undo: () => run((w) => applyPlanChange(w, reverse)), focusUndo });
    },
    [run, toast],
  );

  return {
    pending: write.pending,
    /** The end-of-block answer. Partly or Not done on work says where it went; a practice says what was logged. */
    answer: async (block: BlockRow, answer: BlockAnswer) => {
      const done = await run((w) => answerBlock(w, block.id, answer, clock));
      if (!done) return;
      if (block.practice_id) toast.show(answer.result === 'done' ? `Logged ${formatMinutes(answer.logged_min ?? 0)}` : "Skipped. It doesn't need a new time.");
      else if (answer.result !== 'done') toast.show(QUEUED);
    },
    /** One check-in answer for several missed blocks. */
    noneDone: async (blocks: readonly BlockRow[]) => {
      const done = await run(async (w) => {
        for (const b of blocks) await answerBlock(w, b.id, { result: 'not' }, clock);
        return { writes: [] };
      });
      if (done) toast.show(QUEUED);
    },
    markDoneNow: (block: BlockRow, next: BlockRow | undefined) =>
      withUndo(
        (w) => markDoneNow(w, block.id, clock),
        next ? `Marked done. You're free until ${formatTime(next.start, clock.zone())}.` : 'Marked done. Nothing else planned today.',
        // The Mark done now button unmounts with its block, so focus would otherwise fall to the page.
        true,
      ),
    start: (block: BlockRow) => run((w) => startBlock(w, block.id, clock)),
    startEarly: (block: BlockRow) => run((w) => startEarly(w, block.id, clock)),
    swap: (block: BlockRow, next: BlockRow) => withUndo((w) => swapBlocks(w, block.id, next.id), 'Swapped with your next block'),
    stillGoing: async (block: BlockRow) => {
      if (await run((w) => extendBlock(w, block.id, STILL_GOING_MIN))) toast.show(`Added ${STILL_GOING_MIN} minutes`);
    },
    snooze: (block: BlockRow) => {
      snoozeBlock(block.id, snoozeUntil(clock));
      toast.show("I'll check again in 10 minutes");
    },
  };
}

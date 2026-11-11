// What a person can do to a block, as one transaction each with the message that follows. Today and Week share it.

import { useCallback } from 'react';
import {
  answerBlock,
  answerBlocks,
  extendBlock,
  markDoneNow,
  pauseBlock,
  resumeBlock,
  startBlock,
  startEarly,
  swapBlocks,
  timeSpentMs,
  unscheduleBlock,
} from '../../../core/blocks';
import type { BlockAnswer, BlockAnswerFor } from '../../../core/blocks';
import { formatMinutes, formatTime, localDate, weekStart } from '../../../core/dates';
import { applyPlanChange } from '../../../core/plan';
import type { PlanChange } from '../../../core/plan';
import type { BlockRow } from '../../../core/queries';
import type { Db } from '../../../core/db';
import type { Writer } from '../../../core/records';
import { snoozeUntil } from '../../../core/reminders';
import { snoozeBlock, STILL_GOING_MIN } from '../../app/reminders';
import { useApp, useMutation } from '../../app/store';
import { useToast } from '../Toast';

const QUEUED = 'Added to Needs a new time. No need to decide now.';

/** As long as a pause takes to leave a trace, a Resume can be taken back. */
const TAKE_BACK_MS = 30_000;
/**
 * The last Resume, from the ring, P or the end question, which a Pause soon after takes back exactly, since none shows
 * a toast to undo it from. Held only in this session; past the window, the tap is a new pause.
 */
let lastResume: { db: Db; blockId: string; at: number; reverse: PlanChange } | null = null;

export function useBlockActions() {
  const { clock, db } = useApp();
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
    /**
     * Answers from the missed blocks sheet, one row or several, in one transaction with one Undo. The message hears
     * how many later blocks went with a task the answers finished. Resolves to whether it saved.
     */
    answerAll: async (answers: readonly BlockAnswerFor[], message: (freed: number) => string) => {
      let freed = 0;
      const reverse = await run(async (w) => {
        const answered = await answerBlocks(w, answers, clock);
        freed = answered.freed.length;
        return answered;
      });
      if (reverse) toast.show(message(freed), { undo: () => run((w) => applyPlanChange(w, reverse)) });
      return !!reverse;
    },
    /** Says the time spent, pauses left out, on a block started a minute or more ago. */
    markDoneNow: (block: BlockRow, next: BlockRow | undefined) => {
      const minutes = block.started_at ? Math.round(timeSpentMs(block, clock.now()) / 60_000) : 0;
      const spent = minutes ? ` after ${formatMinutes(minutes)}` : '';
      return withUndo(
        (w) => markDoneNow(w, block.id, clock),
        `Marked done${spent}. ${next ? `You're free until ${formatTime(next.start, clock.zone())}.` : 'Nothing else planned today.'}`,
        // The Mark done now button unmounts with its block, so focus would otherwise fall to the page.
        true,
      );
    },
    /**
     * Pause says so, and its Undo takes the pause away with the end where it was. Resume has no toast: a Pause soon
     * after it takes it back exactly, paused again from the same moment with the end where it was, and that Pause's
     * Undo puts the Resume back. A Pause another device got to first saves nothing, so says nothing.
     */
    pause: async (block: BlockRow) => {
      const last = lastResume;
      lastResume = null;
      const since = last ? clock.now() - last.at : -1;
      const takeBack = last && last.db === db && last.blockId === block.id && since >= 0 && since < TAKE_BACK_MS ? last.reverse : null;
      const reverse = await run((w) => (takeBack ? applyPlanChange(w, takeBack) : pauseBlock(w, block.id, clock)));
      if (reverse?.writes.length) toast.show(`Paused ${block.title ?? 'the block'}`, { undo: () => run((w) => applyPlanChange(w, reverse)) });
    },
    resume: async (block: BlockRow) => {
      const reverse = await run((w) => resumeBlock(w, block.id, clock));
      lastResume = reverse?.writes.length ? { db, blockId: block.id, at: clock.now(), reverse } : null;
    },
    /** Skip, choose a new time later: off the calendar and into To schedule, still in its week. */
    skip: (block: BlockRow) =>
      withUndo(
        (w) => unscheduleBlock(w, block.id, weekStart(localDate(block.start, clock.zone())), clock),
        `Took ${block.title ?? 'it'} off the calendar. It's in To schedule on Week.`,
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

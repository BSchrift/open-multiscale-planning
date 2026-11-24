// What a person can do to a block, as one transaction each with the message that follows. Today and Week share it.

import { useCallback } from 'react';
import {
  answerBlock,
  answerBlocks,
  endNow,
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
import { formatMinutes, formatTime, formatWeekday, instantMs, localDate, weekStart } from '../../../core/dates';
import { applyPlanChange } from '../../../core/plan';
import type { PlanChange } from '../../../core/plan';
import type { BlockRow } from '../../../core/queries';
import type { Db } from '../../../core/db';
import type { Writer } from '../../../core/records';
import { snoozeUntil } from '../../../core/reminders';
import { closeTask, tickOneOff } from '../../../core/tasks';
import { snoozeBlock, STILL_GOING_MIN } from '../../app/reminders';
import { useApp, useMutation } from '../../app/store';
import { useToastOr } from '../Toast';
import type { Say } from '../Toast';

const QUEUED = 'Added to Needs a new time. No need to decide now.';

/** As long as a pause takes to leave a trace, a Resume can be taken back. */
const TAKE_BACK_MS = 30_000;
/**
 * The last Resume, from the ring, P or the end question, which a Pause soon after takes back exactly, as its toast's
 * Undo would: a tap straight after Resume is likelier a slip than a new pause. Held only in this session; past the
 * window, or once that Undo has taken the Resume back, a Pause is a new one.
 */
let lastResume: { db: Db; blockId: string; at: number; reverse: PlanChange } | null = null;

/** say: where its messages go instead of the app's toast, as the phone's Schedule step says its own above its dock. */
export function useBlockActions(say?: Say) {
  const { clock, db } = useApp();
  const toast = useToastOr(say);
  const write = useMutation((w, fn: (w: Writer) => Promise<PlanChange | void>) => fn(w));
  const { run } = write;

  const withUndo = useCallback(
    async (fn: (w: Writer) => Promise<PlanChange>, message: string, focusUndo = false) => {
      const reverse = await run(fn);
      if (reverse) toast.show(message, { undo: () => run((w) => applyPlanChange(w, reverse)), focusUndo });
    },
    [run, toast],
  );
  /**
   * Start, or Start early, which moves the block to now. A start stops any other block under way, so it says which, with
   * an Undo that puts both back; `say` says Started, and where an early one now runs, even when it stopped none.
   */
  const begin = async (block: BlockRow, early: boolean, say: boolean) => {
    const now = clock.now();
    let stopped: readonly BlockRow[] = [];
    const reverse = await run(async (w) => {
      const started = await (early ? startEarly(w, block.id, clock) : startBlock(w, block.id, clock));
      stopped = started.stopped;
      return started;
    });
    if (!reverse || (!say && stopped.length === 0)) return reverse;
    const zone = clock.zone();
    const from = Math.floor(now / 60_000) * 60_000;
    const runs = early ? ` It now runs ${formatTime(from, zone)} to ${formatTime(from + instantMs(block.end) - instantMs(block.start), zone)}.` : '';
    const ended = stopped.map((b) => ` Stopped ${b.title ?? 'a block'} at ${formatTime(now, zone)}.`).join('');
    toast.show(`Started ${block.title ?? 'the block'}.${runs}${ended}`, { undo: () => run((w) => applyPlanChange(w, reverse)) });
    return reverse;
  };
  /** ' after 22m': the time spent, pauses left out, on a block started a minute or more ago. */
  const after = (block: BlockRow) => {
    const minutes = block.started_at ? Math.round(timeSpentMs(block, clock.now()) / 60_000) : 0;
    return minutes ? ` after ${formatMinutes(minutes)}` : '';
  };

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
    /**
     * Done on a block still to come: the task finishes now, as its row's box would, rather than the block being answered,
     * so this block and any later ones come off the calendar and their time is free.
     */
    finish: async (block: BlockRow) => {
      const taskId = block.task_id;
      if (!taskId) return;
      const reverse = await run((w) => (block.task_kind === 'one_off' ? tickOneOff(w, taskId, clock) : closeTask(w, taskId, 'done', clock)));
      if (!reverse) return;
      const freed = reverse.writes.filter((r) => r.type === 'time_block').length;
      const later = freed > 2 ? ` and ${freed - 1} later ones` : freed === 2 ? ' and 1 later one' : '';
      const off = freed ? ` Its ${formatTime(block.start, clock.zone())} block${later} came off the calendar, so that time is free.` : '';
      // The block it was pressed on goes, so focus would otherwise fall to the page.
      toast.show(`Marked ${block.title ?? 'it'} done.${off}`, { undo: () => run((w) => applyPlanChange(w, reverse)), focusUndo: true });
    },
    /** Says the time spent, pauses left out, on a block started a minute or more ago. */
    markDoneNow: (block: BlockRow, next: BlockRow | undefined) =>
      withUndo(
        (w) => markDoneNow(w, block.id, clock),
        `Marked done${after(block)}. ${next ? `You're free until ${formatTime(next.start, clock.zone())}.` : 'Nothing else planned today.'}`,
        // The Mark done now button unmounts with its block, so focus would otherwise fall to the page.
        true,
      ),
    /**
     * Stop for now: the block ends now, as Mark done now ends it, answered Partly with the time left or Not done, so the
     * task waits in Needs a new time. Undo puts the block and its answer back as they were.
     */
    stopForNow: (block: BlockRow, answer: BlockAnswer) =>
      // Its question closes and the Stop for now button goes with the block, so focus would otherwise fall to the page.
      withUndo((w) => endNow(w, block.id, answer, clock), `Stopped${after(block)}. ${QUEUED}`, true),
    /**
     * Pause and Resume each say so, with Undo, and each toast takes the place of the other's, so the one showing always
     * matches the ring. Pause's Undo takes the pause away with the end where it was; Resume's puts the pause back, with
     * its old end. A Pause soon after a Resume takes it back exactly, as Resume's Undo would, and its own Undo puts the
     * Resume back. One that another device got to first saves nothing, so says nothing.
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
      let end = block.end;
      const reverse = await run(async (w) => {
        const change = await resumeBlock(w, block.id, clock);
        end = change.end;
        return change;
      });
      if (!reverse?.writes.length) {
        lastResume = null;
        return;
      }
      const resumed = { db, blockId: block.id, at: clock.now(), reverse };
      lastResume = resumed;
      toast.show(`Resumed. It now ends at ${formatTime(end, clock.zone())}.`, {
        undo: () => {
          // Undone, it's no longer there for a Pause to take back.
          if (lastResume === resumed) lastResume = null;
          return run((w) => applyPlanChange(w, reverse));
        },
      });
    },
    /**
     * Take off calendar, choose a new time later: off the calendar and into To schedule, still in its week. A practice's
     * session says where it was, as it waits for that day only.
     */
    skip: (block: BlockRow) =>
      withUndo(
        (w) => unscheduleBlock(w, block.id, weekStart(localDate(block.start, clock.zone())), clock),
        block.practice_id
          ? `Took ${block.title ?? 'it'} off ${formatWeekday(localDate(block.start, clock.zone()))} ${formatTime(block.start, clock.zone())}. It's in To schedule.`
          : `Took ${block.title ?? 'it'} off the calendar. It's in To schedule on Week.`,
        true,
      ),
    start: (block: BlockRow) => begin(block, false, false),
    startEarly: (block: BlockRow) => begin(block, true, false),
    /** Start, or for one later today Start now, which moves it to now, keeping its length. Says where it now runs. */
    startNow: (block: BlockRow) => begin(block, instantMs(block.start) > clock.now(), true),
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

// What a block's popup section and Today's quick menu both do to a block, so each says and undoes the same: Done as
// fits where the block is in its day, an answer for one gone by, and Start with where it now runs.

import type { BlockAnswer } from '../../../core/blocks';
import { formatTime, instantMs } from '../../../core/dates';
import { applyPlanChange } from '../../../core/plan';
import type { PlanChange } from '../../../core/plan';
import type { BlockRow } from '../../../core/queries';
import type { Minutes } from '../../../core/types';
import { useApp, useMutation } from '../../app/store';
import { useToast } from '../Toast';
import { answerFor, saidOf } from './MissedSheet';
import { useBlockActions } from './useBlockActions';

const MINUTE_MS = 60_000;

/** Where a block is in its day: answered, gone by with no answer, under way, or still to come. */
export type Stage = 'answered' | 'gone' | 'now' | 'later';

export function stageOf(block: BlockRow, now: number): Stage {
  if (block.result) return 'answered';
  if (block.ended_at || instantMs(block.end) <= now) return 'gone';
  return instantMs(block.start) <= now ? 'now' : 'later';
}

export function useBlockCommands() {
  const { clock } = useApp();
  const toast = useToast();
  const actions = useBlockActions();
  const undo = useMutation((w, reverse: PlanChange) => applyPlanChange(w, reverse));

  /** One block's answer, as the missed blocks sheet saves a row. Resolves to whether it saved. */
  const answer = (block: BlockRow, choice: BlockAnswer['result'], minutes: Minutes = 0) =>
    actions.answerAll([{ blockId: block.id, answer: answerFor(block, choice, minutes) }], (freed) => saidOf(block, choice, minutes, freed));

  return {
    ...actions,
    answer,
    /**
     * Done: for one gone by, its answer; for the one under way, Mark done now; for a task's block still to come, the
     * task finishes and frees its time. A practice's session still to come is logged as done, as Did it would be after.
     */
    done: (block: BlockRow, next: BlockRow | undefined): Promise<unknown> => {
      const stage = stageOf(block, clock.now());
      if (stage === 'now') return actions.markDoneNow(block, next);
      if (stage === 'later' && block.task_id) return actions.finish(block);
      return answer(block, 'done');
    },
    /** Start, or for one later today Start now, which moves it to now, keeping its length. Says where it now runs. */
    startNow: async (block: BlockRow) => {
      const now = clock.now();
      const early = instantMs(block.start) > now;
      const reverse = await (early ? actions.startEarly(block) : actions.start(block));
      if (!reverse) return;
      const zone = clock.zone();
      const from = Math.floor(now / MINUTE_MS) * MINUTE_MS;
      const runs = early ? ` It now runs ${formatTime(from, zone)} to ${formatTime(from + instantMs(block.end) - instantMs(block.start), zone)}.` : '';
      toast.show(`Started ${block.title ?? 'the block'}.${runs}`, { undo: () => undo.run(reverse) });
    },
  };
}

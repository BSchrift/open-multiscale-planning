// What a block's popup section and Today's quick menu both do to a block, so each says and undoes the same: Done as
// fits where the block is in its day, an answer for one gone by, and Start now (from useBlockActions) with where it now
// runs.

import type { BlockAnswer } from '../../../core/blocks';
import { instantMs } from '../../../core/dates';
import type { BlockRow } from '../../../core/queries';
import type { Minutes } from '../../../core/types';
import { useApp } from '../../app/store';
import { answerFor, saidOf } from './MissedSheet';
import { useBlockActions } from './useBlockActions';

/** Where a block is in its day: answered, gone by with no answer, under way, or still to come. */
export type Stage = 'answered' | 'gone' | 'now' | 'later';

export function stageOf(block: BlockRow, now: number): Stage {
  if (block.result) return 'answered';
  if (block.ended_at || instantMs(block.end) <= now) return 'gone';
  return instantMs(block.start) <= now ? 'now' : 'later';
}

export function useBlockCommands() {
  const { clock } = useApp();
  const actions = useBlockActions();

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
  };
}

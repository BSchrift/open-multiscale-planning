// One calendar block for every calendar, phone and desktop (docs/design.md). The kind sets the colour; the state sets
// the shape, the icon and the word. Each calendar keeps its own element and geometry, and takes the look from
// blockClass and BlockMarks.

import type { BlockResult } from '../../../core/types';
import type { BlockKind } from '../blocks/describe';
import { AnswerBadge } from './AnswerBadge';

export type BlockLook = 'project' | 'practice' | 'oneoff' | 'planning' | 'event' | 'info';
/** A block record's kind, as the block draws it. */
export const LOOK: Record<BlockKind, BlockLook> = { project: 'project', one_off: 'oneoff', practice: 'practice', planning: 'planning' };
export type BlockState = 'planned' | 'now' | 'done' | 'partly' | 'notdone' | 'goneby' | 'placing' | 'drop' | 'suggested';

/** A block's state from its answer, whether it has ended, and whether it's the one under way. */
export function blockState(b: { result?: BlockResult | null; ended: boolean; now?: boolean }): BlockState {
  if (b.result === 'done') return 'done';
  if (b.result === 'partly') return 'partly';
  if (b.result === 'not') return 'notdone';
  if (b.ended) return 'goneby';
  return b.now ? 'now' : 'planned';
}

/** The block's classes: blk, its kind, its state, and short for one too small for its text. */
export function blockClass(kind: BlockLook, state: BlockState, opts: { short?: boolean } = {}): string {
  return `blk k-${kind} s-${state}${opts.short ? ' short' : ''}`;
}

const ANSWER = { done: 'done', partly: 'partly', notdone: 'notdone', goneby: 'none' } as const;

/** What a state draws beside the title: the answer badge on a block gone by; the live dot and Now on the one under way. */
export function BlockMarks(props: { state: BlockState; short?: boolean }) {
  const { state, short } = props;
  if (state === 'now') {
    return (
      <span className="blknow">
        <span className="live" aria-hidden="true" />
        {!short && 'Now'}
      </span>
    );
  }
  if (state in ANSWER) return <AnswerBadge answer={ANSWER[state as keyof typeof ANSWER]} small={short} />;
  return null;
}

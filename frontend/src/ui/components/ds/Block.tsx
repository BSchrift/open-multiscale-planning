// One calendar block for every calendar, phone and desktop (docs/design.md). The kind sets the colour; the state sets
// the shape, the icon and the word. Each calendar keeps its own element and geometry, and takes the look from
// blockClass and BlockMarks.

import type { BlockResult } from '../../../core/types';
import type { BlockKind } from '../blocks/describe';
import { AnswerBadge } from './AnswerBadge';
import { Icon } from './Icon';

export type BlockLook = 'project' | 'practice' | 'oneoff' | 'planning' | 'inbox' | 'event' | 'info';
/** A block record's kind, as the block draws it. */
export const LOOK: Record<BlockKind, BlockLook> = { project: 'project', one_off: 'oneoff', practice: 'practice', planning: 'planning', inbox: 'inbox' };
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

/**
 * What a block draws beside the title: the inbox icon on an Inbox item's, which no kind's colour marks yet; then the
 * answer badge on a block gone by, or the live dot and Now on the one under way.
 */
export function BlockMarks(props: { state: BlockState; short?: boolean; look?: BlockLook }) {
  const { state, short } = props;
  const inbox = props.look === 'inbox' && <Icon name="inbox" size={16} className="blkinbox" />;
  if (state === 'now') {
    return (
      <>
        {inbox}
        <span className="blknow">
          <span className="live" aria-hidden="true" />
          {!short && 'Now'}
        </span>
      </>
    );
  }
  if (state in ANSWER) {
    return (
      <>
        {inbox}
        <AnswerBadge answer={ANSWER[state as keyof typeof ANSWER]} small={short} />
      </>
    );
  }
  return inbox || null;
}

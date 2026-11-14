// How a block gone by reads, the same on every calendar. It's muted; Done is struck through; Partly and Not done never
// are, and say so in words before the title, outlined dashed, Not done in amber. One with no answer yet is only muted.

import type { BlockResult } from '../../../core/types';
import { OUTCOME_WORD } from './describe';

/** ' done', ' partly' or ' notdone', for a block's classes. */
export const outcomeClass = (result: BlockResult | null | undefined) =>
  result === 'done' ? ' done' : result === 'partly' ? ' partly' : result === 'not' ? ' notdone' : '';

/** 'Partly' or '✕ Not done' before a block's title, so colour is never the only sign. Done is struck through instead. */
export function OutcomeTag(props: { result: BlockResult | null | undefined }) {
  const { result } = props;
  if (result !== 'partly' && result !== 'not') return null;
  return (
    <span className={result === 'not' ? 'outw outw-not' : 'outw'}>
      {result === 'not' && <span aria-hidden="true">✕ </span>}
      {OUTCOME_WORD[result]}{' '}
    </span>
  );
}

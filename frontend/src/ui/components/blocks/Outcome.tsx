// How a block gone by says its answer in words, the same on every calendar, beside the answer badge (Block.tsx): Partly
// and Not done say so before the title, so colour and the badge are never the only sign. Done is struck through
// instead, and nothing else is. Not done is never amber.

import type { BlockResult } from '../../../core/types';
import { OUTCOME_WORD } from './describe';

/** 'Partly' or 'Not done' before a block's title. */
export function OutcomeTag(props: { result: BlockResult | null | undefined }) {
  const { result } = props;
  if (result !== 'partly' && result !== 'not') return null;
  return <span className="outw">{OUTCOME_WORD[result]} </span>;
}

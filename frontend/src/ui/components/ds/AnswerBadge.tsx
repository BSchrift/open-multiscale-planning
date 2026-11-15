// A block's answer as a round badge, in ink rather than the kind's colour (docs/design.md): a filled tick for Done,
// a half circle for Partly, a cross in a ring for Not done, a dashed ring for no answer yet. 16px, or 12px on a
// 15-minute block. Hidden from screen readers: the block's name says its answer in words.

import { Icon } from './Icon';
import type { IconName } from './Icon';

export type Answer = 'done' | 'partly' | 'notdone' | 'none';
const ICON: Record<Answer, IconName> = { done: 'done', partly: 'partly', notdone: 'not-done', none: 'no-answer' };

export function AnswerBadge(props: { answer: Answer; small?: boolean }) {
  return (
    <span className={`ansbadge b-${props.answer}${props.small ? ' small' : ''}`} aria-hidden="true">
      <Icon name={ICON[props.answer]} size={16} />
    </span>
  );
}

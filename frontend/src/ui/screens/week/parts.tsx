// Pieces both Week layouts use.

import { weekday } from '../../../core/dates';
import type { Minutes } from '../../../core/types';
import { KeepAsk } from '../../components/editors/KeepAsk';
import type { WeekModel } from './data';
import { useWeekActions } from './useWeekActions';

/** After a practice session moves to a new time on its day or changes length. Leaving it unanswered means this week only. */
export function PracticeAsk(props: { ask: { blockId: string; wasMin: Minutes }; model: WeekModel; onDone(): void }) {
  const { ask, model, onDone } = props;
  const act = useWeekActions();
  const block = model.blocks.find((b) => b.id === ask.blockId);
  const practice = block && model.practices.find((p) => p.id === block.practice_id);
  if (!block || !practice) return null;
  return (
    <KeepAsk
      practice={practice}
      slot={block}
      day={weekday(block.date)}
      wasMin={ask.wasMin}
      onKeep={(choice) => {
        void act.keepPractice(block.id, choice);
        onDone();
      }}
      onNo={() => {
        onDone();
        document.querySelector<HTMLElement>(`[data-id="${block.id}"]`)?.focus();
      }}
    />
  );
}

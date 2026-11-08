// Pieces both Week layouts use.

import type { Minutes } from '../../../core/types';
import { useApp } from '../../app/store';
import { dayName, slotRange } from '../../components/weekgrid';
import type { WeekModel } from './data';
import { useWeekActions } from './useWeekActions';

/** After a practice session moves or changes length. Leaving it unanswered means this week only. */
export function PracticeAsk(props: { ask: { blockId: string; wasMin: Minutes }; model: WeekModel; onDone(): void }) {
  const { ask, model, onDone } = props;
  const { layout } = useApp();
  const act = useWeekActions();
  const block = model.blocks.find((b) => b.id === ask.blockId);
  if (!block) return null;
  return (
    <div className="panel stack8 wkask" role="status" aria-label="Make this change permanent?">
      <div>
        {block.title} is now {dayName(block.date)}, {slotRange(block)}.
      </div>
      <div className="strong small">Make this change permanent?</div>
      <div className="row">
        <button className={layout === 'phone' ? 'btn pri grow' : 'btn sm pri'} type="button" onClick={onDone}>
          No, this week only
        </button>
        <button
          className={layout === 'phone' ? 'btn grow' : 'btn sm'}
          type="button"
          onClick={() => {
            void act.keepPractice(block.id, ask.wasMin, block.title);
            onDone();
          }}
        >
          Yes, every week
        </button>
      </div>
    </div>
  );
}

// The Now card during a planning block: what's being planned, its time and the Inbox, and one button that opens
// planning. No countdown and no Mark done now: finishing the plan is what finishes the task.

import { startBlock } from '../../../core/blocks';
import { planningWeekOf } from '../../../core/planning';
import { inboxCount } from '../../../core/queries';
import type { BlockRow } from '../../../core/queries';
import type { Layout } from '../../app/registry';
import { useNav } from '../../app/nav';
import { useApp, useMutation, useQuery } from '../../app/store';
import { formatRange } from '../../components/blocks/describe';

export function PlanningNow(props: { block: BlockRow; layout: Layout }) {
  const { block } = props;
  const { clock } = useApp();
  const nav = useNav();
  const inbox = useQuery((sql) => inboxCount(sql), []).data ?? 0;
  const start = useMutation((w) => startBlock(w, block.id, clock));
  const week = planningWeekOf(block.task_id);
  const open = () => week && nav.openFlow('planning', { week });
  const started = !!block.started_at;
  return (
    <section className="now stack" aria-label="Current block">
      <h2>{block.title}</h2>
      <div className="small quiet">
        {formatRange(block.start, block.end, clock.zone())}
        {inbox ? ` · ${inbox} in your Inbox` : ''}
      </div>
      <div className="row">
        <button
          className={`btn pri${props.layout === 'phone' ? ' grow' : ''}`}
          type="button"
          disabled={start.pending}
          onClick={() => void (started ? Promise.resolve() : start.run()).then(open)}
        >
          {started ? 'Keep going' : 'Start planning'}
        </button>
      </div>
    </section>
  );
}

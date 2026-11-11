// The Now card during a planning block: what's being planned, its time and the Inbox, and one button that opens
// planning. No countdown and no Mark done now: finishing the plan is what finishes the task. A block an older app left
// for a week it planned says so, and offers Free this time in place of Start.

import { removeBlock, startBlock } from '../../../core/blocks';
import { applyPlanChange } from '../../../core/plan';
import { planningWeekOf } from '../../../core/planning';
import { inboxCount } from '../../../core/queries';
import type { BlockRow } from '../../../core/queries';
import { getRecord, weekPlanId } from '../../../core/records';
import type { Layout } from '../../app/registry';
import { useNav } from '../../app/nav';
import { useApp, useMutation, useQuery } from '../../app/store';
import { formatRange } from '../../components/blocks/describe';
import { useToast } from '../../components/Toast';

export function PlanningNow(props: { block: BlockRow; layout: Layout }) {
  const { block } = props;
  const { clock } = useApp();
  const nav = useNav();
  const toast = useToast();
  const week = planningWeekOf(block.task_id);
  const data = useQuery(
    async (sql) => ({ inbox: await inboxCount(sql), planned: !!week && !!(await getRecord(sql, 'week_plan', weekPlanId(week)))?.finished_at }),
    [week],
  ).data;
  const start = useMutation((w) => startBlock(w, block.id, clock));
  const free = useMutation((w) => removeBlock(w, block.id));
  const undo = useMutation((w, reverse: Awaited<ReturnType<typeof removeBlock>>) => applyPlanChange(w, reverse));
  const open = () => week && nav.openFlow('planning', { week });
  const started = !!block.started_at;
  const range = formatRange(block.start, block.end, clock.zone());
  const grow = props.layout === 'phone' ? ' grow' : '';
  const freeIt = async () => {
    const reverse = await free.run();
    if (reverse) toast.show(`Freed ${range}.`, { undo: () => undo.run(reverse), focusUndo: true });
  };
  return (
    <section className="now stack" aria-label="Current block">
      <h2>{block.title}</h2>
      <div className="small quiet">
        {range}
        {data?.inbox ? ` · ${data.inbox} in your Inbox` : ''}
      </div>
      {data?.planned && <p>This week is already planned.</p>}
      <div className="row">
        {data?.planned ? (
          <button className={`btn${grow}`} type="button" disabled={free.pending} onClick={() => void freeIt()}>
            Free this time
          </button>
        ) : (
          <button className={`btn pri${grow}`} type="button" disabled={start.pending} onClick={() => void (started ? Promise.resolve() : start.run()).then(open)}>
            {started ? 'Keep going' : 'Start planning'}
          </button>
        )}
      </div>
    </section>
  );
}

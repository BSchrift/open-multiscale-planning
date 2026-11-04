// Dropping a milestone: done tasks stay on record, and open ones move to the next open milestone or are cancelled.

import { useId, useState } from 'react';
import { formatMinutes } from '../../../core/dates';
import { dropMilestone, minutesLeft } from '../../../core/plan';
import type { PlanContext, ProjectPlan } from '../../../core/plan';
import { fixSummary, withStatusLine } from '../../../core/status';
import { usePlanChange } from './usePlanChange';

export function DropMilestone(props: { plan: ProjectPlan; ctx: PlanContext; milestoneId: string; onBack(): void; onDone?(): void }) {
  const { plan, ctx, milestoneId } = props;
  const name = useId();
  const apply = usePlanChange();
  const [cancel, setCancel] = useState(false);
  const m = plan.milestones.find((x) => x.id === milestoneId);
  if (!m) return null;
  const f = fixSummary(plan, milestoneId, ctx);
  const open = plan.tasks.filter((t) => t.milestone_id === milestoneId && !t.done_at && !t.cancelled_at);
  const openWhat = open.length === 1 ? open[0]!.title : `${open.length} open tasks`;

  const drop = async () => {
    const reverse = await apply((work) => withStatusLine(plan, dropMilestone(plan, milestoneId, { cancelOpen: cancel, ...work }, ctx), ctx), {
      closing: cancel ? open.map((t) => t.id) : [],
    });
    if (reverse) props.onDone?.();
  };

  return (
    <div className="stack8">
      <div className="strong">Drop {m.title}?</div>
      {f.doneCount > 0 && (
        <div className="small">{f.doneCount === 1 ? 'Its 1 done task stays on record.' : `Its ${f.doneCount} done tasks stay on record.`}</div>
      )}
      {open.length > 0 && (
        <fieldset className="stack8 plainset">
          <legend className="small">
            {openWhat} ({formatMinutes(open.reduce((sum, t) => sum + minutesLeft(t), 0))}):
          </legend>
          <label className="taskrow small">
            <input type="radio" name={name} checked={!cancel} onChange={() => setCancel(false)} />
            <span>{f.keepLabel}</span>
          </label>
          <label className="taskrow small">
            <input type="radio" name={name} checked={cancel} onChange={() => setCancel(true)} />
            <span>{f.cancelLabel}</span>
          </label>
        </fieldset>
      )}
      <div className="row fixacts">
        <button className="btn sm pri" type="button" onClick={drop}>
          Drop milestone
        </button>
        <button className="btn sm" type="button" onClick={props.onBack}>
          Back
        </button>
      </div>
    </div>
  );
}

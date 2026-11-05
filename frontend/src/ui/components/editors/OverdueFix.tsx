// An overdue milestone asks one question: move its date, drop it, or mark it done. Every answer can be undone from
// the project's change line.

import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import { addDays, today } from '../../../core/dates';
import { markMilestoneDone, moveMilestone } from '../../../core/plan';
import type { PlanContext, ProjectPlan } from '../../../core/plan';
import { fixSummary, previewMove, status, withStatusLine } from '../../../core/status';
import { MilestoneDiamond } from '../MilestoneDiamond';
import { DropMilestone } from './DropMilestone';
import { diamondFor } from './MilestoneEditor';
import { usePlanChange } from './usePlanChange';

export function OverdueFix(props: { plan: ProjectPlan; ctx: PlanContext }) {
  const { plan, ctx } = props;
  const late = status(plan, ctx).late;
  // Keyed by the milestone, so the next overdue one starts on the question.
  return late ? (
    <div className="panel stack8 fixpanel" role="group" aria-label={fixSummary(plan, late.id, ctx).title}>
      <OverdueQuestion key={late.id} plan={plan} ctx={ctx} milestoneId={late.id} />
    </div>
  ) : null;
}

/** The question itself, for a container of the caller's choosing. footer shows under the first question only. */
export function OverdueQuestion(props: { plan: ProjectPlan; ctx: PlanContext; milestoneId: string; onSaved?(): void; footer?: ReactNode }) {
  const { plan, ctx, milestoneId } = props;
  const id = useId();
  const apply = usePlanChange();
  const [mode, setMode] = useState<'ask' | 'move' | 'drop'>('ask');
  const [date, setDate] = useState(() => addDays(today(ctx.clock), 7));
  const f = fixSummary(plan, milestoneId, ctx);
  const move = previewMove(plan, milestoneId, date, ctx);
  const m = plan.milestones.find((x) => x.id === milestoneId)!;
  const open = plan.tasks.filter((t) => t.milestone_id === milestoneId && !t.done_at && !t.cancelled_at).map((t) => t.id);
  const heading = (
    <div className="strong">
      <MilestoneDiamond state={diamondFor(plan, m, ctx)} />
      Milestone: {f.title}
    </div>
  );

  const saved = (reverse: unknown) => {
    if (reverse) props.onSaved?.();
  };

  return (
    <>
      {mode === 'ask' && (
        <>
          {heading}
          <div className="small">{f.sub}</div>
          <div className="row fixacts">
            <button className="btn sm pri" type="button" onClick={() => setMode('move')}>
              Move date
            </button>
            <button className="btn sm" type="button" onClick={() => setMode('drop')}>
              Drop milestone
            </button>
            <button
              className="btn sm"
              type="button"
              onClick={() => apply((work) => withStatusLine(plan, markMilestoneDone(plan, milestoneId, work, ctx), ctx), { closing: open }).then(saved)}
            >
              {f.markLabel}
            </button>
          </div>
          {props.footer}
        </>
      )}
      {mode === 'move' && (
        <>
          {heading}
          <div className="stack8">
            <label className="small" htmlFor={id}>
              New due date
            </label>
            <input
              id={id}
              className="field datefield"
              type="date"
              autoFocus
              min={addDays(today(ctx.clock), 1)}
              value={date}
              onChange={(event) => setDate(event.target.value)}
            />
          </div>
          <div className="small">{move.preview}</div>
          {move.warnings.map((w) => (
            <div key={w} className="small quiet">
              {w}
            </div>
          ))}
          <div className="row fixacts">
            <button
              className="btn sm pri"
              type="button"
              disabled={!move.valid}
              onClick={() => apply(() => withStatusLine(plan, moveMilestone(plan, milestoneId, date, ctx), ctx)).then(saved)}
            >
              {move.moveLabel}
            </button>
            <button className="btn sm" type="button" onClick={() => setMode('ask')}>
              Back
            </button>
          </div>
        </>
      )}
      {mode === 'drop' && (
        <DropMilestone plan={plan} ctx={ctx} milestoneId={milestoneId} onBack={() => setMode('ask')} {...(props.onSaved ? { onDone: props.onSaved } : {})} />
      )}
    </>
  );
}

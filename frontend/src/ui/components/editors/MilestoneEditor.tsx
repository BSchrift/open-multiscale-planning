// Adds or edits a milestone: a popover on desktop, a sheet on phone. Adding stays open with the last one named.
// Editing previews what a new date does to the project's status, and holds Mark met, Not met and Drop. Its fields
// wait for Save, and Esc or a click outside keeps any changes rather than dropping them.

import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { formatDate, isDay, today } from '../../../core/dates';
import {
  applyPlanChange,
  doneInPlan,
  effectiveDue,
  markMilestoneDone,
  markMilestoneNotMet,
  milestoneWarnings,
  moveDone,
  moveMilestone,
  msInPlan,
  msReached,
  planStretch,
  toggleInPlan,
  withChange,
} from '../../../core/plan';
import type { PlanChange, PlanContext, ProjectPlan } from '../../../core/plan';
import { status, withStatusLine } from '../../../core/status';
import type { Milestone } from '../../../core/types';
import { useMutation } from '../../app/store';
import { MilestoneDiamond } from '../MilestoneDiamond';
import type { DiamondState } from '../MilestoneDiamond';
import { Popover } from '../Popover';
import { DropMilestone } from './DropMilestone';
import { useLeave } from './useLeave';
import { usePlanChange } from './usePlanChange';


/** How a milestone's diamond reads: solid in the plan, hollow not, red when overdue, grey once met. */
export function diamondFor(plan: ProjectPlan, m: Milestone, ctx: PlanContext): DiamondState {
  if (msReached(plan, m)) return { met: true };
  const on = !m.dropped_at && msInPlan(plan, m, planStretch(ctx.settings, today(ctx.clock), ctx.planning));
  return { on, late: status(plan, ctx).late?.id === m.id };
}

/** The same for the project's implicit Done, ringed so it reads as the end. */
export function doneDiamond(plan: ProjectPlan, ctx: PlanContext): DiamondState {
  const on = today(ctx.clock);
  if (plan.project.state === 'finished') return { done: true, met: true };
  return { done: true, on: doneInPlan(plan, planStretch(ctx.settings, on, ctx.planning)), late: plan.project.state === 'active' && plan.project.end < on };
}

/** "Project stays On track." or "Project goes from Overdue to Behind." */
const statusPreview = (plan: ProjectPlan, change: PlanChange, ctx: PlanContext) => {
  const before = status(plan, ctx).pill;
  const after = status(withChange(plan, change), ctx).pill;
  return before === after ? `Project stays ${before}.` : `Project goes from ${before} to ${after}.`;
};

export function MilestoneEditor(props: { plan: ProjectPlan; ctx: PlanContext; milestoneId?: string; onClose(): void }) {
  const { plan, ctx, onClose } = props;
  const m = props.milestoneId ? plan.milestones.find((x) => x.id === props.milestoneId) : undefined;
  const [mode, setMode] = useState<'edit' | 'drop'>('edit');
  const label = m ? 'Edit milestone' : 'Add milestone';
  const leave = useRef<(() => boolean) | null>(null);
  return (
    <Popover label={label} onClose={() => (leave.current ? leave.current() : onClose())}>
      {m && mode === 'drop' ? (
        <DropMilestone plan={plan} ctx={ctx} milestoneId={m.id} onBack={() => setMode('edit')} onDone={onClose} />
      ) : (
        <Fields plan={plan} ctx={ctx} milestone={m} heading={label} onClose={onClose} onDrop={() => setMode('drop')} leaveRef={leave} />
      )}
    </Popover>
  );
}

function Fields(props: {
  plan: ProjectPlan;
  ctx: PlanContext;
  milestone?: Milestone;
  heading: string;
  onClose(): void;
  onDrop(): void;
  leaveRef: { current: (() => boolean) | null };
}) {
  const { plan, ctx, milestone: m, onClose } = props;
  const ids = { start: useId(), due: useId() };
  const on = today(ctx.clock);
  const apply = usePlanChange();
  const [name, setName] = useState(m?.title ?? '');
  const [due, setDue] = useState(m?.due ?? '');
  const [start, setStart] = useState(m?.start ?? '');
  const [startOpen, setStartOpen] = useState(!!m?.start);
  const [error, setError] = useState('');
  const [last, setLast] = useState('');

  const add = useMutation(async (w, title: string) => {
    await w.create('milestone', { project_id: plan.project.id, title, due, start: start || null, added_on: on });
    // Done stays last, so a date past the end moves it.
    if (due > plan.project.end) await applyPlanChange(w, moveDone(plan, due, ctx));
    return true;
  });

  const met = !!m && msReached(plan, m);
  const dateChanged = !!m && due !== (m.due ?? '');
  const dateValid = isDay(due) && due >= on;
  const live = m ? plan.tasks.filter((t) => t.milestone_id === m.id && !t.cancelled_at) : [];
  const stretch = planStretch(ctx.settings, on, ctx.planning);
  const moved = m && dateChanged && dateValid ? withStatusLine(plan, moveMilestone(plan, m.id, due, ctx), ctx) : null;
  const draft: Milestone = m ?? { id: 'new', project_id: plan.project.id, title: name, due };
  const warnings = dateValid && (!m || dateChanged) ? milestoneWarnings({ ...plan, milestones: m ? plan.milestones : [...plan.milestones, draft] }, draft.id, due, ctx) : [];
  // Adding stays as it was: Esc or a click outside closes it.
  const { saveRef, leave } = useLeave(!!m && (name !== m.title || dateChanged || start !== (m.start ?? '')), onClose, setError);
  const { leaveRef } = props;
  useEffect(() => {
    leaveRef.current = leave;
    return () => void (leaveRef.current = null);
  });

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const title = name.trim();
    if (!title) return setError('Give it a name.');
    if ((!m || dateChanged) && !dateValid) return setError('Pick today or a later date.');
    if (start && start > (due || (m ? effectiveDue(plan, m, ctx) : ''))) return setError('A start date has to be on or before the due date.');
    // A failed save keeps the form as it was, and has said so.
    if (!m) {
      if (!(await add.run(title))) return;
      setName('');
      setDue('');
      setStart('');
      setStartOpen(false);
      setLast(title);
      return;
    }
    const writes = [{ type: 'milestone' as const, id: m.id, fields: { title, start: start || null } }, ...(moved?.writes ?? [])];
    if (await apply(() => ({ writes }), { message: `Saved ${title}.` })) onClose();
  };

  const togglePlan = async () => {
    if (!m) return;
    const change = withStatusLine(plan, toggleInPlan(plan, m.id, stretch, ctx), ctx);
    if (await apply(() => change)) setDue(withChange(plan, change).milestones.find((x) => x.id === m.id)?.due ?? '');
  };

  const after = (make: () => PlanChange) => async () => {
    if (await apply(make)) onClose();
  };

  return (
    <form className="stack8 editor" onSubmit={save}>
      <h2>
        <MilestoneDiamond state={m ? diamondFor(plan, m, ctx) : {}} />
        {props.heading}
      </h2>
      <label className="popfield">
        Name
        <input
          className="field"
          autoFocus
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            setError('');
          }}
        />
      </label>
      {!met && (
        <>
          <label className="popfield" htmlFor={ids.due}>
            Due date
          </label>
          <input
            id={ids.due}
            className="field datefield"
            type="date"
            value={due}
            onChange={(event) => {
              setDue(event.target.value);
              setError('');
            }}
          />
          {m && !due && <div className="small quiet">No date set, so by {formatDate(effectiveDue(plan, m, ctx))}.</div>}
          {startOpen ? (
            <>
              <label className="popfield" htmlFor={ids.start}>
                Start date (optional)
              </label>
              <input id={ids.start} className="field datefield" type="date" value={start} onChange={(event) => setStart(event.target.value)} />
            </>
          ) : (
            <div>
              <button className="link small" type="button" onClick={() => setStartOpen(true)}>
                Add start date
              </button>
            </div>
          )}
        </>
      )}
      {error && (
        <div className="fielderr" role="alert">
          {error}
        </div>
      )}
      {moved && <div className="small">{statusPreview(plan, moved, ctx)}</div>}
      {warnings.map((w) => (
        <div key={w} className="small quiet">
          {w}
        </div>
      ))}
      <div className="small quiet" role="status">
        {last && `Added ${last}.`}
      </div>
      <div className="row">
        <button ref={saveRef} className="btn sm pri grow" type="submit">
          {m ? 'Save' : 'Add'}
        </button>
        <button className="btn sm" type="button" onClick={onClose}>
          {last && !name.trim() ? 'Done' : 'Cancel'}
        </button>
      </div>
      {/* Act at once, each with its Undo, so they sit apart from Save and Cancel. */}
      {m && (
        <div className="stack8">
          {!met && !m.dropped_at && ctx.settings.plan_cadence && (
            <label className="taskrow small">
              <input type="checkbox" checked={msInPlan(plan, m, stretch)} onChange={togglePlan} />
              <span>
                In this plan, {formatDate(stretch.start)} to {formatDate(stretch.end)}
              </span>
            </label>
          )}
          <div className="row">
            {!met && live.length === 0 && (
              <button className="btn sm" type="button" onClick={after(() => withStatusLine(plan, markMilestoneDone(plan, m.id, {}, ctx), ctx))}>
                Mark met
              </button>
            )}
            {!!m.met_at && live.length === 0 && (
              <button className="btn sm" type="button" onClick={after(() => withStatusLine(plan, markMilestoneNotMet(plan, m.id, ctx), ctx))}>
                Not met
              </button>
            )}
            {!met && (
              <button className="btn sm" type="button" onClick={props.onDrop}>
                Drop milestone
              </button>
            )}
          </div>
        </div>
      )}
    </form>
  );
}

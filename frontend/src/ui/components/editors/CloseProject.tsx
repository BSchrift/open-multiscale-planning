// Finish, Change end date and Drop for a project. Finish and Drop ask first, since they close every open task.

import { useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { addDays, addMonths, formatDate, formatMinutes, isDay, today } from '../../../core/dates';
import { doneDateError, moveDone } from '../../../core/plan';
import type { PlanContext, ProjectPlan } from '../../../core/plan';
import { status } from '../../../core/status';
import { closeProject } from '../../../core/tasks';
import { useApp, useMutation } from '../../app/store';
import { useToast } from '../Toast';
import { usePlanChange } from './usePlanChange';


/** A new end date, with 2 weeks, 1 month and 3 months as shortcuts from the end, or from today once it has passed. */
function ChangeEndDate(props: { plan: ProjectPlan; ctx: PlanContext; onDone?(): void }) {
  const { plan, ctx } = props;
  const id = useId();
  const apply = usePlanChange();
  const on = today(ctx.clock);
  const base = status(plan, ctx).ended ? on : plan.project.end;
  const [date, setDate] = useState(() => addMonths(base, 1));
  const error = !isDay(date) ? 'Pick a date.' : date <= on ? `Pick a date after ${formatDate(on)}.` : doneDateError(plan, date);

  const save = async () => {
    if (error) return;
    if (await apply(() => moveDone(plan, date, ctx))) props.onDone?.();
  };

  return (
    <div className="stack8">
      <label className="small quiet" htmlFor={id}>
        New end date
      </label>
      <input id={id} className="field datefield" type="date" min={addDays(on, 1)} value={date} onChange={(event) => setDate(event.target.value)} />
      <div className="row">
        <button className="dchip" type="button" onClick={() => setDate(addDays(base, 14))}>
          2 weeks
        </button>
        <button className="dchip" type="button" onClick={() => setDate(addMonths(base, 1))}>
          1 month
        </button>
        <button className="dchip" type="button" onClick={() => setDate(addMonths(base, 3))}>
          3 months
        </button>
      </div>
      {error && isDay(date) && (
        <div className="fielderr" role="alert">
          {error}
        </div>
      )}
      <div>
        <button className="btn sm pri" type="button" disabled={!!error} onClick={save}>
          {isDay(date) ? `Change end date to ${formatDate(date)}` : 'Change end date'}
        </button>
      </div>
    </div>
  );
}

/**
 * Finish or Drop's question, in place of the button that asked it, so focus goes into it. Cancel, or Esc, backs out of
 * just the question and gives focus to back(), the asking button once it's back: found directly, since a tap on
 * WebKit leaves focus on the dialog around it rather than on the page.
 */
export function CloseQuestion(props: { state: 'finished' | 'dropped'; onYes(): void; onNo(): void; back(): HTMLElement | null }) {
  const finish = props.state === 'finished';
  const no = () => {
    flushSync(props.onNo);
    props.back()?.focus();
  };
  return (
    <div
      className="stack8"
      role="alert"
      // Before the dialog around it hears Esc and closes, with whatever was typed in it.
      onKeyDownCapture={(event) => {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        no();
      }}
    >
      <div className="strong small">{finish ? 'Finish this project?' : 'Drop this project?'}</div>
      <div className="row">
        <button className="btn sm pri danger grow" type="button" onClick={props.onYes}>
          {finish ? 'Yes, finish' : 'Yes, drop'}
        </button>
        <button className="btn sm" type="button" autoFocus aria-label={finish ? 'Cancel finishing' : 'Cancel dropping'} onClick={no}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * Finish, Change end date and Drop. onClosed runs once the project is finished or dropped, to leave its page. extra
 * sits beside the three buttons. changeEnd={false} leaves out Change end date where an Ends field already does it.
 */
export function CloseProject(props: { plan: ProjectPlan; ctx: PlanContext; onClosed?(): void; extra?: ReactNode; changeEnd?: boolean }) {
  const { plan, ctx, changeEnd = true } = props;
  const { clock } = useApp();
  const toast = useToast();
  const apply = usePlanChange();
  const finishRef = useRef<HTMLButtonElement>(null);
  const dropRef = useRef<HTMLButtonElement>(null);
  const [asking, setAsking] = useState<'finished' | 'dropped' | null>(null);
  const [changing, setChanging] = useState(false);
  const close = useMutation((w, state: 'finished' | 'dropped') => closeProject(w, plan.project.id, state, clock));
  const left = status(plan, ctx).leftMin;

  const confirm = async () => {
    if (!asking) return;
    const reverse = await close.run(asking);
    setAsking(null);
    if (!reverse) return;
    toast.show(asking === 'finished' ? 'Finished. Open tasks cancelled.' : 'Dropped.', { undo: () => apply(() => reverse) });
    props.onClosed?.();
  };

  if (asking) {
    return <CloseQuestion state={asking} onYes={confirm} onNo={() => setAsking(null)} back={() => (asking === 'finished' ? finishRef : dropRef).current} />;
  }
  return (
    <div className="stack8">
      <div className="row pastacts">
        <button ref={finishRef} className="btn sm danger" type="button" onClick={() => setAsking('finished')}>
          Finish
        </button>
        {changeEnd && (
          <button className="btn sm" type="button" aria-expanded={changing} onClick={() => setChanging(!changing)}>
            Change end date
          </button>
        )}
        <button ref={dropRef} className="btn sm danger" type="button" onClick={() => setAsking('dropped')}>
          Drop
        </button>
        {props.extra}
      </div>
      {left > 0 && <div className="small quiet">Finishing cancels the {formatMinutes(left)} left.</div>}
      {changing && <ChangeEndDate plan={plan} ctx={ctx} onDone={() => setChanging(false)} />}
    </div>
  );
}

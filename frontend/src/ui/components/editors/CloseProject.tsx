// Finish, Change end date and Drop for a project. Finish and Drop ask first, since they close every open task. For a
// project with a goal and open tasks, the question has one unticked box that moves those tasks to the goal's backlog
// instead, so nothing moves unless you say so.

import { useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { addDays, addMonths, formatDate, formatMinutes, isDay, today } from '../../../core/dates';
import { doneDateError, minutesLeft, moveDone } from '../../../core/plan';
import type { PlanContext, ProjectPlan } from '../../../core/plan';
import { status } from '../../../core/status';
import { getRecord } from '../../../core/records';
import { closeProject } from '../../../core/tasks';
import { useApp, useMutation, useQuery } from '../../app/store';
import { useToast } from '../Toast';
import { usePlanChange } from './usePlanChange';
import { Button } from '../ds/Button';


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
        <Button variant="primary" size="compact" type="button" disabled={!!error} onClick={save}>
          {isDay(date) ? `Change end date to ${formatDate(date)}` : 'Change end date'}
        </Button>
      </div>
    </div>
  );
}

/**
 * Finish or Drop's question, in place of the button that asked it, so focus goes into it. Cancel, or Esc, backs out of
 * just the question and gives focus to back(), the asking button once it's back: found directly, since a tap on
 * WebKit leaves focus on the dialog around it rather than on the page.
 */
export function CloseQuestion(props: {
  state: 'finished' | 'dropped';
  onYes(): void;
  onNo(): void;
  back(): HTMLElement | null;
  /** The open tasks, and the goal whose backlog can take them; with none, no box. */
  move?: { line: string; goal: string; checked: boolean; onChange(checked: boolean): void };
}) {
  const finish = props.state === 'finished';
  const { move } = props;
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
      {move && (
        <>
          <div className="small">{move.line}</div>
          <label className="row small movecheck">
            <input type="checkbox" checked={move.checked} onChange={(event) => move.onChange(event.target.checked)} />
            Move them to the backlog for {move.goal}
          </label>
        </>
      )}
      <div className="row">
        <Button variant="destructive" filled size="compact" className="grow" type="button" onClick={props.onYes}>
          {finish ? 'Yes, finish' : 'Yes, drop'}
        </Button>
        <Button size="compact" type="button" autoFocus aria-label={finish ? 'Cancel finishing' : 'Cancel dropping'} onClick={no}>
          Cancel
        </Button>
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
  const [moving, setMoving] = useState(false);
  const close = useMutation((w, state: 'finished' | 'dropped', moveToBacklog: boolean) => closeProject(w, plan.project.id, state, clock, { moveToBacklog }));
  const left = status(plan, ctx).leftMin;
  const goalId = plan.project.objective_id ?? '';
  const goal = useQuery((sql) => (goalId ? getRecord(sql, 'objective', goalId) : Promise.resolve(undefined)), [goalId]).data;
  const open = plan.tasks.filter((t) => !t.done_at && !t.cancelled_at);
  const openMin = open.reduce((sum, t) => sum + minutesLeft(t), 0);
  const tasks = `${open.length} ${open.length === 1 ? 'task' : 'tasks'}`;
  const move =
    goal && !goal.deleted_at && open.length > 0
      ? { line: `${tasks} ${open.length === 1 ? 'is' : 'are'} still open${openMin ? `, ${formatMinutes(openMin)}` : ''}.`, goal: goal.title, checked: moving, onChange: setMoving }
      : undefined;

  const confirm = async () => {
    if (!asking) return;
    const moved = !!move && moving;
    const reverse = await close.run(asking, moved);
    setAsking(null);
    setMoving(false);
    if (!reverse) return;
    const word = asking === 'finished' ? 'Finished' : 'Dropped';
    const said = moved ? `${word}. ${open.length} open ${open.length === 1 ? 'task' : 'tasks'} moved to the backlog for ${goal!.title}.` : asking === 'finished' ? 'Finished. Open tasks cancelled.' : 'Dropped.';
    toast.show(said, { undo: () => apply(() => reverse) });
    props.onClosed?.();
  };

  if (asking) {
    return (
      <CloseQuestion
        state={asking}
        onYes={confirm}
        onNo={() => {
          setAsking(null);
          setMoving(false);
        }}
        back={() => (asking === 'finished' ? finishRef : dropRef).current}
        {...(move ? { move } : {})}
      />
    );
  }
  return (
    <div className="stack8">
      <div className="row pastacts">
        <Button ref={finishRef} variant="destructive" size="compact" type="button" onClick={() => setAsking('finished')}>
          Finish
        </Button>
        {changeEnd && (
          <Button size="compact" type="button" aria-expanded={changing} onClick={() => setChanging(!changing)}>
            Change end date
          </Button>
        )}
        <Button ref={dropRef} variant="destructive" size="compact" type="button" onClick={() => setAsking('dropped')}>
          Drop
        </Button>
        {props.extra}
      </div>
      {left > 0 && <div className="small quiet">Finishing cancels the {formatMinutes(left)} left.</div>}
      {changing && <ChangeEndDate plan={plan} ctx={ctx} onDone={() => setChanging(false)} />}
    </div>
  );
}

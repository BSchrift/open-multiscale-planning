// Overdue work, asked about inside its project's card, as the stretch flow's Overdue rows ask: Already done, Keep in
// plan, or Drop. Keep in plan on a milestone moves its date, to any day, and adding its open tasks to this week is a
// separate tick, on to start with, since choosing the week's work is this step's job. On a task that needs a new time,
// Keep in plan adds it to this week at its estimate. Each answer is one change with a toast and Undo.

import { useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { addDays, formatDate, formatMinutes, isDay } from '../../../../core/dates';
import { effectiveDue } from '../../../../core/plan';
import type { ProjectPlan } from '../../../../core/plan';
import { fixSummary } from '../../../../core/status';
import type { Milestone } from '../../../../core/types';
import { useFit } from '../WeekFit';
import type { CardProps } from './Cards';
import type { PickTask } from './model';

/** 'A (2h)', 'A (2h) and B (1h)', 'A (2h), B (1h) and C (30m)'. */
const listed = (rows: readonly PickTask[]) => {
  const items = rows.map((r) => `${r.title} (${formatMinutes(r.c.left)})`);
  return items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
};

function KeepForm(props: CardProps & { plan: ProjectPlan; milestone: Milestone; adding: PickTask[]; onClose(): void }) {
  const { milestone: m, adding: add } = props;
  const id = useId();
  // The end of the week being planned; any day will do.
  const [date, setDate] = useState(addDays(props.week, 6));
  const [tick, setTick] = useState(add.length > 0);
  const [error, setError] = useState('');
  const adds = tick ? add.reduce((sum, r) => sum + r.c.left, 0) : 0;
  useFit(adds ? { minutes: adds, text: `+${formatMinutes(adds)} on Save` } : null);
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (!isDay(date)) return setError('Pick a date.');
    props.keepMilestone(props.plan, m, date, tick ? add : []);
    props.onClose();
  };
  const btn = props.phone ? 'btn grow' : 'btn sm';
  return (
    <form className="keepform" aria-label={`Keep ${m.title} in the plan`} noValidate onSubmit={save}>
      <label className="small strong keepdate" htmlFor={id}>
        New due date for {m.title}
      </label>
      <input
        id={id}
        className="field datefield"
        type="date"
        autoFocus
        value={date}
        onChange={(event) => {
          setDate(event.target.value);
          setError('');
        }}
      />
      <span className="small quiet">Any date.</span>
      {add.length > 0 && (
        <label className="keeptick">
          <input type="checkbox" checked={tick} onChange={(event) => setTick(event.target.checked)} />
          Add its open {add.length === 1 ? 'task' : 'tasks'}, {listed(add)}, to this week
        </label>
      )}
      {error && (
        <div className="fielderr" role="alert">
          {error}
        </div>
      )}
      <div className="row keepacts">
        <button className={`${btn} pri`} type="submit">
          Save
        </button>
        <button className={btn} type="button" onClick={props.onClose}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export function MilestoneAsk(props: CardProps & { plan: ProjectPlan; milestone: Milestone }) {
  const { plan, milestone: m, model, phone } = props;
  const [keeping, setKeeping] = useState(false);
  const keepRef = useRef<HTMLButtonElement>(null);
  const f = fixSummary(plan, m.id, model.ctx);
  const s = props.view.projects.find((p) => p.plan.project.id === plan.project.id);
  const rows = (s?.groups.flatMap((g) => g.rows) ?? []).filter((r) => r.c.task.milestone_id === m.id && !props.isDone(r));
  // With every open task in the week, only its date is left to answer.
  const allIn = rows.length > 0 && rows.every((r) => r.c.picked);
  const add = rows.filter((r) => !r.c.picked && r.c.left > 0);
  const n = rows.length;
  const btn = phone ? 'btn grow' : 'btn sm';
  return (
    <div className="ovstrip" role="group" aria-label={f.title} tabIndex={-1} data-ask>
      <span className="ovw">
        {allIn ? (
          `${n === 1 ? 'Its task is' : n === 2 ? 'Both tasks are' : `All ${n} tasks are`} in this week. Still due ${formatDate(effectiveDue(plan, m, model.ctx))}.`
        ) : (
          <>
            <span className="k">{f.title}.</span> {f.sub}
          </>
        )}
      </span>
      <span className={phone ? 'acts' : 'row'}>
        <button className={btn} type="button" aria-label={`Already done: ${m.title}`} onClick={() => props.milestoneDone(plan, m)}>
          Already done
        </button>
        <button ref={keepRef} className={btn} type="button" aria-label={`${allIn ? 'Move date' : 'Keep in plan'}: ${m.title}`} aria-expanded={keeping} onClick={() => setKeeping(!keeping)}>
          {allIn ? 'Move date' : 'Keep in plan'}
        </button>
        <button className={btn} type="button" aria-label={`Drop ${m.title}`} onClick={() => props.dropMilestone(plan, m)}>
          Drop
        </button>
      </span>
      {keeping && (
        <KeepForm
          {...props}
          adding={allIn ? [] : add}
          onClose={() => {
            setKeeping(false);
            keepRef.current?.focus();
          }}
        />
      )}
    </div>
  );
}

export function CarriedAsk(props: CardProps & { row: PickTask }) {
  const { row: r, phone } = props;
  const btn = phone ? 'btn grow' : 'btn sm';
  return (
    <div className="ovstrip" role="group" aria-label={`${r.title} needs a new time`} tabIndex={-1} data-ask>
      <span className="ovw">
        <span className="k">{r.title} needs a new time.</span> {r.reason ? `${r.reason}, ` : ''}
        {formatMinutes(r.c.left)}.
      </span>
      <span className={phone ? 'acts' : 'row'}>
        <button className={btn} type="button" aria-label={`Already done: ${r.title}`} onClick={() => props.markDone(r, true)}>
          Already done
        </button>
        <button className={btn} type="button" aria-label={`Keep in plan: ${r.title}`} onClick={() => props.keepCarried(r)}>
          Keep in plan
        </button>
        <button className={btn} type="button" aria-label={`Drop ${r.title}`} onClick={() => props.dropTask(r)}>
          Drop
        </button>
      </span>
    </div>
  );
}

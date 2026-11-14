// Overdue work, asked about where it is, as the stretch flow's Overdue rows ask: Already done, Keep in plan, or Drop.
// An overdue milestone asks on its own line, and a task that needs a new time on its own row; on phone each is one line
// with Answer, which opens the three in place. Keep in plan on a milestone moves its date, to any day, and adding its
// open tasks to this week is a separate tick, on to start with, since choosing the week's work is this step's job. On
// a task that needs a new time, Keep in plan adds it to this week at its estimate. Each answer is one change with a
// toast and Undo.

import { useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { addDays, formatDate, formatMinutes, isDay } from '../../../../core/dates';
import { effectiveDue } from '../../../../core/plan';
import type { ProjectPlan } from '../../../../core/plan';
import { fixSummary } from '../../../../core/status';
import type { Milestone } from '../../../../core/types';
import { MilestoneDiamond } from '../../../components/MilestoneDiamond';
import { useOpenTask } from '../../../components/task/TaskName';
import { useFit } from '../WeekFit';
import type { ListProps } from './Cards';
import type { PickGroup, PickTask } from './model';

/** 'A (2h)', 'A (2h) and B (1h)', 'A (2h), B (1h) and C (30m)'. */
const listed = (rows: readonly PickTask[]) => {
  const items = rows.map((r) => `${r.title} (${formatMinutes(r.c.left)})`);
  return items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
};

function KeepForm(props: ListProps & { plan: ProjectPlan; milestone: Milestone; adding: PickTask[]; outside: boolean; onClose(): void }) {
  const { milestone: m, adding: add } = props;
  const id = useId();
  // The end of the week being planned; any day will do.
  const [date, setDate] = useState(addDays(props.week, 6));
  const [tick, setTick] = useState(add.length > 0);
  const [error, setError] = useState('');
  const adds = tick ? add.reduce((sum, r) => sum + r.c.left, 0) : 0;
  useFit(adds ? { minutes: adds, text: `+${formatMinutes(adds)} on Save` } : null);
  // A project outside this stretch joins it once its milestone is dated inside, and its reason goes.
  const joins = props.outside && isDay(date) && props.view.stretches.some((s) => date >= s.start && date <= s.end);
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (!isDay(date)) return setError('Pick a date.');
    props.keepMilestone(props.plan, m, date, tick ? add : []);
    props.onClose();
  };
  const btn = props.phone ? 'btn grow' : 'btn sm';
  return (
    <form className="keepform" aria-label={`Keep ${m.title} in the plan`} noValidate onSubmit={save} onKeyDown={(event) => event.key === 'Escape' && props.onClose()}>
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
      {joins && <p className="small keepnote">{formatDate(date)} is inside this stretch, so on Save the project joins it and its tag goes.</p>}
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

/** Answer, on phone: one line until it's opened, then the three choices in place. */
function Answer(props: { name: string; open: boolean; onToggle(): void }) {
  return (
    <button className="link answer" type="button" aria-expanded={props.open} aria-label={`Answer: ${props.name}`} onClick={props.onToggle}>
      Answer
    </button>
  );
}

/** An overdue milestone's line: its name and date, how much is done, and the question, with its tasks under it. */
export function MilestoneLine(props: ListProps & { plan: ProjectPlan; milestone: Milestone; group: PickGroup; outside: boolean }) {
  const { plan, milestone: m, group: g, model, phone } = props;
  const [keeping, setKeeping] = useState(false);
  const [open, setOpen] = useState(false);
  const keepRef = useRef<HTMLButtonElement>(null);
  const headId = useId();
  const f = fixSummary(plan, m.id, model.ctx);
  const rows = g.rows.filter((r) => !props.isDone(r));
  // With every open task in the week, only its date is left to answer.
  const allIn = rows.length > 0 && rows.every((r) => r.c.picked);
  const add = rows.filter((r) => !r.c.picked && r.c.left > 0);
  const n = rows.length;
  const due = formatDate(effectiveDue(plan, m, model.ctx));
  const btn = phone ? 'btn grow' : 'btn sm';
  const keepName = allIn ? `Move date: ${m.title}` : `Keep ${m.title} in the plan`;
  const sub = allIn ? `${n === 1 ? 'Its task is' : n === 2 ? 'Both tasks are' : `All ${n} tasks are`} in this week. Still due ${due}.` : f.sub;
  const choices = (
    <span className={phone ? 'acts' : 'row ovacts'}>
      <button className={btn} type="button" aria-label={`Already done: ${m.title}`} onClick={() => props.milestoneDone(plan, m)}>
        Already done
      </button>
      <button ref={keepRef} className={btn} type="button" aria-label={keepName} aria-expanded={keeping} onClick={() => setKeeping(!keeping)}>
        {allIn ? 'Move date' : 'Keep in plan'}
      </button>
      <button className={btn} type="button" aria-label={`Drop ${m.title}`} onClick={() => props.dropMilestone(plan, m)}>
        Drop
      </button>
    </span>
  );
  return (
    <div className="msl ask" role="group" aria-labelledby={headId} tabIndex={-1} data-ask={m.id}>
      <div className="mslw">
        <h4 id={headId} className="gh late" aria-label={`Milestone: ${g.head}`}>
          <MilestoneDiamond {...(g.state ? { state: g.state } : {})} />
          {phone ? g.short : g.head}
        </h4>
        {!phone && <span className="small msub">{sub}</span>}
      </div>
      {phone ? <Answer name={`${m.title}, overdue since ${due}`} open={open} onToggle={() => setOpen(!open)} /> : choices}
      {phone && open && (
        <>
          <span className="small msub">{sub}</span>
          {choices}
        </>
      )}
      {keeping && (!phone || open) && (
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

/** A task that needs a new time and isn't in the week yet: its row asks, in place of its time. */
export function AskRow(props: ListProps & { row: PickTask }) {
  const { row: r, phone } = props;
  const openTask = useOpenTask();
  const [open, setOpen] = useState(false);
  const btn = phone ? 'btn grow' : 'btn sm';
  const choices = (
    <span className={phone ? 'acts' : 'row ovacts'}>
      <button className={btn} type="button" aria-label={`Already done: ${r.title}`} onClick={() => props.markDone(r, true)}>
        Already done
      </button>
      <button className={btn} type="button" aria-label={`Keep ${r.title} in the plan`} onClick={() => props.keepCarried(r)}>
        Keep in plan
      </button>
      <button className={btn} type="button" aria-label={`Drop ${r.title}`} onClick={() => props.dropTask(r)}>
        Drop
      </button>
    </span>
  );
  return (
    <li className="tk ask" data-ask={r.c.task.id} tabIndex={-1}>
      <span className="ckt" />
      <span className="tkw">
        <button className="tt" type="button" aria-haspopup="dialog" aria-label={`Edit task ${r.title}`} onClick={() => openTask(r.c.task.id, r.note)}>
          {r.title}
        </button>
        <span className="tm late">
          Needs a new time: {r.reason ? `${r.reason.charAt(0).toLowerCase()}${r.reason.slice(1)}, ` : ''}
          {formatMinutes(r.c.left)}
        </span>
      </span>
      {phone ? <Answer name={`${r.title}, needs a new time`} open={open} onToggle={() => setOpen(!open)} /> : choices}
      {phone && open && choices}
    </li>
  );
}

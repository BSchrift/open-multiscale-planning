// The quick form that gives an Inbox item a home: a new project, practice or goal, one form switching between the
// three. Only the name is needed, and it starts as the item's title. In place on desktop, where Process puts it instead
// of the destinations, and a sheet on phone, its button above the keyboard. It writes nothing itself: the caller makes
// the home and files the item in one change, and closes it once that's saved.

import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { formatDate, formatMinutes, isDay, today } from '../../../core/dates';
import type { GoalPick, Home } from '../../../core/tasks';
import type { LocalDate, Objective, Practice } from '../../../core/types';
import { useApp } from '../../app/store';
import { CloseIcon } from '../icons';
import { Sheet } from '../Sheet';
import { GoalSelect, TargetSlider, targetMax } from './PracticeEditor';

export type HomeKind = Home['kind'];

const KINDS: [HomeKind, string][] = [
  ['project', 'Project'],
  ['practice', 'Practice'],
  ['goal', 'Goal'],
];

export function HomeForm(props: {
  /** The item's title. */
  item: string;
  kind: HomeKind;
  /** The name to start with, if not the item's title. */
  name?: string;
  goals: readonly Objective[];
  /** The goal a project or practice starts under, or '' for none. */
  goal: string;
  /** Where a new project ends unless changed. */
  end: LocalDate;
  /** Makes the home. True once it's saved; a failed save keeps the form as it was. */
  onSave(home: Home): Promise<boolean>;
  onClose(): void;
}) {
  const { layout, clock } = useApp();
  const phone = layout === 'phone';
  const on = today(clock);
  const [kind, setKind] = useState(props.kind);
  const [title, setTitle] = useState(props.name ?? props.item);
  const [goal, setGoal] = useState(props.goal);
  // A new goal's name while its field is open, in place of the select.
  const [newGoal, setNewGoal] = useState<string | null>(null);
  const [start, setStart] = useState(on);
  const [end, setEnd] = useState(props.end);
  const [dates, setDates] = useState(false);
  const [target, setTarget] = useState(30);
  const [per, setPer] = useState<Practice['per']>('day');
  const [timing, setTiming] = useState(false);
  const [firstTask, setFirstTask] = useState(true);
  const [onCard, setOnCard] = useState(false);
  const [error, setError] = useState('');
  const nameRef = useRef<HTMLInputElement>(null);
  const goalRef = useRef<HTMLInputElement>(null);
  const nameId = useId();
  const goalId = useId();

  // Desktop selects the name to type over; on touch the caret goes after it, to add to it.
  useEffect(() => {
    const field = nameRef.current;
    if (!field) return;
    field.focus();
    if (phone) field.setSelectionRange(field.value.length, field.value.length);
    else field.select();
  }, []);

  // Esc in the new goal's field goes back to the select, and leaves the form open. A listener of its own, since the
  // card's and the sheet's own catch Esc before React would.
  useEffect(() => {
    const field = goalRef.current;
    if (!field) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setNewGoal(null);
    };
    field.addEventListener('keydown', onKey);
    return () => field.removeEventListener('keydown', onKey);
  }, [newGoal === null]);

  const change = <T,>(set: (value: T) => void) => (value: T) => {
    set(value);
    setError('');
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const name = title.trim();
    if (!name) return setError('Give it a name.');
    const goalName = newGoal?.trim();
    if (newGoal !== null && !goalName) return setError('Give the new goal a name.');
    const pick: GoalPick = goalName ? { title: goalName } : goal ? { id: goal } : null;
    let home: Home;
    if (kind === 'project') {
      if (!isDay(start) || !isDay(end) || end < start) return setError('Pick an end date on or after the start.');
      home = { kind, title: name, goal: pick, start, end, keep: firstTask };
    } else if (kind === 'practice') {
      home = { kind, title: name, goal: pick, target_min: target, per, keep: onCard };
    } else {
      home = { kind, title: name, keep: onCard };
    }
    await props.onSave(home);
  };

  const btn = phone ? 'btn' : 'btn sm';
  const label = `New ${kind}`;
  const submit =
    kind === 'project' ? (firstTask ? 'Add project and send it there' : 'Add project') : onCard ? `Add ${kind}` : `Make it a ${kind}`;
  const ruleText = `${formatMinutes(target)} a ${per}`;

  const form = (
    <form className="stack8 editor homeform" aria-label={label} onSubmit={save} noValidate>
      {phone && <h2>{label}</h2>}
      <div className="row" role="group" aria-label="Make it a">
        {KINDS.map(([k, text]) => (
          <button key={k} className={`dchip${kind === k ? ' on' : ''}`} type="button" aria-pressed={kind === k} onClick={() => change(setKind)(k)}>
            {text}
          </button>
        ))}
      </div>
      <div className="popfield">
        <label htmlFor={nameId}>Name</label>
        <div className="row nowrap">
          <input id={nameId} ref={nameRef} className="field grow" value={title} onChange={(event) => change(setTitle)(event.target.value)} />
          <button
            className={`${btn} iconbtn`}
            type="button"
            aria-label="Clear name"
            onClick={() => {
              change(setTitle)('');
              nameRef.current?.focus();
            }}
          >
            <CloseIcon />
          </button>
        </div>
      </div>
      {kind !== 'goal' &&
        (newGoal === null ? (
          <GoalSelect goals={props.goals} value={goal} onChange={setGoal} onNew={() => setNewGoal('')} />
        ) : (
          <div className="popfield">
            <label htmlFor={goalId}>New goal name</label>
            <div className="row nowrap">
              <input id={goalId} ref={goalRef} className="field grow" autoFocus value={newGoal} onChange={(event) => change(setNewGoal)(event.target.value)} />
              <button className={`${btn} iconbtn`} type="button" aria-label="Cancel new goal" onClick={() => setNewGoal(null)}>
                <CloseIcon />
              </button>
            </div>
          </div>
        ))}
      {kind === 'project' &&
        (dates ? (
          <div className="row nowrap">
            <label className="popfield grow">
              Starts
              <input className="field datefield" type="date" value={start} onChange={(event) => change(setStart)(event.target.value)} />
            </label>
            <label className="popfield grow">
              Ends
              <input className="field datefield" type="date" value={end} onChange={(event) => change(setEnd)(event.target.value)} />
            </label>
          </div>
        ) : (
          <div className="row homeline">
            <span>{`${start === on ? 'Today' : formatDate(start)} to ${formatDate(end)}`}</span>
            <span aria-hidden="true">·</span>
            <button className="link" type="button" aria-label="Change dates" onClick={() => setDates(true)}>
              Change
            </button>
          </div>
        ))}
      {kind === 'practice' &&
        (timing ? (
          <>
            <TargetSlider per={per} value={target} onChange={setTarget} />
            <label className="popfield">
              Per
              <select
                className="field"
                aria-label="Per"
                value={per}
                onChange={(event) => {
                  const next = event.target.value as Practice['per'];
                  setPer(next);
                  setTarget(Math.min(targetMax(next), target));
                }}
              >
                <option value="day">Day</option>
                <option value="week">Week</option>
              </select>
            </label>
          </>
        ) : (
          <div className="row homeline">
            <span>{ruleText}</span>
            <span aria-hidden="true">·</span>
            <button className="link" type="button" aria-label="Change time" onClick={() => setTiming(true)}>
              Change
            </button>
          </div>
        ))}
      <label className="taskrow">
        {kind === 'project' ? (
          <input type="checkbox" checked={firstTask} onChange={() => setFirstTask(!firstTask)} />
        ) : (
          <input type="checkbox" checked={onCard} onChange={() => setOnCard(!onCard)} />
        )}
        <span>{kind === 'project' ? `Keep "${props.item}" as its first task` : 'Keep it on this card to file next'}</span>
      </label>
      {error && (
        <div className="fielderr" role="alert">
          {error}
        </div>
      )}
      <div className="row homeacts">
        <button className={`${btn} pri grow`} type="submit">
          {submit}
        </button>
        <button className={btn} type="button" onClick={props.onClose}>
          Cancel
        </button>
      </div>
    </form>
  );

  if (!phone) return form;
  return (
    <Sheet label={label} tall onClose={props.onClose}>
      {form}
    </Sheet>
  );
}

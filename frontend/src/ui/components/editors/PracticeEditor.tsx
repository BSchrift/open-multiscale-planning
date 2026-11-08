// A practice's settings, saved as they change: name, goal (or none, never a project), target, days and preferred
// times, Pause and End. Planning places sessions from these, so changes apply from the next plan.

import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { formatMinutes, formatTimeOfDay } from '../../../core/dates';
import { applyPlanChange } from '../../../core/plan';
import type { PlanChange } from '../../../core/plan';
import { endPractice } from '../../../core/tasks';
import type { Fields, Objective, Practice, Weekday } from '../../../core/types';
import { useApp, useMutation } from '../../app/store';
import { Sheet } from '../Sheet';
import { useToast } from '../Toast';
import { SheetOnPhone } from './SheetOnPhone';

type DaysKey = 'all' | 'weekdays' | 'weekends';
const DAYS: Record<DaysKey, Weekday[]> = { all: [0, 1, 2, 3, 4, 5, 6], weekdays: [0, 1, 2, 3, 4], weekends: [5, 6] };

function daysKey(days: readonly Weekday[] | null | undefined): DaysKey {
  const set = [...(days ?? [])].sort().join();
  return set === DAYS.weekdays.join() ? 'weekdays' : set === DAYS.weekends.join() ? 'weekends' : 'all';
}

const targetMax = (per: Practice['per']) => (per === 'day' ? 240 : 1200);
const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** "15m a day, weekdays, around 7am" */
export function practiceRule(p: Practice): string {
  const times = (p.preferred_times ?? []).map(formatTimeOfDay).join(' or ') || 'any time';
  const when = p.per === 'day' ? ` a day, ${{ all: 'every day', weekdays: 'weekdays', weekends: 'weekends' }[daysKey(p.days)]}` : ' a week';
  return `${formatMinutes(p.target_min)}${when}, around ${times}`;
}

/** Goals a practice or project can link to: any that isn't archived. */
const linkable = (goals: readonly Objective[]) => goals.filter((g) => g.state !== 'archived' && !g.deleted_at);

export function GoalSelect(props: { goals: readonly Objective[]; value: string; onChange(id: string): void }) {
  return (
    <label className="popfield">
      Goal
      <select className="field" aria-label="Goal" value={props.value} onChange={(event) => props.onChange(event.target.value)}>
        <option value="">No goal</option>
        {linkable(props.goals).map((g) => (
          <option key={g.id} value={g.id}>
            {g.title}
          </option>
        ))}
      </select>
    </label>
  );
}

function TargetSlider(props: { per: Practice['per']; value: number; onChange(minutes: number): void }) {
  const id = useId();
  return (
    <div className="stack8">
      <div className="between">
        <label className="small quiet" htmlFor={id}>
          Target
        </label>
        <span className="strong">{formatMinutes(props.value)}</span>
      </div>
      <input
        id={id}
        type="range"
        className="wideslider"
        min={5}
        max={targetMax(props.per)}
        step={5}
        value={props.value}
        aria-valuetext={formatMinutes(props.value)}
        onChange={(event) => props.onChange(Number(event.target.value))}
      />
    </div>
  );
}

/** Edits a practice in place. Every change is saved at once; a blank name is never saved. */
export function PracticeFields(props: { practice: Practice; goals: readonly Objective[]; onEnded?(): void }) {
  const p = props.practice;
  const { clock } = useApp();
  const toast = useToast();
  const timeId = useId();
  const [name, setName] = useState(p.title);
  const [time, setTime] = useState('');
  const save = useMutation((w, fields: Fields<'practice'>) => w.set('practice', p.id, fields));
  const set = (fields: Fields<'practice'>) => void save.run(fields);
  const times = p.preferred_times ?? [];
  const addTime = (text: string, list: readonly number[]) => {
    const minutes = toMinutes(text);
    if (text && !list.includes(minutes)) set({ preferred_times: [...list, minutes].sort((a, b) => a - b) });
  };
  // A time typed but not added is added as the fields close, since everything else here saves as you go.
  const typed = useRef({ time, times });
  typed.current = { time, times };
  useEffect(() => () => addTime(typed.current.time, typed.current.times), []);

  const ending = useMutation((w) => endPractice(w, p.id, clock));
  const undo = useMutation((w, reverse: PlanChange) => applyPlanChange(w, reverse));
  const end = async () => {
    const reverse = await ending.run();
    props.onEnded?.();
    if (reverse) toast.show(`${p.title} ended. Its history stays.`, { undo: () => undo.run(reverse) });
  };

  return (
    <div className="stack8">
      <label className="popfield">
        Name
        <input
          className="field"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            const title = event.target.value.trim();
            if (title) set({ title });
          }}
        />
      </label>
      <GoalSelect goals={props.goals} value={p.objective_id ?? ''} onChange={(id) => set({ objective_id: id || null })} />
      <TargetSlider per={p.per} value={p.target_min} onChange={(target_min) => set({ target_min })} />
      <div className="row nowrap">
        <label className="popfield grow">
          Per
          <select
            className="field"
            aria-label="Per"
            value={p.per}
            onChange={(event) => {
              const per = event.target.value as Practice['per'];
              set({ per, target_min: Math.min(targetMax(per), p.target_min) });
            }}
          >
            <option value="day">Day</option>
            <option value="week">Week</option>
          </select>
        </label>
        {p.per === 'day' && (
          <label className="popfield grow">
            On
            <select className="field" aria-label="On" value={daysKey(p.days)} onChange={(event) => set({ days: DAYS[event.target.value as DaysKey] })}>
              <option value="all">Every day</option>
              <option value="weekdays">Weekdays</option>
              <option value="weekends">Weekends</option>
            </select>
          </label>
        )}
      </div>
      <div className="stack8">
        <div className="small quiet">Preferred times</div>
        {times.length > 0 && (
          <div className="row">
            {times.map((t) => (
              <button
                key={t}
                className="dchip"
                type="button"
                aria-label={`Remove ${formatTimeOfDay(t)}`}
                onClick={() => set({ preferred_times: times.filter((x) => x !== t) })}
              >
                {formatTimeOfDay(t)} ×
              </button>
            ))}
          </div>
        )}
        <div className="row nowrap">
          <input
            id={timeId}
            className="field grow"
            type="time"
            aria-label="New preferred time"
            value={time}
            onChange={(event) => setTime(event.target.value)}
          />
          <button
            className="btn sm"
            type="button"
            onClick={() => {
              addTime(time, times);
              setTime('');
            }}
          >
            Add time
          </button>
        </div>
      </div>
      <p className="small quiet">Changes apply from your next plan.</p>
      <div className="row">
        <button className="btn sm" type="button" onClick={() => set({ state: p.state === 'paused' ? 'active' : 'paused' })}>
          {p.state === 'paused' ? 'Resume' : 'Pause'}
        </button>
        <button className="btn sm" type="button" onClick={end}>
          End practice
        </button>
      </div>
    </div>
  );
}

/** The practice editor as a sheet, as tapping a practice opens it on phone. */
export function PracticeSheet(props: { practice: Practice; goals: readonly Objective[]; onClose(): void }) {
  return (
    <Sheet label="Edit practice" tall onClose={props.onClose}>
      <div className="between">
        <h2>Edit practice</h2>
        <button className="btn sm" type="button" onClick={props.onClose}>
          Done
        </button>
      </div>
      <PracticeFields practice={props.practice} goals={props.goals} onEnded={props.onClose} />
    </Sheet>
  );
}

/** Adds a practice, linked to a goal or to nothing. */
export function PracticeAdd(props: { goals: readonly Objective[]; objectiveId: string | null; onAdded?(id: string): void; onClose(): void }) {
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [goal, setGoal] = useState(props.objectiveId ?? '');
  const [target, setTarget] = useState(30);
  const [per, setPer] = useState<Practice['per']>('day');
  const [time, setTime] = useState('07:00');
  const [error, setError] = useState('');
  const add = useMutation((w, name: string) =>
    w.create('practice', {
      title: name,
      objective_id: goal || null,
      target_min: target,
      per,
      preferred_times: time ? [toMinutes(time)] : [],
      state: 'active',
    }),
  );

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const name = title.trim();
    if (!name) return setError('Give it a name.');
    const id = await add.run(name);
    if (!id) return;
    props.onAdded?.(id);
    toast.show('Practice added. It waits in To schedule on Week until you give it a time.');
    props.onClose();
  };

  return (
    <SheetOnPhone label="Add practice" onClose={props.onClose}>
      <form className="stack8 editor" aria-label="Add practice" onSubmit={save}>
        <h2>Add practice</h2>
        <label className="popfield">
          Name
          <input
            className="field"
            autoFocus
            value={title}
            onChange={(event) => {
              setTitle(event.target.value);
              setError('');
            }}
          />
        </label>
        <GoalSelect goals={props.goals} value={goal} onChange={setGoal} />
        <TargetSlider per={per} value={target} onChange={setTarget} />
        <div className="row nowrap">
          <label className="popfield grow">
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
          <label className="popfield grow">
            Preferred time
            <input className="field" type="time" value={time} onChange={(event) => setTime(event.target.value)} />
          </label>
        </div>
        {error && (
          <div className="fielderr" role="alert">
            {error}
          </div>
        )}
        <div className="row">
          <button className="btn sm pri grow" type="submit">
            Add practice
          </button>
          <button className="btn sm" type="button" onClick={props.onClose}>
            Cancel
          </button>
        </div>
      </form>
    </SheetOnPhone>
  );
}

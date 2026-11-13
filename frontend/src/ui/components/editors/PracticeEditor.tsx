// A practice's settings, changed as a draft that Save writes in one go and Cancel drops: name, goal (or none, never a
// project), target, days and preferred times. Pause and End act at once. Planning places sessions from these, so
// changes apply from the next plan.

import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { formatMinutes, formatTimeOfDay } from '../../../core/dates';
import { applyPlanChange } from '../../../core/plan';
import type { PlanChange } from '../../../core/plan';
import { endPractice } from '../../../core/tasks';
import type { Fields, Objective, Practice, TimeOfDay, Weekday } from '../../../core/types';
import { useApp, useMutation } from '../../app/store';
import { Sheet } from '../Sheet';
import { useToast } from '../Toast';
import { SheetOnPhone } from './SheetOnPhone';
import { useLeave } from './useLeave';
import { usePlanChange } from './usePlanChange';

type DaysKey = 'all' | 'weekdays' | 'weekends';
const DAYS: Record<DaysKey, Weekday[]> = { all: [0, 1, 2, 3, 4, 5, 6], weekdays: [0, 1, 2, 3, 4], weekends: [5, 6] };

function daysKey(days: readonly Weekday[] | null | undefined): DaysKey {
  const set = [...(days ?? [])].sort().join();
  return set === DAYS.weekdays.join() ? 'weekdays' : set === DAYS.weekends.join() ? 'weekends' : 'all';
}

export const targetMax = (per: Practice['per']) => (per === 'day' ? 240 : 1200);
const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** "15m a day, weekdays, around 7am" */
export function practiceRule(p: Practice): string {
  const times = (p.preferred_times ?? []).map(formatTimeOfDay).join(' or ') || 'any time';
  const when = p.per === 'day' ? ` a day, ${{ all: 'every day', weekdays: 'weekdays', weekends: 'weekends' }[daysKey(p.days)]}` : ' a week';
  return `${formatMinutes(p.target_min)}${when}, around ${times}`;
}

/** Goals a practice or project can link to: any that isn't archived. */
const linkable = (goals: readonly Objective[]) => goals.filter((g) => g.state !== 'archived' && !g.deleted_at);

/** With onNew, a + New goal button follows the select, rather than being one of its options. */
export function GoalSelect(props: { goals: readonly Objective[]; value: string; onChange(id: string): void; onNew?(): void }) {
  const { layout } = useApp();
  const select = (
    <label className={props.onNew ? 'popfield grow' : 'popfield'}>
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
  if (!props.onNew) return select;
  return (
    <div className="row nowrap fieldandbtn">
      {select}
      <button className={layout === 'phone' ? 'btn' : 'btn sm'} type="button" onClick={props.onNew}>
        + New goal
      </button>
    </div>
  );
}

export function TargetSlider(props: { per: Practice['per']; value: number; onChange(minutes: number): void }) {
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

/** What the fields hold: days by which choice they are, so a practice saved with none reads as every day. */
interface Draft {
  title: string;
  objective_id: string | null;
  target_min: number;
  per: Practice['per'];
  days: DaysKey;
  preferred_times: TimeOfDay[];
}

/**
 * Edits a practice as a draft. Nothing is written until Save, which writes every change at once, with Undo; Cancel
 * drops them. A blank name is never saved. Pause and End act at once, apart from Save and Cancel.
 */
export function PracticeFields(props: {
  practice: Practice;
  goals: readonly Objective[];
  /** The editor's name, where nothing around it names it. */
  label?: string;
  heading?: ReactNode;
  /** A goal control of the caller's own, in place of the select, as planning's links a new goal too. */
  goalField?(value: string | null, onChange: (id: string | null) => void): ReactNode;
  /** Saves the change instead, as planning does to log it with its Undo. Resolves to whether it saved. */
  write?(text: string, change: PlanChange): Promise<boolean>;
  /** After Save, with the fields it wrote, or Cancel. */
  onClose(saved?: Fields<'practice'>): void;
  onEnded?(): void;
  /** Set to the editor's other way out, for the caller's Esc, backdrop or toggle. It resolves to whether it closed. */
  leaveRef?: { current: (() => boolean) | null };
}) {
  const p = props.practice;
  const { clock, layout } = useApp();
  const toast = useToast();
  const apply = usePlanChange();
  const live: Draft = {
    title: p.title,
    objective_id: p.objective_id ?? null,
    target_min: p.target_min,
    per: p.per,
    days: daysKey(p.days),
    preferred_times: p.preferred_times ?? [],
  };
  // Only the fields edited here are kept, so the rest show the practice as it is now, after a sync or Pause.
  const [edits, setEdits] = useState<Partial<Draft>>({});
  const [time, setTime] = useState('');
  const [error, setError] = useState('');
  const form = { ...live, ...edits };
  const edit = (fields: Partial<Draft>) => {
    setEdits({ ...edits, ...fields });
    setError('');
  };
  const withTime = (text: string, list: readonly TimeOfDay[]) => {
    const minutes = toMinutes(text);
    return text && !list.includes(minutes) ? [...list, minutes].sort((a, b) => a - b) : [...list];
  };
  // What Save writes: a time typed but not added is added, as everything else on screen is kept.
  const next: Draft = { ...form, title: form.title.trim(), preferred_times: withTime(time, form.preferred_times) };
  const changed = (Object.keys(next) as (keyof Draft)[]).filter((k) => JSON.stringify(next[k]) !== JSON.stringify(live[k]));
  const { saveRef, leave } = useLeave(changed.length > 0, () => props.onClose(), setError);
  const { leaveRef } = props;
  useEffect(() => {
    if (!leaveRef) return;
    leaveRef.current = leave;
    return () => void (leaveRef.current = null);
  });
  // A goal made and linked at once, beside the select, replaces one picked here.
  useEffect(
    () =>
      setEdits((e) => {
        const rest = { ...e };
        delete rest.objective_id;
        return rest;
      }),
    [p.objective_id],
  );

  const write = props.write ?? (async (text: string, change: PlanChange) => !!(await apply(() => change, { message: text })));
  const save = async () => {
    if (!next.title) return setError('Give it a name.');
    if (!changed.length) return props.onClose();
    const fields = Object.fromEntries(changed.map((k) => [k, k === 'days' ? DAYS[next.days] : next[k]])) as Fields<'practice'>;
    // A failed save keeps the fields as they were, and has said so.
    if (await write(`Saved ${next.title}.`, { writes: [{ type: 'practice', id: p.id, fields }] })) props.onClose(fields);
  };

  const pause = useMutation((w, state: Practice['state']) => w.set('practice', p.id, { state }));
  const ending = useMutation((w) => endPractice(w, p.id, clock));
  const undo = useMutation((w, reverse: PlanChange) => applyPlanChange(w, reverse));
  const end = async () => {
    const reverse = await ending.run();
    props.onEnded?.();
    if (reverse) toast.show(`${p.title} ended. Its history stays.`, { undo: () => undo.run(reverse) });
  };
  const btn = layout === 'phone' ? 'btn grow' : 'btn sm';

  // Not a form, since planning's goal control holds a form of its own, so Enter in the name saves instead.
  return (
    <div
      className="stack8 editor"
      role={props.label ? 'group' : undefined}
      aria-label={props.label}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        leave();
      }}
    >
      {props.heading}
      <label className="popfield">
        Name
        <input
          className="field"
          value={form.title}
          onChange={(event) => edit({ title: event.target.value })}
          onKeyDown={(event) => event.key === 'Enter' && void save()}
        />
      </label>
      {props.goalField?.(form.objective_id, (id) => edit({ objective_id: id })) ?? (
        <GoalSelect goals={props.goals} value={form.objective_id ?? ''} onChange={(id) => edit({ objective_id: id || null })} />
      )}
      <TargetSlider per={form.per} value={form.target_min} onChange={(target_min) => edit({ target_min })} />
      <div className="row nowrap">
        <label className="popfield grow">
          Per
          <select
            className="field"
            aria-label="Per"
            value={form.per}
            onChange={(event) => {
              const per = event.target.value as Practice['per'];
              edit({ per, target_min: Math.min(targetMax(per), form.target_min) });
            }}
          >
            <option value="day">Day</option>
            <option value="week">Week</option>
          </select>
        </label>
        {form.per === 'day' && (
          <label className="popfield grow">
            On
            <select className="field" aria-label="On" value={form.days} onChange={(event) => edit({ days: event.target.value as DaysKey })}>
              <option value="all">Every day</option>
              <option value="weekdays">Weekdays</option>
              <option value="weekends">Weekends</option>
            </select>
          </label>
        )}
      </div>
      <div className="stack8">
        <div className="small quiet">Preferred times</div>
        {form.preferred_times.length > 0 && (
          <div className="row">
            {form.preferred_times.map((t) => (
              <button
                key={t}
                className="dchip"
                type="button"
                aria-label={`Remove ${formatTimeOfDay(t)}`}
                onClick={() => edit({ preferred_times: form.preferred_times.filter((x) => x !== t) })}
              >
                {formatTimeOfDay(t)} ×
              </button>
            ))}
          </div>
        )}
        <div className="row nowrap">
          <input
            className="field grow"
            type="time"
            aria-label="New preferred time"
            value={time}
            onChange={(event) => {
              setTime(event.target.value);
              setError('');
            }}
          />
          <button
            className="btn sm"
            type="button"
            onClick={() => {
              edit({ preferred_times: withTime(time, form.preferred_times) });
              setTime('');
            }}
          >
            Add time
          </button>
        </div>
      </div>
      <p className="small quiet">Changes apply from your next plan.</p>
      {error && (
        <div className="fielderr" role="alert">
          {error}
        </div>
      )}
      <div className="row">
        <button ref={saveRef} className={`${btn} pri`} type="button" onClick={() => void save()}>
          Save
        </button>
        <button className={btn} type="button" onClick={() => props.onClose()}>
          Cancel
        </button>
      </div>
      <div className="row">
        <button className="btn sm" type="button" onClick={() => void pause.run(p.state === 'paused' ? 'active' : 'paused')}>
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
export function PracticeSheet(props: { practice: Practice; goals: readonly Objective[]; onClose(saved?: Fields<'practice'>): void }) {
  const leave = useRef<(() => boolean) | null>(null);
  return (
    <Sheet label="Edit practice" tall onClose={() => (leave.current ? leave.current() : props.onClose())}>
      <PracticeFields
        practice={props.practice}
        goals={props.goals}
        heading={<h2>Edit practice</h2>}
        leaveRef={leave}
        onClose={props.onClose}
        onEnded={() => props.onClose()}
      />
    </Sheet>
  );
}

/** Adds a practice, linked to a goal or to nothing. */
export function PracticeAdd(props: {
  goals: readonly Objective[];
  objectiveId: string | null;
  /** Saves the practice instead of the form, resolving to its id. The caller then reports it. */
  write?(fields: Fields<'practice'>): Promise<string | undefined>;
  onAdded?(id: string): void;
  onClose(): void;
}) {
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [goal, setGoal] = useState(props.objectiveId ?? '');
  const [target, setTarget] = useState(30);
  const [per, setPer] = useState<Practice['per']>('day');
  const [time, setTime] = useState('07:00');
  const [error, setError] = useState('');
  const add = useMutation((w, fields: Fields<'practice'>) => w.create('practice', fields));

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const name = title.trim();
    if (!name) return setError('Give it a name.');
    const fields: Fields<'practice'> = {
      title: name,
      objective_id: goal || null,
      target_min: target,
      per,
      preferred_times: time ? [toMinutes(time)] : [],
      state: 'active',
    };
    const id = props.write ? await props.write(fields) : await add.run(fields);
    if (!id) return;
    props.onAdded?.(id);
    if (!props.write) toast.show('Practice added. It waits in To schedule on Week until you give it a time.');
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

// A practice's settings, changed as a draft that Save writes in one go and Cancel drops: name, goal (or none, never a
// project) and its schedule (PracticeSchedule). Pause and End act at once. Sessions already placed stay put; those
// still to place follow the schedule.

import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { formatMinutes, instantMs, localDate, thisWeek, weekday, weekRange } from '../../../core/dates';
import { applyPlanChange } from '../../../core/plan';
import type { PlanChange } from '../../../core/plan';
import { weekPractices } from '../../../core/queries';
import { sessionDay } from '../../../core/records';
import { endPractice } from '../../../core/tasks';
import type { Fields, LocalDate, Objective, Practice } from '../../../core/types';
import { useApp, useMutation, useQuery } from '../../app/store';
import { Sheet } from '../Sheet';
import { useToast } from '../Toast';
import { DAY_NAMES, newSchedule, practiceRule, scheduleFields, ScheduleFields, scheduleOf } from './PracticeSchedule';
import type { ScheduleDraft } from './PracticeSchedule';
import { SheetOnPhone } from './SheetOnPhone';
import { useLeave } from './useLeave';
import { usePlanChange } from './usePlanChange';

export { practiceRule };

export const targetMax = (per: Practice['per']) => (per === 'day' ? 240 : 1200);
const NO_DAYS = 'Choose at least one day.';

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


interface Draft {
  title: string;
  objective_id: string | null;
  schedule: ScheduleDraft;
}

const SCHEDULE_KEYS = ['per', 'target_min', 'sessions', 'days', 'preferred_times', 'day_times'] as const;
const TARGET: readonly string[] = ['per', 'target_min', 'sessions'];

/**
 * The schedule fields an edit writes: those that read differently, with per, target and count together so they never
 * part. Comparing the fields the opening schedule would write, not the record, means opening an older weekly practice
 * and saving rewrites nothing it didn't change.
 */
function scheduleChanges(p: Practice, before: ScheduleDraft, after: ScheduleDraft): Fields<'practice'> {
  const backups = (p.preferred_times ?? []).slice(1);
  const was = scheduleFields(before, backups);
  const now = scheduleFields(after, backups);
  const keys = SCHEDULE_KEYS.filter((k) => JSON.stringify(was[k] ?? null) !== JSON.stringify(now[k] ?? null));
  const target = keys.some((k) => TARGET.includes(k));
  const written = SCHEDULE_KEYS.filter((k) => keys.includes(k) || (target && TARGET.includes(k) && !(k === 'sessions' && now.sessions == null && p.sessions == null)));
  return Object.fromEntries(written.map((k) => [k, now[k]])) as Fields<'practice'>;
}

/** "Thursday's placed session stays.", for sessions still ahead this week on days the new set days leave out. */
function staysLine(placed: readonly LocalDate[], s: ScheduleDraft): string {
  const days = s.mode === 'days' ? [...new Set(placed.filter((d) => !s.days.includes(weekday(d))))].sort() : [];
  if (!days.length) return '';
  const names = new Intl.ListFormat('en-GB').format(days.map((d) => `${DAY_NAMES[weekday(d)]}'s`));
  return days.length === 1 ? ` ${names} placed session stays.` : ` ${names} placed sessions stay.`;
}

/**
 * Edits a practice as a draft. Nothing is written until Save, which writes every change at once, with Undo; Cancel
 * drops them. A blank name or no days is never saved. Pause and End act at once, apart from Save and Cancel.
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
  const live: Draft = { title: p.title, objective_id: p.objective_id ?? null, schedule: scheduleOf(p) };
  // Only the fields edited here are kept, so the rest show the practice as it is now, after a sync or Pause.
  const [edits, setEdits] = useState<Partial<Draft>>({});
  const [error, setError] = useState('');
  const [daysError, setDaysError] = useState('');
  const monday = useRef<HTMLInputElement>(null);
  const form = { ...live, ...edits };
  const edit = (fields: Partial<Draft>) => {
    setEdits({ ...edits, ...fields });
    setError('');
    setDaysError('');
  };
  const next: Draft = { ...form, title: form.title.trim() };
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
  // This week's sessions still ahead, by the day each is for, so Save can say which stay off the new days.
  const ahead =
    useQuery(
      async (sql, c) =>
        (await weekPractices(sql, weekRange(thisWeek(c), c.zone())))
          .filter((b) => b.practice_id === p.id && !b.cancelled && instantMs(b.start) > c.now())
          .map((b) => sessionDay(b.id, p.id) ?? localDate(b.start, c.zone())),
      [p.id],
    ).data ?? [];

  const write = props.write ?? (async (text: string, change: PlanChange) => !!(await apply(() => change, { message: text })));
  const save = async () => {
    if (!next.title) return setError('Give it a name.');
    if (!next.schedule.days.length) {
      setDaysError(NO_DAYS);
      monday.current?.focus();
      return;
    }
    const fields: Fields<'practice'> = {
      ...(changed.includes('title') ? { title: next.title } : {}),
      ...(changed.includes('objective_id') ? { objective_id: next.objective_id } : {}),
      ...(changed.includes('schedule') ? scheduleChanges(p, live.schedule, next.schedule) : {}),
    };
    if (!Object.keys(fields).length) return props.onClose();
    const scheduled = SCHEDULE_KEYS.some((k) => k in fields);
    const text = scheduled ? `Saved ${next.title}: ${practiceRule({ ...p, ...fields })}.${staysLine(ahead, next.schedule)}` : `Saved ${next.title}.`;
    // A failed save keeps the fields as they were, and has said so.
    if (await write(text, { writes: [{ type: 'practice', id: p.id, fields }] })) props.onClose(fields);
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
      <ScheduleFields value={form.schedule} onChange={(schedule) => edit({ schedule })} daysError={daysError} mondayRef={monday} />
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

/** Adds a practice, linked to a goal or to nothing, starting at every day around 7am. */
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
  const [schedule, setSchedule] = useState(newSchedule);
  const [error, setError] = useState('');
  const [daysError, setDaysError] = useState('');
  const monday = useRef<HTMLInputElement>(null);
  const add = useMutation((w, fields: Fields<'practice'>) => w.create('practice', fields));

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const name = title.trim();
    if (!name) return setError('Give it a name.');
    if (!schedule.days.length) {
      setDaysError(NO_DAYS);
      monday.current?.focus();
      return;
    }
    // A new practice stores only what its schedule uses.
    const stored = Object.fromEntries(Object.entries(scheduleFields(schedule)).filter(([, v]) => v !== null));
    const fields: Fields<'practice'> = { title: name, objective_id: goal || null, ...stored, state: 'active' };
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
        <ScheduleFields
          value={schedule}
          onChange={(s) => {
            setSchedule(s);
            setDaysError('');
          }}
          daysError={daysError}
          mondayRef={monday}
        />
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

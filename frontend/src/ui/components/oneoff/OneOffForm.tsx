// The form that adds a one off, with all six ways it can repeat. On desktop it sits on the page; on phone it goes
// inside a Sheet, with Cancel. Given a task, it changes that one instead.

import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import type { Fields, RepeatUnit, Task } from '../../../core/types';
import { useApp, useToday } from '../../app/store';
import { EstimateSlider } from '../EstimateSlider';
import { NotesField } from '../notes/NotesField';
import { draftError, draftOf, emptyDraft, oneOffFields, REPEAT_TYPES } from './draft';
import type { OneOffDraft, RepeatType, RuleDay, RuleOf, RulePos } from './draft';
import './oneoff.css';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const UNITS: readonly [RepeatUnit, string][] = [['day', 'Daily'], ['week', 'Weekly'], ['month', 'Monthly'], ['year', 'Yearly']];
const POSITIONS: readonly [RulePos, string][] = [[1, '1st'], [2, '2nd'], [3, '3rd'], [4, '4th'], [-1, 'Last']];
const DAYS: readonly [RuleDay, string][] = [
  ['MO', 'Monday'], ['TU', 'Tuesday'], ['WE', 'Wednesday'], ['TH', 'Thursday'], ['FR', 'Friday'], ['SA', 'Saturday'], ['SU', 'Sunday'],
  ['weekday', 'Weekday'], ['day', 'Day'],
];
const OF: readonly [RuleOf, string][] = [['month', 'Month'], ['quarter', 'Quarter'], ['year', 'Year']];

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;

function SpanSlider(props: { label: string; value: number; max: number; unit: string; onChange(n: number): void }) {
  const id = useId();
  const text = plural(props.value, props.unit);
  return (
    <div className="stack8">
      <div className="between small">
        <label className="quiet" htmlFor={id}>
          {props.label}
        </label>
        <span className="strong">{text}</span>
      </div>
      <input
        id={id}
        type="range"
        className="ooslider"
        min={1}
        max={props.max}
        step={1}
        value={props.value}
        aria-valuetext={text}
        onChange={(event) => props.onChange(Number(event.target.value))}
      />
    </div>
  );
}

function Choice<T extends string | number>(props: { label: string; value: T; options: readonly (readonly [T, string])[]; onChange(v: T): void }) {
  const id = useId();
  return (
    <div className="stack8">
      <label className="small quiet" htmlFor={id}>
        {props.label}
      </label>
      <select
        id={id}
        className="field"
        value={String(props.value)}
        onChange={(event) => props.onChange(props.options.find(([v]) => String(v) === event.target.value)![0])}
      >
        {props.options.map(([v, text]) => (
          <option key={String(v)} value={String(v)}>
            {text}
          </option>
        ))}
      </select>
    </div>
  );
}

export function OneOffForm(props: {
  /** Saves the new task's fields. Resolving to false keeps what was typed, such as when the save failed. */
  onSave(fields: Fields<'task'>): unknown;
  /** Shows Cancel, for a form inside a sheet. */
  onCancel?(): void;
  /** Shows Delete, for a one off being changed. */
  onDelete?(): void;
  /** A one off to change rather than add. */
  task?: Task;
}) {
  const { layout } = useApp();
  const today = useToday();
  const [draft, setDraft] = useState(() => (props.task ? draftOf(props.task, today) : emptyDraft(today)));
  const [error, setError] = useState<string | null>(null);
  // The key starts the description afresh after each add.
  const [added, setAdded] = useState(0);
  const ids = { title: useId(), type: useId(), from: useId(), to: useId(), starts: useId(), months: useId() };
  const put = (patch: Partial<OneOffDraft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setError(null);
  };
  const phone = layout === 'phone';

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const problem = draftError(draft);
    if (problem) return setError(problem);
    if ((await props.onSave(oneOffFields(draft, today))) === false) return;
    setDraft((d) => ({ ...d, title: '', from: '', to: '', ranged: false, notes: undefined }));
    setAdded((n) => n + 1);
  };

  const toggleMonth = (m: number) => put({ months: draft.months.includes(m) ? draft.months.filter((x) => x !== m) : [...draft.months, m] });

  return (
    <form className={phone ? 'stack oneoffform' : 'panel mform oneoffform'} aria-label={props.task ? `Change ${props.task.title}` : 'Add a one off'} onSubmit={submit} noValidate>
      {!props.task && <h2 className={phone ? 'mhead' : undefined}>Add a one off</h2>}
      <div className="stack8">
        <label className="small quiet" htmlFor={ids.title}>
          Title
        </label>
        {/* In a sheet the title takes focus, so typing can start at once. */}
        <input id={ids.title} className="field" autoFocus={!!props.onCancel} value={draft.title} onChange={(e) => put({ title: e.target.value })} />
      </div>
      <div className="stack8">
        <label className="small quiet" htmlFor={ids.type}>
          Repeats
        </label>
        <select id={ids.type} className="field" value={draft.type} onChange={(e) => put({ type: e.target.value as RepeatType })}>
          {REPEAT_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
      </div>

      {draft.type === 'once' && (
        <div className="stack8">
          <label className="small quiet" htmlFor={ids.from}>
            Date (optional)
          </label>
          <div className={phone ? 'stack8' : 'row'}>
            <input id={ids.from} className="field oodatefield" type="date" value={draft.from} onChange={(e) => put({ from: e.target.value })} />
            {draft.ranged ? (
              <>
                <label className="sr" htmlFor={ids.to}>
                  End date
                </label>
                <input id={ids.to} className="field oodatefield" type="date" min={draft.from || undefined} value={draft.to} onChange={(e) => put({ to: e.target.value })} />
              </>
            ) : (
              <div>
                <button className={phone ? 'btn plain' : 'btn sm'} type="button" onClick={() => put({ ranged: true })}>
                  + End date
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {draft.type === 'recurring' && (
        <>
          <Choice label="How often" value={draft.unit} options={UNITS} onChange={(unit) => put({ unit })} />
          <div className="stack8">
            <label className="small quiet" htmlFor={ids.starts}>
              Starts
            </label>
            <input id={ids.starts} className="field oodatefield" type="date" value={draft.starts} onChange={(e) => put({ starts: e.target.value })} />
          </div>
        </>
      )}

      {draft.type === 'float' && (
        <SpanSlider label="After you last did it" value={draft.weeks} max={52} unit="week" onChange={(weeks) => put({ weeks })} />
      )}

      {draft.type === 'window' && (
        <>
          <SpanSlider
            label="Every, at least"
            value={draft.winMin}
            max={24}
            unit="month"
            onChange={(winMin) => put({ winMin, winMax: Math.max(winMin, draft.winMax) })}
          />
          <SpanSlider
            label="At most"
            value={draft.winMax}
            max={24}
            unit="month"
            onChange={(winMax) => put({ winMax, winMin: Math.min(winMax, draft.winMin) })}
          />
        </>
      )}

      {draft.type === 'seasonal' && (
        <div className="stack8 oospan">
          <span className="small quiet" id={ids.months}>
            Months
          </span>
          <div className="oomonths" role="group" aria-labelledby={ids.months}>
            {MONTHS.map((name, i) => {
              const on = draft.months.includes(i + 1);
              return (
                <button key={name} type="button" className={on ? 'dchip on' : 'dchip'} aria-pressed={on} aria-label={name} onClick={() => toggleMonth(i + 1)}>
                  {name.slice(0, 3)}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {draft.type === 'rule' && (
        <div className="oorule oospan">
          <Choice label="Which" value={draft.rulePos} options={POSITIONS} onChange={(rulePos) => put({ rulePos })} />
          <Choice label="Day" value={draft.ruleDay} options={DAYS} onChange={(ruleDay) => put({ ruleDay })} />
          <Choice label="Of each" value={draft.ruleOf} options={OF} onChange={(ruleOf) => put({ ruleOf })} />
        </div>
      )}

      <div className="oospan">
        <EstimateSlider label="Time" value={draft.estimate} onChange={(estimate) => put({ estimate })} />
      </div>
      <div className="oospan">
        <NotesField key={added} value={draft.notes ?? ''} onChange={(notes) => put({ notes })} />
      </div>
      {error && (
        <div className="fielderr oospan" role="alert">
          {error}
        </div>
      )}
      <div className="row">
        <button className={phone ? 'btn pri grow' : 'btn pri'} type="submit">
          {props.task ? 'Save' : 'Add one off'}
        </button>
        {props.onCancel && (
          <button className="btn" type="button" onClick={props.onCancel}>
            Cancel
          </button>
        )}
        {props.onDelete && (
          <button className="btn" type="button" onClick={props.onDelete}>
            Delete
          </button>
        )}
      </div>
    </form>
  );
}

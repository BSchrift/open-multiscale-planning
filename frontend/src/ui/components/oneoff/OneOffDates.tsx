// Add date or Change date on a one off that doesn't repeat, edited in place under its title. Anywhere a one off
// shows (One offs, Today, the week, the plan) can use it; pass commit to put the change on that screen's Undo.

import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { isRepeating, setOnceDates, validateSchedule } from '../../../core/schedule';
import type { LocalDate, Task } from '../../../core/types';
import { useApp, useMutation } from '../../app/store';
import './oneoff.css';

interface Editing {
  from: string;
  to: string;
  ranged: boolean;
  error: string | null;
}

export function OneOffDates(props: {
  task: Task;
  /** Saves new dates; null clears them. Defaults to writing them to the task. */
  commit?(from: LocalDate | null, to: LocalDate | null): unknown;
}) {
  const { task } = props;
  const { layout } = useApp();
  const save = useMutation((w, from: LocalDate | null, to: LocalDate | null) => w.set('task', task.id, setOnceDates(from, to)));
  const commit = props.commit ?? save.run;
  const [ed, setEd] = useState<Editing | null>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  if (isRepeating(task) || task.done_at) return null;

  const s = task.schedule?.type === 'once' ? task.schedule : null;
  const label = s?.from ? 'Change date' : 'Add date';
  const phone = layout === 'phone';
  const put = (patch: Partial<Editing>) => setEd((e) => e && { ...e, error: null, ...patch });
  const close = () => {
    setEd(null);
    toggleRef.current?.focus();
  };
  const apply = async (from: LocalDate | null, to: LocalDate | null) => {
    await commit(from, to);
    close();
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ed) return;
    const to = ed.ranged && ed.to ? ed.to : null;
    const error = ed.from ? validateSchedule(setOnceDates(ed.from, to).schedule!) : 'Pick a date.';
    if (error) return put({ error });
    await apply(ed.from, to);
  };

  return (
    <>
      <div>
        <button
          ref={toggleRef}
          className={phone ? 'btn plain' : 'link small'}
          type="button"
          aria-expanded={!!ed}
          aria-label={`${label} for ${task.title}`}
          onClick={() => (ed ? close() : setEd({ from: s?.from ?? '', to: s?.to ?? '', ranged: !!s?.to, error: null }))}
        >
          {label}
        </button>
      </div>
      {ed && (
        <form
          className="stack8 oodate"
          aria-label={`Dates for ${task.title}`}
          noValidate
          onSubmit={submit}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              close();
            }
          }}
        >
          <div className={phone ? 'stack8' : 'row small'}>
            <label className={phone ? 'stack8 small quiet' : 'popfield'}>
              Date
              <input className="field oodatefield" type="date" autoFocus value={ed.from} onChange={(e) => put({ from: e.target.value })} />
            </label>
            {ed.ranged ? (
              <label className={phone ? 'stack8 small quiet' : 'popfield'}>
                End date
                <input className="field oodatefield" type="date" min={ed.from || undefined} value={ed.to} onChange={(e) => put({ to: e.target.value })} />
              </label>
            ) : (
              <div>
                <button className={phone ? 'btn plain' : 'btn sm'} type="button" onClick={() => put({ ranged: true })}>
                  + End date
                </button>
              </div>
            )}
          </div>
          {ed.error && (
            <div className="fielderr" role="alert">
              {ed.error}
            </div>
          )}
          <div className="row">
            <button className={phone ? 'btn pri grow' : 'btn sm pri'} type="submit">
              Set date
            </button>
            {s?.from && (
              <button className={phone ? 'btn' : 'btn sm'} type="button" onClick={() => void apply(null, null)}>
                {phone ? 'Clear' : 'Clear date'}
              </button>
            )}
            <button className={phone ? 'btn' : 'btn sm'} type="button" onClick={close}>
              Close
            </button>
          </div>
        </form>
      )}
    </>
  );
}

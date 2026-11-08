// Add date or Change date on a one off that doesn't repeat, edited in place under its title. Anywhere a one off
// shows as a row (One offs, Today, Process) uses OneOffDates. The plan opens OneOffDateForm from its own date
// controls, with commit putting the change on its Undo line.

import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { isRepeating, onceWhen, setOnceDates, validateSchedule } from '../../../core/schedule';
import type { Fields, LocalDate, Task } from '../../../core/types';
import { useApp, useMutation } from '../../app/store';
import { useToast } from '../Toast';
import './oneoff.css';

interface Editing {
  from: string;
  to: string;
  ranged: boolean;
  error: string | null;
}

/** A one off's dates. It closes once they save, or on Close or Esc. */
export function OneOffDateForm(props: {
  task: Task;
  /** Saves new dates, null clearing them, resolving to something once saved. Defaults to writing them to the task, with Undo. */
  commit?(from: LocalDate | null, to: LocalDate | null): Promise<unknown>;
  /** Called as the dates save, so a list can say where focus lands if they take the row out of it. */
  onSave?(): void;
  onClose(): void;
}) {
  const { task, onClose } = props;
  const { layout } = useApp();
  const toast = useToast();
  const write = useMutation((w, fields: Fields<'task'>) => w.set('task', task.id, fields));
  const save = async (from: LocalDate | null, to: LocalDate | null) => {
    const previous = await write.run(setOnceDates(from, to));
    if (previous) toast.show(`${task.title}, ${onceWhen({ type: 'once', from, to }) || 'no date'}.`, { undo: () => write.run(previous) });
    return previous;
  };
  const commit = props.commit ?? save;
  const s = task.schedule?.type === 'once' ? task.schedule : null;
  const [ed, setEd] = useState<Editing>({ from: s?.from ?? '', to: s?.to ?? '', ranged: !!s?.to, error: null });
  const phone = layout === 'phone';
  const put = (patch: Partial<Editing>) => setEd((e) => ({ ...e, error: null, ...patch }));
  // A save that fails stays open, with the toast saying so, so nothing typed is lost.
  const apply = async (from: LocalDate | null, to: LocalDate | null) => {
    props.onSave?.();
    if (await commit(from, to)) onClose();
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const to = ed.ranged && ed.to ? ed.to : null;
    const error = ed.from ? validateSchedule(setOnceDates(ed.from, to).schedule!) : 'Pick a date.';
    if (error) return put({ error });
    await apply(ed.from, to);
  };

  return (
    <form
      className="stack8 oodate"
      aria-label={`Dates for ${task.title}`}
      noValidate
      onSubmit={submit}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
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
        <button className={phone ? 'btn' : 'btn sm'} type="button" onClick={onClose}>
          Close
        </button>
      </div>
    </form>
  );
}

/** Add date or Change date, and the dates under it when open. Closing puts focus back on it. */
export function OneOffDates(props: { task: Task; onSave?(): void }) {
  const { task } = props;
  const { layout } = useApp();
  const [open, setOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  if (isRepeating(task) || task.done_at) return null;

  const label = task.schedule?.type === 'once' && task.schedule.from ? 'Change date' : 'Add date';
  const close = () => {
    setOpen(false);
    toggleRef.current?.focus();
  };
  return (
    <>
      <div>
        <button
          ref={toggleRef}
          className={layout === 'phone' ? 'btn plain' : 'link small'}
          type="button"
          aria-expanded={open}
          aria-label={`${label} for ${task.title}`}
          onClick={() => (open ? close() : setOpen(true))}
        >
          {label}
        </button>
      </div>
      {open && <OneOffDateForm task={task} {...(props.onSave ? { onSave: props.onSave } : {})} onClose={close} />}
    </>
  );
}

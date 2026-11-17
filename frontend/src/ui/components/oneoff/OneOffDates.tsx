// Add date or Change date on a one off that doesn't repeat, edited in place under its title. Anywhere a one off
// shows as a row (One offs, Today, Process) uses OneOffDates. The plan opens OneOffDateForm from its own date
// controls, with commit putting the change on its Undo line.

import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { isRepeating, onceWhen, setOnceDates, validateSchedule } from '../../../core/schedule';
import type { Fields, LocalDate, Task } from '../../../core/types';
import { useApp, useMutation } from '../../app/store';
import { DATE_UNSET, useLeave } from '../editors/useLeave';
import { useToast } from '../Toast';
import './oneoff.css';
import { Button } from '../ds/Button';

interface Editing {
  from: string;
  to: string;
  ranged: boolean;
  error: string | null;
}

/** A one off's dates. It closes once they save, or on Cancel, or on Esc unless a date has changed. */
export function OneOffDateForm(props: {
  task: Task;
  /** Saves new dates, null clearing them, resolving to something once saved. Defaults to writing them to the task, with Undo. */
  commit?(from: LocalDate | null, to: LocalDate | null): Promise<unknown>;
  /** Called as the dates save, so a list can say where focus lands if they take the row out of it. */
  onSave?(): void;
  /** For a caller that can move on with the form still open, as Process's card does: set to save the dates typed, if whole. */
  pending?: { current: (() => Promise<boolean>) | null };
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
  const changed = ed.from !== (s?.from ?? '') || (ed.ranged ? ed.to : '') !== (s?.to ?? '');
  const { saveRef, leave } = useLeave(changed, onClose, (error) => put({ error }), DATE_UNSET);
  // A save that fails stays open, with the toast saying so, so nothing typed is lost.
  const apply = async (from: LocalDate | null, to: LocalDate | null) => {
    props.onSave?.();
    if (await commit(from, to)) onClose();
  };
  const to = ed.ranged && ed.to ? ed.to : null;
  const invalid = ed.from ? validateSchedule(setOnceDates(ed.from, to).schedule!) : 'Pick a date.';
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (invalid) return put({ error: invalid });
    await apply(ed.from, to);
  };
  if (props.pending) props.pending.current = changed && !invalid ? async () => !!(await commit(ed.from, to)) : null;

  return (
    <form
      className="stack8 oodate"
      aria-label={`Dates for ${task.title}`}
      noValidate
      onSubmit={submit}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          leave();
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
            <Button variant={phone ? 'quiet' : 'secondary'} size="compact" type="button" onClick={() => put({ ranged: true })}>
              + End date
            </Button>
          </div>
        )}
      </div>
      {ed.error && (
        <div className="fielderr" role="alert">
          {ed.error}
        </div>
      )}
      <div className="row">
        <Button ref={saveRef} variant="primary" size="compact" className={phone ? 'grow' : undefined} type="submit">
          Set date
        </Button>
        {s?.from && (
          <Button size="compact" type="button" onClick={() => void apply(null, null)}>
            {phone ? 'Clear' : 'Clear date'}
          </Button>
        )}
        <Button size="compact" type="button" onClick={onClose}>
          Cancel
        </Button>
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
        <Button
          ref={toggleRef}
          variant={layout === 'phone' ? 'quiet' : 'link'} className={layout === 'phone' ? undefined : 'small'}
          type="button"
          aria-expanded={open}
          aria-label={`${label} for ${task.title}`}
          onClick={() => (open ? close() : setOpen(true))}
        >
          {label}
        </Button>
      </div>
      {open && <OneOffDateForm task={task} {...(props.onSave ? { onSave: props.onSave } : {})} onClose={close} />}
    </>
  );
}

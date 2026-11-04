// One offs dated to today that aren't on the calendar yet: tick, Find a time, or Change date in place.

import { useState } from 'react';
import type { FormEvent } from 'react';
import { isOnToday, oneOffRows, rowLine, setOnceDates } from '../../../core/schedule';
import type { OneOffRow } from '../../../core/schedule';
import type { Task } from '../../../core/types';
import { useNav } from '../../app/nav';
import { useShowCompleted } from '../../app/showCompleted';
import { useApp, useMutation } from '../../app/store';
import { useOneOffTick } from '../../components/oneoff';
import { ShowCompleted } from '../../components/ShowCompleted';
import { TaskRow } from '../../components/TaskRow';
import type { TodayData } from './data';

function DateEditor(props: { task: Task; onClose(): void }) {
  const { task, onClose } = props;
  const once = task.schedule?.type === 'once' ? task.schedule : null;
  const [from, setFrom] = useState(once?.from ?? '');
  const [to, setTo] = useState(once?.to ?? '');
  const [ranged, setRanged] = useState(!!once?.to);
  const [error, setError] = useState('');
  const write = useMutation((w, from: string | null, to: string | null) => w.set('task', task.id, setOnceDates(from, to)));

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const end = ranged && to ? to : null;
    if (!from) return setError('Pick a date.');
    if (end && end < from) return setError('The end date is before the start date.');
    if (await write.run(from, end)) onClose();
  };

  return (
    <form className="stack8 oodate" onSubmit={(e) => void save(e)} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <div className="row small">
        <label className="popfield">
          Date
          <input className="field" type="date" autoFocus value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        {ranged ? (
          <label className="popfield">
            End date
            <input className="field" type="date" min={from} value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
        ) : (
          <button className="btn sm" type="button" onClick={() => setRanged(true)}>
            + End date
          </button>
        )}
      </div>
      <div className="row">
        <button className="btn sm pri" type="submit" disabled={write.pending}>
          Set date
        </button>
        {once?.from && (
          <button className="btn sm" type="button" onClick={() => void write.run(null, null).then(onClose)}>
            Clear date
          </button>
        )}
        <button className="btn sm" type="button" onClick={onClose}>
          Close
        </button>
      </div>
      {error && (
        <div className="fielderr" role="alert">
          {error}
        </div>
      )}
    </form>
  );
}

function Row(props: { row: OneOffRow; onToggle(box: HTMLInputElement): void }) {
  const { row } = props;
  const { task, checked } = row;
  const { layout } = useApp();
  const nav = useNav();
  const [editing, setEditing] = useState(false);
  const btn = layout === 'phone' ? 'btn plain' : 'btn sm';
  return (
    <TaskRow title={task.title} checked={checked} onToggle={(_, box) => props.onToggle(box)} line={rowLine(row)}>
      {!checked && (
        <div className="row">
          <button className={btn} type="button" aria-label={`Find a time for ${task.title}`} onClick={() => nav.go('week', { place: task.id })}>
            Find a time
          </button>
          <button className={btn} type="button" aria-label={`Change date for ${task.title}`} aria-expanded={editing} onClick={() => setEditing(!editing)}>
            Change date
          </button>
        </div>
      )}
      {editing && !checked && <DateEditor task={task} onClose={() => setEditing(false)} />}
    </TaskRow>
  );
}

export function OneOffsToday(props: { data: TodayData }) {
  const { data } = props;
  const { clock } = useApp();
  const ticks = useOneOffTick();
  const showCompleted = useShowCompleted();
  const placed = new Set(data.blocks.map((b) => b.task_id));
  const rows = oneOffRows(data.tasks, data.completions, clock).filter((r) => isOnToday(r.task, data.date) && !placed.has(r.task.id));
  if (rows.length === 0) return null;
  return (
    <section className="stack8" aria-label="One offs today">
      <h3 className="mhead">One offs today</h3>
      <div className="card">
        {rows
          .filter((r) => showCompleted || !r.checked)
          .map((row) => (
            <Row key={row.task.id} row={row} onToggle={(box) => void ticks.toggle(row, box)} />
          ))}
        <ShowCompleted count={rows.filter((r) => r.checked).length} list="One offs today" />
      </div>
    </section>
  );
}

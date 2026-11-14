// Select mode, as Inbox has it: tick rows that show, never folded ones, then add them to this week, finish them, or
// take them out of it together, each as one change with one toast and Undo. Does it fit previews what adding them
// would do. In select mode a selection is the checkbox and one tint, and whether a task is in the week shows as words.

import { useEffect, useState } from 'react';
import { formatMinutes } from '../../../../core/dates';
import { useFit } from '../WeekFit';
import type { PickTask } from './model';
import type { PickProps } from './PickStep';

export interface Selection {
  on: boolean;
  has(row: PickTask): boolean;
  toggle(row: PickTask): void;
}

export function useSelection() {
  const [on, setOn] = useState(false);
  const [ids, setIds] = useState<readonly string[]>([]);
  const sel: Selection & { start(): void; exit(): void; set(rows: readonly PickTask[]): void; ids: readonly string[] } = {
    on,
    ids,
    has: (row) => ids.includes(row.c.task.id),
    toggle: (row) => setIds((now) => (now.includes(row.c.task.id) ? now.filter((id) => id !== row.c.task.id) : [...now, row.c.task.id])),
    start: () => {
      setIds([]);
      setOn(true);
    },
    exit: () => {
      setOn(false);
      setIds([]);
    },
    set: (rows) => setIds(rows.map((r) => r.c.task.id)),
  };
  return sel;
}

/** What a row counts for in a selection: its time this week, or what adding it would add. */
const minutesOf = (r: PickTask) => (r.c.picked ? r.c.week : r.adds);

export function SelectBar(props: PickProps & { rows: readonly PickTask[]; sel: ReturnType<typeof useSelection>; phone: boolean; onCancel(): void }) {
  const { sel, model } = props;
  const chosen = props.rows.filter((r) => sel.has(r));
  const toAdd = chosen.filter((r) => !r.c.picked);
  const toDrop = chosen.filter((r) => r.c.picked);
  const adds = toAdd.reduce((sum, r) => sum + r.adds, 0);
  const count = `${chosen.length} selected · ${formatMinutes(chosen.reduce((sum, r) => sum + minutesOf(r), 0))}`;
  useFit(adds ? { minutes: adds, text: `+${formatMinutes(adds)} if added: ${formatMinutes(model.use.used + adds)} of ${formatMinutes(model.open)}` } : null);
  // The count is said once it settles, not at every tick.
  const [spoken, setSpoken] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setSpoken(chosen.length ? count.replace(' · ', ', ') : ''), 500);
    return () => clearTimeout(timer);
  }, [count, chosen.length]);
  // An action that would do nothing is shown, but says it's unavailable.
  const act = (rows: readonly PickTask[], run: (rows: PickTask[]) => void) => () => {
    if (!rows.length) return;
    sel.exit();
    run([...rows]);
  };
  const btn = props.phone ? 'btn' : 'btn sm';
  return (
    <section className={`selbar${props.phone ? ' ph' : ''}`} aria-label="Selected tasks">
      <div className="selhead">
        <span className="selc">{count}</span>
        <span className="sr" aria-live="polite">
          {spoken}
        </span>
        <button className="link small" type="button" onClick={() => sel.set(props.rows)}>
          Select all shown ({props.rows.length})
        </button>
        {props.phone && (
          <button className="link small" type="button" onClick={props.onCancel}>
            Cancel
          </button>
        )}
      </div>
      <div className="selacts">
        <button className={`${btn} pri`} type="button" aria-disabled={!toAdd.length} onClick={act(toAdd, props.pickMany)}>
          Add to this week
        </button>
        <button className={btn} type="button" aria-disabled={!chosen.length} onClick={act(chosen, props.doneMany)}>
          Already done
        </button>
        <button className={btn} type="button" aria-disabled={!toDrop.length} onClick={act(toDrop, props.dropMany)}>
          Remove from week
        </button>
        {!props.phone && (
          <button className={btn} type="button" onClick={props.onCancel}>
            Cancel
          </button>
        )}
      </div>
    </section>
  );
}

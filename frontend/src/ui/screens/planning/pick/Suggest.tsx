// Add suggested lists what it would add before it adds anything, each ticked, so any can be left out. Add puts the
// rest in the week as one change, with one toast and Undo.

import { useState } from 'react';
import { formatMinutes } from '../../../../core/dates';
import { Popover } from '../../../components/Popover';
import type { PickTask } from './model';
import type { PickProps } from './PickStep';

export function SuggestPreview(props: PickProps & { phone: boolean; onClose(): void }) {
  const { view, model } = props;
  // Listed as they were when it opened, so nothing moves while it's open.
  const [rows] = useState(() =>
    [
      ...view.projects.flatMap((p) => p.groups.flatMap((g) => g.rows.map((r) => ({ r, where: p.plan.project.title })))),
      ...view.oneOffs.rows.map((r) => ({ r, where: 'One offs' })),
    ].filter(({ r }) => model.hints[r.c.task.id] && !r.c.picked && !props.isDone(r)),
  );
  const [off, setOff] = useState<readonly string[]>([]);
  const chosen: PickTask[] = rows.filter(({ r }) => !off.includes(r.c.task.id)).map(({ r }) => r);
  const total = rows.reduce((sum, { r }) => sum + r.adds, 0);
  const sum = chosen.reduce((s, r) => s + r.adds, 0);
  const btn = props.phone ? 'btn grow' : 'btn sm';
  return (
    <Popover label="Add suggested" onClose={props.onClose}>
      <h2>Add suggested</h2>
      <p className="small quiet">
        {rows.length} {rows.length === 1 ? 'task' : 'tasks'}, {formatMinutes(total)}. Untick any you don’t want.
      </p>
      <ul className="picklist sugglist">
        {rows.map(({ r, where }) => (
          <li key={r.c.task.id}>
            <label className={`sugrow${r.oneOff ? ' oo' : ''}`}>
              <input
                type="checkbox"
                checked={!off.includes(r.c.task.id)}
                onChange={(event) => setOff((now) => (event.target.checked ? now.filter((id) => id !== r.c.task.id) : [...now, r.c.task.id]))}
              />
              <span className="tkw">
                <span>{r.title}</span>
                <span className="tm">{where}</span>
              </span>
              <span className="tq">{r.adds < r.c.left ? `${formatMinutes(r.adds)} of ${formatMinutes(r.c.left)}` : formatMinutes(r.adds)}</span>
            </label>
          </li>
        ))}
      </ul>
      <div className="row">
        <button
          className={`${btn} pri`}
          type="button"
          aria-disabled={!chosen.length}
          onClick={() => {
            if (!chosen.length) return;
            props.onClose();
            props.pickMany(chosen);
          }}
        >
          Add {formatMinutes(sum)}
        </button>
        <button className={btn} type="button" onClick={props.onClose}>
          Cancel
        </button>
      </div>
    </Popover>
  );
}

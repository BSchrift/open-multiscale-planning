// One offs: things to do that don't belong to a project. One-time ones soonest first with undated last, then the
// repeating ones in their own group, then everything finished. One-time ones ticked today wait behind Show completed
// until the day changes.

import { useId, useState } from 'react';
import { isRepeating } from '../../../core/schedule';
import type { OneOffRow as Row } from '../../../core/schedule';
import type { Fields } from '../../../core/types';
import type { ScreenProps } from '../../app/registry';
import { useShowCompleted } from '../../app/showCompleted';
import { useMutation, useQuery, useToday } from '../../app/store';
import { OneOffForm, OneOffRow, useOneOffTick } from '../../components/oneoff';
import { Sheet } from '../../components/Sheet';
import { ShowCompleted } from '../../components/ShowCompleted';
import { FinishedTasks } from './FinishedTasks';
import { oneOffList } from './rows';
import './oneoffs.css';

export default function OneOffsScreen({ layout }: ScreenProps) {
  const day = useToday();
  const rows = useQuery((sql, clock) => oneOffList(sql, clock), [day]).data ?? [];
  const ticks = useOneOffTick();
  const showCompleted = useShowCompleted();
  const create = useMutation((w, fields: Fields<'task'>) => w.create('task', fields));
  const [adding, setAdding] = useState(false);
  const repeatingId = useId();
  const phone = layout === 'phone';

  const save = async (fields: Fields<'task'>) => {
    if ((await create.run(fields)) === undefined) return false;
    setAdding(false);
    return true;
  };
  const list = (group: Row[]) => group.map((row) => <OneOffRow key={row.task.id} row={row} onToggle={(r, box) => void ticks.toggle(r, box)} />);
  const once = rows.filter((r) => !isRepeating(r.task));
  const repeating = rows.filter((r) => isRepeating(r.task));

  return (
    <div className={phone ? 'stack oneoffs' : 'wrap stack32 oneoffs'}>
      <section className="stack8">
        <h1 className="mhead">One offs</h1>
        {phone ? (
          <p className="small quiet">Not part of a project.</p>
        ) : (
          <p className="quiet">
            Things to do that don't belong to a project. Give one a date or a date range and it shows up in that plan and week, or on that day.
          </p>
        )}
        {phone ? (
          <div>
            <button className="btn" type="button" onClick={() => setAdding(true)}>
              Add one off
            </button>
          </div>
        ) : (
          <OneOffForm onSave={save} />
        )}
        <div className="card">
          {list(once.filter((r) => showCompleted || !r.checked))}
          <ShowCompleted count={once.filter((r) => r.checked).length} list="One offs" />
        </div>
        {repeating.length > 0 && (
          <section className="oogroup" aria-labelledby={repeatingId}>
            <h2 id={repeatingId}>Repeating</h2>
            <div className="card">{list(repeating)}</div>
          </section>
        )}
        <div className="sr" role="status">
          {ticks.said}
        </div>
        <FinishedTasks />
      </section>
      {adding && (
        <Sheet label="Add a one off" tall onClose={() => setAdding(false)}>
          <OneOffForm onSave={save} onCancel={() => setAdding(false)} />
        </Sheet>
      )}
    </div>
  );
}

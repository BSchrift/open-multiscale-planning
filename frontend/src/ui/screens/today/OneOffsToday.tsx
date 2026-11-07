// One offs dated to today that aren't on the calendar yet: tick, Find a time, or Change date in place.

import { isOnToday, oneOffRows, rowLine } from '../../../core/schedule';
import type { OneOffRow } from '../../../core/schedule';
import { useNav } from '../../app/nav';
import { useShowCompleted } from '../../app/showCompleted';
import { useApp } from '../../app/store';
import { OneOffDates, useOneOffTick } from '../../components/oneoff';
import { ShowCompleted } from '../../components/ShowCompleted';
import { TaskRow } from '../../components/TaskRow';
import type { TodayData } from './data';

function Row(props: { row: OneOffRow; onToggle(box: HTMLInputElement): void }) {
  const { row } = props;
  const { task, checked } = row;
  const { layout } = useApp();
  const nav = useNav();
  return (
    <TaskRow title={task.title} checked={checked} onToggle={(_, box) => props.onToggle(box)} line={rowLine(row)}>
      {!checked && (
        <div className="row oorow">
          <button className={layout === 'phone' ? 'btn plain' : 'btn sm'} type="button" aria-label={`Find a time for ${task.title}`} onClick={() => nav.go('week', { place: task.id })}>
            Find a time
          </button>
          <OneOffDates task={task} />
        </div>
      )}
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

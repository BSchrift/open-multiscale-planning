// One offs dated to today that aren't on the calendar yet: tick, Find a time, or Change date in place.

import { useRef } from 'react';
import { isOnToday, oneOffRows, rowLine } from '../../../core/schedule';
import type { OneOffRow } from '../../../core/schedule';
import { useNav } from '../../app/nav';
import { useShowCompleted } from '../../app/showCompleted';
import { useApp } from '../../app/store';
import { OneOffDates, useOneOffTick } from '../../components/oneoff';
import { ShowCompleted } from '../../components/ShowCompleted';
import { useOpenTask } from '../../components/task/TaskName';
import { useFocusLanding } from '../../components/useFocusLanding';
import { TaskRow } from '../../components/TaskRow';
import type { TodayData } from './data';

function Row(props: { row: OneOffRow; onToggle(box: HTMLInputElement): void; onSave(): void }) {
  const { row } = props;
  const { task, checked } = row;
  const { layout } = useApp();
  const nav = useNav();
  const openTask = useOpenTask();
  return (
    <TaskRow
      title={task.title}
      checked={checked}
      details={!!task.notes}
      onOpen={() => openTask(task.id)}
      onToggle={(_, box) => props.onToggle(box)}
      line={rowLine(row)}
    >
      {!checked && (
        <div className="row oorow">
          <button className={layout === 'phone' ? 'btn plain' : 'btn sm'} type="button" aria-label={`Find a time for ${task.title}`} onClick={() => nav.go('week', { place: task.id })}>
            Find a time
          </button>
          <OneOffDates task={task} onSave={props.onSave} />
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
  const land = useFocusLanding();
  const listRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLHeadingElement>(null);
  const placed = new Set(data.blocks.map((b) => b.task_id));
  const rows = oneOffRows(data.tasks, data.completions, clock).filter((r) => isOnToday(r.task, data.date) && !placed.has(r.task.id));
  if (rows.length === 0) return null;
  const shown = rows.filter((r) => showCompleted || !r.checked);
  // New dates off today take the row away, so focus lands on the row now in its place, the one before, the heading,
  // or with the list gone, on the toast's Undo.
  const landFrom = (i: number) =>
    land(() => {
      const boxes = listRef.current?.querySelectorAll<HTMLElement>('.checkcircle');
      return boxes?.[i] ?? boxes?.[i - 1] ?? headRef.current ?? document.querySelector<HTMLElement>('[role="status"] .toastact');
    });
  return (
    <section className="stack8" aria-label="One offs today">
      <h3 ref={headRef} className="mhead" tabIndex={-1}>
        One offs today
      </h3>
      <div ref={listRef} className="card">
        {shown.map((row, i) => (
          <Row key={row.task.id} row={row} onToggle={(box) => void ticks.toggle(row, box)} onSave={() => landFrom(i)} />
        ))}
        <ShowCompleted count={rows.filter((r) => r.checked).length} list="One offs today" />
      </div>
    </section>
  );
}

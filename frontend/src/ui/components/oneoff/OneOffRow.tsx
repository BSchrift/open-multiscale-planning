// A one off with its tick, its line and its dates, as on the One offs page. How it repeats is changed in its popup.

import { useRef, useState } from 'react';
import { applyPlanChange } from '../../../core/plan';
import type { PlanChange } from '../../../core/plan';
import { isRepeating, rowLine } from '../../../core/schedule';
import type { OneOffRow as Row } from '../../../core/schedule';
import { tickOneOff, untickOneOff } from '../../../core/tasks';
import { useShowCompleted } from '../../app/showCompleted';
import { useApp, useMutation } from '../../app/store';
import { useTickAway } from '../ShowCompleted';
import { useOpenTask } from '../task/TaskName';
import { TaskRow } from '../TaskRow';
import { OneOffDates } from './OneOffDates';

/**
 * Ticking and unticking rows. A tick keeps its exact reverse, so unticking in the same session also gives back the
 * blocks and picks it freed. `said` is a line for a live region. A one-time one ticked while completed tasks are
 * hidden goes out of view with a toast instead, so call this from the list rather than a row.
 */
export function useOneOffTick() {
  const { clock } = useApp();
  const reverses = useRef(new Map<string, PlanChange>());
  const [said, setSaid] = useState('');
  const showCompleted = useShowCompleted();
  const tickAway = useTickAway();
  const toggle = useMutation(async (w, row: Row) => {
    const { task } = row;
    if (!row.checked) {
      reverses.current.set(task.id, await tickOneOff(w, task.id, clock));
      return `${task.title} done`;
    }
    const reverse = reverses.current.get(task.id);
    reverses.current.delete(task.id);
    if (reverse) await applyPlanChange(w, reverse);
    else if (row.completion) await untickOneOff(w, row.completion.id, clock);
    else await w.set('task', task.id, { done_at: null });
    return `${task.title} not done`;
  });
  return {
    said,
    toggle: async (row: Row, box: HTMLInputElement) => {
      // A repeating one stays in view on its next date.
      if (!row.checked && !showCompleted && !isRepeating(row.task)) {
        return tickAway(box, row.task.title, () => toggle.run(row), () => toggle.run({ ...row, checked: true }));
      }
      const text = await toggle.run(row);
      if (text) setSaid(text);
    },
  };
}

export function OneOffRow(props: { row: Row; onToggle(row: Row, box: HTMLInputElement): void }) {
  const { row } = props;
  const openTask = useOpenTask();
  return (
    <TaskRow
      title={row.task.title}
      checked={row.checked}
      line={rowLine(row)}
      details={!!row.task.notes}
      onOpen={() => openTask(row.task.id)}
      onToggle={(_, box) => props.onToggle(row, box)}
    >
      <OneOffDates task={row.task} />
    </TaskRow>
  );
}

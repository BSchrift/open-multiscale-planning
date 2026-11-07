// A one off with its tick, its line, its dates and how it repeats, as on the One offs page.

import { useRef, useState } from 'react';
import { addDays, localDate, today } from '../../../core/dates';
import { applyPlanChange } from '../../../core/plan';
import type { PlanChange } from '../../../core/plan';
import { firstDue, isRepeating, rowLine } from '../../../core/schedule';
import type { OneOffRow as Row } from '../../../core/schedule';
import { closeTask, tickOneOff, untickOneOff } from '../../../core/tasks';
import type { Fields, Task, TaskCompletion, TaskSchedule } from '../../../core/types';
import { useShowCompleted } from '../../app/showCompleted';
import { useApp, useMutation } from '../../app/store';
import { useTickAway } from '../ShowCompleted';
import { TaskRow } from '../TaskRow';
import { useToast } from '../Toast';
import { OneOffDates } from './OneOffDates';
import { OneOffForm } from './OneOffForm';

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
  return (
    <TaskRow title={row.task.title} checked={row.checked} line={rowLine(row)} onToggle={(_, box) => props.onToggle(row, box)}>
      <OneOffDates task={row.task} />
      <OneOffRepeat task={row.task} />
    </TaskRow>
  );
}

const scheduleKey = (s?: TaskSchedule | null) => JSON.stringify(s ?? null, Object.keys(s ?? {}).sort());

/** Change repeat: the add form, filled in, under the row. */
function OneOffRepeat(props: { task: Task }) {
  const { task } = props;
  const { layout } = useApp();
  const [open, setOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  if (task.done_at) return null;
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
          aria-label={`Change repeat for ${task.title}`}
          onClick={() => (open ? close() : setOpen(true))}
        >
          Change repeat
        </button>
      </div>
      {open && <OneOffEditor task={task} onClose={close} />}
    </>
  );
}

/** The add form filled in from a one off, to change or delete it. Esc closes it, and so do Save and Delete. */
export function OneOffEditor(props: { task: Task; onClose(): void }) {
  const { task, onClose } = props;
  const { clock } = useApp();
  const save = useMutation(async (w, fields: Fields<'task'>) => {
    // An unchanged schedule keeps its date, even one overdue. A new one counts from today, or from tomorrow when it was
    // done today, and a float or window from the latest finish.
    let next_due = task.next_due ?? null;
    if (scheduleKey(fields.schedule) !== scheduleKey(task.schedule)) {
      const finishes = await w.sql.all<TaskCompletion>('SELECT * FROM task_completion WHERE task_id = :task', { task: task.id });
      const done = finishes.filter((c) => !c.deleted_at).map((c) => localDate(c.done_at, clock.zone())).sort().pop() ?? null;
      const day = today(clock);
      next_due = firstDue(fields.schedule!, done === day ? addDays(day, 1) : day, done);
    }
    return w.set('task', task.id, { ...fields, next_due });
  });
  const toast = useToast();
  const remove = useMutation((w) => closeTask(w, task.id, 'deleted', clock));
  const undo = useMutation((w, reverse: PlanChange) => applyPlanChange(w, reverse));
  return (
    <div
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <OneOffForm
        task={task}
        onCancel={onClose}
        onDelete={async () => {
          const reverse = await remove.run();
          if (!reverse) return;
          onClose();
          // The row goes with it, so focus moves to Undo rather than the page.
          toast.show(`Deleted ${task.title}`, { undo: () => undo.run(reverse), focusUndo: true });
        }}
        onSave={async (fields) => {
          if ((await save.run(fields)) === undefined) return false;
          onClose();
          return true;
        }}
      />
    </div>
  );
}

// A goal's backlog: the goal's tasks that aren't part of a project, in the order they arrived, each ticked done from its
// row and opened by its title. A task can be dragged to a new place: by its handle on desktop, by holding the row on
// phone, and with the arrow keys on its handle. It opens in place on Goals on desktop, and as its own page on phone.

import { useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { orderBetween, untouchedSince } from '../../../core/backlog';
import { formatDate, formatMinutes, today } from '../../../core/dates';
import { applyPlanChange, minutesLeft } from '../../../core/plan';
import type { PlanChange, ProjectPlan } from '../../../core/plan';
import { closeTask } from '../../../core/tasks';
import type { Objective, Task } from '../../../core/types';
import { useShowCompleted } from '../../app/showCompleted';
import { useApp, useMutation } from '../../app/store';
import { TaskEditor, usePlanChange } from '../../components/editors';
import { NoteMark } from '../../components/notes/NoteMark';
import { ShowCompleted, useTickAway } from '../../components/ShowCompleted';
import { useOpenTask } from '../../components/task/TaskName';
import { useFocusLanding } from '../../components/useFocusLanding';
import { useHoldToMove } from './ProjectView';

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
const isOpen = (t: Task) => !t.done_at && !t.cancelled_at;

/** One definition, said wherever the backlog is. */
export const BACKLOG_LINE = "Tasks for this goal that aren't part of a project.";

/** "the backlog for Learn to bake bread", for sentences and accessible names. */
export const backlogFor = (goal: Pick<Objective, 'title'>) => `the backlog for ${goal.title}`;

/** "5 tasks, 4h 30m", or "No tasks" while it has none open. */
export function backlogSummary(plan: ProjectPlan | undefined): string {
  const open = plan?.tasks.filter(isOpen) ?? [];
  if (!open.length) return 'No tasks';
  const minutes = open.reduce((sum, t) => sum + minutesLeft(t), 0);
  return minutes ? `${plural(open.length, 'task')}, ${formatMinutes(minutes)}` : plural(open.length, 'task');
}

export function BacklogBody(props: { goal: Objective; plan: ProjectPlan | undefined; touches: Record<string, number> }) {
  const { goal, plan, touches } = props;
  const { layout, clock } = useApp();
  const phone = layout === 'phone';
  const apply = usePlanChange();
  const openTask = useOpenTask();
  const showCompleted = useShowCompleted();
  const tickAway = useTickAway();
  const land = useFocusLanding();
  const [adding, setAdding] = useState(false);
  const addRef = useRef<HTMLButtonElement>(null);
  const ticked = useRef(new Map<string, PlanChange>());
  const tasks = plan?.tasks ?? [];
  const open = tasks.filter(isOpen);
  const done = tasks.filter((t) => t.done_at);
  const shown = tasks.filter((t) => isOpen(t) || (showCompleted && t.done_at));
  const on = today(clock);
  const list = backlogFor(goal);

  const tick = useMutation(async (w, task: Task, finished: boolean) => {
    if (finished) {
      ticked.current.set(task.id, await closeTask(w, task.id, 'done', clock));
      return true;
    }
    // Unticking reverses the tick, giving back the time it freed, while that's still known.
    const reverse = ticked.current.get(task.id);
    ticked.current.delete(task.id);
    if (reverse) await applyPlanChange(w, reverse);
    else await w.set('task', task.id, { done_at: null });
  });

  const handleOf = (id: string) => document.querySelector<HTMLElement>(`[data-handle="${CSS.escape(id)}"]`);
  /** Moves a task to an index among the open ones, saying where it went, with Undo. Focus stays on its handle. */
  const moveTo = (task: Task, index: number) => {
    const from = open.findIndex((t) => t.id === task.id);
    if (index < 0 || index >= open.length || index === from) return;
    land(() => handleOf(task.id));
    void apply(() => ({ writes: [{ type: 'task', id: task.id, fields: { order: orderBetween(open, task.id, index) } }] }), {
      message: `Moved ${task.title} to ${index + 1} of ${open.length}.`,
    });
  };
  const dropOn = (taskId: string, key: string) => {
    const task = open.find((t) => t.id === taskId);
    const to = open.findIndex((t) => t.id === key);
    if (task && to >= 0) moveTo(task, to);
  };
  // A handle drags at once; a row on phone lifts after a hold, so a swipe still scrolls.
  const byHandle = useHoldToMove(dropOn, 0);
  const byRow = useHoldToMove(dropOn);
  const drag = byHandle.drag ?? byRow.drag;
  const keys = (task: Task, index: number) => (event: KeyboardEvent) => {
    const step = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
    if (!step) return;
    event.preventDefault();
    moveTo(task, index + step);
  };

  const row = (t: Task) => {
    const index = open.indexOf(t);
    const since = isOpen(t) ? untouchedSince(touches[t.id], on) : null;
    const meta = t.estimate_min ? formatMinutes(t.estimate_min) : 'No estimate';
    const dropOn = drag && drag.over === t.id && drag.id !== t.id ? ' dropon' : '';
    return (
      <div key={t.id} className={`taskline editrow backlogline${drag?.id === t.id ? ' lifted' : ''}${dropOn}`} data-drop={isOpen(t) ? t.id : undefined}>
        <label className="taskcheck">
          <input
            type="checkbox"
            aria-label={`${t.title} done`}
            checked={!!t.done_at}
            onChange={(event) => {
              if (!event.target.checked || showCompleted) return void tick.run(t, event.target.checked);
              void tickAway(event.target, t.title, () => tick.run(t, true), () => tick.run(t, false));
            }}
          />
        </label>
        {isOpen(t) ? (
          <button
            className="rowbtn"
            type="button"
            aria-label={`Edit task ${t.title}, ${meta}${since ? `, untouched since ${formatDate(since)}` : ''}${t.notes ? ', has details' : ''}`}
            onPointerDown={phone ? byRow.press(t.id, t.title) : undefined}
            onClick={() => openTask(t.id)}
          >
            <span className="grow">
              {t.title}
              {t.notes && <NoteMark />}
              {since && <span className="small quiet lineblock">Untouched since {formatDate(since)}</span>}
            </span>
            <span className="small quiet">{meta}</span>
            <span className="editcue" aria-hidden="true">
              Edit
            </span>
          </button>
        ) : (
          <div className="rowstatic taskstatic grow">
            <span className="grow done">{t.title}</span>
            <span className="small quiet">{meta}</span>
          </div>
        )}
        {isOpen(t) && open.length > 1 && (
          <button
            className={phone ? 'icbtn draghandle' : 'icon draghandle'}
            type="button"
            data-handle={t.id}
            aria-label={`Reorder ${t.title}, ${index + 1} of ${open.length}`}
            aria-describedby={`${goal.id}-reorder`}
            onPointerDown={byHandle.press(t.id, t.title)}
            onKeyDown={keys(t, index)}
          >
            <span aria-hidden="true">⠿</span>
          </button>
        )}
      </div>
    );
  };

  return (
    <div className="stack8 backlogbody">
      <p className="small quiet">{BACKLOG_LINE}</p>
      <span id={`${goal.id}-reorder`} className="sr" hidden>
        Up and down arrows move it.
      </span>
      {open.length === 0 && !showCompleted && (
        <p className="small quiet">No tasks yet. Add tasks for this goal that don't belong to a project, or move Inbox items here from Process.</p>
      )}
      <div className="backlogtasks" role="group" aria-label={`Tasks in ${list}`}>
        {shown.map(row)}
        <ShowCompleted count={done.length} list={list} />
      </div>
      {drag && (
        <div className="taskghost" style={{ top: drag.y }} aria-hidden="true">
          {drag.title}
        </div>
      )}
      <div className="editrow addrow">
        <button ref={addRef} className={phone ? 'btn plain' : 'btn sm'} type="button" aria-label={`Add task to ${list}`} onClick={() => setAdding(true)}>
          {phone ? '+ Task' : 'Add task'}
        </button>
        {adding && (
          <BacklogAdd
            goal={goal}
            onClose={() => {
              setAdding(false);
              land(() => addRef.current);
            }}
          />
        )}
      </div>
    </div>
  );
}

/** Add task for a goal's backlog: TaskEditor with no milestone, which closes on Add. */
export function BacklogAdd(props: { goal: Objective; onClose(): void }) {
  return <TaskEditor backlog={{ goalId: props.goal.id, goalTitle: props.goal.title }} label={`Add task to ${backlogFor(props.goal)}`} onClose={props.onClose} />;
}

/** The backlog as its own page on phone, its goal inside the heading so the headings rotor tells goals apart. */
export function BacklogPage(props: { goal: Objective | undefined; plan: ProjectPlan | undefined; touches: Record<string, number> }) {
  const heading = useRef<HTMLHeadingElement>(null);
  const focused = useRef(false);
  if (!props.goal) return <p className="quiet">This goal is no longer here.</p>;
  return (
    <div className="stack">
      <h1
        ref={(el) => {
          heading.current = el;
          if (el && !focused.current) {
            focused.current = true;
            el.focus();
          }
        }}
        tabIndex={-1}
      >
        <span className="small quiet lineblock">{props.goal.title}</span> Backlog
      </h1>
      <BacklogBody goal={props.goal} plan={props.plan} touches={props.touches} />
    </div>
  );
}

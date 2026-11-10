// Adds or edits a project task: a popover on desktop, a sheet on phone. Adding stays open with the last one named,
// so a few can go in together. Moving it to another milestone and deleting it both offer Undo. Its description is
// saved with the rest, and an empty one is none.

import { useState } from 'react';
import type { FormEvent } from 'react';
import { sortedMilestones } from '../../../core/plan';
import type { PlanContext, ProjectPlan } from '../../../core/plan';
import { closeTask } from '../../../core/tasks';
import { useApp, useMutation } from '../../app/store';
import { EstimateSlider } from '../EstimateSlider';
import { NotesField } from '../notes/NotesField';
import { Popover } from '../Popover';
import { useToast } from '../Toast';
import { usePlanChange } from './usePlanChange';

export function TaskEditor(props: {
  plan: ProjectPlan;
  ctx: PlanContext;
  /** Edits this task; without it, adds one. */
  taskId?: string;
  /** The milestone a new task starts under. */
  milestoneId?: string | null;
  /** Called with each task added, and the milestone it went under. */
  onAdded?(id: string, milestoneId: string | null): void;
  /** A line about the task under the heading, such as why it's suggested. */
  note?: string;
  onClose(): void;
}) {
  const { plan, ctx, onClose } = props;
  const { clock } = useApp();
  const toast = useToast();
  const apply = usePlanChange();
  const task = props.taskId ? plan.tasks.find((t) => t.id === props.taskId) : undefined;
  const [title, setTitle] = useState(task?.title ?? '');
  const [estimate, setEstimate] = useState(task ? (task.estimate_min ?? 0) : 60);
  const [milestone, setMilestone] = useState(task ? (task.milestone_id ?? '') : (props.milestoneId ?? ''));
  const [notes, setNotes] = useState(task?.notes ?? '');
  // The key starts the field afresh after each add, so it opens empty for the next task.
  const [added, setAdded] = useState(0);
  const notesValue = notes.trim() ? notes : null;
  const [error, setError] = useState('');
  const [last, setLast] = useState('');
  const options = sortedMilestones(plan, ctx).filter((m) => !m.dropped_at);

  const add = useMutation((w, name: string) =>
    w.create('task', {
      kind: 'project',
      project_id: plan.project.id,
      milestone_id: milestone || null,
      title: name,
      estimate_min: estimate || null,
      ...(notesValue ? { notes: notesValue } : {}),
    }),
  );
  const remove = useMutation((w, id: string) => closeTask(w, id, 'deleted', clock));

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const name = title.trim();
    if (!name) return setError('Give it a title.');
    if (!task) {
      const id = await add.run(name);
      if (id) {
        props.onAdded?.(id, milestone || null);
        setTitle('');
        setNotes('');
        setAdded((n) => n + 1);
        setLast(name);
      }
      return;
    }
    const moved = milestone !== (task.milestone_id ?? '');
    const target = options.find((m) => m.id === milestone)?.title ?? 'Done';
    // A failed save keeps the editor open as it was, and has said so.
    const saved = await apply(
      () => ({
        writes: [
          {
            type: 'task',
            id: task.id,
            fields: {
              title: name,
              estimate_min: estimate || null,
              ...(moved ? { milestone_id: milestone || null, moved_from: null } : {}),
              ...(notesValue !== (task.notes || null) ? { notes: notesValue } : {}),
            },
          },
        ],
      }),
      moved ? { message: `Moved ${name} to ${target}.` } : {},
    );
    if (saved) onClose();
  };

  const deleteTask = async () => {
    if (!task) return;
    const reverse = await remove.run(task.id);
    if (!reverse) return;
    onClose();
    toast.show(`Deleted ${task.title}.`, { undo: () => apply(() => reverse) });
  };

  const heading = task ? 'Edit task' : 'Add task';
  return (
    <Popover label={heading} onClose={onClose}>
      <form className="stack8 editor" onSubmit={save}>
        <h2>{heading}</h2>
        {props.note && <p className="small quiet">{props.note}</p>}
        <label className="popfield">
          Title
          <input
            className="field"
            autoFocus
            value={title}
            onChange={(event) => {
              setTitle(event.target.value);
              setError('');
            }}
          />
        </label>
        <EstimateSlider label="Time estimate" value={estimate} onChange={setEstimate} />
        <label className="popfield">
          Milestone
          <select className="field" aria-label="Milestone" value={milestone} onChange={(event) => setMilestone(event.target.value)}>
            {/* No milestone: the task sits under the project's Done. */}
            <option value="">Done</option>
            {options.map((m) => (
              <option key={m.id} value={m.id}>
                {m.title}
              </option>
            ))}
          </select>
        </label>
        <NotesField key={added} value={notes} onChange={setNotes} />
        {error && (
          <div className="fielderr" role="alert">
            {error}
          </div>
        )}
        <div className="small quiet" role="status">
          {last && `Added ${last}.`}
        </div>
        <div className="row">
          <button className="btn sm pri grow" type="submit">
            {task ? 'Save' : 'Add'}
          </button>
          <button className="btn sm" type="button" onClick={onClose}>
            {last && !title.trim() ? 'Done' : 'Cancel'}
          </button>
        </div>
        {task && (
          <div>
            <button className="btn sm" type="button" onClick={deleteTask}>
              Delete task
            </button>
          </div>
        )}
      </form>
    </Popover>
  );
}

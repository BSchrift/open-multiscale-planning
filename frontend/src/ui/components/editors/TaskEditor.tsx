// Adds project tasks: a popover on desktop, a sheet on phone. It stays open with the last one named, so a few can go
// in together, each with its estimate, milestone and description. A task once added is changed in its popup.

import { useState } from 'react';
import type { FormEvent } from 'react';
import { sortedMilestones } from '../../../core/plan';
import type { PlanContext, ProjectPlan } from '../../../core/plan';
import { useMutation } from '../../app/store';
import { EstimateSlider } from '../EstimateSlider';
import { NotesField } from '../notes/NotesField';
import { Popover } from '../Popover';

export function TaskEditor(props: {
  plan: ProjectPlan;
  ctx: PlanContext;
  /** The milestone a new task starts under. */
  milestoneId?: string | null;
  /** Called with each task added, and the milestone it went under. */
  onAdded?(id: string, milestoneId: string | null): void;
  onClose(): void;
}) {
  const { plan, ctx, onClose } = props;
  const [title, setTitle] = useState('');
  const [estimate, setEstimate] = useState(60);
  const [milestone, setMilestone] = useState(props.milestoneId ?? '');
  const [notes, setNotes] = useState('');
  // The key starts the field afresh after each add, so it opens empty for the next task.
  const [added, setAdded] = useState(0);
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
      ...(notes.trim() ? { notes } : {}),
    }),
  );

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const name = title.trim();
    if (!name) return setError('Give it a title.');
    const id = await add.run(name);
    if (!id) return;
    props.onAdded?.(id, milestone || null);
    setTitle('');
    setNotes('');
    setAdded((n) => n + 1);
    setLast(name);
  };

  return (
    <Popover label="Add task" onClose={onClose}>
      <form className="stack8 editor" onSubmit={save}>
        <h2>Add task</h2>
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
            Add
          </button>
          <button className="btn sm" type="button" onClick={onClose}>
            {last && !title.trim() ? 'Done' : 'Cancel'}
          </button>
        </div>
      </form>
    </Popover>
  );
}

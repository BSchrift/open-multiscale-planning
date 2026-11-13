// Adds project tasks: a popover on desktop, a sheet on phone, or in place on desktop for a form at the foot of a list.
// It stays open with the last one named, so a few can go in together, each with its estimate, milestone and
// description. A task once added is changed in its popup.

import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { sortedMilestones } from '../../../core/plan';
import type { PlanContext, ProjectPlan } from '../../../core/plan';
import type { Fields } from '../../../core/types';
import { useMutation } from '../../app/store';
import { EstimateSlider } from '../EstimateSlider';
import { NotesField } from '../notes/NotesField';
import { Popover } from '../Popover';
import { SheetOnPhone } from './SheetOnPhone';

export function TaskEditor(props: {
  plan: ProjectPlan;
  ctx: PlanContext;
  /** The milestone a new task starts under. */
  milestoneId?: string | null;
  /** Called with each task added, and the milestone it went under. */
  onAdded?(id: string, milestoneId: string | null): void;
  onClose(): void;
  /** In place on desktop rather than hanging from its button, named for where it adds. */
  inPlace?: boolean;
  label?: string;
  /** Shows a This week tick, on to start with, which goes to write. */
  week?: boolean;
  /** Saves the task instead of the form, with what goes with it, resolving to its id. The caller then reports it. */
  write?(fields: Fields<'task'>, inWeek: boolean): Promise<string | undefined>;
}) {
  const { plan, ctx, onClose } = props;
  const [title, setTitle] = useState('');
  const [estimate, setEstimate] = useState(60);
  const [milestone, setMilestone] = useState(props.milestoneId ?? '');
  const [notes, setNotes] = useState('');
  const [inWeek, setInWeek] = useState(true);
  // The key starts the field afresh after each add, so it opens empty for the next task.
  const [added, setAdded] = useState(0);
  const [error, setError] = useState('');
  const [last, setLast] = useState('');
  const titleRef = useRef<HTMLInputElement>(null);
  const options = sortedMilestones(plan, ctx).filter((m) => !m.dropped_at);

  const fieldsOf = (name: string): Fields<'task'> => ({
    kind: 'project',
    project_id: plan.project.id,
    milestone_id: milestone || null,
    title: name,
    estimate_min: estimate || null,
    ...(notes.trim() ? { notes } : {}),
  });
  const add = useMutation((w, name: string) => w.create('task', fieldsOf(name)));

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const name = title.trim();
    if (!name) return setError('Give it a title.');
    const id = props.write ? await props.write(fieldsOf(name), inWeek) : await add.run(name);
    if (!id) return;
    props.onAdded?.(id, milestone || null);
    setTitle('');
    setNotes('');
    setAdded((n) => n + 1);
    setLast(name);
    // Ready for the next one, however this one was added.
    titleRef.current?.focus();
  };

  const label = props.label ?? 'Add task';
  const form = (
    <form className="stack8 editor" aria-label={props.label} onSubmit={save}>
      <div>
        {props.label && <div className="small quiet">{plan.project.title}</div>}
        <h2>Add task</h2>
      </div>
      <label className="popfield">
        Title
        <input
          ref={titleRef}
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
      {props.week && (
        <label className="row small weektick">
          <input type="checkbox" checked={inWeek} onChange={(event) => setInWeek(event.target.checked)} />
          This week
        </label>
      )}
      {error && (
        <div className="fielderr" role="alert">
          {error}
        </div>
      )}
      {/* A caller that writes the task says so itself, in a toast with Undo, so it's said once. */}
      {!props.write && (
        <div className="small quiet" role="status">
          {last && `Added ${last}.`}
        </div>
      )}
      <div className="row">
        <button className="btn sm pri grow" type="submit">
          Add
        </button>
        <button className="btn sm" type="button" onClick={onClose}>
          {props.write ? 'Close' : last && !title.trim() ? 'Done' : 'Cancel'}
        </button>
      </div>
    </form>
  );
  return props.inPlace ? (
    <SheetOnPhone label={label} onClose={onClose}>
      {form}
    </SheetOnPhone>
  ) : (
    <Popover label={label} onClose={onClose}>
      {form}
    </Popover>
  );
}

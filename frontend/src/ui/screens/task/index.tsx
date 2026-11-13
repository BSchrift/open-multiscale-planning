// A task's popup: everything about one task, to read and change, opened by tapping the task wherever it shows. A sheet
// on phone and a centred dialog on desktop. Top to bottom: its name, with what Process made of a finished Inbox item,
// Time estimate, where it belongs, Description, Attachments, then Save, Cancel and Delete task. Focus starts on the
// name, read as the heading, so the phone's keyboard stays down until a field is tapped. Save and Delete each offer
// Undo. Attachments are added and removed as they go, each with its own Undo, rather than on Save.

import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { MAX_TITLE } from '../../../core/captureTitle';
import type { Sql } from '../../../core/db';
import { applyPlanChange } from '../../../core/plan';
import type { PlanChange } from '../../../core/plan';
import { getRecord, listRecords } from '../../../core/records';
import { closeTask } from '../../../core/tasks';
import type { Fields, LocalDate, Task } from '../../../core/types';
import type { ScreenProps } from '../../app/registry';
import { useApp, useMutation, useQuery, useToday } from '../../app/store';
import { Attachments } from '../../components/attachments/Attachments';
import { useLeave } from '../../components/editors/useLeave';
import { usePlanChange } from '../../components/editors/usePlanChange';
import { EstimateSlider } from '../../components/EstimateSlider';
import { CloseIcon } from '../../components/icons';
import { NotesField } from '../../components/notes/NotesField';
import { emptyDraft, oneOffFields } from '../../components/oneoff/draft';
import { Sheet } from '../../components/Sheet';
import { Became } from '../../components/task/Became';
import { useToast } from '../../components/Toast';
import './task.css';

const INBOX = 'inbox';
const ONE_OFFS = 'oneoffs';

/** Where a task can belong, as the Belongs to choice shows it. */
interface Place {
  value: string;
  label: string;
  projectId?: string;
  milestoneId?: string;
}

const placeOf = (task: Task) =>
  task.kind === 'project' && task.project_id ? (task.milestone_id ? `m:${task.milestone_id}` : `p:${task.project_id}`) : task.kind === 'one_off' ? ONE_OFFS : INBOX;

/** The task, and the projects and open milestones it could move to, with wherever it is now. */
async function loadTask(sql: Sql, id: string) {
  const task = await getRecord(sql, 'task', id);
  if (!task) return { task, places: [] };
  const projects = (await listRecords(sql, 'project')).filter((p) => p.state === 'active' || p.state === 'paused' || p.id === task.project_id);
  const milestones = (await listRecords(sql, 'milestone'))
    .filter((m) => (!m.met_at && !m.dropped_at) || m.id === task.milestone_id)
    .sort((a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999') || a.title.localeCompare(b.title));
  const places: Place[] = [
    { value: INBOX, label: 'Inbox' },
    { value: ONE_OFFS, label: 'One offs' },
    ...projects.flatMap((p) => [
      ...milestones.filter((m) => m.project_id === p.id).map((m) => ({ value: `m:${m.id}`, label: `${p.title}, ${m.title}`, projectId: p.id, milestoneId: m.id })),
      // No milestone: it sits under the project's Done.
      { value: `p:${p.id}`, label: `${p.title}, Done`, projectId: p.id },
    ]),
  ];
  return { task, places };
}

/** The fields that move a task to a place. Fields merge one by one, so each kind clears the others'. */
function moveFields(place: Place, task: Task, today: LocalDate): Fields<'task'> {
  if (place.value === INBOX) return { kind: 'inbox', project_id: null, milestone_id: null, schedule: null, next_due: null };
  if (place.value === ONE_OFFS) {
    const { kind, project_id, milestone_id, schedule, next_due } = oneOffFields({ ...emptyDraft(today), title: task.title }, today);
    return { kind, project_id, milestone_id, schedule, next_due };
  }
  return { kind: 'project', project_id: place.projectId!, milestone_id: place.milestoneId ?? null, moved_from: null, schedule: null, next_due: null };
}

export default function Screen(props: ScreenProps) {
  const id = props.params.task ?? '';
  const data = useQuery((sql) => loadTask(sql, id), [id]).data;
  // Deleted, here or on another device, it has nothing left to show.
  const gone = !!data && (!data.task || !!data.task.deleted_at);
  const { close } = props;
  useEffect(() => {
    if (gone) close();
  }, [gone, close]);
  if (!data?.task || gone) return null;
  return <TaskPopup key={id} task={data.task} places={data.places} note={props.params.note} close={close} />;
}

function TaskPopup(props: { task: Task; places: readonly Place[]; note?: string; close(): void }) {
  const { task, places, close } = props;
  const { layout, clock } = useApp();
  const today = useToday();
  const toast = useToast();
  const apply = usePlanChange();
  const remove = useMutation((w) => closeTask(w, task.id, 'deleted', clock));
  const undo = useMutation((w, reverse: PlanChange) => applyPlanChange(w, reverse));
  const [title, setTitle] = useState(task.title);
  const [renaming, setRenaming] = useState(false);
  const [estimate, setEstimate] = useState(task.estimate_min ?? 0);
  const [place, setPlace] = useState(placeOf(task));
  const [notes, setNotes] = useState(task.notes ?? '');
  const [error, setError] = useState('');
  const head = useRef<HTMLHeadingElement>(null);
  const phone = layout === 'phone';

  // After the dialog takes focus, which its own effect does first.
  useEffect(() => head.current?.focus(), []);

  const name = title.trim();
  const notesValue = notes.trim() ? notes : null;
  const moved = place !== placeOf(task) ? places.find((p) => p.value === place) : undefined;
  const fields: Fields<'task'> = {
    ...(name !== task.title ? { title: name } : {}),
    ...((estimate || null) !== (task.estimate_min ?? null) ? { estimate_min: estimate || null } : {}),
    ...(notesValue !== (task.notes || null) ? { notes: notesValue } : {}),
    ...(moved ? moveFields(moved, task, today) : {}),
  };
  const { saveRef, leave } = useLeave(Object.keys(fields).length > 0, close, setError);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!name) return setError('Give it a title.');
    if (Object.keys(fields).length === 0) return close();
    // A failed save keeps the popup open as it was, and has said so.
    const saved = await apply(() => ({ writes: [{ type: 'task', id: task.id, fields }] }), {
      message: moved ? `Moved ${name} to ${moved.label}.` : `Saved ${name}.`,
    });
    if (saved) close();
  };

  const deleteTask = async () => {
    const reverse = await remove.run();
    if (!reverse) return;
    close();
    // The rows it was in lose it, so focus moves to Undo rather than the page.
    toast.show(`Deleted ${task.title}.`, { undo: () => undo.run(reverse), focusUndo: true });
  };

  const choices = places.some((p) => p.value === place) ? places : [{ value: place, label: 'Where it is now' }, ...places];
  return (
    <Sheet label={task.title} className="taskpop" onClose={leave}>
      <form className="taskpopform" onSubmit={save} noValidate>
        <div className="taskpoptop">
          {phone && <div className="taskpopgrab" aria-hidden="true" />}
          <div className="taskpophead">
            {renaming ? (
              <input
                className="field taskpopnamefield"
                aria-label="Name"
                autoFocus
                maxLength={MAX_TITLE}
                value={title}
                onChange={(event) => {
                  setTitle(event.target.value);
                  setError('');
                }}
              />
            ) : (
              <h2 ref={head} tabIndex={-1}>
                <button className="taskpopname" type="button" aria-label={`Rename ${title}`} onClick={() => setRenaming(true)}>
                  {title}
                </button>
              </h2>
            )}
            {!phone && (
              <button className="taskpopclose" type="button" aria-label="Close" onClick={leave}>
                <CloseIcon />
              </button>
            )}
          </div>
          {props.note && <p className="small quiet">{props.note}</p>}
          {task.done_at && task.became && <Became became={task.became} onGo={close} />}
        </div>
        <div className="taskpopbody">
          <EstimateSlider label="Time estimate" value={estimate} onChange={setEstimate} />
          <label className="popfield">
            Belongs to
            <select className="field" value={place} onChange={(event) => setPlace(event.target.value)}>
              {choices.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <NotesField value={notes} onChange={setNotes} />
          <Attachments taskId={task.id} />
          {error && (
            <div className="fielderr" role="alert">
              {error}
            </div>
          )}
        </div>
        <div className="taskpopbar">
          <button className="link taskpopdelete" type="button" onClick={deleteTask}>
            Delete task
          </button>
          <button className="btn" type="button" onClick={close}>
            Cancel
          </button>
          <button ref={saveRef} className="btn pri" type="submit">
            Save
          </button>
        </div>
      </form>
    </Sheet>
  );
}

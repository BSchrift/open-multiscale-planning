// A task's popup: everything about one task, to read and change, opened by tapping the task wherever it shows. A sheet
// on phone and a centred dialog on desktop. Top to bottom: its name, with what Process made of a finished Inbox item,
// then, opened from a block on a calendar, that block's own section, then Time estimate, where it belongs, Description,
// Attachments, then Save, Cancel and Delete task. Focus starts on the
// name, read as the heading, so the phone's keyboard stays down until a field is tapped. Save and Delete each offer
// Undo. Attachments are added and removed as they go, each with its own Undo, rather than on Save. A goal's backlog is a
// place too: a task moved there loses its milestone and any date, and a repeating one off can't go.

import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { backlogGoal, backlogTitle, fileToBacklog, isBacklog } from '../../../core/backlog';
import { MAX_TITLE } from '../../../core/captureTitle';
import { formatDate, formatWeekday } from '../../../core/dates';
import type { Sql } from '../../../core/db';
import { applyPlanChange } from '../../../core/plan';
import type { PlanChange } from '../../../core/plan';
import { getRecord, listRecords } from '../../../core/records';
import { isRepeating, onceWhen, projectDates } from '../../../core/schedule';
import { closeTask } from '../../../core/tasks';
import type { Fields, LocalDate, Task } from '../../../core/types';
import type { ScreenProps } from '../../app/registry';
import { useApp, useMutation, useQuery, useToday } from '../../app/store';
import { Attachments } from '../../components/attachments/Attachments';
import { LeavePopup } from '../../components/blocks/BlockSection';
import { useLeave } from '../../components/editors/useLeave';
import { usePlanChange } from '../../components/editors/usePlanChange';
import { EstimateSlider } from '../../components/EstimateSlider';
import { CloseIcon, PenIcon } from '../../components/icons';
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
  /** A goal's backlog, made if it's new when the task moves in. */
  goalId?: string;
  goalTitle?: string;
}

const placeOf = (task: Task) => {
  if (task.kind === 'project' && task.project_id && isBacklog({ id: task.project_id })) return `b:${backlogGoal({ id: task.project_id })}`;
  return task.kind === 'project' && task.project_id ? (task.milestone_id ? `m:${task.milestone_id}` : `p:${task.project_id}`) : task.kind === 'one_off' ? ONE_OFFS : INBOX;
};

/** The day or days a task is dated, for the note that moving it to a backlog clears them. */
function dateOf(task: Task): string {
  const s = task.schedule?.type === 'once' ? task.schedule : null;
  if (s?.from) return s.to && s.to !== s.from ? onceWhen(s) : `${formatWeekday(s.from)} ${formatDate(s.from)}`;
  return task.next_due && !isRepeating(task) ? `${formatWeekday(task.next_due)} ${formatDate(task.next_due)}` : '';
}

/** The task, and the projects and open milestones it could move to, with wherever it is now. */
async function loadTask(sql: Sql, id: string) {
  const task = await getRecord(sql, 'task', id);
  if (!task) return { task, places: [] };
  const projects = (await listRecords(sql, 'project')).filter((p) => !isBacklog(p) && (p.state === 'active' || p.state === 'paused' || p.id === task.project_id));
  const goals = (await listRecords(sql, 'objective')).filter((g) => g.state !== 'archived' || placeOf(task) === `b:${g.id}`);
  goals.sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity) || (a.id < b.id ? -1 : 1));
  const milestones = (await listRecords(sql, 'milestone'))
    .filter((m) => (!m.met_at && !m.dropped_at) || m.id === task.milestone_id)
    .sort((a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999') || a.title.localeCompare(b.title));
  const places: Place[] = [
    { value: INBOX, label: 'Inbox' },
    { value: ONE_OFFS, label: 'One offs' },
    ...goals.map((g) => ({ value: `b:${g.id}`, label: backlogTitle(g.title), goalId: g.id, goalTitle: g.title })),
    ...projects.flatMap((p) => [
      ...milestones.filter((m) => m.project_id === p.id).map((m) => ({ value: `m:${m.id}`, label: `${p.title}, ${m.title}`, projectId: p.id, milestoneId: m.id })),
      // No milestone: it sits under the project's Done.
      { value: `p:${p.id}`, label: `${p.title}, Done`, projectId: p.id },
    ]),
  ];
  return { task, places };
}

/**
 * The fields that move a task to a place. Fields merge one by one, so each kind clears the others'. A date goes with it,
 * a day or a range, but a repeat stays with One offs, and the Inbox holds none.
 */
function moveFields(place: Place, task: Task, today: LocalDate): Fields<'task'> {
  if (place.value === INBOX) return { kind: 'inbox', project_id: null, milestone_id: null, schedule: null, next_due: null };
  if (place.value === ONE_OFFS) {
    const once = task.schedule?.type === 'once' ? task.schedule : null;
    const draft = { ...emptyDraft(today), title: task.title, ...(once?.from ? { from: once.from, to: once.to ?? '', ranged: !!once.to } : {}) };
    const { kind, project_id, milestone_id, schedule, next_due } = oneOffFields(draft, today);
    return { kind, project_id, milestone_id, schedule, next_due };
  }
  return { kind: 'project', project_id: place.projectId!, milestone_id: place.milestoneId ?? null, moved_from: null, ...projectDates(task) };
}

export default function Screen(props: ScreenProps) {
  return <TaskPopupFor id={props.params.task ?? ''} note={props.params.note} close={props.close} />;
}

/**
 * The popup, for a calendar that draws it itself, opened from one of its blocks: block is that block's section, whose
 * actions can reach back into the calendar, such as Move.
 */
export function TaskPopupFor(props: { id: string; note?: string | undefined; close(): void; block?: ReactNode }) {
  const { id, close } = props;
  const data = useQuery((sql) => loadTask(sql, id), [id]).data;
  // Deleted, here or on another device, it has nothing left to show.
  const gone = !!data && (!data.task || !!data.task.deleted_at);
  useEffect(() => {
    if (gone) close();
  }, [gone, close]);
  if (!data?.task || gone) return null;
  return <TaskPopup key={id} task={data.task} places={data.places} note={props.note} close={close} block={props.block} />;
}

function TaskPopup(props: { task: Task; places: readonly Place[]; note?: string | undefined; close(): void; block?: ReactNode }) {
  const { task, places, close } = props;
  const { layout, clock } = useApp();
  const today = useToday();
  const toast = useToast();
  const apply = usePlanChange();
  const remove = useMutation((w) => closeTask(w, task.id, 'deleted', clock));
  // Into a backlog, made if it's new, with any other edits in the same change.
  const file = useMutation(async (w, goalId: string, edits: Fields<'task'>) => {
    const edited = Object.keys(edits).length ? await applyPlanChange(w, { writes: [{ type: 'task', id: task.id, fields: edits }] }) : { writes: [] };
    const moved = await fileToBacklog(w, goalId, [task.id], clock);
    return { writes: [...moved.writes, ...edited.writes] };
  });
  const noteId = useId();
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
  const edits: Fields<'task'> = {
    ...(name !== task.title ? { title: name } : {}),
    ...((estimate || null) !== (task.estimate_min ?? null) ? { estimate_min: estimate || null } : {}),
    ...(notesValue !== (task.notes || null) ? { notes: notesValue } : {}),
  };
  const fields: Fields<'task'> = { ...edits, ...(moved && !moved.goalId ? moveFields(moved, task, today) : {}), ...(moved?.goalId ? { project_id: moved.value } : {}) };
  const repeats = isRepeating(task);
  const dated = moved?.goalId ? dateOf(task) : '';
  const note = repeats ? 'A repeating task stays in One offs. For regular time toward a goal, add a practice.' : dated ? `Backlog tasks have no date, so ${dated} will be cleared.` : '';
  const { saveRef, leave } = useLeave(Object.keys(fields).length > 0, close, setError);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!name) return setError('Give it a title.');
    if (Object.keys(fields).length === 0) return close();
    if (moved?.goalId) {
      const reverse = await file.run(moved.goalId, edits);
      if (!reverse) return;
      close();
      toast.show(`Moved ${name} to the backlog for ${moved.goalTitle}.`, { undo: () => undo.run(reverse) });
      return;
    }
    // A failed save keeps the popup open as it was, and has said so.
    const saved = await apply(() => ({ writes: [{ type: 'task', id: task.id, fields }] }), {
      message: moved ? `Moved ${name} to ${moved.label}.${moved.projectId && isRepeating(task) ? " Repeats stay with One offs, so it won't repeat." : ''}` : `Saved ${name}.`,
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
                  <span>{title}</span>
                  <span className="pen" aria-hidden="true">
                    <PenIcon />
                  </span>
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
          <LeavePopup.Provider value={leave}>{props.block}</LeavePopup.Provider>
          <EstimateSlider label="Time estimate" value={estimate} onChange={setEstimate} />
          <label className="popfield">
            Belongs to
            <select className="field" value={place} aria-describedby={note ? noteId : undefined} onChange={(event) => setPlace(event.target.value)}>
              {choices.map((p) => (
                <option key={p.value} value={p.value} disabled={repeats && !!p.goalId}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          {/* In the select's description, so it's heard as it appears and on returning to the select. */}
          <div id={noteId} className="small quiet" role="status">
            {note}
          </div>
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

// A task's popup: everything about one task, to read and change, opened by tapping the task wherever it shows, the same
// popup everywhere. A sheet on phone and a centred dialog on desktop. Top to bottom: its name, with what Process made of
// a finished Inbox item; then what can be done to it, which is that block's own section when a calendar opens it from a
// block, and Start now, Mark done and Schedule… anywhere else; then Time estimate, where it belongs, its dates,
// Description, Attachments, then Save, Cancel and Delete task. Where it opens from changes only which actions apply.
// Focus starts on the name, read as the heading, so the phone's keyboard stays down until a field is tapped. Save and
// Delete each offer Undo. The actions and attachments save as they go, each with its own Undo, rather than on Save. A
// goal's backlog is a place too: a task moved there loses its milestone and any date, and a repeating one off can't go.
// Its frame, PopupShell, is the one a practice's and a planning block's popups have too.

import { useEffect, useId, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { backlogGoal, backlogTitle, fileToBacklog, isBacklog } from '../../../core/backlog';
import { formatDate, formatWeekday, localDate } from '../../../core/dates';
import type { Sql } from '../../../core/db';
import { applyPlanChange } from '../../../core/plan';
import type { PlanChange } from '../../../core/plan';
import { getRecord, listRecords } from '../../../core/records';
import { isRepeating, onceWhen } from '../../../core/schedule';
import { closeTask } from '../../../core/tasks';
import type { Fields, LocalDate, Task, TaskCompletion } from '../../../core/types';
import type { ScreenProps } from '../../app/registry';
import { useApp, useMutation, useQuery, useToday } from '../../app/store';
import { Attachments } from '../../components/attachments/Attachments';
import { useLeave } from '../../components/editors/useLeave';
import { usePlanChange } from '../../components/editors/usePlanChange';
import { EstimateSlider } from '../../components/EstimateSlider';
import { NotesField } from '../../components/notes/NotesField';
import { draftOf } from '../../components/oneoff/draft';
import type { OneOffDraft } from '../../components/oneoff/draft';
import { SearchSelect } from '../../components/SearchSelect';
import { Sheet } from '../../components/Sheet';
import { Became } from '../../components/task/Became';
import { useToast } from '../../components/Toast';
import { datesError, datesFields, TaskDates } from './TaskDates';
import type { DatesFor } from './TaskDates';
import { TaskActions } from './TaskActions';
import { PopupShell } from './PopupShell';
import './task.css';
import { Button } from '../../components/ds/Button';

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

/** The task, the projects and open milestones it could move to, with wherever it is now, and its latest finish. */
async function loadTask(sql: Sql, id: string, zone: string) {
  const task = await getRecord(sql, 'task', id);
  if (!task) return { task, places: [], lastDone: null };
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
  // A new repeat counts from the latest finish, as One offs counts it.
  const finishes = await sql.all<TaskCompletion>('SELECT * FROM task_completion WHERE task_id = :task', { task: id });
  const lastDone = finishes.filter((c) => !c.deleted_at).map((c) => localDate(c.done_at, zone)).sort().pop() ?? null;
  return { task, places, lastDone };
}

/**
 * The fields that move a task to a place. Fields merge one by one, so each kind clears the others'. Its dates go as
 * the popup's dates say, a day or a range to a project, but a repeat stays with One offs, and the Inbox holds none.
 */
function moveFields(place: Place): Fields<'task'> {
  if (place.value === INBOX) return { kind: 'inbox', project_id: null, milestone_id: null, schedule: null, next_due: null };
  if (place.value === ONE_OFFS) return { kind: 'one_off', project_id: null, milestone_id: null };
  return { kind: 'project', project_id: place.projectId!, milestone_id: place.milestoneId ?? null, moved_from: null };
}

/** What a task's dates can be in a place. */
const datesFor = (place: string): DatesFor => (place === INBOX ? 'inbox' : place === ONE_OFFS ? 'one_off' : place.startsWith('b:') ? 'backlog' : 'project');

export default function Screen(props: ScreenProps) {
  return <TaskPopupFor id={props.params.task ?? ''} note={props.params.note} close={props.close} />;
}

/**
 * The popup, for a calendar that draws it itself, opened from one of its blocks: block is that block's section, whose
 * actions can reach back into the calendar, such as Move.
 */
export function TaskPopupFor(props: { id: string; note?: string | undefined; close(): void; block?: ReactNode }) {
  const { id, close } = props;
  const data = useQuery((sql, clock) => loadTask(sql, id, clock.zone()), [id]).data;
  // Deleted, here or on another device, it has nothing left to show.
  const gone = !!data && (!data.task || !!data.task.deleted_at);
  useEffect(() => {
    if (gone) close();
  }, [gone, close]);
  if (!data?.task || gone) return null;
  return <TaskPopup key={id} task={data.task} places={data.places} lastDone={data.lastDone} note={props.note} close={close} block={props.block} />;
}

/**
 * Delete task: it goes, and its blocks still to come come off the calendar, with Undo. `then` runs before the toast,
 * such as closing what it was pressed in, whose focus would otherwise return over Undo's. Resolves to whether it did.
 */
export function useDeleteTask() {
  const { clock } = useApp();
  const toast = useToast();
  const remove = useMutation((w, id: string) => closeTask(w, id, 'deleted', clock));
  const undo = useMutation((w, reverse: PlanChange) => applyPlanChange(w, reverse));
  return {
    pending: remove.pending,
    run: async (task: Pick<Task, 'id' | 'title'>, then?: () => void) => {
      const reverse = await remove.run(task.id);
      if (!reverse) return false;
      then?.();
      // The rows it was in lose it, so focus moves to Undo rather than the page.
      toast.show(`Deleted ${task.title}.`, { undo: () => undo.run(reverse), focusUndo: true });
      return true;
    },
  };
}

/** Delete task, asked first where the popup's Save and Cancel aren't there to show what goes, as from a block's menu. */
export function DeleteTask(props: { task: Pick<Task, 'id' | 'title'>; onClose(): void }) {
  const { task, onClose } = props;
  const { layout } = useApp();
  const remove = useDeleteTask();
  const id = useId();
  const btn = { className: layout === 'phone' ? 'grow' : undefined };
  return (
    <Sheet label={`Delete ${task.title}?`} describedBy={id} onClose={onClose}>
      <h2>Delete {task.title}?</h2>
      <p id={id}>Its blocks come off the calendar. You can undo this.</p>
      <div className="row">
        <Button {...btn} variant="destructive" filled icon="bin" type="button" disabled={remove.pending} onClick={() => void remove.run(task, onClose)}>
          Delete task
        </Button>
        <Button {...btn} type="button" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </Sheet>
  );
}

function TaskPopup(props: { task: Task; places: readonly Place[]; lastDone: LocalDate | null; note?: string | undefined; close(): void; block?: ReactNode }) {
  const { task, places, close } = props;
  const { layout, clock } = useApp();
  const today = useToday();
  const toast = useToast();
  const apply = usePlanChange();
  const remove = useDeleteTask();
  // Into a backlog, made if it's new, with any other edits in the same change.
  const file = useMutation(async (w, goalId: string, edits: Fields<'task'>) => {
    const edited = Object.keys(edits).length ? await applyPlanChange(w, { writes: [{ type: 'task', id: task.id, fields: edits }] }) : { writes: [] };
    const moved = await fileToBacklog(w, goalId, [task.id], clock);
    return { writes: [...moved.writes, ...edited.writes] };
  });
  const noteId = useId();
  const undo = useMutation((w, reverse: PlanChange) => applyPlanChange(w, reverse));
  const [title, setTitle] = useState(task.title);
  const [estimate, setEstimate] = useState(task.estimate_min ?? 0);
  const [place, setPlace] = useState(placeOf(task));
  const [notes, setNotes] = useState(task.notes ?? '');
  // Its dates and repeat, as the one off form holds them; only those fields of the draft are used.
  const [opened] = useState<OneOffDraft>(() => draftOf(task, today));
  const [draft, setDraft] = useState(opened);
  const [error, setError] = useState('');
  const phone = layout === 'phone';

  const name = title.trim();
  const notesValue = notes.trim() ? notes : null;
  const moved = place !== placeOf(task) ? places.find((p) => p.value === place) : undefined;
  const edits: Fields<'task'> = {
    ...(name !== task.title ? { title: name } : {}),
    ...((estimate || null) !== (task.estimate_min ?? null) ? { estimate_min: estimate || null } : {}),
    ...(notesValue !== (task.notes || null) ? { notes: notesValue } : {}),
  };
  const dates = datesFor(place);
  const fields: Fields<'task'> = {
    ...edits,
    ...(moved && !moved.goalId ? moveFields(moved) : {}),
    ...datesFields(dates, draft, opened, task, props.lastDone, today, !!moved),
    ...(moved?.goalId ? { project_id: moved.value } : {}),
  };
  // As the dates have it, so a repeat chosen here can't go to a backlog either.
  const repeats = draft.type !== 'once';
  const dated = moved?.goalId ? dateOf(task) : '';
  const note = repeats ? 'A repeating task stays in One offs. For regular time toward a goal, add a practice.' : dated ? `Backlog tasks have no date, so ${dated} will be cleared.` : '';
  const { saveRef, leave } = useLeave(Object.keys(fields).length > 0, close, setError);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!name) return setError('Give it a title.');
    const wrong = datesError(dates, draft);
    if (wrong) return setError(wrong);
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
      message: moved ? `Moved ${name} to ${moved.label}.${moved.projectId && repeats ? " Repeats stay with One offs, so it won't repeat." : ''}` : `Saved ${name}.`,
    });
    if (saved) close();
  };

  const deleteTask = () => void remove.run(task, close);

  const choices = places.some((p) => p.value === place) ? places : [{ value: place, label: 'Where it is now' }, ...places];
  return (
    <PopupShell
      label={task.title}
      name={title}
      rename={(name) => {
        setTitle(name);
        setError('');
      }}
      leave={leave}
      close={close}
      top={
        <>
          {props.note && <p className="small quiet">{props.note}</p>}
          {task.done_at && task.became && <Became became={task.became} onGo={close} />}
        </>
      }
      error={error}
      remove={{ label: 'Delete task', run: deleteTask }}
      save={{ ref: saveRef, submit: save }}
    >
      {props.block || <TaskActions task={task} />}
      <EstimateSlider label="Time estimate" value={estimate} onChange={setEstimate} />
      <SearchSelect
        className="popfield"
        label="Belongs to"
        phone={phone}
        value={place}
        options={choices.map((p) => ({ value: p.value, label: p.label, off: repeats && p.goalId ? 'Not for a repeating task' : undefined }))}
        placeholder="Search places"
        describedBy={note ? noteId : undefined}
        onChange={setPlace}
      />
      {/* In the field's description, so it's heard as it appears and on returning to the field. */}
      <div id={noteId} className="small quiet" role="status">
        {note}
      </div>
      <TaskDates
        kind={dates}
        draft={draft}
        said={!!note}
        put={(patch) => {
          setDraft((d) => ({ ...d, ...patch }));
          setError('');
        }}
      />
      <NotesField value={notes} onChange={setNotes} />
      <Attachments taskId={task.id} />
    </PopupShell>
  );
}

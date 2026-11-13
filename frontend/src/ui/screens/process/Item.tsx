// The item on Process's card, and everything the task popup can change about it, changed where it shows: the title in
// place behind its pencil, its date in the app's date form, the description in the popup's own field, links and photos,
// and Time. Empty ones are
// buttons in a row; filled ones show their value. Each saves when it's finished, through the card, which keeps the
// reverse so one Undo puts the item back as it arrived.

import { useId, useState } from 'react';
import type { FormEvent, ReactNode, RefObject } from 'react';
import { MAX_TITLE } from '../../../core/captureTitle';
import { onceWhen, setOnceDates } from '../../../core/schedule';
import type { RecordWrite } from '../../../core/plan';
import { taskAttachments } from '../../../core/queries';
import type { Fields, Task } from '../../../core/types';
import { useQuery } from '../../app/store';
import { Attachments } from '../../components/attachments/Attachments';
import { CalendarIcon, NotesIcon, PenIcon } from '../../components/icons';
import { NotesField } from '../../components/notes/NotesField';
import { OneOffDateForm } from '../../components/oneoff';

/** What on the card is open to change. */
export type Editing = 'title' | 'date' | 'notes' | null;

const number = new Intl.NumberFormat('en-US');
/** The key that saves a description, as its field takes it. */
const saveNotesKey = () => (/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘↩' : 'Ctrl ↩');

export function Item(props: {
  task: Task;
  phone: boolean;
  editing: Editing;
  setEditing(editing: Editing): void;
  titleRef: RefObject<HTMLElement | null>;
  dateRef: RefObject<HTMLButtonElement | null>;
  /** Whether its date came with it, rather than being set here. */
  dated: boolean;
  /** Saves fields on the item. True once saved. */
  save(fields: Fields<'task'>): Promise<boolean>;
  /** An attachment added or removed, by its exact reverse. */
  onAttachment(reverse: RecordWrite): void;
  /** A key's cap, on desktop. */
  cap(key: string): ReactNode;
  slider: ReactNode;
  /** Last on the phone's card: the week toggle. */
  children?: ReactNode;
}) {
  const { task, phone, editing, setEditing } = props;
  const count = useQuery((sql) => taskAttachments(sql, task.id), [task.id]).data?.length ?? 0;
  const [notes, setNotes] = useState('');
  const hint = useId();
  const btn = phone ? 'btn pxchip' : 'btn sm pxchip';
  const plainCap = (k: string) =>
    !phone && (
      <kbd className="keycap" aria-hidden="true">
        {k}
      </kbd>
    );

  const openNotes = () => {
    setNotes(task.notes ?? '');
    setEditing('notes');
  };
  const saveNotes = async () => {
    if (await props.save({ notes: notes.trim() ? notes : null })) setEditing(null);
  };

  const once = task.schedule?.type === 'once' && task.schedule.from ? task.schedule : null;
  const when = once ? onceWhen(once) : '';
  // First under the title on every item, then the date itself once it has one.
  const dateChip = (
    <button
      ref={props.dateRef}
      className={`${btn} date${once ? ' set' : ''}`}
      type="button"
      aria-expanded={editing === 'date'}
      aria-label={once ? `Change date, ${when}` : undefined}
      onClick={() => setEditing(editing === 'date' ? null : 'date')}
    >
      <CalendarIcon />
      {once ? (
        <>
          {when}
          <span className="quiet">· Change</span>
        </>
      ) : (
        'Add date'
      )}
    </button>
  );
  const dateForm = editing === 'date' && (
    <div className="pxdateform">
      <OneOffDateForm task={task} commit={(from, to) => props.save(setOnceDates(from, to))} onClose={() => setEditing(null)} />
    </div>
  );
  const dateNote = once && props.dated && <span className="pxdatenote">It came with this date.</span>;

  const heading = (
    <div className="pxhead">
      <h1 className="pxtitle" aria-live="polite">
        <button ref={props.titleRef as RefObject<HTMLButtonElement>} className="pxedit" type="button" aria-describedby={hint} onClick={() => setEditing('title')}>
          <span>{task.title}</span>
          <span className="pen" aria-hidden="true">
            <PenIcon />
          </span>
        </button>
      </h1>
      <span id={hint} hidden>
        Edit title
      </span>
      {props.cap('E')}
    </div>
  );
  const title = editing === 'title' ? <TitleForm title={task.title} phone={phone} cap={plainCap} onSave={(title) => props.save({ title })} onClose={() => setEditing(null)} /> : heading;
  const adds = (
    <>
      {!task.notes && editing !== 'notes' && (
        <button className={btn} type="button" onClick={openNotes}>
          <NotesIcon />
          Add description
        </button>
      )}
      {count === 0 && <Attachments taskId={task.id} inline onWrite={props.onAttachment} />}
    </>
  );
  const description = (task.notes || editing === 'notes') && (
    <div className="pxnotes stack8">
      <NotesField value={editing === 'notes' ? notes : (task.notes ?? '')} editing={editing === 'notes'} onEdit={openNotes} onChange={setNotes} onSubmit={() => void saveNotes()} />
      {editing === 'notes' && (
        <div className="row">
          <button className={phone ? 'btn pri grow' : 'btn sm pri'} type="button" onClick={() => void saveNotes()}>
            Save
            {plainCap(saveNotesKey())}
          </button>
          <button className={phone ? 'btn grow' : 'btn sm'} type="button" onClick={() => setEditing(null)}>
            Cancel
            {plainCap('esc')}
          </button>
        </div>
      )}
    </div>
  );
  const attachments = count > 0 && <Attachments taskId={task.id} onWrite={props.onAttachment} />;

  if (phone) {
    return (
      <div className="card stack pxitem">
        {title}
        {once && dateChip}
        {dateNote}
        {dateForm}
        <div className="pxfour">
          {!once && dateChip}
          {adds}
        </div>
        {description}
        {attachments}
        {props.slider}
        {props.children}
      </div>
    );
  }
  return (
    <div className="pxitem">
      {title}
      <div className="pxfacts">
        {dateChip}
        {adds}
        {props.slider}
      </div>
      {dateNote}
      {dateForm}
      {(description || attachments) && (
        <div className="pxdetails">
          {description}
          {attachments}
        </div>
      )}
    </div>
  );
}

/** The title as a field of its own size: Enter or Save keeps it, Esc or Cancel puts the old one back. */
function TitleForm(props: { title: string; phone: boolean; cap(key: string): ReactNode; onSave(title: string): Promise<boolean>; onClose(): void }) {
  const { phone } = props;
  const [title, setTitle] = useState(props.title);
  const [error, setError] = useState('');
  const save = async (event: FormEvent) => {
    event.preventDefault();
    const name = title.trim();
    if (!name) return setError('Give it a title.');
    if (name === props.title || (await props.onSave(name))) props.onClose();
  };
  return (
    <form className="stack8 pxtitleform" aria-label="Edit title" onSubmit={save} noValidate>
      <input
        className="pxtitlefield"
        aria-label="Title"
        maxLength={MAX_TITLE}
        autoFocus
        // The caret at the end, to add to it.
        onFocus={(event) => event.currentTarget.setSelectionRange(title.length, title.length)}
        value={title}
        onChange={(event) => {
          setTitle(event.target.value);
          setError('');
        }}
      />
      {error && (
        <div className="fielderr" role="alert">
          {error}
        </div>
      )}
      <div className="row">
        <button className={phone ? 'btn pri grow' : 'btn sm pri'} type="submit">
          Save
          {props.cap('↩')}
        </button>
        <button className={phone ? 'btn grow' : 'btn sm'} type="button" onClick={props.onClose}>
          Cancel
          {props.cap('esc')}
        </button>
        {!phone && <span className="small quiet">{`Up to ${number.format(MAX_TITLE)} characters.`}</span>}
      </div>
    </form>
  );
}

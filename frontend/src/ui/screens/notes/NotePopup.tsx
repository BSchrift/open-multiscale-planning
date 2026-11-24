// A note's popup, laid out as a task's: its name as a heading, then Belongs to, Show it on Today on, Description and
// Attachments, a line on where notes are kept, and Delete note, Cancel and Save. Only Delete note acts at once, and
// attachments, which are added and removed as they go with Undo, as on a task. Belongs to is a search over goals,
// projects and practices, with Notes on its own first and Inbox, which makes the note a task again on Save, last: under
// the field on desktop, in a sheet on phone.

import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { MAX_TITLE } from '../../../core/captureTitle';
import { formatDate } from '../../../core/dates';
import { deleteNote, editNote, toTask } from '../../../core/memos';
import type { NoteEdit } from '../../../core/memos';
import { applyPlanChange } from '../../../core/plan';
import type { PlanChange } from '../../../core/plan';
import { getRecord } from '../../../core/records';
import type { Memo } from '../../../core/types';
import { useApp, useMutation, useQuery, useToday } from '../../app/store';
import { Attachments } from '../../components/attachments/Attachments';
import { useLeave } from '../../components/editors/useLeave';
import { NotesField } from '../../components/notes/NotesField';
import { Sheet } from '../../components/Sheet';
import { useToast } from '../../components/Toast';
import { Button } from '../../components/ds/Button';
import { Icon } from '../../components/ds/Icon';
import '../task/task.css';
import { HomeList, homeKey, useHomes } from './HomePicker';
import type { HomeOption } from './HomePicker';

const ON_ITS_OWN: HomeOption = { key: 'own', label: 'Notes', type: 'On its own', home: null };
const INBOX: HomeOption = { key: 'inbox', label: 'Inbox', type: 'Make it a task', home: null, inbox: true };

/** close's refocus is false once the note has left where it was opened from, as after Delete note, for Undo to take focus. */
export function NotePopup(props: { id: string; close(refocus?: boolean): void }) {
  const { id, close } = props;
  const memo = useQuery((sql) => getRecord(sql, 'memo', id), [id]).data;
  const loaded = memo !== undefined;
  // Deleted, here or on another device, it has nothing left to show.
  const gone = loaded && (!memo || !!memo.deleted_at);
  useEffect(() => {
    if (gone) close(false);
  }, [gone, close]);
  if (!memo || gone) return null;
  return <Popup key={id} memo={memo} close={close} />;
}

function Popup(props: { memo: Memo; close(refocus?: boolean): void }) {
  const { memo, close } = props;
  const { layout, clock } = useApp();
  const toast = useToast();
  const phone = layout === 'phone';
  const [title, setTitle] = useState(memo.title);
  const [renaming, setRenaming] = useState(false);
  const homes = useHomes();
  const day = useToday();
  const homeAt = homeKey(memo.home);
  const [belongs, setBelongs] = useState<HomeOption | null>(null);
  const [picking, setPicking] = useState(false);
  const [showOn, setShowOn] = useState(memo.show_on ?? '');
  const [body, setBody] = useState(memo.body ?? '');
  const [error, setError] = useState('');
  const head = useRef<HTMLHeadingElement>(null);
  const belongsRef = useRef<HTMLButtonElement>(null);
  const ids = { belongs: useId(), value: useId() };
  const save = useMutation((w, fields: NoteEdit) => editNote(w, memo.id, fields));
  const makeTask = useMutation((w, fields: { title: string; body: string | null }) => toTask(w, memo.id, fields, clock));
  const remove = useMutation((w) => deleteNote(w, memo.id, clock));
  const undo = useMutation((w, reverse: PlanChange) => applyPlanChange(w, reverse));

  // After the dialog takes focus, which its own effect does first.
  useEffect(() => head.current?.focus(), []);

  const name = title.trim();
  const bodyValue = body.trim() ? body : null;
  // Where it is now: its home, or Notes on its own when it has none, or one that's finished or gone.
  const current: HomeOption = belongs ?? homes?.find((o) => o.key === homeAt) ?? ON_ITS_OWN;
  const toInbox = current.inbox === true;
  const edits: NoteEdit = {
    ...(name !== memo.title ? { title: name } : {}),
    ...(bodyValue !== (memo.body || null) ? { body: bodyValue } : {}),
    ...(belongs && !toInbox && belongs.key !== homeAt ? { home: belongs.home } : {}),
    ...((showOn || null) !== (memo.show_on ?? null) ? { show_on: showOn || null } : {}),
  };
  const changed = Object.keys(edits).length > 0 || toInbox;
  const { saveRef, leave } = useLeave(changed, close, setError);
  const closePicking = () => {
    setPicking(false);
    requestAnimationFrame(() => belongsRef.current?.focus());
  };
  const choose = (option: HomeOption) => {
    setBelongs(option);
    setError('');
    closePicking();
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name) return setError('Give it a title.');
    if (toInbox) {
      const made = await makeTask.run({ title: name, body: bodyValue });
      if (!made) return;
      close(false);
      // The note leaves the list it was in, so focus moves to Undo rather than the page.
      toast.show(`Moved ${name} to your Inbox.`, { undo: () => undo.run(made.reverse), focusUndo: true });
      return;
    }
    if (!changed) return close();
    const reverse = await save.run(edits);
    if (!reverse) return;
    close();
    toast.show(`Saved ${name}.`, { undo: () => undo.run(reverse) });
  };

  const deleteIt = async () => {
    const reverse = await remove.run();
    if (!reverse) return;
    close(false);
    toast.show(`Deleted ${memo.title}.`, { undo: () => undo.run(reverse), focusUndo: true });
  };

  const share = typeof navigator.share === 'function' && (
    <Button size="compact" type="button" onClick={() => void navigator.share({ title: name, text: bodyValue ? `${name}\n\n${bodyValue}` : name }).catch(() => undefined)}>
      Share…
    </Button>
  );

  return (
    <Sheet label={`Note: ${memo.title}`} className="taskpop notepop" onClose={() => (picking ? closePicking() : leave())}>
      {/* On phone, Belongs to searches in the sheet itself, full height, its field at the top, and Close goes back. */}
      {picking && phone && homes && (
        <div className="nbelongsview stack8">
          <div className="between">
            <h2>Belongs to</h2>
            <Button type="button" onClick={closePicking}>
              Close
            </Button>
          </div>
          <HomeList label="Belongs to" homes={homes} first={[ON_ITS_OWN]} last={[INBOX]} value={current.key} onChoose={choose} onCancel={closePicking} />
        </div>
      )}
      <form className="taskpopform" onSubmit={submit} noValidate hidden={picking && phone}>
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
                    <Icon name="pen" />
                  </span>
                </button>
              </h2>
            )}
            {!phone && (
              <button className="taskpopclose" type="button" aria-label="Close" onClick={leave}>
                <Icon name="close" />
              </button>
            )}
          </div>
          <p className="small quiet">{memo.saved_on ? `Note · saved ${formatDate(memo.saved_on)}` : 'Note'}</p>
        </div>
        <div className="taskpopbody">
          <div className="popfield">
            <span id={ids.belongs}>Belongs to</span>
            {picking && !phone && homes ? (
              <div className="nbelongs">
                <HomeList label="Belongs to" homes={homes} first={[ON_ITS_OWN]} last={[INBOX]} value={current.key} onChoose={choose} onCancel={closePicking} />
              </div>
            ) : (
              <button
                ref={belongsRef}
                className="pkfield"
                type="button"
                aria-haspopup={phone ? 'dialog' : 'listbox'}
                aria-expanded={phone ? undefined : false}
                aria-labelledby={`${ids.belongs} ${ids.value}`}
                onClick={() => setPicking(true)}
              >
                <Icon name="search" size={16} />
                <span className="pkval" id={ids.value}>
                  <span className="strong">{current.label}</span>
                  {current.type && (
                    <>
                      {' '}
                      <span className="pkgoal">· {current.type}</span>
                    </>
                  )}
                </span>
              </button>
            )}
          </div>
          {!toInbox && (
            <label className="popfield">
              <span>
                Show it on Today on <span className="quiet">(optional)</span>
              </span>
              <input className="field" type="date" min={day} value={showOn} onChange={(event) => setShowOn(event.target.value)} />
            </label>
          )}
          <NotesField value={body} onChange={setBody} />
          <Attachments memoId={memo.id} />
          {share && <div className="row">{share}</div>}
          <p className="small quiet">
            Notes are stored on your devices and, once you sign in, on Amazon Web Services, encrypted there but not end to end. Use a password manager
            for passwords and codes.
          </p>
          {error && (
            <div className="fielderr" role="alert">
              {error}
            </div>
          )}
        </div>
        <div className="taskpopbar">
          <button className="link taskpopdelete" type="button" onClick={deleteIt}>
            Delete note
          </button>
          <Button type="button" onClick={() => close()}>
            Cancel
          </Button>
          <Button ref={saveRef} variant="primary" type="submit">
            Save
          </Button>
        </div>
      </form>
    </Sheet>
  );
}

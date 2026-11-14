// What's waiting in the Inbox, in added order, as rows of one card. The whole row opens the item's popup, to change it
// or write its description; its pencil renames it in the row; and Assign on desktop, or › on phone, opens Process on it. Select ticks many
// items and gives them all a home at once, so a long Inbox takes a few actions rather than a card each. The Inbox and
// planning's Inbox step show it.

import { useRef, useState } from 'react';
import type { FormEvent, MouseEvent } from 'react';
import { MAX_TITLE } from '../../../core/captureTitle';
import { formatMinutes } from '../../../core/dates';
import type { InboxRow } from '../../../core/queries';
import type { Fields } from '../../../core/types';
import { useMutation } from '../../app/store';
import { ChevronIcon, PenIcon } from '../icons';
import { TaskName, useOpenTask } from '../task/TaskName';
import { useToast } from '../Toast';
import { useFocusLanding } from '../useFocusLanding';
import { SelectBar } from './SelectBar';
import './inbox.css';

export function InboxList(props: { rows: readonly InboxRow[]; phone: boolean; onOpen(id: string): void }) {
  const { rows, phone, onOpen } = props;
  const land = useFocusLanding();
  const [selecting, setSelecting] = useState(false);
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const [renaming, setRenaming] = useState<string | null>(null);
  const top = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const openTask = useOpenTask();
  const toast = useToast();
  const rename = useMutation((w, id: string, fields: Fields<'task'>) => w.set('task', id, fields));
  if (rows.length === 0) return null;

  const pen = (id: string) => () => list.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"] .rowpen`);
  // Anywhere on the row opens the popup, as its name does; its own buttons do their own thing.
  const openRow = (event: MouseEvent, id: string) => {
    if (!(event.target as Element).closest('button, input, a, form')) openTask(id);
  };
  /** Back to the row, focus on its pencil, renamed or not. */
  const stopRenaming = (id: string) => {
    land(pen(id));
    setRenaming(null);
  };
  const saveName = async (i: InboxRow, title: string) => {
    const previous = await rename.run(i.id, { title });
    if (!previous) return;
    stopRenaming(i.id);
    toast.show(`Renamed to ${title}.`, { undo: () => rename.run(i.id, previous) });
  };

  // Only items still in the Inbox count, so one given a home elsewhere meanwhile drops out.
  const selected = rows.filter((i) => ticked.has(i.id));
  const tick = (id: string) =>
    setTicked((now) => {
      const next = new Set(now);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  // Nothing is written while selecting, so leaving only forgets the ticks.
  const leave = () => {
    setSelecting(false);
    setTicked(new Set());
  };
  const toggle = () => top.current?.querySelector<HTMLElement>('[data-toggle]');
  // A tap on phone WebKit focuses the page around a button rather than the button, so focus is put on it.
  const toggleSelect = () => {
    land(toggle);
    if (selecting) leave();
    else setSelecting(true);
  };
  /** Once the action has saved: focus the item after the first one gone, or Select. With none left, Undo takes it. */
  const done = (gone: readonly string[]) => {
    const at = rows.findIndex((i) => gone.includes(i.id));
    const next = rows.slice(at).find((i) => !gone.includes(i.id));
    const row = () => [...(list.current?.querySelectorAll<HTMLElement>('[data-id]') ?? [])].find((el) => el.dataset.id === next?.id);
    if (rows.some((i) => !gone.includes(i.id))) land(() => row()?.querySelector('button') ?? toggle());
    leave();
  };

  return (
    <>
      <div ref={top} className={selecting ? 'inboxsel' : undefined}>
        <div className="inboxbar">
          {selecting && (
            <>
              <button className="link" type="button" onClick={() => setTicked(new Set(rows.map((i) => i.id)))}>
                Select all
              </button>
              <span className="inboxcount" role="status">
                {selected.length} selected
              </span>
            </>
          )}
          {/* One button that changes its words, so focus stays on it either way. */}
          <button className="link inboxtoggle" type="button" data-toggle onClick={toggleSelect}>
            {selecting ? 'Cancel' : 'Select'}
          </button>
        </div>
        {selecting && <SelectBar selected={selected} total={rows.length} phone={phone} onDone={done} />}
      </div>
      <div ref={list} className="card inboxlist">
        {rows.map((i) => {
          const est = i.estimate_min ? `${formatMinutes(i.estimate_min)} estimate` : null;
          // While selecting, the whole row is the checkbox's label.
          if (selecting) {
            return (
              <label key={i.id} className={`inboxrow inboxtick${phone ? ' phone' : ''}`} data-id={i.id}>
                <input type="checkbox" aria-label={i.title} checked={ticked.has(i.id)} onChange={() => tick(i.id)} />
                <span className="inboxlines">
                  <span className="rowname">{i.title}</span>
                  {est && <span className="small quiet">{est}</span>}
                </span>
              </label>
            );
          }
          if (renaming === i.id) {
            return (
              <div key={i.id} className={`inboxrow renaming${phone ? ' phone' : ''}`} data-id={i.id}>
                <RenameField title={i.title} phone={phone} onSave={(title) => saveName(i, title)} onCancel={() => stopRenaming(i.id)} />
              </div>
            );
          }
          // The name, its estimate and the icons are cells of one grid, so the icons centre on the name's line, not on
          // the name and estimate together.
          const name = <TaskName id={i.id} title={i.title} details={!!i.has_notes} className={phone ? 'rowname inboxname' : 'rowname'} />;
          const estimate = est && <span className="small quiet inboxest">{est}</span>;
          const pencil = (
            <button className="rowpen" type="button" aria-label={`Rename ${i.title}`} title="Rename" onClick={() => setRenaming(i.id)}>
              <PenIcon />
            </button>
          );
          return phone ? (
            <div key={i.id} className="inboxrow phone whole" data-id={i.id} onClick={(event) => openRow(event, i.id)}>
              {name}
              {estimate}
              {pencil}
              <button className="inboxgo" type="button" aria-label={`Process ${i.title}`} onClick={() => onOpen(i.id)}>
                <ChevronIcon />
              </button>
            </div>
          ) : (
            <div key={i.id} className="inboxrow whole" data-id={i.id} onClick={(event) => openRow(event, i.id)}>
              <div className="rowmain">
                {name}
                {estimate}
                {pencil}
              </div>
              <button className="btn sm" type="button" aria-label={`Assign ${i.title}`} onClick={() => onOpen(i.id)}>
                Assign
              </button>
            </div>
          );
        })}
      </div>
    </>
  );
}

/** An item's title as a field in its row: Enter or Save keeps it, Esc or Cancel puts the old one back. */
function RenameField(props: { title: string; phone: boolean; onSave(title: string): void; onCancel(): void }) {
  const [title, setTitle] = useState(props.title);
  const btn = props.phone ? 'btn grow' : 'btn sm';
  const save = (event: FormEvent) => {
    event.preventDefault();
    const name = title.trim();
    if (!name || name === props.title) return props.onCancel();
    props.onSave(name);
  };
  return (
    <form
      className="inboxrename"
      aria-label={`Rename ${props.title}`}
      onSubmit={save}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        props.onCancel();
      }}
    >
      <input
        className="field"
        aria-label="Title"
        maxLength={MAX_TITLE}
        autoFocus
        // The caret at the end, to add to it.
        onFocus={(event) => event.currentTarget.setSelectionRange(title.length, title.length)}
        value={title}
        onChange={(event) => setTitle(event.target.value)}
      />
      <div className="row">
        <button className={`${btn} pri`} type="submit">
          Save
        </button>
        <button className={btn} type="button" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

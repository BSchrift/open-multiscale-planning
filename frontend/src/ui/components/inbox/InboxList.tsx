// What's waiting in the Inbox, in added order, as rows of one card. Each item's name opens its popup, to change it or
// write its description, and beside it Assign on desktop, or › on phone, opens Process on the item. Select ticks many
// items and gives them all a home at once, so a long Inbox takes a few actions rather than a card each. The Inbox and
// planning's Inbox step show it.

import { useRef, useState } from 'react';
import { formatMinutes } from '../../../core/dates';
import type { InboxRow } from '../../../core/queries';
import { TaskName } from '../task/TaskName';
import { useFocusLanding } from '../useFocusLanding';
import { SelectBar } from './SelectBar';
import './inbox.css';

export function InboxList(props: { rows: readonly InboxRow[]; phone: boolean; onOpen(id: string): void }) {
  const { rows, phone, onOpen } = props;
  const land = useFocusLanding();
  const [selecting, setSelecting] = useState(false);
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const top = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  if (rows.length === 0) return null;

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
          return phone ? (
            <div key={i.id} className="inboxrow phone" data-id={i.id}>
              <TaskName id={i.id} title={i.title} details={!!i.has_notes} className="rowname inboxname" />
              {est && <span className="small quiet inboxest">{est}</span>}
              <button className="inboxgo" type="button" aria-label={`Process ${i.title}`} onClick={() => onOpen(i.id)}>
                <span className="chev" aria-hidden="true">
                  ›
                </span>
              </button>
            </div>
          ) : (
            <div key={i.id} className="inboxrow" data-id={i.id}>
              <div className="inboxlines">
                <TaskName id={i.id} title={i.title} details={!!i.has_notes} className="rowname" />
                {est && <span className="small quiet">{est}</span>}
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

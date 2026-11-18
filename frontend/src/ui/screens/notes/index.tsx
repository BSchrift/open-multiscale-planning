// Notes: the things saved from the Inbox to look up or remember, never to do. Led by a search over titles and
// descriptions that ignores case and accents and underlines what matched; then every note by month, newest first, 100 at
// a time; then Recently deleted, closed, where a deleted note waits 30 days. A note opens in its popup. Nothing here is
// counted, badged or due, and notes arrive only through Process.

import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { addDays, formatDate, localDate, today } from '../../../core/dates';
import { foldMatches, restore, searchNotes } from '../../../core/memos';
import { applyPlanChange } from '../../../core/plan';
import type { PlanChange } from '../../../core/plan';
import { deletedNotes, notesList } from '../../../core/queries';
import type { NoteRow } from '../../../core/queries';
import type { ScreenProps } from '../../app/registry';
import { useApp, useMutation, useQuery } from '../../app/store';
import { useToast } from '../../components/Toast';
import { Button } from '../../components/ds/Button';
import { Icon } from '../../components/ds/Icon';
import { NotePopup } from './NotePopup';
import './notes.css';

const PAGE = 100;
/** How long after typing stops the count is spoken. */
const SAY_MS = 400;

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** "Saved Nov 12 · 1 photo · 2 links". */
export function savedLine(note: NoteRow): string {
  const bits = [note.saved_on ? `Saved ${formatDate(note.saved_on)}` : 'Saved'];
  if (note.photos) bits.push(plural(note.photos, 'photo'));
  if (note.links) bits.push(plural(note.links, 'link'));
  if (note.files) bits.push(plural(note.files, 'file'));
  return bits.join(' · ');
}

/** The first line of a description, cut to about 120 characters. */
function firstLine(body: string | null): string {
  const line = (body ?? '').split('\n').find((l) => l.trim()) ?? '';
  return line.length > 120 ? `${line.slice(0, 119).trimEnd()}…` : line;
}

/** Text with what was searched for underlined. */
function Marked(props: { text: string; term: string }) {
  const parts: ReactNode[] = [];
  let at = 0;
  for (const [start, end] of foldMatches(props.text, props.term)) {
    parts.push(props.text.slice(at, start), <mark key={start}>{props.text.slice(start, end)}</mark>);
    at = end;
  }
  parts.push(props.text.slice(at));
  return <>{parts}</>;
}

const monthOf = (date: string, thisYear: string) => {
  const name = new Date(`${date.slice(0, 7)}-01T00:00:00Z`).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
  return date.slice(0, 4) === thisYear ? name : `${name} ${date.slice(0, 4)}`;
};

/** A note's row: read as its title, with its first line and Saved line as its description. */
function Row(props: { note: NoteRow; term: string; onOpen(el: HTMLButtonElement): void; rowRef?: (el: HTMLButtonElement | null) => void }) {
  const { note, term } = props;
  const id = useId();
  const line = firstLine(note.body);
  return (
    <button
      ref={props.rowRef}
      className="nrow"
      type="button"
      aria-labelledby={`${id}t`}
      aria-describedby={`${line ? `${id}b ` : ''}${id}m`}
      onClick={(event) => props.onOpen(event.currentTarget)}
    >
      <span className="nmark">
        <Icon name="note" />
      </span>
      <span className="nwhat">
        <span className="ntitle" id={`${id}t`}>
          <Marked text={note.title} term={term} />
        </span>
        {line && (
          <span className="nbody" id={`${id}b`}>
            <Marked text={line} term={term} />
          </span>
        )}
        <span className="nmeta" id={`${id}m`}>
          {savedLine(note)}
        </span>
      </span>
    </button>
  );
}

export default function Screen(props: ScreenProps) {
  const { layout } = props;
  const phone = layout === 'phone';
  const { clock } = useApp();
  const toast = useToast();
  const ids = { search: useId(), help: useId(), all: useId(), deleted: useId() };
  const notes = useQuery((sql) => notesList(sql), []).data;
  const deleted = useQuery((sql) => deletedNotes(sql), []).data ?? [];
  const [query, setQuery] = useState('');
  const [said, setSaid] = useState('');
  const [shown, setShown] = useState(PAGE);
  const [binOpen, setBinOpen] = useState(false);
  const [open, setOpen] = useState<{ id: string; opener: HTMLElement | null } | null>(null);
  const firstNew = useRef<string | null>(null);
  const rows = useRef(new Map<string, HTMLButtonElement>());
  const bring = useMutation((w, id: string) => restore(w, id));
  const undo = useMutation((w, reverse: PlanChange) => applyPlanChange(w, reverse));

  const term = query.trim();
  const hits = notes ? searchNotes(notes, term) : [];
  const listed = hits.slice(0, shown);
  const more = hits.length - listed.length;

  // The count is spoken once typing stops, from one place outside the list.
  useEffect(() => {
    if (!term) return;
    const timer = setTimeout(() => setSaid(hits.length ? `${plural(hits.length, 'note')} ${hits.length === 1 ? 'matches' : 'match'} “${term}”` : `No notes match “${term}”.`), SAY_MS);
    return () => clearTimeout(timer);
  }, [term, hits.length]);
  // Show 100 more takes focus to the first row it adds.
  useEffect(() => {
    const id = firstNew.current;
    if (!id) return;
    firstNew.current = null;
    rows.current.get(id)?.focus();
  });

  const search = (text: string) => {
    setQuery(text);
    setShown(PAGE);
    if (!text.trim()) setSaid('');
  };
  const onSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Escape' || !query) return;
    // Clears the search rather than leaving the page.
    event.preventDefault();
    event.stopPropagation();
    search('');
    setSaid('Showing all notes');
  };
  const restoreNote = async (note: NoteRow) => {
    const reverse = await bring.run(note.id);
    if (!reverse) return;
    toast.show(`Restored ${note.title}.`, { undo: () => undo.run(reverse), focusUndo: true });
  };

  const thisYear = today(clock).slice(0, 4);
  const opener = (note: NoteRow) => (el: HTMLButtonElement) => setOpen({ id: note.id, opener: el });
  const rowRef = (id: string) => (el: HTMLButtonElement | null) => void (el ? rows.current.set(id, el) : rows.current.delete(id));
  const list = (items: readonly NoteRow[]) => (
    <ul className="card nlist">
      {items.map((note) => (
        <li key={note.id}>
          <Row note={note} term={term} onOpen={opener(note)} rowRef={rowRef(note.id)} />
        </li>
      ))}
    </ul>
  );
  // By month of saving, newest first, each a heading of its own.
  const months: { label: string; items: NoteRow[] }[] = [];
  for (const note of listed) {
    const label = note.saved_on ? monthOf(note.saved_on, thisYear) : 'Earlier';
    const last = months.at(-1);
    if (last?.label === label) last.items.push(note);
    else months.push({ label, items: [note] });
  }
  const text = phone ? 'small' : undefined;

  return (
    <div className={phone ? 'stack16 notespage' : 'wrap stack16 notespage'}>
      <h1>Notes</h1>
      <div className="notesearchwrap" role="search">
        <div className="notesearch">
          <Icon name="search" />
          <input
            id={ids.search}
            type="search"
            aria-label="Search notes"
            aria-describedby={ids.help}
            placeholder="Search notes"
            autoComplete="off"
            value={query}
            onChange={(event) => search(event.target.value)}
            onKeyDown={onSearchKey}
          />
        </div>
        <p id={ids.help} className="small quiet">
          Finds words in titles and descriptions, ignoring case and accents.
        </p>
      </div>
      <p className={`quiet${phone ? ' small' : ''}`}>Things to look up or remember. Nothing here is due or ticked.</p>
      <div className="sr" role="status" aria-live="polite">
        {said}
      </div>
      {notes && notes.length === 0 && (
        <p className={text}>No notes yet. In Process, Save as note keeps an Inbox item here, with what you wrote and attached.</p>
      )}
      {term ? (
        <section className="stack8" aria-label="Search results">
          <p className={text}>{hits.length ? `${plural(hits.length, 'note')} ${hits.length === 1 ? 'matches' : 'match'} “${term}”` : `No notes match “${term}”.`}</p>
          {listed.length > 0 && list(listed)}
        </section>
      ) : (
        notes &&
        notes.length > 0 && (
          <section className="stack8" aria-labelledby={ids.all}>
            <h2 id={ids.all}>
              All notes
            </h2>
            {months.map((m) => (
              <div key={m.label} className="stack8">
                <h3 className="nmonth">{m.label}</h3>
                {list(m.items)}
              </div>
            ))}
          </section>
        )
      )}
      {more > 0 && (
        <div>
          <Button
            size="compact"
            type="button"
            onClick={() => {
              firstNew.current = hits[shown]?.id ?? null;
              setShown(shown + PAGE);
            }}
          >
            {`Show ${Math.min(PAGE, more)} more`}
          </Button>
        </div>
      )}
      {deleted.length > 0 && (
        <div className="card nbin">
          <button className="ndisc" type="button" aria-expanded={binOpen} aria-controls={ids.deleted} onClick={() => setBinOpen(!binOpen)}>
            <Icon name={binOpen ? 'chevron-down' : 'chevron-right'} size={16} />
            <span className="strong">Recently deleted</span>
            <span className="small quiet">{deleted.length}</span>
          </button>
          {binOpen && (
            <ul id={ids.deleted} className="nlist">
              {deleted.map((note) => {
                const day = note.deleted_at ? localDate(note.deleted_at, clock.zone()) : today(clock);
                return (
                  <li key={note.id} className="nrow ngone">
                    <span className="nmark">
                      <Icon name="note" />
                    </span>
                    <span className="nwhat">
                      <span className="ntitle">{note.title}</span>
                      <span className="nmeta">{`Deleted ${formatDate(day)} · gone after ${formatDate(addDays(day, 30))}`}</span>
                    </span>
                    <Button size="compact" type="button" aria-label={`Restore ${note.title}`} onClick={() => void restoreNote(note)}>
                      Restore
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
      {open && (
        <NotePopup
          id={open.id}
          close={(refocus = true) => {
            const back = open.opener;
            setOpen(null);
            // Back to the row that opened it, after Save or Cancel. A note deleted or made a task has left the list, and
            // its toast's Undo takes focus.
            if (refocus) requestAnimationFrame(() => back?.isConnected && back.focus());
          }}
        />
      )}
    </div>
  );
}

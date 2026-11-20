// A note's row, read as its title with its first line and saved line as its description, and a list of them that opens
// each in its popup: Notes draws the rows, and the places a note's home shows it draw the list.

import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import { formatDate } from '../../../core/dates';
import { foldMatches } from '../../../core/memos';
import { notesForDay, notesList } from '../../../core/queries';
import type { NoteRow } from '../../../core/queries';
import type { LocalDate, MemoHome, Objective } from '../../../core/types';
import { useQuery, useToday } from '../../app/store';
import { Icon } from '../../components/ds/Icon';
import { homeKey, useHomeNames } from './HomePicker';
import { NotePopup } from './NotePopup';
import './notes.css';

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** "Saved Nov 12 · 1 photo · Kitchen redo · On Today Nov 20": its home when it has one, and a day to come on Today. */
export function savedLine(note: NoteRow, homes?: ReadonlyMap<string, string>, today?: LocalDate): string {
  const bits = [note.saved_on ? `Saved ${formatDate(note.saved_on)}` : 'Saved'];
  if (note.photos) bits.push(plural(note.photos, 'photo'));
  if (note.links) bits.push(plural(note.links, 'link'));
  if (note.files) bits.push(plural(note.files, 'file'));
  const home = homes?.get(homeKey(note.home));
  if (home) bits.push(home);
  if (today && note.show_on && note.show_on >= today) bits.push(note.show_on === today ? 'On Today now' : `On Today ${formatDate(note.show_on)}`);
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

export function NoteRowButton(props: {
  note: NoteRow;
  term?: string;
  homes?: ReadonlyMap<string, string> | undefined;
  today?: LocalDate;
  onOpen(el: HTMLButtonElement): void;
  rowRef?: (el: HTMLButtonElement | null) => void;
}) {
  const { note, term = '' } = props;
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
          {savedLine(note, props.homes, props.today)}
        </span>
      </span>
    </button>
  );
}

/**
 * Notes as rows in a card, each opening its popup, which returns focus to the row. homes names each row's home; the
 * places a home shows its notes leave it out, as every row there has that home.
 */
export function NoteList(props: { notes: readonly NoteRow[]; label?: string; homes?: ReadonlyMap<string, string> | undefined }) {
  const day = useToday();
  const [open, setOpen] = useState<{ id: string; opener: HTMLElement } | null>(null);
  return (
    <>
      <ul className="card nlist" aria-label={props.label}>
        {props.notes.map((note) => (
          <li key={note.id}>
            <NoteRowButton note={note} homes={props.homes} today={day} onOpen={(el) => setOpen({ id: note.id, opener: el })} />
          </li>
        ))}
      </ul>
      {open && (
        <NotePopup
          id={open.id}
          close={(refocus = true) => {
            const back = open.opener;
            setOpen(null);
            if (refocus) requestAnimationFrame(() => back.isConnected && back.focus());
          }}
        />
      )}
    </>
  );
}

/** Every live note, for the places a home shows its notes. */
function useNotes(): NoteRow[] {
  return useQuery((sql) => notesList(sql), []).data ?? [];
}

/** The notes that live on one goal, project or practice, as a Notes section: nothing at all when there are none. */
export function HomeNotes(props: { home: MemoHome }) {
  const key = homeKey(props.home);
  const notes = useNotes().filter((n) => homeKey(n.home) === key);
  const id = useId();
  if (!notes.length) return null;
  return (
    <section className="stack8 homenotes" aria-labelledby={id}>
      <h3 id={id}>Notes</h3>
      <NoteList notes={notes} />
    </section>
  );
}

/**
 * An open goal card's last row: every note under the goal, on the goal itself or on its projects and practices, grouped
 * by home, opening in place. Nothing when there are none.
 */
export function GoalNotes(props: { goal: Objective; homes: readonly { home: MemoHome; title: string }[] }) {
  const all = useNotes();
  const [open, setOpen] = useState(false);
  const listId = useId();
  const groups = [{ home: { type: 'objective', id: props.goal.id } as MemoHome, title: props.goal.title }, ...props.homes]
    .map((h) => ({ ...h, notes: all.filter((n) => homeKey(n.home) === homeKey(h.home)) }))
    .filter((g) => g.notes.length);
  const count = groups.reduce((sum, g) => sum + g.notes.length, 0);
  if (!count) return null;
  return (
    <div className="prow goalnotes">
      <div className="prowhead">
        <button className="pmain" type="button" aria-expanded={open} aria-controls={listId} aria-label={`Notes, ${plural(count, 'note')}`} onClick={() => setOpen(!open)}>
          <span className="qcaret" aria-hidden="true">
            <Icon name={open ? 'chevron-down' : 'chevron-right'} size={16} />
          </span>
          <span className="nmark" aria-hidden="true">
            <Icon name="note" size={16} />
          </span>
          <span className="row grow">
            <span className="strong">Notes</span>
            <span className="small quiet">{plural(count, 'note')}</span>
          </span>
        </button>
      </div>
      {open && (
        <div id={listId} className="detail stack8">
          {groups.map((g) => (
            <div key={homeKey(g.home)} className="stack8">
              <h4 className="small quiet">{g.title}</h4>
              <NoteList notes={g.notes} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Today's card of the notes you chose to see today: read only, nothing to answer, and gone from Today tomorrow. */
export function NotesToday() {
  const day = useToday();
  const notes = useQuery((sql) => notesForDay(sql, day), [day]).data ?? [];
  return notes.length ? <TodaysNotes notes={notes} /> : null;
}

/** Apart from NotesToday, so Today reads the homes' names only on a day with notes to show. */
function TodaysNotes(props: { notes: readonly NoteRow[] }) {
  const names = useHomeNames();
  const id = useId();
  return (
    <section className="stack8 notestoday" aria-labelledby={id}>
      <div>
        <h2 id={id}>Notes for today</h2>
        <p className="small quiet">Shown today only. Tomorrow they're just in Notes.</p>
      </div>
      <NoteList notes={props.notes} homes={names} />
    </section>
  );
}

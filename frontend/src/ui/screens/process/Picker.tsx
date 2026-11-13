// Where an item goes: one searchable field, "Add to a project or One offs". Its list has "+ New project" first, then One
// offs, then every project under its goal; typing narrows it to projects whose name or goal has the letters, each goal
// moving beside its project, and lights the best match for Enter. Closed, it shows the place last used, so Enter, or
// Add to beside it, adds there again. On desktop the list opens under the field; on phone the field is a button that
// opens it in a sheet, ready to search.

import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode, RefObject } from 'react';
import { SearchIcon } from '../../components/icons';
import { LateWarning, lateSaid } from '../../components/LateWarning';
import { Sheet } from '../../components/Sheet';
import type { Destination, PickGroup } from './data';

/** A place to add an item to: a project, or One offs as null. */
export type Place = Destination | null;

export const ONE_OFFS = 'one_offs';
export const placeKey = (p: Place) => (p ? p.plan.project.id : ONE_OFFS);
export const placeName = (p: Place) => (p ? p.title : 'One offs');

const LABEL = 'Add to a project or One offs';

type Row = { key: string; kind: 'new' | 'one' } | { key: string; kind: 'project'; dest: Destination };

/** The letters typed, bold where they match. */
function mark(text: string, q: string): ReactNode {
  const i = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (i < 0) return text;
  return (
    <>
      {text.slice(0, i)}
      <b>{text.slice(i, i + q.length)}</b>
      {text.slice(i + q.length)}
    </>
  );
}

const count = (n: number) => (n === 0 ? 'No matches' : n === 1 ? '1 match' : `${n} matches`);

export function Picker(props: {
  phone: boolean;
  groups: readonly PickGroup[];
  /** Shown while nothing is typed: the place last used, or a project just made. Undefined for none. */
  value: Place | undefined;
  /** What the lit row adds besides, while the week toggle is on: its tag, and the words a screen reader hears. */
  tag: { text: string; says: string } | null;
  /** Why adding the item to a project would leave its date after the deadline, or null. It only warns. */
  late(dest: Destination): string | null;
  fieldRef: RefObject<HTMLElement | null>;
  addRef: RefObject<HTMLButtonElement | null>;
  /** The key that adds, on desktop. */
  cap?: ReactNode;
  onAdd(place: Place): void;
  /** Opens the new project form, named as typed. */
  onNew(name: string): void;
  /** Beside the field on desktop: the week toggle. */
  children?: ReactNode;
}) {
  const { phone, groups, value, tag } = props;
  const [q, setQ] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  // The lit row, or null for the one the list starts on.
  const [at, setAt] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listId = useId();

  const typed = (q ?? '').trim();
  const lq = typed.toLowerCase();
  const all = groups.flatMap((g) => g.dests);
  const found = lq ? all.filter((d) => `${d.title} ${d.goal ?? ''}`.toLowerCase().includes(lq)) : all;
  const oneShown = !lq || 'one offs'.includes(lq);
  const rows: Row[] = [
    { key: 'new', kind: 'new' },
    ...(oneShown ? [{ key: ONE_OFFS, kind: 'one' as const }] : []),
    ...found.map((dest): Row => ({ key: dest.plan.project.id, kind: 'project', dest })),
  ];
  const index = new Map(rows.map((r, i) => [r.key, i]));
  // Typed, the best match; else the place shown, or on desktop One offs. A phone with nothing shown lights nothing.
  const start = lq
    ? found.length
      ? index.get(found[0]!.plan.project.id)!
      : oneShown
        ? 1
        : 0
    : value !== undefined
      ? (index.get(placeKey(value)) ?? -1)
      : phone
        ? -1
        : 1;
  const lit = at ?? start;
  const name = value === undefined ? '' : placeName(value);

  const openList = () => {
    setAt(null);
    setOpen(true);
  };
  const reset = () => {
    setOpen(false);
    setQ(null);
    setAt(null);
  };
  const choose = (row: Row | undefined) => {
    if (!row) return;
    reset();
    if (row.kind === 'new') props.onNew(typed);
    else props.onAdd(row.kind === 'project' ? row.dest : null);
  };

  // Esc closes the list, then clears what was typed. A listener of its own, since the card's catches Esc before React
  // would; with nothing to close, Esc goes on to the card.
  useEffect(() => {
    const field = inputRef.current;
    if (!field || phone) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || (!open && q === null)) return;
      event.stopPropagation();
      if (open) setOpen(false);
      else setQ(null);
    };
    field.addEventListener('keydown', onKey);
    return () => field.removeEventListener('keydown', onKey);
  }, [open, q, phone]);
  // The place shown is selected whenever it shows in a focused field, so typing replaces it.
  useEffect(() => {
    const field = inputRef.current;
    if (q === null && field && document.activeElement === field) field.select();
  }, [q]);
  // The lit row stays in view as the arrows move it.
  useEffect(() => {
    if (open && lit >= 0) document.getElementById(`${listId}-${lit}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [open, lit, listId]);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.altKey || event.metaKey || event.ctrlKey) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) return openList();
      setAt(Math.min(rows.length - 1, Math.max(0, lit + (event.key === 'ArrowDown' ? 1 : -1))));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (open) choose(rows[lit]);
      else if (q === null && value !== undefined) props.onAdd(value);
      else openList();
    }
  };

  const option = (row: Row) => {
    const i = index.get(row.key)!;
    const on = i === lit;
    const said =
      'dest' in row ? (row.dest.goal ? `${row.dest.title}, ${row.dest.goal}` : row.dest.title) : row.kind === 'one' ? 'One offs' : typed ? `+ New project “${typed}”` : '+ New project';
    const tagged = on && row.kind !== 'new' && tag;
    const late = 'dest' in row ? props.late(row.dest) : null;
    return (
      <div
        key={row.key}
        id={`${listId}-${i}`}
        className={`pkopt${row.kind === 'new' ? ' pknew' : row.kind === 'one' ? ' pkone' : ''}`}
        role="option"
        aria-selected={on}
        aria-label={`${said}${tagged ? `, ${tag.says}` : ''}${lateSaid(late)}`}
        // The field keeps focus, so typing goes on.
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => choose(row)}
      >
        {row.kind === 'new' && <span>{said}</span>}
        {row.kind === 'one' && (
          <>
            <span className="pkdot" aria-hidden="true" />
            <span>One offs</span>
          </>
        )}
        {row.kind === 'project' && (
          <>
            <span>{mark(row.dest.title, typed)}</span>
            {lq && row.dest.goal && <span className="pkgoal">{mark(row.dest.goal, typed)}</span>}
          </>
        )}
        {tagged && <span className="pktag">{tag.text}</span>}
        {late && <LateWarning text={late} />}
      </div>
    );
  };
  const listbox = (
    <div id={listId} className="pkopts" role="listbox" aria-label="Projects and One offs">
      {rows.filter((r) => r.kind !== 'project').map(option)}
      {lq
        ? rows.filter((r) => r.kind === 'project').map(option)
        : groups.map((g) => (
            <div key={g.label} role="group" aria-label={g.label}>
              <div className="pkhead" aria-hidden="true">
                {g.label}
              </div>
              {g.dests.map((d) => option({ key: d.plan.project.id, kind: 'project', dest: d }))}
            </div>
          ))}
      {lq && !found.length && !oneShown && <div className="pkempty">{`No project matches “${typed}”.`}</div>}
    </div>
  );
  const field = (input: { placeholder: string; autoFocus?: boolean }) => (
    <>
      <input
        ref={(el) => {
          inputRef.current = el;
          if (!phone) props.fieldRef.current = el;
        }}
        role="combobox"
        aria-label={LABEL}
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && lit >= 0 ? `${listId}-${lit}` : undefined}
        data-typed={q !== null || undefined}
        placeholder={input.placeholder}
        autoFocus={input.autoFocus}
        autoComplete="off"
        enterKeyHint="go"
        // Sized by its box, not by a count of characters.
        size={1}
        value={q ?? (phone ? '' : name)}
        onFocus={(event) => q === null && event.currentTarget.select()}
        onClick={(event) => {
          if (q === null) event.currentTarget.select();
          if (!open) openList();
        }}
        onChange={(event) => {
          setQ(event.target.value);
          setAt(null);
          setOpen(true);
        }}
        onBlur={(event) => {
          if (!phone && !event.currentTarget.closest('.pkwrap')?.contains(event.relatedTarget)) setOpen(false);
        }}
        onKeyDown={onKeyDown}
      />
      {lq && (
        <span className="sr" aria-live="polite">
          {count(found.length + (oneShown ? 1 : 0))}
        </span>
      )}
    </>
  );
  // Shown on a project, as one just made or the last used, the warning sits under the picker.
  const late = q === null && value ? props.late(value) : null;
  const lateLine = late && (
    <p className="pklate">
      <LateWarning text={late} />
    </p>
  );
  const addButton = value !== undefined && (
    <button ref={props.addRef} className="btn pri pkadd" type="button" onClick={() => props.onAdd(value)}>
      Add to {name}
      {props.cap}
    </button>
  );

  if (phone) {
    return (
      <div className="pkphone">
        <button
          ref={(el) => void (props.fieldRef.current = el)}
          className="pkfield"
          type="button"
          aria-haspopup="dialog"
          aria-label={value === undefined ? LABEL : `${LABEL}: ${name}`}
          onClick={openList}
        >
          <SearchIcon />
          <span className="pkval">
            {value === undefined ? (
              <span className="quiet">{LABEL}</span>
            ) : (
              <>
                <span className="strong">{name}</span>
                {value?.goal && <span className="pkgoal">· {value.goal}</span>}
              </>
            )}
          </span>
        </button>
        {addButton}
        {lateLine}
        {open && (
          <Sheet label="Add to" tall className="pksheet" onClose={reset}>
            <div className="between">
              <h2>Add to</h2>
              <button className="btn" type="button" onClick={reset}>
                Close
              </button>
            </div>
            <div className="pkfield">
              <SearchIcon />
              {field({ placeholder: 'Search projects', autoFocus: true })}
            </div>
            {listbox}
          </Sheet>
        )}
      </div>
    );
  }

  return (
    <div className="pkrow">
      <div className="pkwrap">
        <div
          className={`pkfield${open ? ' open' : ''}`}
          // A click anywhere on it is a click in the field.
          onClick={(event) => {
            if (event.target === inputRef.current) return;
            inputRef.current?.focus();
            if (!open) openList();
          }}
        >
          <SearchIcon />
          {/* As wide as the place it shows, so its goal follows it; as wide as it can be once typed in. */}
          <span className="pksize" data-value={q === null && name ? name : undefined}>
            {field({ placeholder: LABEL })}
          </span>
          {q === null && value?.goal && (
            <span className="pkgoal" aria-hidden="true">
              · {value.goal}
            </span>
          )}
        </div>
        {open && <div className="pklist">{listbox}</div>}
      </div>
      {q === null && !open && addButton}
      {props.children}
      {lateLine}
    </div>
  );
}

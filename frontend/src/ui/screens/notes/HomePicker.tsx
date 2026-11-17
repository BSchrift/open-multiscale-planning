// Where a note lives, as one search over every goal, project and practice, built as Process's Add to picker is: one field,
// results grouped under Goals, Projects and Practices with the type on each row, fixed rows first and last, ↑ and ↓ to
// move, Enter to choose, Esc to go back. Typing narrows by name, by a project's or practice's goal, or by type, so
// "practice" lists the practices. Save as note's Attach note to and a note's Belongs to both use it.

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { isBacklog } from '../../../core/backlog';
import type { Sql } from '../../../core/db';
import { listRecords } from '../../../core/records';
import type { MemoHome } from '../../../core/types';
import { useQuery } from '../../app/store';
import { Icon } from '../../components/ds/Icon';
import '../process/process.css';

export interface HomeOption {
  key: string;
  label: string;
  /** What it is, said after its name: "Project · Home". */
  type: string;
  home: MemoHome | null;
  /** Inbox, to make the note a task, in Belongs to. */
  inbox?: true;
}

export const homeKey = (home: MemoHome | null | undefined) => (home ? `${home.type}:${home.id}` : 'own');

const GROUPS = [
  ['objective', 'Goals', 'Goal'],
  ['project', 'Projects', 'Project'],
  ['practice', 'Practices', 'Practice'],
] as const;

/** Every goal not archived, every project still running and every practice not ended, by type, with names. */
export async function loadHomes(sql: Sql): Promise<HomeOption[]> {
  const goals = (await listRecords(sql, 'objective')).filter((g) => g.state !== 'archived').sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity) || a.title.localeCompare(b.title));
  const goal = new Map(goals.map((g) => [g.id, g.title]));
  const projects = (await listRecords(sql, 'project')).filter((p) => !isBacklog(p) && (p.state === 'active' || p.state === 'paused'));
  const practices = (await listRecords(sql, 'practice')).filter((p) => p.state !== 'ended');
  const under = (id: string | null | undefined) => (id && goal.get(id) ? ` · ${goal.get(id)}` : '');
  const byTitle = <T extends { title: string }>(list: T[]) => [...list].sort((a, b) => a.title.localeCompare(b.title));
  return [
    ...goals.map((g): HomeOption => ({ key: `objective:${g.id}`, label: g.title, type: 'Goal', home: { type: 'objective', id: g.id } })),
    ...byTitle(projects).map((p): HomeOption => ({ key: `project:${p.id}`, label: p.title, type: `Project${under(p.objective_id)}`, home: { type: 'project', id: p.id } })),
    ...byTitle(practices).map((p): HomeOption => ({ key: `practice:${p.id}`, label: p.title, type: `Practice${under(p.objective_id)}`, home: { type: 'practice', id: p.id } })),
  ];
}

export function useHomes(): HomeOption[] | undefined {
  return useQuery((sql) => loadHomes(sql), []).data;
}

/**
 * The names of the homes a note can have, by homeKey. A note whose home is finished, dropped, archived, ended or gone, or
 * of a type a newer app made, isn't in it, so it reads as no home: the note outlives its home.
 */
export function useHomeNames(): ReadonlyMap<string, string> | undefined {
  const homes = useHomes();
  return useMemo(() => homes && new Map(homes.map((o) => [o.key, o.label])), [homes]);
}

const fold = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** The search field and its list, open for as long as it's shown: inside Attach note to's panel or sheet, or under Belongs to. */
export function HomeList(props: {
  label: string;
  homes: readonly HomeOption[];
  first: readonly HomeOption[];
  last?: readonly HomeOption[];
  /** The row lit at the start, as what's chosen now. */
  value?: string;
  onChoose(option: HomeOption): void;
  onCancel(): void;
}) {
  const { homes, first, last = [] } = props;
  const [q, setQ] = useState('');
  const [at, setAt] = useState<number | null>(null);
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const words = fold(q).split(/\s+/).filter(Boolean);
  const hit = (o: HomeOption) => words.every((w) => fold(`${o.label} ${o.type}`).includes(w));
  const found = homes.filter(hit);
  const groups = GROUPS.map(([type, label]) => ({ label, rows: found.filter((o) => o.home?.type === type) })).filter((g) => g.rows.length);
  // The fixed rows stay, whatever's typed.
  const rows = [...first, ...groups.flatMap((g) => g.rows), ...last];
  // Typed, the best match among the homes; else what's chosen now, or the first row.
  const start = words.length ? Math.max(0, rows.indexOf(found[0]!)) : Math.max(0, rows.findIndex((r) => r.key === props.value));
  const lit = Math.min(at ?? start, rows.length - 1);

  useEffect(() => input.current?.focus(), []);
  useEffect(() => {
    if (lit >= 0) document.getElementById(`${listId}-${lit}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [lit, listId]);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setAt(Math.min(rows.length - 1, Math.max(0, lit + (event.key === 'ArrowDown' ? 1 : -1))));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (rows[lit]) props.onChoose(rows[lit]);
    } else if (event.key === 'Escape') {
      // Back to where it was opened from, rather than closing what holds it.
      event.preventDefault();
      event.stopPropagation();
      props.onCancel();
    }
  };
  const option = (o: HomeOption) => {
    const i = rows.indexOf(o);
    return (
      <div
        key={o.key}
        id={`${listId}-${i}`}
        className={`pkopt${o.home ? '' : ' pkfixed'}`}
        role="option"
        aria-selected={i === lit}
        aria-label={`${o.label}, ${o.type}`}
        // The field keeps focus, so typing goes on.
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => props.onChoose(o)}
      >
        {!o.home && <Icon name={o.inbox ? 'inbox' : 'note'} size={16} />}
        <span>{o.label}</span>
        <span className="pkgoal">{o.type}</span>
      </div>
    );
  };
  return (
    <>
      <div className="pkfield open">
        <Icon name="search" />
        <input
          ref={input}
          role="combobox"
          aria-label={props.label}
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={rows.length ? `${listId}-${lit}` : undefined}
          data-typed={q ? true : undefined}
          placeholder="Search goals, projects and practices"
          autoComplete="off"
          enterKeyHint="go"
          size={1}
          value={q}
          onChange={(event) => {
            setQ(event.target.value);
            setAt(null);
          }}
          onKeyDown={onKeyDown}
        />
        {words.length > 0 && (
          <span className="sr" aria-live="polite">
            {found.length === 1 ? '1 match' : `${found.length || 'No'} matches`}
          </span>
        )}
      </div>
      <div id={listId} className="pkopts" role="listbox" aria-label={props.label}>
        {first.map(option)}
        {groups.map((g) => (
          <div key={g.label} role="group" aria-label={g.label}>
            <div className="pkhead" aria-hidden="true">
              {g.label}
            </div>
            {g.rows.map(option)}
          </div>
        ))}
        {words.length > 0 && !found.length && <div className="pkempty">{`No goal, project or practice matches “${q.trim()}”.`}</div>}
        {last.map(option)}
      </div>
    </>
  );
}

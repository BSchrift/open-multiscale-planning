// A search's list of choices, in the look of Process's picker: a listbox under a combobox field, in groups under
// headings, with the row Enter takes lit and the letters typed in bold. The field stays the caller's, since each one
// types and keys differently: it points at the lit row with aria-activedescendant (optionId) and moves it with step.
// A row that can't be chosen here is greyed, says why, and the arrows pass over it.

import { Fragment, useEffect } from 'react';
import type { ReactNode } from 'react';
import './searchlist.css';

export interface Choice {
  key: string;
  /** What a screen reader hears for the row. */
  said: string;
  /** Why it can't be chosen here, shown on the row. */
  off?: string | undefined;
  /** The row's own classes, after pkopt. */
  className?: string;
  body: ReactNode;
}

export interface ChoiceGroup {
  key: string;
  /** Its heading, and the group's name for a screen reader. None for rows that head the list. */
  label?: string;
  choices: readonly Choice[];
}

/** The letters typed, bold where they match. */
export function mark(text: string, q: string): ReactNode {
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

export const count = (n: number) => (n === 0 ? 'No matches' : n === 1 ? '1 match' : `${n} matches`);

export const optionId = (list: string, i: number) => `${list}-${i}`;

/** The next row the arrows reach from `at`, passing over rows that can't be chosen; at either end it stays put. */
export function step(choices: readonly Choice[], at: number, by: 1 | -1): number {
  for (let i = at + by; i >= 0 && i < choices.length; i += by) if (!choices[i]!.off) return i;
  return at;
}

export function SearchList(props: {
  id: string;
  label: string;
  groups: readonly ChoiceGroup[];
  /** The lit row's place among every group's rows, in order. */
  lit: number;
  onChoose(choice: Choice): void;
  /** After the rows: a hint, or why nothing matches. */
  children?: ReactNode;
}) {
  const { id, lit } = props;
  // The lit row stays in view as the arrows move it.
  useEffect(() => {
    if (lit >= 0) document.getElementById(optionId(id, lit))?.scrollIntoView?.({ block: 'nearest' });
  }, [id, lit]);
  let n = -1;
  const row = (c: Choice) => {
    const i = ++n;
    return (
      <div
        key={c.key}
        id={optionId(id, i)}
        className={`pkopt${c.className ? ` ${c.className}` : ''}${c.off ? ' off' : ''}`}
        role="option"
        aria-selected={i === lit}
        aria-disabled={c.off ? true : undefined}
        aria-label={c.off ? `${c.said}, ${c.off}` : c.said}
        // The field keeps focus, so typing goes on.
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => !c.off && props.onChoose(c)}
      >
        {c.body}
        {c.off && <span className="pktag mute">{c.off}</span>}
      </div>
    );
  };
  return (
    <div id={id} className="pkopts" role="listbox" aria-label={props.label}>
      {props.groups.map((g) =>
        g.label ? (
          <div key={g.key} role="group" aria-label={g.label}>
            <div className="pkhead" aria-hidden="true">
              {g.label}
            </div>
            {g.choices.map(row)}
          </div>
        ) : (
          <Fragment key={g.key}>{g.choices.map(row)}</Fragment>
        ),
      )}
      {props.children}
    </div>
  );
}

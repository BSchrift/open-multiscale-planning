// The milestones of the project Process's picker holds, in a row under it: up to three as chips, the rest in a list,
// No milestone, and New milestone, a name field in place. One is always chosen, the suggestion at first; none is ever
// required. A row of radios: Tab reaches the one chosen, the arrows move the choice, and Enter files the item.

import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import type { Milestone } from '../../../core/types';
import { Button } from '../../components/ds/Button';
import { Icon } from '../../components/ds/Icon';

/** Where the item goes in its project: a milestone there is, a new one by its name, made as the item is added, or none. */
export type MilestoneChoice = { id: string } | { name: string } | null;

/** How many show as chips before the rest go in a list. */
const CHIPS = 3;

export function Milestones(props: {
  phone: boolean;
  project: string;
  /** The project's open milestones, by date. */
  milestones: readonly Milestone[];
  /** A milestone's date, as the chips show it. */
  due(m: Milestone): string;
  chosen: MilestoneChoice;
  onChoose(choice: MilestoneChoice): void;
  /** Files the item, for Enter on a chip. */
  onAdd(): void;
  /** Whether New milestone's name field is open, which Option M opens from anywhere on the card. */
  naming: boolean;
  setNaming(naming: boolean): void;
  /** New milestone's key, on desktop. */
  cap: ReactNode;
}) {
  const { phone, milestones, chosen, onChoose } = props;
  const [name, setName] = useState('');
  const field = useRef<HTMLInputElement>(null);
  const group = useRef<HTMLDivElement>(null);

  // Esc closes the name field and leaves the card open: a listener of its own, since the card's catches Esc before React.
  useEffect(() => {
    const el = field.current;
    if (!el) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      props.setNaming(false);
    };
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, [props.naming]);

  const fresh = chosen && 'name' in chosen ? chosen.name : null;
  const chosenId = chosen && 'id' in chosen ? chosen.id : null;
  const chips = milestones.slice(0, fresh ? CHIPS - 1 : CHIPS);
  const rest = milestones.slice(chips.length);
  // The radios in order, each with what choosing it means.
  const radios: { key: string; title: string; meta: string; choice: MilestoneChoice }[] = [
    ...(fresh ? [{ key: 'new', title: fresh, meta: 'new', choice: { name: fresh } }] : []),
    ...chips.map((m) => ({ key: m.id, title: m.title, meta: `due ${props.due(m)}`, choice: { id: m.id } })),
    { key: 'none', title: 'No milestone', meta: '', choice: null },
  ];
  const on = (choice: MilestoneChoice) => (choice === null ? chosen === null : 'name' in choice ? !!fresh : choice.id === chosenId);
  // One stop for the row, on the radio chosen, or the first when the choice is in the list.
  const stop = Math.max(0, radios.findIndex((r) => on(r.choice)));

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (event.key === 'Enter') {
      event.preventDefault();
      props.onAdd();
    } else if (step) {
      event.preventDefault();
      const next = (i + step + radios.length) % radios.length;
      onChoose(radios[next]!.choice);
      group.current?.querySelectorAll<HTMLButtonElement>('[role=radio]')[next]?.focus();
    }
  };

  const make = () => {
    const typed = name.trim();
    if (typed) onChoose({ name: typed });
    setName('');
    props.setNaming(false);
  };

  return (
    <div ref={group} className="pkms" role="radiogroup" aria-label={`Milestone in ${props.project}`}>
      <span className="pkmslabel" aria-hidden="true">
        {phone ? `Milestone in ${props.project}` : 'Under'}
      </span>
      {!milestones.length && !fresh && <span className="small quiet">No milestones yet.</span>}
      {radios.map((r, i) => (
        <button
          key={r.key}
          className={`dchip${on(r.choice) ? ' on' : ''}`}
          type="button"
          role="radio"
          aria-checked={on(r.choice)}
          aria-label={r.meta ? `${r.title}, ${r.meta}` : r.title}
          tabIndex={i === stop ? 0 : -1}
          onClick={() => onChoose(r.choice)}
          onKeyDown={(event) => onKeyDown(event, i)}
        >
          {r.title}
          {/* On phone, only the chosen one has room for its date. */}
          {r.meta && (!phone || on(r.choice)) && <span className="msdue">{r.meta}</span>}
        </button>
      ))}
      {rest.length > 0 && (
        <select
          className="field mssel"
          aria-label="More milestones"
          value={rest.some((m) => m.id === chosenId) ? chosenId! : ''}
          onChange={(event) => event.target.value && onChoose({ id: event.target.value })}
        >
          <option value="">{`${rest.length} more`}</option>
          {rest.map((m) => (
            <option key={m.id} value={m.id}>
              {`${m.title}, due ${props.due(m)}`}
            </option>
          ))}
        </select>
      )}
      {props.naming ? (
        <span className="pkmsnew">
          <input
            ref={field}
            className="field"
            aria-label="New milestone name"
            placeholder="New milestone name"
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              // Its own Enter: it names the milestone, and the next Enter files the item.
              event.preventDefault();
              event.stopPropagation();
              make();
            }}
          />
          <Button size="compact" type="button" onClick={make}>
            Add
          </Button>
          <Button variant="icon" size="compact" label="Cancel new milestone" type="button" onClick={() => props.setNaming(false)}>
            <Icon name="close" />
          </Button>
        </span>
      ) : (
        <Button variant="quiet" size="compact" icon="plus" type="button" onClick={() => props.setNaming(true)}>
          New milestone
          {props.cap}
        </Button>
      )}
    </div>
  );
}

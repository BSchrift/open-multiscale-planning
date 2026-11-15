// The design system's containers (docs/design.md): the section card and the list row.

import { useId } from 'react';
import type { ReactNode } from 'react';

/** A section card on the ground, named by its heading, with the section's actions beside the heading. */
export function Card(props: { title?: string; actions?: ReactNode; className?: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className={`card${props.className ? ` ${props.className}` : ''}`} aria-labelledby={props.title ? id : undefined}>
      {(props.title || props.actions) && (
        <div className="cardhead">
          {props.title && <h2 id={id}>{props.title}</h2>}
          {props.actions}
        </div>
      )}
      {props.children}
    </section>
  );
}

/** A row in a list: its title and meta line first, and its trailing icons in one fixed column, so they line up. */
export function ListRow(props: { title: ReactNode; meta?: ReactNode; trailing?: ReactNode; className?: string }) {
  return (
    <div className={`lrow${props.className ? ` ${props.className}` : ''}`}>
      <div className="lrowmain">
        <span className="lrowtitle">{props.title}</span>
        {props.meta && <span className="lrowmeta">{props.meta}</span>}
      </div>
      {props.trailing && <div className="lrowtrail">{props.trailing}</div>}
    </div>
  );
}

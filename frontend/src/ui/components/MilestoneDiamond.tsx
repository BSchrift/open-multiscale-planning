// A milestone always shows as one: a diamond, solid when in the plan and hollow when not.

export interface DiamondState {
  /** Solid: in the plan. */
  on?: boolean;
  met?: boolean;
  /** Red: overdue. */
  late?: boolean;
  /** Ringed: the project's implicit Done. */
  done?: boolean;
}

export function diamondClass(state: DiamondState = {}): string {
  return (['on', 'met', 'late', 'done'] as const).filter((k) => state[k]).join(' ');
}

/** The inline marker, for lists and headings. */
export function MilestoneDiamond(props: { state?: DiamondState }) {
  return <span className={`msdia ${diamondClass(props.state)}`.trim()} aria-hidden="true" />;
}

/** A diamond at a position on a timeline track. */
export function TimelineDiamond(props: { state?: DiamondState; percent: number }) {
  return <i className={`gdia ${diamondClass(props.state)}`.trim()} style={{ left: `${props.percent}%` }} />;
}

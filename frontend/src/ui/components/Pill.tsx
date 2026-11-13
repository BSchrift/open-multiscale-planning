// Status is always a labelled pill, never an unexplained shape.
// red: Overdue, Past end date. amber: Behind, No tasks. green: On track. grey: Paused, Not started, Finished.

import type { ReactNode } from 'react';

export type PillTone = 'red' | 'amber' | 'green' | 'grey';

const TONE_CLASS: Record<PillTone, string> = { red: 'p-r', amber: 'p-a', green: 'p-g', grey: 'p-n' };

export function Pill(props: {
  tone: PillTone;
  children: ReactNode;
  /** Makes the pill a button, for one that opens a question. */
  onClick?(): void;
  'aria-label'?: string;
  'aria-expanded'?: boolean;
}) {
  const pill = <span className={`pill ${TONE_CLASS[props.tone]}`}>{props.children}</span>;
  if (!props.onClick) return pill;
  return (
    <button
      className="pillbtn"
      type="button"
      aria-label={props['aria-label']}
      aria-expanded={props['aria-expanded']}
      aria-haspopup={props['aria-expanded'] === undefined ? undefined : 'dialog'}
      onClick={props.onClick}
    >
      {pill}
    </button>
  );
}

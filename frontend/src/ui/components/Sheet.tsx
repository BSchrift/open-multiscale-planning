// A modal: centred on desktop, rising from the bottom on phone. Esc and the backdrop close it, and focus stays
// inside until it returns to where it was.

import type { ReactNode } from 'react';
import { useApp } from '../app/store';
import { useDialogFocus } from './useDialogFocus';

export function Sheet(props: {
  label: string;
  describedBy?: string;
  onClose(): void;
  tall?: boolean;
  /** Another class for the sheet, for one that sizes itself. */
  className?: string;
  children: ReactNode;
}) {
  const { layout } = useApp();
  const ref = useDialogFocus<HTMLDivElement>(props.onClose);
  const sheet = (
    <div
      ref={ref}
      className={`sheet stack8${props.tall ? ' tall' : ''}${props.className ? ` ${props.className}` : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label={props.label}
      aria-describedby={props.describedBy}
      tabIndex={-1}
      onClick={(event) => event.stopPropagation()}
    >
      {props.children}
    </div>
  );
  if (layout === 'phone') {
    return (
      <>
        <button className="scrim" type="button" aria-label="Close" tabIndex={-1} onClick={props.onClose} />
        {sheet}
      </>
    );
  }
  return (
    <div className="overlay" onClick={props.onClose}>
      {sheet}
    </div>
  );
}

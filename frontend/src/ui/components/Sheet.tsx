// A modal: centred on desktop, rising from the bottom on phone. Esc and the backdrop close it, and focus stays
// inside until it returns to where it was.

import { useContext, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { FlowFrame, PaneShown } from '../app/nav';
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
  const shown = useContext(PaneShown);
  const flow = useContext(FlowFrame);
  // Opened from a page, it's drawn at the layout's root, so no sticky header or other stacking context there can hold
  // it under the tab bar or the + button, and the layout's styles still reach it. In a flow, it's drawn at the top of
  // the flow's screen, for the same reason: opened from a sticky column, such as Pick's This week, it was held under
  // the sticky Does it fit? bar. The screen's styles still reach it there. In an overlay, it's drawn in place, above
  // what opened it. Found once: one open as the app first draws, before the root is there, stays in place.
  const [root] = useState(() =>
    shown !== null ? document.querySelector<HTMLElement>('[data-layout]') : ((flow?.current?.firstElementChild as HTMLElement | null | undefined) ?? null),
  );
  // Out of sight with the pane it opened from, as it was when it was drawn inside it.
  const hide = shown === false ? { visibility: 'hidden' as const } : undefined;
  const sheet = (
    <div
      ref={ref}
      className={`sheet stack8${props.tall ? ' tall' : ''}${props.className ? ` ${props.className}` : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label={props.label}
      aria-describedby={props.describedBy}
      tabIndex={-1}
      style={hide}
      onClick={(event) => event.stopPropagation()}
    >
      {props.children}
    </div>
  );
  const drawn =
    layout === 'phone' ? (
      <>
        <button className="scrim" type="button" aria-label="Close" tabIndex={-1} style={hide} onClick={props.onClose} />
        {sheet}
      </>
    ) : (
      <div className="overlay" style={hide} onClick={props.onClose}>
        {sheet}
      </div>
    );
  return root ? createPortal(drawn, root) : drawn;
}

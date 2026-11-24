// "Schedule both at the same time?" when a block lands on another block: a drag on Week or Today, Move here or Place
// here, or a card dropped from To schedule. Keep both, the default and Enter's choice, leaves both, side by side.
// Replace sends the blocks landed on back to be placed again. Cancel changes nothing, and Esc is Cancel. Other
// calendars' events never ask, and a block under way or gone by can only be kept. On desktop it hangs under what
// has focus, the block let go or the button pressed; on phone it's a sheet, as the app's Popover is. Hold to create
// never asks: it keeps its overlap.

import { useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import type { Slot } from '../../../core/slots';
import type { LocalDate } from '../../../core/types';
import { useApp } from '../../app/store';
import { Button } from '../ds/Button';
import { Sheet } from '../Sheet';
import { useDialogFocus } from '../useDialogFocus';

export type BothAnswer = 'keep' | 'replace' | 'cancel';

/** A block landed on, and whether it can only stay: under way, or gone by. */
export interface Landed {
  id: string;
  title: string;
  fixed?: boolean;
}

/**
 * The blocks a new time lands on that its old time didn't, so arrow steps or a drag across a block ask once. Leaves out
 * the block itself.
 */
export function landsOn<T extends { id: string; date: LocalDate; start: number; end: number }>(blocks: readonly T[], self: string | null, slot: Slot, from?: Slot | null): T[] {
  const on = (b: T, s: Slot) => b.date === s.date && b.start < s.end && s.start < b.end;
  return blocks.filter((b) => b.id !== self && on(b, slot) && !(from && on(b, from)));
}

const names = new Intl.ListFormat('en-GB');

/** Asks, and resolves to the answer. `asking` is the question while it's open, to draw anywhere in the screen. */
export function useBothAsk(): { ask(title: string, on: readonly Landed[]): Promise<BothAnswer>; asking: ReactNode } {
  const [open, setOpen] = useState<{ title: string; on: readonly Landed[]; answer(a: BothAnswer): void } | null>(null);
  const ask = (title: string, on: readonly Landed[]) =>
    new Promise<BothAnswer>((resolve) =>
      setOpen({
        title,
        on,
        answer: (a) => {
          setOpen(null);
          resolve(a);
        },
      }),
    );
  return { ask, asking: open && <BothQuestion {...open} /> };
}

function BothQuestion(props: { title: string; on: readonly Landed[]; answer(a: BothAnswer): void }) {
  const { layout } = useApp();
  const label = 'Schedule both at the same time?';
  const canReplace = props.on.some((x) => !x.fixed);
  const body = (
    <>
      <p className="small">
        {props.title} overlaps {names.format(props.on.map((x) => x.title))}.
      </p>
      <div className={layout === 'phone' ? 'stack8' : 'row'}>
        <Button variant="primary" size="compact" className={layout === 'phone' ? 'grow' : undefined} type="button" autoFocus onClick={() => props.answer('keep')}>
          Keep both
        </Button>
        {canReplace && (
          <Button size="compact" className={layout === 'phone' ? 'grow' : undefined} type="button" onClick={() => props.answer('replace')}>
            Replace
          </Button>
        )}
        <Button size="compact" className={layout === 'phone' ? 'grow' : undefined} type="button" onClick={() => props.answer('cancel')}>
          Cancel
        </Button>
      </div>
      {canReplace && <p className="small quiet">Replace takes {names.format(props.on.filter((x) => !x.fixed).map((x) => x.title))} off the calendar, to place again.</p>}
    </>
  );
  if (layout === 'phone') {
    return (
      <Sheet label={label} className="bothsheet" onClose={() => props.answer('cancel')}>
        <h2>{label}</h2>
        {body}
      </Sheet>
    );
  }
  return <Hanging label={label} onClose={() => props.answer('cancel')}>{body}</Hanging>;
}

/** Fixed under whatever had focus as it opened, or over it near the bottom of the screen, and never off its edges. */
function Hanging(props: { label: string; onClose(): void; children: ReactNode }) {
  const ref = useDialogFocus<HTMLDivElement>(props.onClose);
  // Placed as it opens from roughly its size, rather than hidden while it's measured, when it couldn't take focus.
  const [style] = useState<CSSProperties>(() => {
    const at = document.activeElement && document.activeElement !== document.body ? document.activeElement.getBoundingClientRect() : null;
    const [width, height] = [320, 160];
    const left = Math.max(8, Math.min(innerWidth - width - 8, at ? at.left : (innerWidth - width) / 2));
    const below = at ? at.bottom + 4 : (innerHeight - height) / 2;
    const top = at && below + height > innerHeight - 8 ? Math.max(8, at.top - height - 4) : below;
    return { position: 'fixed', top, left };
  });
  return (
    <div ref={ref} className="panel stack8 popover bothask" role="dialog" aria-label={props.label} tabIndex={-1} style={style}>
      <div className="strong">{props.label}</div>
      {props.children}
    </div>
  );
}

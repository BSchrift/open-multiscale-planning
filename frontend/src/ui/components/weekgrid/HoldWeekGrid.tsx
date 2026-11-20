// The week grid with hold to create, Week's and the Schedule step's. Apart from WeekGrid, which data modules import for
// its helpers, so they don't load Capture with it.

import { dragResult, DRAWN_DAY, isPast } from '../../../core/slots';
import { useApp } from '../../app/store';
import { DraftCapture } from '../../screens/capture/DraftCapture';
import { HoldRing, overlapWords, useHoldToCreate } from './holdCreate';
import { COLUMN_GAP, hourPx, sharedWith, WeekGrid } from './WeekGrid';
import type { WeekGridProps } from './WeekGrid';

/**
 * A press held on empty time drafts an hour at the quarter hour under it, which moves with the mouse as a block does, a
 * day per column and never into time gone by, and letting go opens Capture on it. A mouse dragged on empty time draws
 * the draft instead, in the pressed day's column. The caller turns it off while a block is open, selected or being placed.
 */
export function HoldWeekGrid(props: WeekGridProps & { holdOff: boolean }) {
  const { holdOff, ...grid } = props;
  const { ctx, blocks } = grid;
  const { layout } = useApp();
  const hr = hourPx(!!grid.editing);
  const hold = useHoldToCreate({
    at: (_x, py, el) => ({ date: el.dataset.dropDate!, minute: DRAWN_DAY.from + (py * 60) / hr }),
    move: (s, dx, dy, el) => {
      const next = dragResult(s, 'move', Math.round(dx / ((el.getBoundingClientRect().width || 100) + COLUMN_GAP)), (dy * 60) / hr, []);
      return isPast(next.date, next.start, ctx) ? null : next;
    },
    earliest: ctx.earliest,
    off: holdOff,
    draws: true,
  });
  const held = hold.draft?.slot;
  return (
    <>
      <WeekGrid {...grid} hold={hold} />
      <HoldRing ring={hold.ring} />
      {held && hold.draft!.open && (
        <DraftCapture layout={layout} close={hold.close} slot={hold.slot(overlapWords(held, sharedWith(held, blocks, ctx).map((o) => ({ title: o.title || 'Busy', start: o.start, end: o.end }))))} />
      )}
    </>
  );
}

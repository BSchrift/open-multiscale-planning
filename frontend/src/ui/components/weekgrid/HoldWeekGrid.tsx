// The week grid with hold to create, Week's and the Schedule step's. Apart from WeekGrid, which data modules import for
// its helpers, so they don't load Capture with it.

import { useState } from 'react';
import { formatTimeOfDay } from '../../../core/dates';
import { closestFit, DRAFT_MIN, dragResult, DRAWN_DAY, holdSlot, isPast } from '../../../core/slots';
import type { LocalDate } from '../../../core/types';
import { useApp } from '../../app/store';
import { Capture } from '../../screens/capture';
import { Menu } from '../Menu';
import { HoldRing, overlapWords, useHoldToCreate } from './holdCreate';
import { COLUMN_GAP, dayName, hourPx, sharedWith, WeekGrid } from './WeekGrid';
import type { WeekGridProps } from './WeekGrid';

/**
 * A press held on empty time drafts an hour at the quarter hour under it, which moves with the mouse as a block does, a
 * day per column and never into time gone by, and letting go opens Capture on it. A mouse dragged on empty time draws
 * the draft instead, in the pressed day's column. The caller turns it off while a block is open, selected or being placed.
 * With newTaskMenu, a right-click on empty time, or Shift-F10 or the menu key on a day, offers New task here whether or
 * not hold is off: it drafts the hour there, or the day's first free hour from the keys, and opens Capture on it.
 */
export function HoldWeekGrid(props: WeekGridProps & { holdOff: boolean; newTaskMenu?: boolean }) {
  const { holdOff, newTaskMenu, ...grid } = props;
  const { ctx, blocks } = grid;
  const { layout } = useApp();
  const hr = hourPx(!!grid.editing, grid.zoom);
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
  const [menu, setMenu] = useState<{ label: string; date: LocalDate; minute: number; at: { x: number; y: number }; from: HTMLElement } | null>(null);
  const onEmptyMenu = (date: LocalDate, minute: number | null, at: { x: number; y: number }, from: HTMLElement) => {
    const start = minute ?? closestFit(date, 0, DRAFT_MIN, 'project', ctx) ?? DRAWN_DAY.from;
    const slot = holdSlot(date, start, ctx.earliest);
    if (!slot) return false;
    setMenu({ label: minute === null ? dayName(date) : `${dayName(date)}, ${formatTimeOfDay(slot.start)}`, date, minute: start, at, from });
    return true;
  };
  const held = hold.draft?.slot;
  return (
    <>
      <WeekGrid {...grid} hold={hold} {...(newTaskMenu && { onEmptyMenu })} />
      <HoldRing ring={hold.ring} />
      {menu && (
        <Menu
          label={menu.label}
          entries={[{ id: 'new', label: 'New task here', icon: 'plus' }]}
          at={menu.at}
          onChoose={() => {
            setMenu(null);
            hold.create(menu.date, menu.minute);
          }}
          onClose={() => {
            setMenu(null);
            menu.from.focus();
          }}
        />
      )}
      {held && hold.draft!.open && (
        <Capture layout={layout} close={hold.close} slot={hold.slot(overlapWords(held, sharedWith(held, blocks, ctx).map((o) => ({ title: o.title || 'Busy', start: o.start, end: o.end }))))} />
      )}
    </>
  );
}

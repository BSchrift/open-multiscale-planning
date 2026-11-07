// Dragging between To schedule and the calendar. A drop lands on whatever carries data-drop-date (a drawn day, whose
// height is DRAWN_DAY), and a block let go over data-unscheduled comes off the calendar. Week and its phone day use it.

import type { PointerEvent as ReactPointerEvent } from 'react';
import { dropSlot, DRAWN_DAY } from '../../../core/slots';
import type { Slot, SlotContext } from '../../../core/slots';

/** The drop target under a point: a day to place on, or To schedule. */
function under(x: number, y: number) {
  const el = document.elementFromPoint?.(x, y);
  return { day: el?.closest<HTMLElement>('[data-drop-date]') ?? null, lane: el?.closest<HTMLElement>('[data-unscheduled]') ?? null };
}

/** Where a point over a day lands, measured from the drawn day each time, so scrolling during a drag can't shift it. */
export function slotAt(x: number, y: number, length: number, ctx: SlotContext, targets: readonly Slot[] = []): Slot | null {
  const { day } = under(x, y);
  if (!day) return null;
  const r = day.getBoundingClientRect();
  const minute = DRAWN_DAY.from + ((y - r.top) / (r.height || 1)) * (DRAWN_DAY.to - DRAWN_DAY.from);
  return dropSlot(day.dataset.dropDate!, minute, length, ctx, targets);
}

/** Whether a point is over To schedule, which lights up while something is dragged over it. */
export function overLane(x: number, y: number): boolean {
  const { lane } = under(x, y);
  for (const el of document.querySelectorAll('[data-unscheduled].drop')) if (el !== lane) el.classList.remove('drop');
  lane?.classList.add('drop');
  return !!lane;
}

export const clearLane = () => document.querySelectorAll('[data-unscheduled].drop').forEach((el) => el.classList.remove('drop'));

/** A copy of the card follows the pointer; let go over a day, the item is placed there. A press without a move is a click. */
export function dragCard(event: ReactPointerEvent<HTMLElement>, item: { length: number; offers: readonly Slot[] }, ctx: SlotContext, on: { preview(slot: Slot | null): void; drop(slot: Slot): void }) {
  if (event.button !== 0) return;
  const card = event.currentTarget;
  const [x0, y0] = [event.clientX, event.clientY];
  let ghost: HTMLElement | null = null;
  let last: Slot | null = null;
  const move = (e: PointerEvent) => {
    if (!ghost && Math.hypot(e.clientX - x0, e.clientY - y0) < 6) return;
    if (!ghost) {
      ghost = card.cloneNode(true) as HTMLElement;
      ghost.classList.add('cardghost');
      ghost.setAttribute('aria-hidden', 'true');
      ghost.style.width = `${card.getBoundingClientRect().width}px`;
      // Inside the layout, so its styles still apply.
      (card.closest('[data-layout]') ?? document.body).appendChild(ghost);
    }
    ghost.style.left = `${e.clientX - 16}px`;
    ghost.style.top = `${e.clientY - 12}px`;
    const slot = slotAt(e.clientX, e.clientY, item.length, ctx, item.offers);
    if (slot?.date !== last?.date || slot?.start !== last?.start) on.preview(slot);
    last = slot;
  };
  const end = (drop: boolean) => () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', cancel);
    if (!ghost) return;
    ghost.remove();
    on.preview(null);
    // The click that follows a drag isn't a tap.
    const swallow = (e: Event) => e.stopPropagation();
    card.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => card.removeEventListener('click', swallow, { capture: true }));
    if (drop && last) on.drop(last);
  };
  const up = end(true);
  const cancel = end(false);
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', cancel);
}

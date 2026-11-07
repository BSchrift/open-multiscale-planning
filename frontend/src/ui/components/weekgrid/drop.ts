// Dragging between To schedule and the calendar. A drop lands on whatever carries data-drop-date: a drawn day, whose
// height runs from data-drop-from to data-drop-to in minutes (DRAWN_DAY without them). A block let go over
// data-unscheduled comes off the calendar. Week, its phone day and Today use it.

import type { PointerEvent as ReactPointerEvent } from 'react';
import { formatTimeOfDay } from '../../../core/dates';
import { dropSlot, DRAWN_DAY } from '../../../core/slots';
import type { Slot, SlotContext } from '../../../core/slots';

/** On touch, a card lifts once held this long without moving, so a swipe still scrolls. As holding a block on Today. */
export const HOLD_MS = 400;
const SLOP_PX = 8;

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
  const from = Number(day.dataset.dropFrom ?? DRAWN_DAY.from);
  const to = Number(day.dataset.dropTo ?? DRAWN_DAY.to);
  return dropSlot(day.dataset.dropDate!, from + ((y - r.top) / (r.height || 1)) * (to - from), length, ctx, targets);
}

/** Whether a point is over To schedule, which lights up while something is dragged over it. */
export function overLane(x: number, y: number): boolean {
  const { lane } = under(x, y);
  for (const el of document.querySelectorAll('[data-unscheduled].drop')) if (el !== lane) el.classList.remove('drop');
  lane?.classList.add('drop');
  return !!lane;
}

export const clearLane = () => document.querySelectorAll('[data-unscheduled].drop').forEach((el) => el.classList.remove('drop'));

/**
 * A copy of the card follows the pointer, saying the time it would land at; let go over a day, the item is placed
 * there. A mouse drags at once. A finger holds first, and moving before then scrolls instead. A press without a drag
 * is a click.
 */
export function dragCard(event: ReactPointerEvent<HTMLElement>, item: { length: number; offers: readonly Slot[] }, ctx: SlotContext, on: { preview(slot: Slot | null): void; drop(slot: Slot): void }) {
  if (event.button !== 0) return;
  const card = event.currentTarget;
  const touch = event.pointerType === 'touch' || event.pointerType === 'pen';
  const [x0, y0] = [event.clientX, event.clientY];
  let ghost: HTMLElement | null = null;
  let when: HTMLElement | null = null;
  let last: Slot | null = null;
  const lift = (x: number, y: number) => {
    ghost = card.cloneNode(true) as HTMLElement;
    ghost.classList.add('cardghost');
    ghost.setAttribute('aria-hidden', 'true');
    ghost.style.width = `${card.getBoundingClientRect().width}px`;
    when = ghost.appendChild(document.createElement('span'));
    when.className = 'small strong ghostwhen';
    // Inside the layout, so its styles still apply.
    (card.closest('[data-layout]') ?? document.body).appendChild(ghost);
    card.classList.add('lifted');
    follow(x, y);
  };
  const follow = (x: number, y: number) => {
    ghost!.style.left = `${x - 16}px`;
    ghost!.style.top = `${y - (touch ? 48 : 12)}px`;
    const slot = slotAt(x, y, item.length, ctx, item.offers);
    if (slot?.date !== last?.date || slot?.start !== last?.start) on.preview(slot);
    last = slot;
    when!.textContent = slot ? formatTimeOfDay(slot.start) : '';
  };
  const move = (e: PointerEvent) => {
    if (ghost) return follow(e.clientX, e.clientY);
    const far = Math.hypot(e.clientX - x0, e.clientY - y0) >= (touch ? SLOP_PX : 6);
    if (far && touch) return end(false)();
    if (far) lift(e.clientX, e.clientY);
  };
  // Once lifted, the page stays still under the finger and the long-press menu stays away.
  const still = (e: Event) => {
    if (ghost) e.preventDefault();
  };
  const end = (drop: boolean) => () => {
    clearTimeout(timer);
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', cancel);
    window.removeEventListener('touchmove', still);
    window.removeEventListener('contextmenu', still);
    if (!ghost) return;
    (ghost as HTMLElement).remove();
    card.classList.remove('lifted');
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
  window.addEventListener('touchmove', still, { passive: false });
  window.addEventListener('contextmenu', still);
  const timer = touch
    ? setTimeout(() => {
        navigator.vibrate?.(10);
        lift(x0, y0);
      }, HOLD_MS)
    : undefined;
}

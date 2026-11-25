// Dragging between To schedule and the calendar. A drop lands on whatever carries data-drop-date: a drawn day, whose
// height runs from data-drop-from to data-drop-to in minutes (DRAWN_DAY without them). A block let go over
// data-unscheduled comes off the calendar. Week, its phone day and Today use it, and holdToDrag, the press every block
// and card that moves shares.

import type { PointerEvent as ReactPointerEvent } from 'react';
import { formatTimeOfDay } from '../../../core/dates';
import { dropSlot, DRAWN_DAY } from '../../../core/slots';
import type { Slot, SlotContext } from '../../../core/slots';

/**
 * A block or card lifts to drag once held this long, by mouse or finger, so a click or tap opens it and a swipe still
 * scrolls. Every hold to drag uses it.
 */
export const HOLD_MS = 400;
/** How far a finger can drift during a hold before it counts as a swipe instead. */
export const SLOP_PX = 8;
/** How far a mouse moves from its press before what it lifted follows, so a hand that shifts during a slow click still clicks. */
export const DRAG_PX = 6;
/** Near the top or bottom of the screen, where the strip and tab bar sit, a dragged card scrolls the page. */
const EDGE_PX = 120;
const SCROLL_PX = 12;

/** What scrolls under an element: its nearest scrolling ancestor, else the page. */
export function scrollerOf(el: Element): Element {
  for (let e = el.parentElement; e; e = e.parentElement) {
    const o = getComputedStyle(e).overflowY;
    if ((o === 'auto' || o === 'scroll') && e.scrollHeight > e.clientHeight) return e;
  }
  return document.scrollingElement ?? document.documentElement;
}

/** The drop target under a point: a day to place on, or To schedule. */
function under(x: number, y: number) {
  const el = document.elementFromPoint?.(x, y);
  return { day: el?.closest<HTMLElement>('[data-drop-date]') ?? null, lane: el?.closest<HTMLElement>('[data-unscheduled]') ?? null };
}

/** Where a point over a day lands, measured from the drawn day each time, so scrolling during a drag can't shift it. */
function slotAt(x: number, y: number, length: number, ctx: SlotContext, targets: readonly Slot[] = []): Slot | null {
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
 * The click that follows a drag isn't a tap, so it stops before the element's own handler. Called as the drag is let go:
 * the browser sends that click in the same turn as the release, however long the page then takes to draw, and the
 * listener is gone by the next turn, so a later click is a click.
 */
export function swallowClick(el: Element) {
  const swallow = (e: Event) => e.stopPropagation();
  el.addEventListener('click', swallow, { capture: true, once: true });
  setTimeout(() => el.removeEventListener('click', swallow, { capture: true }));
}

/**
 * A press on a block or card that moves. A click or tap opens it, and only a hold (HOLD_MS) lifts it to drag, with a
 * mouse as with a finger, so a click whose hand shifts a few pixels is still a click. Before the hold, a finger that
 * moves is scrolling, so the press lets go; a mouse that moves waits for the hold. Once lifted, the page holds still,
 * and moving past a click's wobble drags it: `drag` gets the pointer's distance from the press. Let go after dragging,
 * it drops; let go in place, it's held, which opens nothing unless `held` does. Either way the click that follows is
 * swallowed.
 */
export function holdToDrag(
  event: ReactPointerEvent,
  on: {
    lift(): void;
    drag(dx: number, dy: number, e: PointerEvent): void;
    drop(e: PointerEvent): void;
    /** Let go before the hold. An element with a click of its own leaves this out, since its click still comes. */
    tap?(): void;
    /** Lifted, then let go without dragging, or the browser took the press back. */
    cancel?(): void;
    /** Lifted, then let go without dragging, after cancel: as a phone's hold, then let go, opens a menu. */
    held?(): void;
    /** The platform's light tap, as a finger's hold lifts. */
    haptic?(): unknown;
  },
): void {
  if (event.button !== 0) return;
  const touch = event.pointerType === 'touch' || event.pointerType === 'pen';
  // A press on a block's length handle drags the block it's in, whose click comes with letting go.
  const target = (event.currentTarget as Element).closest('.cev, .ev') ?? (event.currentTarget as Element);
  const [x0, y0] = [event.clientX, event.clientY];
  const pressed = performance.now();
  let lifted = false;
  let dragged = false;
  const lift = () => {
    clearTimeout(timer);
    lifted = true;
    if (touch) void on.haptic?.();
    on.lift();
  };
  // Only the pointer that pressed: a mouse resting elsewhere sends moves of its own as the page changes under it.
  const own = (e: PointerEvent) => e.pointerId === event.pointerId;
  const move = (e: PointerEvent) => {
    if (!own(e)) return;
    const [dx, dy] = [e.clientX - x0, e.clientY - y0];
    const far = Math.hypot(dx, dy) >= (touch ? SLOP_PX : DRAG_PX);
    if (!lifted) {
      // Held long enough, though a busy page ran the timer late: it lifts rather than reading as a swipe.
      if (performance.now() - pressed >= HOLD_MS) lift();
      else {
        if (touch && far) end();
        return;
      }
    }
    if (!dragged && !far) return;
    dragged = true;
    on.drag(dx, dy, e);
  };
  // Once lifted, the page stays still under the finger and the long-press menu stays away.
  const still = (e: Event) => {
    if (lifted) e.preventDefault();
  };
  const up = (e: PointerEvent) => {
    if (!own(e)) return;
    end();
    if (!lifted) return on.tap?.();
    swallowClick(target);
    if (dragged) return on.drop(e);
    on.cancel?.();
    on.held?.();
  };
  const cancel = (e: PointerEvent) => {
    if (!own(e)) return;
    end();
    if (lifted) on.cancel?.();
  };
  // A second finger down means a pinch, which the press gives way to.
  const second = (e: PointerEvent) => {
    if (own(e)) return;
    end();
    if (lifted) on.cancel?.();
  };
  const end = () => {
    clearTimeout(timer);
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', cancel);
    window.removeEventListener('pointerdown', second);
    window.removeEventListener('touchmove', still);
    window.removeEventListener('contextmenu', still);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', cancel);
  window.addEventListener('pointerdown', second);
  window.addEventListener('touchmove', still, { passive: false });
  window.addEventListener('contextmenu', still);
  const timer = setTimeout(lift, HOLD_MS);
}

/**
 * A copy of the card follows the pointer, saying the time it would land at; let go over a day, the item is placed
 * there. It lifts after a hold, as holdToDrag has it, so a click or tap opens it and a swipe scrolls.
 */
export function dragCard(
  event: ReactPointerEvent<HTMLElement>,
  item: { length: number; offers: readonly Slot[] },
  ctx: SlotContext,
  on: { preview(slot: Slot | null): void; drop(slot: Slot): void; /** As the hold lifts it. */ lift?(): void; /** The platform's light tap, as a held card lifts. */ haptic?(): unknown },
) {
  const card = event.currentTarget;
  const touch = event.pointerType === 'touch' || event.pointerType === 'pen';
  const [x0, y0] = [event.clientX, event.clientY];
  let ghost: HTMLElement | null = null;
  let when: HTMLElement | null = null;
  let last: Slot | null = null;
  let at = { x: x0, y: y0 };
  let raf = 0;
  const scroller = scrollerOf(card);
  // Keeps scrolling while the card is held near an edge, and the time under it follows. Only once it has left the edge
  // it started at, so a card near the top doesn't scroll the page away as it lifts.
  let armed = false;
  const edge = () => (!armed ? 0 : at.y > innerHeight - EDGE_PX ? SCROLL_PX : at.y < EDGE_PX ? -SCROLL_PX : 0);
  const scroll = () => {
    raf = 0;
    if (!ghost || !edge()) return;
    const was = scroller.scrollTop;
    scroller.scrollTop += edge();
    if (scroller.scrollTop !== was) follow(at.x, at.y);
  };
  const follow = (x: number, y: number) => {
    at = { x, y };
    armed ||= y > EDGE_PX && y < innerHeight - EDGE_PX;
    if (edge() && !raf) raf = requestAnimationFrame(scroll);
    ghost!.style.left = `${x - 16}px`;
    ghost!.style.top = `${y - (touch ? 48 : 12)}px`;
    const slot = slotAt(x, y, item.length, ctx, item.offers);
    if (slot?.date !== last?.date || slot?.start !== last?.start) on.preview(slot);
    last = slot;
    when!.textContent = slot ? formatTimeOfDay(slot.start) : '';
  };
  const put = () => {
    cancelAnimationFrame(raf);
    ghost?.remove();
    ghost = null;
    card.classList.remove('lifted');
    on.preview(null);
  };
  holdToDrag(event, {
    lift: () => {
      ghost = card.cloneNode(true) as HTMLElement;
      ghost.classList.add('cardghost');
      ghost.setAttribute('aria-hidden', 'true');
      ghost.style.width = `${card.getBoundingClientRect().width}px`;
      when = ghost.appendChild(document.createElement('span'));
      when.className = 'small strong ghostwhen';
      // Inside the layout, so its styles still apply.
      (card.closest('[data-layout]') ?? document.body).appendChild(ghost);
      card.classList.add('lifted');
      follow(x0, y0);
      on.lift?.();
    },
    drag: (_dx, _dy, e) => follow(e.clientX, e.clientY),
    drop: () => {
      const slot = last;
      put();
      if (slot) on.drop(slot);
    },
    cancel: put,
    ...(on.haptic ? { haptic: on.haptic } : {}),
  });
}

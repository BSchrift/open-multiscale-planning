// Pinching a day's calendar on phone draws its hours taller or shorter, as Apple Calendar does: smoothly while the
// fingers move, from the size that fits the whole drawn day on screen to three times the usual, and around the point
// between the fingers, so the time under them stays put. The zoom is kept on this device only, as a multiple of the
// usual size, so each way of drawing the day can scale its own hours by it.

import { useLayoutEffect, useRef, useState } from 'react';
import type { TouchEvent } from 'react';
import { useStickyState } from '../../app/store';
import { scrollerOf } from '../weekgrid/drop';

/** Three times the usual size, as far as a day zooms in. */
export const MAX_ZOOM = 3;

/** The zoom a pinch has reached: the one it started from, scaled by how far the fingers have spread. */
export const pinched = (from: number, startGap: number, gap: number, min: number, max: number) => Math.min(max, Math.max(min, (from * gap) / startGap));

/** The zoom at which a day drawn `drawn` pixels tall at the usual size fits `room`. */
export const fitZoom = (room: number, drawn: number) => room / drawn;

/** How far to scroll so the point `frac` of the way down an element drawn from `top`, `height` tall, sits at `y`. */
export const anchorShift = (frac: number, top: number, height: number, y: number) => top + frac * height - y;

const fingers = (e: TouchEvent) => [e.touches[0]!, e.touches[1]!] as const;
const spread = (e: TouchEvent) => {
  const [a, b] = fingers(e);
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
};
const between = (e: TouchEvent) => {
  const [a, b] = fingers(e);
  return { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
};

/**
 * The day's zoom, and touch handlers for what draws the day. `least` says, as a pinch starts, the zoom at which the
 * whole day fits. The point between the fingers is kept on the row or drawn day under it (`.tlrow`, `.day`), which
 * keeps its place in the page as the hours around it change.
 */
export function usePinchZoom(key: string, least: () => number) {
  const [kept, keep] = useStickyState(key, 1);
  const [live, setLive] = useState<number | null>(null);
  const zoom = live ?? kept;
  const start = useRef<{ spread: number; zoom: number; least: number; anchor: Element | null; frac: number } | null>(null);
  const hold = useRef<{ anchor: Element; frac: number; y: number } | null>(null);
  // Once the day has drawn at the new zoom, the page scrolls so the anchor is back under the fingers.
  useLayoutEffect(() => {
    const at = hold.current;
    hold.current = null;
    if (!at?.anchor.isConnected) return;
    const r = at.anchor.getBoundingClientRect();
    scrollerOf(at.anchor).scrollTop += anchorShift(at.frac, r.top, r.height, at.y);
  });
  const handlers = {
    onTouchStart: (e: TouchEvent) => {
      if (e.touches.length !== 2) return;
      const mid = between(e);
      const anchor = document.elementFromPoint(mid.x, mid.y)?.closest('.tlrow, .day') ?? null;
      const r = anchor?.getBoundingClientRect();
      start.current = { spread: spread(e), zoom, least: Math.min(1, least()), anchor, frac: r?.height ? (mid.y - r.top) / r.height : 0 };
    },
    onTouchMove: (e: TouchEvent) => {
      const s = start.current;
      if (!s || e.touches.length !== 2) return;
      if (s.anchor) hold.current = { anchor: s.anchor, frac: s.frac, y: between(e).y };
      setLive(pinched(s.zoom, s.spread, spread(e), s.least, MAX_ZOOM));
    },
    onTouchEnd: (e: TouchEvent) => {
      if (!start.current || e.touches.length >= 2) return;
      start.current = null;
      if (live !== null) keep(live);
      setLive(null);
    },
  };
  // A zoom set by other means, such as a menu's Zoom in, is kept as a pinch's is.
  return { zoom, set: keep, handlers: { ...handlers, onTouchCancel: handlers.onTouchEnd } };
}

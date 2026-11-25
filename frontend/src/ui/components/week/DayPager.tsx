// Swiping from day to day on phone, as Apple Maps pages between places. Once a finger moves sideways the day follows it,
// with the days either side drawn beside it; let go, and a spring from the finger's speed settles on the day momentum
// points to: the day the swipe began on or one either side, never further, however long the drag or hard the flick.
// Vertical scrolling stays the phone's own. A hold that lifts something to drag owns its finger, so it never swipes.
// The physics and its values are in swipePhysics.ts. Any view of one day uses it: draw each day with DayPager, or
// draw the frame, track and panes yourself and give them to useDaySwipe.

import { Component, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { HTMLAttributes, ReactNode, Ref } from 'react';
import { addDays } from '../../../core/dates';
import type { LocalDate } from '../../../core/types';
import { heldPointers, HOLD_MS, scrollerOf, SLOP_PX, swallowClick } from '../weekgrid/drop';
import { decayOffset, pickTarget, spring, stretch, stretchSlope, SWIPE, unstretch, velocity } from './swipePhysics';
import type { Sample } from './swipePhysics';
import './week.css';

/** How far a finger moves before the swipe decides which way it's going. */
const LOCK_PX = 10;
/** Steeper than this, in degrees, the phone scrolls the page itself; between it and SWIPE.lockAngle the swipe does. */
const NATIVE_ANGLE = 45;
/** The fastest a spring starts, in px per s, so a wild flick can't fling it. */
const MAX_SPRING_V = 8000;

/** The time of day kept across a change of day: the minute at the top of what shows, and how far below `top` it is. */
export interface KeptTime {
  minute: number;
  below: number;
}

export interface DaySwipe {
  /** The day shown. */
  day: LocalDate;
  /** Off while something else owns a sideways drag on the day, such as editing or placing. */
  enabled: boolean;
  /**
   * The swipe settled on the day before or after, which the caller makes `day`. `time` is the time of day to keep, for
   * a caller that draws the day afresh, as Week does on another week (DayPager's `time`).
   */
  onDay(day: LocalDate, time: KeptTime | null): void;
  /** The day nearest the middle as the finger drags and the spring settles, for a strip or heading to follow. */
  onNear?(day: LocalDate): void;
  /** The screen y under any sticky header, where the time of day is kept across days. The top of the screen if left out. */
  top?(): number;
}

type Gesture = {
  id: number;
  type: 'pending' | 'x' | 'scroll' | 'native' | 'held';
  x0: number;
  y0: number;
  t0: number;
  now0: number;
  /** Moved past a hold's slop before the hold, so no hold can lift under it. */
  free: boolean;
  /** Pressed while a spring was settling. */
  caught: boolean;
  samples: Sample[];
  /** Where the finger and the page were as the swipe locked, or the page's scroll as a scroll by hand began. */
  from: number;
  start: number;
};

// Each day's rows say the minutes they cover in data-drop-from and data-drop-to, as drops read them, so the time at a
// point is found the same way however the day is drawn: Week's rows that shorten closed time, or an hour scale.
const rowsOf = (pane: Element | null) => (pane ? [...pane.querySelectorAll<HTMLElement>('[data-drop-from][data-drop-to]')] : []);
const span = (row: HTMLElement) => [Number(row.dataset.dropFrom), Number(row.dataset.dropTo)] as const;
const within = (x: number) => Math.max(0, Math.min(1, x));

/** The screen y of a minute in a drawn day. */
function yOf(pane: Element | null, minute: number) {
  const rows = rowsOf(pane);
  const row = rows.find((r) => minute < span(r)[1]) ?? rows.at(-1);
  if (!row) return null;
  const [from, to] = span(row);
  const box = row.getBoundingClientRect();
  return box.top + within((minute - from) / (to - from || 1)) * box.height;
}

/** The time of day at the top of what shows of a drawn day, or at its first row while that's further down. */
export function keepTime(pane: Element | null, top: number): KeptTime | null {
  const rows = rowsOf(pane);
  if (!rows.length) return null;
  const line = Math.min(Math.max(top, rows[0]!.getBoundingClientRect().top), rows.at(-1)!.getBoundingClientRect().bottom);
  const row = rows.find((r) => line < r.getBoundingClientRect().bottom) ?? rows.at(-1)!;
  const [from, to] = span(row);
  const box = row.getBoundingClientRect();
  return { minute: from + within((line - box.top) / (box.height || 1)) * (to - from), below: line - top };
}

/** Scrolls the page so the kept time of day is back where it was under `top`. */
export function restoreTime(pane: Element | null, kept: KeptTime, top: number) {
  const y = yOf(pane, kept.minute);
  if (pane && y !== null) scrollerOf(pane).scrollTop += y - (top + kept.below);
}

const reduced = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const coalesced = (e: PointerEvent) => {
  const list = e.getCoalescedEvents?.();
  return list?.length ? list : [e];
};

/**
 * The gesture. `frame` goes on the element a finger swipes on, with touch-action: pan-y so vertical scrolling stays the
 * phone's; `track` on the element inside it that moves sideways, holding one pane per day drawn, each with data-day.
 * While `swiping`, draw the days either side too: they're placed beside the day and lined up on its time of day.
 */
export function useDaySwipe(o: DaySwipe) {
  const opts = useRef(o);
  opts.current = o;
  const frame = useRef<HTMLDivElement | null>(null);
  const track = useRef<HTMLDivElement | null>(null);
  const [swiping, setSwiping] = useState(false);
  // How far the page has moved toward the next day (px, negative toward the day before), and what moves it.
  const s = useRef({ pos: 0, width: 0, near: 0, raf: 0, glide: 0, anim: null as { to: number; f: (t: number) => [number, number]; t0: number } | null, g: null as Gesture | null }).current;

  const paneOf = (day: LocalDate) => frame.current?.querySelector<HTMLElement>(`[data-day="${day}"]`) ?? null;
  const top = () => opts.current.top?.() ?? 0;

  /** Draws the track where the page is, and tells the caller when the day nearest the middle changes. */
  const paint = useCallback(() => {
    if (track.current) track.current.style.transform = s.pos ? `translate3d(${-s.pos}px, 0, 0)` : '';
    const near = s.width ? Math.max(-1, Math.min(1, Math.round(s.pos / s.width))) : 0;
    if (near === s.near) return;
    s.near = near;
    opts.current.onNear?.(addDays(opts.current.day, near));
  }, [s]);

  useEffect(() => {
    const el = frame.current;
    if (!o.enabled || !el) return;
    const stopAnim = () => {
      s.anim = null;
      cancelAnimationFrame(s.raf);
      s.raf = 0;
    };
    // The page has come to rest on a day either side: the caller draws that day, and the next drawing puts the track back.
    const commit = (near: number) => {
      const { day, onDay } = opts.current;
      const kept = keepTime(paneOf(day), top());
      s.pos -= near * s.width;
      s.near = 0;
      onDay(addDays(day, near), kept);
    };
    const settle = () => {
      const near = s.width ? Math.round(s.pos / s.width) : 0;
      if (near) commit(near);
      else paint();
      if (!s.g) setSwiping(false);
    };
    const frameAt = (ts: number) => {
      s.raf = 0;
      const a = s.anim;
      if (!a) return;
      const [x, v] = a.f(Math.max(0, ts - a.t0) / 1000);
      s.pos = a.to + x;
      if (Math.abs(x) < 0.3 && Math.abs(v) < 12) {
        s.pos = a.to;
        s.anim = null;
        return settle();
      }
      paint();
      s.raf = requestAnimationFrame(frameAt);
    };
    // Letting go: the day momentum points to, settled by a spring from the release speed, or at once with reduced motion.
    const release = (v: number) => {
      const { target } = pickTarget({ pos: s.pos, v, width: s.width, rate: SWIPE.rate, flick: SWIPE.flick, start: 0, min: -1, max: 1 });
      stopAnim();
      const to = target * s.width;
      if (reduced() || !s.width) {
        s.pos = to;
        return settle();
      }
      const v0 = Math.max(-MAX_SPRING_V, Math.min(MAX_SPRING_V, v * 1000));
      s.anim = { to, f: spring(s.pos - to, v0, SWIPE.response, SWIPE.damping), t0: performance.now() };
      s.raf = requestAnimationFrame(frameAt);
    };
    // A drag between the swipe's angle and the phone's own scroll scrolls the page by hand, gliding on as iOS does.
    const glide = (v: number) => {
      if (Math.abs(v) < 0.05) return;
      const page = scrollerOf(el);
      const [from, t0] = [page.scrollTop, performance.now()];
      const tick = (ts: number) => {
        const t = Math.max(0, ts - t0);
        const before = page.scrollTop;
        page.scrollTop = from + decayOffset(v, SWIPE.rate, t);
        s.glide = Math.abs(v * SWIPE.rate ** t) < 0.02 || (t > 32 && page.scrollTop === before) ? 0 : requestAnimationFrame(tick);
      };
      s.glide = requestAnimationFrame(tick);
    };
    const lim = () => [-s.width, s.width] as const;

    const move = (e: PointerEvent) => {
      const g = s.g;
      if (!g || e.pointerId !== g.id) return;
      const [dx, dy] = [e.clientX - g.x0, e.clientY - g.y0];
      if (g.type === 'pending') {
        // Still within a hold's slop when the hold came due, or something held lifted: the hold owns the finger.
        if (!g.free) {
          if (Math.max(performance.now() - g.now0, e.timeStamp - g.t0) >= HOLD_MS) return void (g.type = 'held');
          if (Math.abs(dx) <= SLOP_PX && Math.abs(dy) <= SLOP_PX) return;
          g.free = true;
        }
        if (heldPointers.has(g.id)) return void (g.type = 'held');
        if (Math.hypot(dx, dy) < LOCK_PX) return;
        const angle = (Math.atan2(Math.abs(dy), Math.abs(dx)) * 180) / Math.PI;
        s.width = el.clientWidth;
        if (angle <= SWIPE.lockAngle && s.width) {
          // Locked sideways: from here the page follows the finger 1:1, from where it is now, so nothing jumps.
          g.type = 'x';
          g.from = e.clientX;
          g.start = unstretch(s.pos, ...lim(), s.width, SWIPE.rubber);
          g.samples = [{ t: e.timeStamp, x: e.clientX }];
          setSwiping(true);
        } else if (angle <= NATIVE_ANGLE) {
          g.type = 'scroll';
          g.from = e.clientY;
          g.start = scrollerOf(el).scrollTop;
          g.samples = [{ t: e.timeStamp, x: e.clientY }];
        } else g.type = 'native';
        return;
      }
      if (g.type !== 'x' && g.type !== 'scroll') return;
      for (const c of coalesced(e)) g.samples.push({ t: c.timeStamp, x: g.type === 'x' ? c.clientX : c.clientY });
      while (g.samples.length > 2 && e.timeStamp - g.samples[0]!.t > 150) g.samples.shift();
      if (g.type === 'scroll') {
        scrollerOf(el).scrollTop = g.start - (e.clientY - g.from);
        return;
      }
      s.pos = stretch(g.start - (e.clientX - g.from), ...lim(), s.width, SWIPE.rubber);
      paint();
    };
    const up = (e: PointerEvent) => {
      const g = s.g;
      if (!g || e.pointerId !== g.id) return;
      end();
      if (g.type === 'x') {
        if (e.clientX !== g.samples.at(-1)?.x) g.samples.push({ t: e.timeStamp, x: e.clientX });
        // The finger's speed, as the page's: slowed by the stretch past one day, and toward the next day as it moves left.
        release(-velocity(g.samples, e.timeStamp) * stretchSlope(s.pos, ...lim(), s.width, SWIPE.rubber));
        // Letting go after a swipe isn't a tap on whatever is under the finger.
        swallowClick(el);
        return;
      }
      if (g.type === 'scroll') glide(-velocity(g.samples, e.timeStamp));
      // A page caught mid-spring, then tapped or scrolled, still settles on a day.
      if (g.caught) release(0);
    };
    const cancel = (e: PointerEvent) => {
      if (s.g && e.pointerId === s.g.id) giveUp();
    };
    // The browser took the finger back, or a second finger came down for a pinch: the page settles where it is.
    const giveUp = () => {
      const g = s.g;
      end();
      if (g && (g.type === 'x' || g.caught)) release(0);
    };
    // Once the swipe has locked, the page holds still: a vertical scroll can't start in the middle of it.
    const still = (e: TouchEvent) => {
      if (s.g?.type === 'x' || s.g?.type === 'scroll') e.preventDefault();
    };
    const end = () => {
      s.g = null;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('touchmove', still);
    };
    const down = (e: PointerEvent) => {
      // Fingers and pens swipe; a mouse has the strip.
      if (e.pointerType === 'mouse') return;
      if (s.g) return e.pointerId === s.g.id ? undefined : giveUp();
      const caught = !!s.anim;
      stopAnim();
      cancelAnimationFrame(s.glide);
      // Caught past halfway, the page is already on the next day: that day becomes the one the swipe starts from.
      const near = caught && s.width ? Math.round(s.pos / s.width) : 0;
      if (near) commit(near);
      s.g = { id: e.pointerId, type: 'pending', x0: e.clientX, y0: e.clientY, t0: e.timeStamp, now0: performance.now(), free: false, caught, samples: [], from: 0, start: 0 };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', cancel);
      window.addEventListener('touchmove', still, { passive: false });
    };
    el.addEventListener('pointerdown', down);
    return () => {
      el.removeEventListener('pointerdown', down);
      end();
      stopAnim();
      cancelAnimationFrame(s.glide);
      // Turned off mid-swipe, as editing starts: the day stays where it was.
      s.pos = 0;
      paint();
      setSwiping(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [o.enabled, s, paint]);

  // Each drawing puts the track where the page is, as the day changes under it. While swiping, the days either side sit
  // beside the day, each moved up or down so the time of day lines up across them, as it stays when the day changes.
  useLayoutEffect(() => {
    paint();
    const { day } = opts.current;
    const main = paneOf(day);
    if (main) main.style.transform = '';
    if (!swiping) return;
    const kept = keepTime(main, top());
    const at = kept && yOf(main, kept.minute);
    for (const side of [-1, 1]) {
      const pane = paneOf(addDays(day, side));
      if (!pane) continue;
      pane.style.transform = `translate3d(${side * 100}%, 0, 0)`;
      const there = kept && yOf(pane, kept.minute);
      if (at != null && there != null) pane.style.transform = `translate3d(${side * 100}%, ${at - there}px, 0)`;
    }
  });

  return { frame, track, swiping };
}

interface KeepProps {
  day: LocalDate;
  pane(day: LocalDate): HTMLElement | null;
  top(): number;
  initial: KeptTime | null;
  children: ReactNode;
}

/**
 * Keeps the time of day where it was when the day changes, by a swipe or a tap on a strip. The page is read just
 * before the new day is drawn, which only a class can do (getSnapshotBeforeUpdate).
 */
class KeepTime extends Component<KeepProps> {
  override componentDidMount() {
    const { initial, day, pane, top } = this.props;
    if (initial) restoreTime(pane(day), initial, top());
  }

  override getSnapshotBeforeUpdate(prev: KeepProps) {
    return prev.day === this.props.day ? null : keepTime(this.props.pane(prev.day), this.props.top());
  }

  override componentDidUpdate(_prev: KeepProps, _state: unknown, kept: KeptTime | null) {
    const pane = this.props.pane(this.props.day);
    // A day a swipe brought in was drawn beside, moved to line up; drawn as the day now, it's put back first.
    if (pane) pane.style.transform = '';
    if (kept) restoreTime(pane, kept, this.props.top());
  }

  override render() {
    return this.props.children;
  }
}

/**
 * One day, swiped to the day before or after. `render` draws a day: the one shown, and while a swipe lasts, the one
 * either side, hidden from assistive tech and out of reach of taps. `time`, given as it first draws, puts the time of
 * day where a swipe kept it, for a day drawn afresh after the swipe. Anything else goes on the frame.
 */
export function DayPager(
  props: DaySwipe & { render(day: LocalDate, shown: boolean): ReactNode; time?: KeptTime | null; ref?: Ref<HTMLDivElement> } & Omit<HTMLAttributes<HTMLDivElement>, 'onDay'>,
) {
  const { day, enabled, onDay, onNear, top, render, time, ref, className, ...rest } = props;
  const { frame, track, swiping } = useDaySwipe({ day, enabled, onDay, ...(onNear ? { onNear } : {}), ...(top ? { top } : {}) });
  const setFrame = useCallback(
    (el: HTMLDivElement | null) => {
      frame.current = el;
      if (typeof ref === 'function') ref(el);
      else if (ref) ref.current = el;
    },
    [frame, ref],
  );
  const days = swiping ? [addDays(day, -1), day, addDays(day, 1)] : [day];
  return (
    <div ref={setFrame} className={`dpager${className ? ` ${className}` : ''}`} data-swiping={swiping || undefined} {...rest}>
      <KeepTime day={day} pane={(d) => frame.current?.querySelector<HTMLElement>(`[data-day="${d}"]`) ?? null} top={() => top?.() ?? 0} initial={time ?? null}>
        <div ref={track} className="dptrack">
          {days.map((d) =>
            d === day ? (
              <div key={d} className="dppane" data-day={d}>
                {render(d, true)}
              </div>
            ) : (
              <div key={d} className="dppane dpside" data-day={d} aria-hidden="true" inert>
                {render(d, false)}
              </div>
            ),
          )}
        </div>
      </KeepTime>
    </div>
  );
}

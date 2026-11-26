// The week's strip on the phone's Today, folding away as the day scrolls (fold.ts has the numbers). It's three pieces in
// the page's own flow, so the day row can stick to the top through the whole day: the week row, which scrolls away with
// the day; the day row, which docks at the top and folds into a 44pt slim bar over the next 72pt of scroll; and the
// footer, which scrolls away under it. A scroll only asks for a frame, and each frame sets transform and opacity alone.
// Stopped half folded, the scroll springs to the nearer end; a finger, a wheel or any other scroll stops the spring.
// A tap on the slim bar opens the days again over the day without scrolling it, until the day scrolls or a day is
// tapped. Past halfway the slim bar is the one control taps and screen readers reach; before it, the seven days are.

import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { Icon } from '../ds/Icon';
import './week.css';
import { scrollerOf } from '../weekgrid/drop';
import { foldPaint, foldProgress, settleTo, springAt, springDone } from './fold';

/** How long the scroll rests, with no finger on it, before a half fold settles. */
const IDLE_MS = 140;
/** Opened from the slim bar, scrolling further than this folds it again. */
const REFOLD_PX = 8;
/** How long the days take to open from the slim bar, before focus goes to them. */
const OPENED_MS = 320;

export type Dot = 'past' | 'on' | '';

export function StripFold(props: {
  /** What the strip is called: "This week, Nov 23 to 29". */
  label: string;
  week: ReactNode;
  days: ReactNode;
  foot: ReactNode;
  /** The slim bar: the day shown, its date, what it says to a screen reader, and a dot for each day of the week. */
  slim: { name: string; date: string; label: string; dots: readonly Dot[] };
}) {
  const wk = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLElement>(null);
  // Folded or not, as it was last painted, so the attributes it sets survive the days being drawn again.
  const half = useRef(false);
  const apply = useRef<(folded: boolean) => void>(() => {});

  useEffect(() => {
    const fd = box.current;
    const row = wk.current;
    if (!fd || !row) return;
    const pane = scrollerOf(fd) as HTMLElement;
    const q = <T extends HTMLElement>(sel: string) => fd.querySelector<T>(sel)!;
    const [bg, card, slimBg, days, slim] = [q('.sfbg'), q('.sfcard'), q('.sfslimbg'), q('.sfdays'), q<HTMLButtonElement>('.sfslim')];
    const motion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const reduced = () => !!motion?.matches;
    let open = false;
    let shown = 0;
    let tween: { from: number; t0: number } | null = null;
    let settle: { from: number; to: number; t0: number; last: number } | null = null;
    let touching = false;
    let idle = 0;
    let openedAt = 0;
    let frame = 0;
    let lastHalf: boolean | null = null;

    // Where the day row docks: the bottom of the week row, in the page's scroll.
    const dockAt = () => row.getBoundingClientRect().bottom - pane.getBoundingClientRect().top + pane.scrollTop;
    const progress = () => foldProgress(pane.scrollTop, dockAt(), reduced());
    apply.current = (folded) => {
      days.style.pointerEvents = folded ? 'none' : '';
      if (folded) days.setAttribute('aria-hidden', 'true');
      else days.removeAttribute('aria-hidden');
      for (const b of days.querySelectorAll('button')) b.tabIndex = folded ? -1 : 0;
      slim.style.pointerEvents = folded ? 'auto' : 'none';
      slim.tabIndex = folded ? 0 : -1;
      if (folded) slim.removeAttribute('aria-hidden');
      else slim.setAttribute('aria-hidden', 'true');
    };
    const paint = (p: number) => {
      const f = foldPaint(p);
      bg.style.transform = `scaleY(${f.rowScale})`;
      card.style.transform = `scaleY(${f.rowScale})`;
      card.style.opacity = String(f.cardOpacity);
      slimBg.style.opacity = String(f.slimBgOpacity);
      days.style.opacity = String(f.daysOpacity);
      days.style.transform = `translateY(${f.daysShift.toFixed(2)}px) scale(${f.daysScale.toFixed(4)})`;
      slim.style.opacity = String(f.slimOpacity);
      slim.style.transform = `translateY(${f.slimShift.toFixed(2)}px)`;
      for (const d of slim.querySelectorAll<HTMLElement>('.sfdot')) d.style.transform = `scale(${f.dotScale.toFixed(3)})`;
      // Screen readers and taps change over only as the fold crosses halfway.
      if (f.folded === lastHalf) return;
      lastHalf = f.folded;
      half.current = f.folded;
      apply.current(f.folded);
    };
    const target = () => (open ? 0 : progress());
    const tick = (now: number) => {
      frame = 0;
      // A scroll from anything else, such as a drag or the keyboard, stops the settle rather than fighting it.
      if (settle && Math.abs(pane.scrollTop - settle.last) > 1) settle = null;
      if (settle) {
        const ms = now - settle.t0;
        pane.scrollTop = springAt(settle.from, settle.to, ms);
        settle.last = pane.scrollTop;
        if (springDone(settle.from, settle.to, ms)) {
          pane.scrollTop = settle.to;
          settle = null;
        }
      }
      if (tween) {
        const ms = now - tween.t0;
        shown = springAt(tween.from, target(), ms);
        if (springDone(tween.from, target(), ms)) tween = null;
      } else shown = target();
      paint(shown);
      if (settle || tween) kick();
    };
    const kick = () => {
      if (!frame) frame = requestAnimationFrame(tick);
    };
    const startTween = () => {
      tween = reduced() ? null : { from: shown, t0: performance.now() };
      kick();
    };
    const fold = () => {
      if (!open) return;
      open = false;
      fd.classList.remove('open');
      slim.setAttribute('aria-expanded', 'false');
      startTween();
    };
    const maybeSettle = () => {
      if (touching || settle || open || reduced()) return;
      const to = settleTo(pane.scrollTop, dockAt());
      if (to === null) return;
      settle = { from: pane.scrollTop, to, t0: performance.now(), last: pane.scrollTop };
      kick();
    };
    const rest = () => {
      clearTimeout(idle);
      idle = window.setTimeout(maybeSettle, IDLE_MS);
    };
    const onScroll = () => {
      if (open && Math.abs(pane.scrollTop - openedAt) > REFOLD_PX) fold();
      kick();
      rest();
    };
    const onTouchStart = () => {
      touching = true;
      settle = null;
    };
    const onTouchEnd = () => {
      touching = false;
      rest();
    };
    const onWheel = () => void (settle = null);
    const onSlim = () => {
      open = true;
      openedAt = pane.scrollTop;
      fd.classList.add('open');
      slim.setAttribute('aria-expanded', 'true');
      startTween();
      window.setTimeout(() => days.querySelector<HTMLElement>('[aria-pressed="true"]')?.focus({ preventScroll: true }), reduced() ? 0 : OPENED_MS);
    };
    const onDay = (e: Event) => {
      if ((e.target as Element).closest('button')) fold();
    };
    pane.addEventListener('scroll', onScroll, { passive: true });
    // A finger down, or a pointer pressed to hold or drag on the day, owns the scroll until it lifts.
    for (const type of ['touchstart', 'pointerdown']) pane.addEventListener(type, onTouchStart, { passive: true });
    for (const type of ['touchend', 'touchcancel', 'pointerup', 'pointercancel']) window.addEventListener(type, onTouchEnd, { passive: true });
    pane.addEventListener('wheel', onWheel, { passive: true });
    slim.addEventListener('click', onSlim);
    days.addEventListener('click', onDay);
    motion?.addEventListener('change', kick);
    paint(progress());
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(idle);
      pane.removeEventListener('scroll', onScroll);
      for (const type of ['touchstart', 'pointerdown']) pane.removeEventListener(type, onTouchStart);
      for (const type of ['touchend', 'touchcancel', 'pointerup', 'pointercancel']) window.removeEventListener(type, onTouchEnd);
      pane.removeEventListener('wheel', onWheel);
      slim.removeEventListener('click', onSlim);
      days.removeEventListener('click', onDay);
      motion?.removeEventListener('change', kick);
    };
  }, []);
  // The days drawn again, such as on another day, keep what the fold set on them.
  useEffect(() => apply.current(half.current));

  const { slim } = props;
  return (
    <>
      <div ref={wk} className="sfweek">
        {props.week}
      </div>
      <section ref={box} className="sffold" aria-label={props.label}>
        <i className="sfbg" />
        <i className="sfcard" />
        <i className="sfslimbg" />
        <div className="sfdays">{props.days}</div>
        <button type="button" className="sfslim" aria-expanded="false" aria-label={slim.label} tabIndex={-1} aria-hidden="true">
          <span>
            <span className="strong">{slim.name}</span> <span className="quiet">{slim.date}</span>
          </span>
          <span className="sfdots" aria-hidden="true">
            {slim.dots.map((d, i) => (
              <i key={i} className={`sfdot${d ? ` ${d}` : ''}`} />
            ))}
          </span>
          <Icon name="chevron-down" size={16} />
        </button>
      </section>
      <div className="sffoot">{props.foot}</div>
    </>
  );
}

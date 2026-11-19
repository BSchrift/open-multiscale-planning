// Hold to create, on every calendar: a press held still on empty time drafts an hour there, as the phone taps and a
// ring spreads from the finger, and letting go opens Capture with that time. Moving before the hold scrolls the page (a
// finger) or does nothing (a mouse); moving after it moves the draft, keeping its length. Each calendar draws the draft
// and the ring in its own geometry, and passes the draft's time to Capture, which can change its length and name it.
//
//   const hold = useHoldToCreate({ at, move, earliest, off: !!dragging });
//   <div onPointerDown={(e) => !onABlock(e) && hold.press(e)}>{hold.draft && <div ref={hold.draftRef} … />}</div>
//   {hold.draft?.open && <DraftCapture layout={layout} close={hold.close} slot={hold.slot(overlap)} />}

import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react';
import { createPortal } from 'react-dom';
import { formatMinutes, formatTimeOfDay } from '../../../core/dates';
import { DRAWN_DAY, holdSlot } from '../../../core/slots';
import type { HeldSlot, Slot } from '../../../core/slots';
import type { LocalDate, Minutes, TimeOfDay } from '../../../core/types';
import { useApp } from '../../app/store';
import type { CaptureSlot } from '../../screens/capture';
import { blockClass } from '../ds/Block';
import { useToast } from '../Toast';
import { DRAG_PX, HOLD_MS, SLOP_PX, swallowClick } from './drop';
import './hold.css';

/** Long enough for the ring's spread, which is twice --dur-slow. */
const RING_MS = 600;

export const PAST_TIME = 'That time has gone by. Hold on a later time.';

/** The draft a hold made, which the calendar draws while it's held and while Capture is open on it. */
export interface HeldDraft {
  slot: Slot;
  /** Where the hold moved it: past the time gone by, or back within the day. */
  moved: HeldSlot['moved'];
  /** What Capture's name field says, for the draft to show. */
  name: string;
  /** Let go, so Capture is open on it. */
  open: boolean;
  /** Just drafted, so it pops in; once moved it doesn't again. */
  fresh: boolean;
}

/** Where the ring spreads from: the press, on the screen. */
export interface HeldRing {
  x: number;
  y: number;
  key: number;
}

/**
 * The ring that spreads from the finger as a draft appears, drawn over the page at the layout's root, where the press
 * was on the screen, so it shows the same on every calendar. The page holds still while a draft is held.
 */
export function HoldRing(props: { ring: HeldRing | null }) {
  const { ring } = props;
  if (!ring) return null;
  const drawn = <span key={ring.key} className="holdring" style={{ left: ring.x, top: ring.y }} aria-hidden="true" />;
  const root = document.querySelector<HTMLElement>('[data-layout]');
  return root ? createPortal(drawn, root) : drawn;
}

/** How tall a block is drawn before a second line fits under its title: on phone the line sits under it, on desktop beside. */
export const SECOND_LINE = { phone: 40, desktop: 24 };

/**
 * The draft on a day drawn as a column of blocks, Today's timeline and Week's phone day: a block being placed, beside
 * what it overlaps, as a block that clashes is drawn. Its time goes on a second line where there's room, and before its
 * name where there isn't.
 */
export function DraftBlock(props: { hold: { draft: HeldDraft | null; draftRef: RefObject<HTMLDivElement | null> }; top: number; height: number; beside: boolean }) {
  const { layout } = useApp();
  const { draft, draftRef } = props.hold;
  if (!draft) return null;
  const { start, end } = draft.slot;
  const height = Math.max(13, props.height);
  const short = height < 24;
  const lines = height >= SECOND_LINE[layout];
  const time = `${formatTimeOfDay(start)} to ${formatTimeOfDay(end)}`;
  return (
    <div
      ref={draftRef}
      className={`cev holddraft ${blockClass('project', 'placing', { short })}${short ? ' compact' : ''}${draft.fresh ? ' pop' : ''}`}
      style={{ top: props.top, height, left: props.beside ? '50%' : '4px', right: '4px' }}
      title={time}
      aria-hidden="true"
    >
      <span className="cevt">
        <span className="blktitle">
          {lines ? '' : `${formatTimeOfDay(start)} `}
          {draft.name.trim() || 'New task'}
        </span>
      </span>
      {lines && <span className="time">{time}</span>}
    </div>
  );
}

const same = (a: Slot, b: Slot) => a.date === b.date && a.start === b.start && a.end === b.end;

/** Why the draft isn't quite where it was held, in Capture's words. */
function movedNote(draft: HeldDraft, to: TimeOfDay): string | undefined {
  const start = formatTimeOfDay(draft.slot.start);
  if (draft.moved === 'next') return `Starts at ${start}, the next quarter hour.`;
  if (draft.moved === 'end') return `Starts at ${start} to keep its hour: the calendar ends at ${formatTimeOfDay(to)}.`;
  if (draft.moved === 'short') return `Ends at ${formatTimeOfDay(to)}, where the calendar ends.`;
  return undefined;
}

/** "Overlaps Team sync prep by 15m.", for the first of these the draft overlaps. */
export function overlapWords(slot: Slot, others: readonly { title: string; start: number; end: number }[]): string | undefined {
  const o = [...others].sort((a, b) => a.start - b.start).find((x) => x.start < slot.end && slot.start < x.end);
  return o && `Overlaps ${o.title} by ${formatMinutes(Math.min(o.end, slot.end) - Math.max(o.start, slot.start))}.`;
}

export function useHoldToCreate(opts: {
  /** The day and minute at a point in the pressed element, measured from its top left, or null for none. */
  at(x: number, y: number, el: HTMLElement): { date: LocalDate; minute: number } | null;
  /** Where a draft held at `from` goes once the pointer has moved by dx and dy, as a held block would; null stays put. */
  move(from: Slot, dx: number, dy: number, el: HTMLElement): Slot | null;
  /** Now: nothing is drafted before it. */
  earliest: { date: LocalDate; minutes: TimeOfDay };
  /** Where the calendar's day ends. */
  to?: TimeOfDay;
  /** While another block is selected, being moved or being placed. */
  off?: boolean;
}) {
  const { platform, layout } = useApp();
  const toast = useToast();
  const live = useRef(opts);
  live.current = opts;
  const [draft, setDraft] = useState<HeldDraft | null>(null);
  const [ring, setRing] = useState<HeldRing | null>(null);
  const draftRef = useRef<HTMLDivElement | null>(null);
  const drafted = useRef(false);
  drafted.current = !!draft;
  /** Ends the press under way, as a second finger does. */
  const pressing = useRef<(() => void) | null>(null);
  const to = () => live.current.to ?? DRAWN_DAY.to;

  useEffect(() => () => pressing.current?.(), []);
  useEffect(() => {
    if (!ring) return;
    const timer = setTimeout(() => setRing(null), RING_MS);
    return () => clearTimeout(timer);
  }, [ring]);
  // On phone, Capture's sheet rises from the bottom, so the draft goes up the page, above it, and below the week's top,
  // which stays stuck over Week's day and the Schedule step's.
  const open = !!draft?.open;
  useEffect(() => {
    const el = draftRef.current;
    if (!open || layout !== 'phone' || !el) return;
    const stuck = document.querySelector('.weektop')?.getBoundingClientRect().bottom ?? 0;
    el.style.scrollMarginTop = `${Math.max(0, stuck) + 8}px`;
    el.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  }, [open, layout]);

  const press = (event: ReactPointerEvent<HTMLElement>) => {
    if (pressing.current) return pressing.current();
    if (event.button !== 0 || live.current.off || drafted.current) return;
    const mouse = event.pointerType === 'mouse';
    // So a mouse held still selects no text.
    if (mouse) event.preventDefault();
    const el = event.currentTarget;
    const box = el.getBoundingClientRect();
    const [x0, y0] = [event.clientX, event.clientY];
    // From the events' own times, which say when the finger moved or lifted however late a busy page hears of it.
    const pressed = event.timeStamp;
    let held: Slot | null = null;
    const own = (e: Event) => (e as PointerEvent).pointerId === event.pointerId;
    const lift = () => {
      clearTimeout(timer);
      const at = live.current.at(x0 - box.left, y0 - box.top, el);
      const slot = at && holdSlot(at.date, at.minute, live.current.earliest, to());
      if (!at || !slot) {
        stop();
        if (at) toast.show(PAST_TIME);
        return;
      }
      held = { date: slot.date, start: slot.start, end: slot.end };
      setDraft({ slot: held, moved: slot.moved, name: '', open: false, fresh: true });
      setRing({ x: x0, y: y0, key: pressed });
      void platform.haptic?.();
    };
    const on: Record<string, (ev: Event) => void> = {
      pointermove: (ev) => {
        const m = ev as PointerEvent;
        if (!own(m)) return;
        if (!held) {
          // Held long enough, though a busy page ran the timer late: it drafts rather than reading as a swipe.
          if (m.timeStamp - pressed >= HOLD_MS) lift();
          else {
            const [dx, dy] = [m.clientX - x0, m.clientY - y0];
            if (mouse ? Math.hypot(dx, dy) >= DRAG_PX : Math.abs(dx) > SLOP_PX || Math.abs(dy) > SLOP_PX) stop();
            return;
          }
          if (!held) return;
        }
        const next = live.current.move(held, m.clientX - x0, m.clientY - y0, el);
        if (next) setDraft((d) => d && (same(d.slot, next) ? d : { ...d, slot: next, moved: null, fresh: false }));
      },
      pointerup: (ev) => {
        if (!own(ev)) return;
        // Let go after the hold, though the timer hasn't run yet on a busy page.
        if (!held && ev.timeStamp - pressed >= HOLD_MS) lift();
        stop();
        if (!held) return;
        // Letting go isn't a click on whatever is under the finger.
        swallowClick(el);
        setDraft((d) => d && { ...d, open: true });
      },
      pointercancel: (ev) => {
        if (!own(ev)) return;
        cancel();
      },
      // A second finger is a pinch.
      touchstart: (ev) => {
        if ((ev as TouchEvent).touches.length > 1) cancel();
      },
      // Once held, the page stays still under the finger and the long-press menu stays away.
      touchmove: (ev) => {
        if (held) ev.preventDefault();
      },
      contextmenu: (ev) => {
        if (held) ev.preventDefault();
      },
    };
    const stop = () => {
      clearTimeout(timer);
      pressing.current = null;
      for (const [k, f] of Object.entries(on)) window.removeEventListener(k, f);
    };
    const cancel = () => {
      stop();
      if (held) setDraft(null);
    };
    pressing.current = cancel;
    for (const [k, f] of Object.entries(on)) window.addEventListener(k, f, k === 'touchmove' ? { passive: false } : undefined);
    const timer = setTimeout(lift, HOLD_MS);
  };

  /** What Capture is given: the draft's time, which its Time slider lengthens and its name field names. */
  const slot = (overlap?: string): CaptureSlot | undefined =>
    draft
      ? {
          slot: draft.slot,
          note: movedNote(draft, to()),
          overlap,
          onLength: (minutes: Minutes) => setDraft((d) => d && { ...d, slot: { ...d.slot, end: Math.min(to(), d.slot.start + minutes) }, moved: null, fresh: false }),
          onName: (name: string) => setDraft((d) => d && { ...d, name }),
          anchor: () => draftRef.current?.getBoundingClientRect(),
        }
      : undefined;

  return { draft, ring, draftRef, press, slot, close: () => setDraft(null) };
}

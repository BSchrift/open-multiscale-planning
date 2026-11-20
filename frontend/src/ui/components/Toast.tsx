// A short message at the bottom of the screen, with Undo when a change can be reversed. And a green check over the page,
// as Process closes on a clear Inbox, which holds a moment then fades by itself; a toast shown with it waits for it.
//
//   const toast = useToast();
//   toast.show('Task moved', { undo: () => restore() });
//   toast.check('Inbox clear', '12 items processed', true);

import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

const PLAIN_MS = 3500;
const WITH_UNDO_MS = 5000;
/** The check draws in 0.7s, holds about 1.5s, then fades over 0.4s, or 0.15s with less motion. */
const CHECK_MS = 2200;
const FADE_MS = 400;
const FADE_LESS_MS = 150;

interface ToastOptions {
  /** Shows an Undo button that runs this and dismisses the toast. */
  undo?: () => void | Promise<unknown>;
  /** Moves focus to Undo, for when the control that made the change has gone. */
  focusUndo?: boolean;
  /** Said after the message but not shown, such as what the change leaves free. */
  spoken?: string;
  /** Stays until the next action, such as a tap, rather than going after a few seconds: for a change made out of sight. */
  stay?: boolean;
}

interface ToastApi {
  show(message: string, options?: ToastOptions): void;
  /** The green check, with what it says: a title, and under it a count, green when all is done, or a quieter line. */
  check(title: string, detail: string, done: boolean): void;
}

const ToastContext = createContext<ToastApi | null>(null);

/**
 * Listens for taps that begin while it listens, and calls back as each finishes, on its click. Not the click that ends a
 * press begun before, such as the drag whose drop showed a toast, nor one from Enter or Space, which comes with no press:
 * keys never put a toast away. Returns what stops it.
 */
function onTaps(tap: (target: Element) => void): () => void {
  let pressed = false;
  const down = () => void (pressed = true);
  const click = (event: MouseEvent) => {
    if (pressed) tap(event.target as Element);
    pressed = false;
  };
  document.addEventListener('pointerdown', down, true);
  document.addEventListener('click', click, true);
  return () => {
    document.removeEventListener('pointerdown', down, true);
    document.removeEventListener('click', click, true);
  };
}

export function useToast(): ToastApi {
  const toast = useContext(ToastContext);
  if (!toast) throw new Error('useToast needs a ToastProvider');
  return toast;
}

interface Current extends ToastOptions {
  message: string;
  key: number;
}

interface Check {
  title: string;
  detail: string;
  done: boolean;
  /** Fading out, by itself or put away sooner. */
  leaving: boolean;
}

export function ToastProvider(props: { children: ReactNode }) {
  const [current, setCurrent] = useState<Current | null>(null);
  const [check, setCheck] = useState<Check | null>(null);
  // Focus or the mouse on the toast holds it open, so Undo can't vanish while someone is reaching for it.
  const [held, setHeld] = useState({ focus: false, hover: false });
  const counter = useRef(0);
  const cameFrom = useRef<HTMLElement | null>(null);
  const toastEl = useRef<HTMLDivElement>(null);
  const undoEl = useRef<HTMLButtonElement>(null);

  const api = useMemo<ToastApi>(
    () => ({
      show: (message, options = {}) => setCurrent({ ...options, message, key: ++counter.current }),
      check: (title, detail, done) => setCheck({ title, detail, done, leaving: false }),
    }),
    [],
  );

  // The check holds, then fades. A tap or Esc puts it away sooner; it never takes focus. A tap counts once it finishes,
  // its click: put away as the finger went down, the toast waiting behind the check came in and moved the page, so the
  // release landed on something else.
  useEffect(() => {
    if (!check) return;
    if (check.leaving) {
      const less = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      const timer = setTimeout(() => setCheck(null), less ? FADE_LESS_MS : FADE_MS);
      return () => clearTimeout(timer);
    }
    const leave = () => setCheck((c) => c && { ...c, leaving: true });
    const timer = setTimeout(leave, CHECK_MS);
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && leave();
    const stopTaps = onTaps(leave);
    document.addEventListener('keydown', onKey, true);
    return () => {
      clearTimeout(timer);
      stopTaps();
      document.removeEventListener('keydown', onKey, true);
    };
  }, [check]);

  useEffect(() => {
    // A toast waiting for the check isn't showing yet, so nothing puts it away.
    if (!current || check) return;
    // A tap on the message or anywhere else puts it away; only Undo keeps it for its own click. Once the tap finishes,
    // on its click: on phone the toast holds space above the bottom bar, and put away as the finger went down, the page
    // moved under it, so the release pressed whatever had moved there.
    return onTaps((target) => {
      if (!target.closest?.('.toastact')) setCurrent(null);
    });
  }, [current, !!check]);

  // A toast that takes another's place is the same element with a new message, so the mouse resting on it and focus on
  // its Undo go on holding it. Focus is read afresh with each message, since a focused Undo that goes, or the toast
  // going, sends no blur; and the mouse is let go with the toast, which sends no leave.
  const showing = !!current && !check;
  useLayoutEffect(() => {
    if (!showing) {
      setHeld((h) => (h.focus || h.hover ? { focus: false, hover: false } : h));
      return;
    }
    if (current.focusUndo) undoEl.current?.focus();
    const focus = !!toastEl.current?.contains(document.activeElement);
    setHeld((h) => (h.focus === focus ? h : { ...h, focus }));
  }, [current, showing]);

  // The browser's own pointerenter and pointerleave, not React's. React makes its enter from a pointerout on what the
  // mouse was over before, and when a change took that away, as Week takes away the card or button just pressed, the
  // browser sends none: the mouse reaches the toast and React says nothing. WebKit reports a finger as a pointer that
  // never leaves, so only a mouse holds it. Listening from before the toast is painted, for a mouse already where it shows.
  useLayoutEffect(() => {
    const el = toastEl.current;
    if (!showing || !el) return;
    const hover = (on: boolean) => (event: PointerEvent) => event.pointerType === 'mouse' && setHeld((h) => (h.hover === on ? h : { ...h, hover: on }));
    const enter = hover(true);
    const leave = hover(false);
    el.addEventListener('pointerenter', enter);
    el.addEventListener('pointerleave', leave);
    return () => {
      el.removeEventListener('pointerenter', enter);
      el.removeEventListener('pointerleave', leave);
    };
  }, [showing]);

  const paused = held.focus || held.hover;
  useEffect(() => {
    if (!current || paused || check || current.stay) return;
    const timer = setTimeout(() => setCurrent(null), current.undo ? WITH_UNDO_MS : PLAIN_MS);
    return () => clearTimeout(timer);
  }, [current, paused, !!check]);

  return (
    <ToastContext.Provider value={api}>
      {props.children}
      {/* The live region stays mounted so screen readers announce what appears inside it. */}
      <div role="status" aria-live="polite">
        {check && (
          <div className={`clearveil${check.leaving ? ' leaving' : ''}`}>
            <div className="clearcard">
              <svg className="doneck" width="64" height="64" viewBox="0 0 56 56" aria-hidden="true">
                <circle cx="28" cy="28" r="24" />
                <path d="M17 29l7.5 7.5L39 21" />
              </svg>
              <p className="cleartitle">{check.title}</p>
              <p className={check.done ? 'clearcount' : 'clearmore'}>{check.detail}</p>
            </div>
          </div>
        )}
        {current && !check && (
          <div
            ref={toastEl}
            className={current.undo ? 'toast withaction' : 'toast'}
            onFocus={() => setHeld((h) => ({ ...h, focus: true }))}
            onBlur={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget)) setHeld((h) => ({ ...h, focus: false }));
            }}
          >
            {/* A new element for each message, so screen readers announce it even when it repeats the last. */}
            <span key={current.key}>
              {current.message}
              {current.spoken && <span className="sr"> {current.spoken}</span>}
            </span>
            {current.undo && (
              <button
                className="toastact"
                type="button"
                ref={undoEl}
                // Reached by Tab from a dialog's last control, Tab goes back there, either way.
                onFocus={(e) => void (cameFrom.current = e.relatedTarget as HTMLElement | null)}
                onKeyDown={(e) => {
                  if (e.key !== 'Tab' || !cameFrom.current?.isConnected || !cameFrom.current.closest('[role=dialog]')) return;
                  e.preventDefault();
                  cameFrom.current.focus();
                }}
                onClick={() => {
                  void current.undo?.();
                  setCurrent(null);
                }}
              >
                Undo
              </button>
            )}
          </div>
        )}
      </div>
    </ToastContext.Provider>
  );
}

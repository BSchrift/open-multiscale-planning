// A short message at the bottom of the screen, with Undo when a change can be reversed. And a green check over the page,
// as Process closes on a clear Inbox, which holds a moment then fades by itself; a toast shown with it waits for it.
//
//   const toast = useToast();
//   toast.show('Task moved', { undo: () => restore() });
//   toast.check('Inbox clear', '12 items processed', true);

import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
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

  const api = useMemo<ToastApi>(
    () => ({
      show: (message, options = {}) => {
        setHeld({ focus: false, hover: false });
        setCurrent({ ...options, message, key: ++counter.current });
      },
      check: (title, detail, done) => setCheck({ title, detail, done, leaving: false }),
    }),
    [],
  );

  // The check holds, then fades. A tap or Esc puts it away sooner; it never takes focus.
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
    document.addEventListener('pointerdown', leave, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('pointerdown', leave, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [check]);

  useEffect(() => {
    // A toast waiting for the check isn't showing yet, so nothing puts it away.
    if (!current || check) return;
    // A tap on the message or anywhere else puts it away; only Undo keeps it for its own click.
    const away = (event: PointerEvent) => {
      if (!(event.target as Element).closest?.('.toastact')) setCurrent(null);
    };
    document.addEventListener('pointerdown', away, true);
    return () => document.removeEventListener('pointerdown', away, true);
  }, [current, !!check]);

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
            key={current.key}
            className={current.undo ? 'toast withaction' : 'toast'}
            onFocus={() => setHeld((h) => ({ ...h, focus: true }))}
            onBlur={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget)) setHeld((h) => ({ ...h, focus: false }));
            }}
            // WebKit reports a finger as a pointer that never leaves, so only a mouse holds it.
            onPointerEnter={(e) => e.pointerType === 'mouse' && setHeld((h) => ({ ...h, hover: true }))}
            onPointerLeave={(e) => e.pointerType === 'mouse' && setHeld((h) => ({ ...h, hover: false }))}
          >
            <span>
              {current.message}
              {current.spoken && <span className="sr"> {current.spoken}</span>}
            </span>
            {current.undo && (
              <button
                className="toastact"
                type="button"
                autoFocus={current.focusUndo}
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

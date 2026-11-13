// A short message at the bottom of the screen, with Undo when a change can be reversed.
//
//   const toast = useToast();
//   toast.show('Task moved', { undo: () => restore() });

import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

const PLAIN_MS = 3500;
const WITH_UNDO_MS = 5000;

interface ToastOptions {
  /** Shows an Undo button that runs this and dismisses the toast. */
  undo?: () => void | Promise<unknown>;
  /** Moves focus to Undo, for when the control that made the change has gone. */
  focusUndo?: boolean;
  /** Said after the message but not shown, such as what the change leaves free. */
  spoken?: string;
}

interface ToastApi {
  show(message: string, options?: ToastOptions): void;
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

export function ToastProvider(props: { children: ReactNode }) {
  const [current, setCurrent] = useState<Current | null>(null);
  // Focus or the mouse on the toast holds it open, so Undo can't vanish while someone is reaching for it.
  const [held, setHeld] = useState({ focus: false, hover: false });
  const counter = useRef(0);

  const api = useMemo<ToastApi>(
    () => ({
      show: (message, options = {}) => {
        setHeld({ focus: false, hover: false });
        setCurrent({ ...options, message, key: ++counter.current });
      },
    }),
    [],
  );

  useEffect(() => {
    if (!current) return;
    // A tap on the message or anywhere else puts it away; only Undo keeps it for its own click.
    const away = (event: PointerEvent) => {
      if (!(event.target as Element).closest?.('.toastact')) setCurrent(null);
    };
    document.addEventListener('pointerdown', away, true);
    return () => document.removeEventListener('pointerdown', away, true);
  }, [current]);

  const paused = held.focus || held.hover;
  useEffect(() => {
    if (!current || paused) return;
    const timer = setTimeout(() => setCurrent(null), current.undo ? WITH_UNDO_MS : PLAIN_MS);
    return () => clearTimeout(timer);
  }, [current, paused]);

  return (
    <ToastContext.Provider value={api}>
      {props.children}
      {/* The live region stays mounted so screen readers announce what appears inside it. */}
      <div role="status" aria-live="polite">
        {current && (
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

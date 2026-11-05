import { useEffect, useRef, useState } from 'react';

// WebKit doesn't focus a button you tap, so the opener is the last button pressed, until a key is used instead.
let pressed: HTMLElement | null = null;
document.addEventListener('pointerdown', (event) => void (pressed = (event.target as Element).closest?.<HTMLElement>('button,a[href]') ?? null), true);
document.addEventListener('keydown', () => void (pressed = null), true);

/** Traps Tab inside a dialog, closes on Esc, and returns focus to where it was on close. */
export function useDialogFocus<E extends HTMLElement>(onClose: () => void) {
  const ref = useRef<E>(null);
  const close = useRef(onClose);
  close.current = onClose;
  // Read while rendering, before an autoFocus field inside can take focus.
  const [returnTo] = useState(() => (pressed?.isConnected ? pressed : (document.activeElement as HTMLElement | null)));
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const focusables = () =>
      Array.from(
        element.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'),
      );
    // The dialog itself takes focus unless something inside asked for it with autoFocus, so Enter can't fire a button.
    if (!element.contains(document.activeElement)) element.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close.current();
      } else if (event.key === 'Tab') {
        const items = focusables();
        const first = items[0];
        const last = items[items.length - 1];
        if (!first || !last) {
          event.preventDefault();
        } else if (event.shiftKey && (document.activeElement === first || document.activeElement === element)) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    element.addEventListener('keydown', onKey);
    return () => {
      element.removeEventListener('keydown', onKey);
      // Only once the dialog has gone: StrictMode also runs this cleanup on mount, with the dialog still there. And
      // only if focus went with it, so a dialog closing on its own (a sync answered it) leaves your typing alone.
      const lost = !document.activeElement || document.activeElement === document.body;
      if (!element.isConnected && lost) returnTo?.focus?.();
    };
  }, []);
  return ref;
}

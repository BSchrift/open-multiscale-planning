import { useEffect, useRef } from 'react';

type Find = () => HTMLElement | null | undefined;

/**
 * For a control that takes itself away, such as a row's Remove or a question's answer: call land() with where
 * focus should go. Once the control has gone and focus has fallen to the page (or to a container around that
 * place), it moves there. It's forgotten at the next key or press, so it never pulls focus later.
 */
export function useFocusLanding() {
  const target = useRef<Find | null>(null);
  useEffect(() => {
    const forget = () => {
      target.current = null;
    };
    // Capture runs before the control's own handler, so the press that calls land() doesn't clear it.
    document.addEventListener('keydown', forget, true);
    document.addEventListener('pointerdown', forget, true);
    return () => {
      document.removeEventListener('keydown', forget, true);
      document.removeEventListener('pointerdown', forget, true);
    };
  }, []);
  useEffect(() => {
    const find = target.current;
    if (!find) return;
    // A tap on phone WebKit focuses the page around the control rather than the control, from the start, so the
    // place may not have arrived yet.
    const place = find();
    const active = document.activeElement;
    if (!place || (active && active !== document.body && !active.contains(place))) return;
    target.current = null;
    place.focus();
  });
  return (find: Find) => {
    target.current = find;
  };
}

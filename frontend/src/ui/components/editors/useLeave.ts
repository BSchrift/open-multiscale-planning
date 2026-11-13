import { useRef } from 'react';

export const UNSAVED = "Your changes aren't saved. Save them, or Cancel to drop them.";
export const DATE_UNSET = "This date isn't set yet. Set it, or Cancel to drop it.";

/**
 * The ways out of an editor that say neither Save nor Cancel: Esc, the backdrop, a click outside, a close icon, a
 * row's toggle. With nothing changed they close it. With changes it stays open and says so, with focus on its save
 * button, so nothing typed is thrown away unasked. leave resolves to whether it closed.
 */
export function useLeave(changed: boolean, close: () => void, say: (text: string) => void, text = UNSAVED) {
  const saveRef = useRef<HTMLButtonElement>(null);
  const leave = () => {
    if (!changed) {
      close();
      return true;
    }
    say(text);
    saveRef.current?.focus();
    return false;
  };
  return { saveRef, leave };
}

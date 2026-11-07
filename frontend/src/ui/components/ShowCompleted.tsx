// Show N completed, or Hide completed, under a task list whose completed tasks wait out of view, and the tick that
// sends a task there.

import { useApp, useStickyState } from '../app/store';
import { useToast } from './Toast';
import { useFocusLanding } from './useFocusLanding';

/** Nothing while the list has nothing completed. `list` names the list for screen readers, as a page can have several. */
export function ShowCompleted(props: { count: number; list: string }) {
  const { layout } = useApp();
  const [shown, setShown] = useStickyState('showCompleted', false);
  if (!props.count) return null;
  const text = shown ? 'Hide completed' : `Show ${props.count} completed`;
  return (
    <div>
      <button
        className={`${layout === 'phone' ? 'link' : 'link small'} showcompleted`}
        type="button"
        aria-expanded={shown}
        aria-label={`${text} in ${props.list}`}
        onClick={() => setShown(!shown)}
      >
        {text}
      </button>
    </div>
  );
}

/**
 * A tick that takes its row out of view: focus moves on to the next row's tick, else to the list's Show completed,
 * and a toast offers Undo, which brings focus back to the row. Focus lands as the calling component renders, so call
 * this from one that stays while the row goes. `tick` resolves to something truthy once saved.
 */
export function useTickAway() {
  const toast = useToast();
  const land = useFocusLanding();
  return async (box: HTMLInputElement, title: string, tick: () => Promise<unknown>, untick: () => Promise<unknown>) => {
    const list = box.closest('.taskline, .maintrow')?.parentElement;
    const boxes = () => [...(list?.querySelectorAll<HTMLInputElement>('input[type="checkbox"]') ?? [])];
    const all = boxes();
    // Past any that can't be ticked, such as cancelled ones.
    const next = all.slice(all.indexOf(box) + 1).find((c) => !c.disabled);
    land(() => next ?? list?.querySelector<HTMLElement>('.showcompleted'));
    if (!(await tick())) return;
    toast.show(`Completed ${title}.`, {
      undo: () => {
        land(() => boxes().find((c) => c.getAttribute('aria-label') === `${title} done`));
        return untick();
      },
    });
  };
}

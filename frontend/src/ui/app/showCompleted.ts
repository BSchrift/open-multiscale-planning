// Whether task lists show completed tasks among the open ones. Hidden by default; one choice for every list, kept on
// this device only, like the appearance.

import { useStickyState } from './store';

/** Where it's kept, for an account switch to leave alone. */
export const SHOW_COMPLETED_KEY = 'multiscale.showCompleted';

/** The choice and its setter, for Show completed itself. */
export const useShowCompletedState = () => useStickyState('showCompleted', false);

/** The choice, for a list that only reads it. */
export function useShowCompleted(): boolean {
  return useShowCompletedState()[0];
}

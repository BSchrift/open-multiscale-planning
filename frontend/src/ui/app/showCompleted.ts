// Whether task lists show completed tasks among the open ones. Hidden by default; one choice for every list, kept on
// this device only, like the appearance. It's useStickyState('showCompleted', false), which ShowCompleted sets.

import { useStickyState } from './store';

/** Where it's kept, for an account switch to leave alone. */
export const SHOW_COMPLETED_KEY = 'multiscale.showCompleted';

/** The choice, for a list that only reads it. */
export function useShowCompleted(): boolean {
  return useStickyState('showCompleted', false)[0];
}

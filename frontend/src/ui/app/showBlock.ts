// A widget's link to a block on Today asks Today to bring it into view, as a notification asks for a prompt. Its own
// module, so Today's code doesn't carry the widgets', which only the iPhone loads (widgets.ts).

import { useSyncExternalStore } from 'react';

let blockRequest: string | null = null;
const blockListeners = new Set<() => void>();

export function requestShowBlock(blockId: string | null): void {
  blockRequest = blockId;
  for (const notify of blockListeners) notify();
}

/** The block a widget asked Today to show, if any. Clear it with requestShowBlock(null) once shown. */
export function useShowBlockRequest(): string | null {
  return useSyncExternalStore(
    (notify) => {
      blockListeners.add(notify);
      return () => void blockListeners.delete(notify);
    },
    () => blockRequest,
  );
}

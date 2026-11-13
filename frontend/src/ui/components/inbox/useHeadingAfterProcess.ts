import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { useOverlay } from '../../app/nav';

/**
 * Once Process closes with the Inbox emptied, focus goes to the page's heading: the Process button it would go back to
 * has gone with the last item. The list may catch up a moment after Process has closed, taking that button with it, so
 * it waits for that.
 */
export function useHeadingAfterProcess(heading: RefObject<HTMLElement | null>, empty: boolean) {
  const overlay = useOverlay();
  const processing = useRef(false);
  const pending = useRef(false);
  useEffect(() => {
    if (overlay?.area === 'process') {
      processing.current = true;
      return;
    }
    if (processing.current && !overlay) {
      processing.current = false;
      pending.current = true;
    }
    if (!pending.current || !empty) return;
    pending.current = false;
    // Focus that went back to something still there stays.
    const active = document.activeElement;
    if (!active || active === document.body || !active.isConnected) heading.current?.focus();
  }, [overlay, empty, heading]);
}

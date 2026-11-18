// Text shared to the app from the iPhone share sheet waits in a native queue until the app opens. This saves it to
// the Inbox, on launch and each time the app comes to the front, and only then takes it off the queue, so a failed
// save or a quit before the next try loses nothing.
// shortcut: a crash between saving and taking items off the queue imports them again; give each task an id from its
// queue item if duplicates ever show up.

import { useEffect, useRef } from 'react';
import { captureShare } from '../../core/captureShare';
import { transact } from '../../core/records';
import { useApp, useStickyState } from './store';

/** The Inbox items whose shared description was cut, on this device, for Process to say so. */
export const useCutShares = () => useStickyState<string[]>('cutShares', []);

export function useShareImport(): void {
  const { platform, db, clock } = useApp();
  const [cutShares, setCutShares] = useCutShares();
  const latest = useRef(cutShares);
  latest.current = cutShares;
  useEffect(() => {
    const share = platform.shareImport;
    if (!share) return;
    let chain = Promise.resolve();
    const run = async () => {
      const items = await share.peek();
      if (items.length === 0) return;
      const cut: string[] = [];
      await transact(db, clock, async (w) => {
        for (const { text } of items) {
          // From other apps, so tidied like any capture, or dropped if blank.
          const shared = captureShare(String(text));
          if (!shared) continue;
          const id = await w.create('task', { kind: 'inbox', title: shared.title, ...(shared.notes ? { notes: shared.notes } : {}) });
          if (shared.link) await w.create('attachment', { task_id: id, kind: 'link', name: shared.link, url: shared.link });
          if (shared.cut) cut.push(id);
        }
      });
      // The latest 50 at most: each matters only until its item is processed. Kept here too, for a run before the next render.
      if (cut.length > 0) setCutShares((latest.current = [...latest.current, ...cut].slice(-50)));
      await share.remove(items.map((item) => item.id));
    };
    // One run at a time, so a foreground during a save can't save the same items twice.
    const next = () => {
      chain = chain.then(run).catch((error: unknown) => console.error('Share import failed', error));
    };
    next();
    return platform.lifecycle.onForeground(next);
  }, [platform, db, clock, setCutShares]);
}

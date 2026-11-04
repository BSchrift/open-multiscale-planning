// Text shared to the app from the iPhone share sheet waits in a native queue until the app opens. This saves it to
// the Inbox, on launch and each time the app comes to the front, and only then takes it off the queue, so a failed
// save or a quit before the next try loses nothing.
// shortcut: a crash between saving and taking items off the queue imports them again; give each task an id from its
// queue item if duplicates ever show up.

import { useEffect } from 'react';
import { transact } from '../../core/records';
import { useApp } from './store';

/** The longest title a share can make, as for any capture. */
const MAX_TITLE = 2000;

/** Shared text comes from other apps, so it's tidied into a one-line title, or dropped if blank. */
function titleOf(text: string): string | null {
  const title = text.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE).trim();
  return title || null;
}

export function useShareImport(): void {
  const { platform, db, clock } = useApp();
  useEffect(() => {
    const share = platform.shareImport;
    if (!share) return;
    let chain = Promise.resolve();
    const run = async () => {
      const items = await share.peek();
      if (items.length === 0) return;
      await transact(db, clock, async (w) => {
        for (const { text } of items) {
          const title = titleOf(String(text));
          if (title) await w.create('task', { kind: 'inbox', title });
        }
      });
      await share.remove(items.map((item) => item.id));
    };
    // One run at a time, so a foreground during a save can't save the same items twice.
    const next = () => {
      chain = chain.then(run).catch((error: unknown) => console.error('Share import failed', error));
    };
    next();
    return platform.lifecycle.onForeground(next);
  }, [platform, db, clock]);
}

// Text shared to the app from the iPhone share sheet waits in a native queue until the app opens. This saves it to
// the Inbox, on launch and each time the app comes to the front, and only then takes it off the queue, so a failed
// save or a quit before the next try loses nothing.
// shortcut: a crash between saving and taking items off the queue imports them again; give each task an id from its
// queue item if duplicates ever show up.

import { useEffect } from 'react';
import { captureTitle } from '../../core/captureTitle';
import { transact } from '../../core/records';
import { useApp } from './store';

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
          // From other apps, so tidied like any capture, or dropped if blank.
          const title = captureTitle(String(text));
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

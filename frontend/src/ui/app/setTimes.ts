// Places practices at their set times (core/setTimes.ts) whenever this device works out Today: on opening, on coming
// back to the foreground and on a new day. Each run waits for the sync under way, the first after opening or the one the
// return started, to finish or fail, so it places around what other devices did; a device that's signed out, or has no
// sync, runs at once. The device that placed sessions says so once, with Undo; other devices see them arrive by sync and
// say nothing. Mounted once, in the Shell. The placing code loads after the app has drawn, outside the first load.

import { useEffect } from 'react';
import { applyPlanChange } from '../../core/plan';
import { transact } from '../../core/records';
import { useToast } from '../components/Toast';
import { useApp, useToday } from './store';

export function useSetTimes(): void {
  const { db, clock, platform, sync } = useApp();
  const toast = useToast();
  const day = useToday();
  useEffect(() => {
    let stopped = false;
    const place = async () => {
      await sync?.settled();
      if (stopped) return;
      const { placeSetTimes, placedMessage } = await import('../../core/setTimes');
      const done = await transact(db, clock, (w) => placeSetTimes(w.automatic, clock));
      if (stopped || !done.placed.length) return;
      toast.show(placedMessage(done.placed, clock), { undo: () => transact(db, clock, (w) => applyPlanChange(w, done)) });
    };
    const run = () => void place().catch((error: unknown) => console.error('Placing set times failed', error));
    run();
    const stop = platform.lifecycle.onForeground(run);
    return () => {
      stopped = true;
      stop();
    };
  }, [db, clock, platform, sync, toast, day]);
}

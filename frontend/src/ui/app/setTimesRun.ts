// The run useSetTimes starts (setTimes.ts): waits for the sync under way, places what's missing, and says what it placed
// with Undo. Its own module, loaded after the app has drawn, so none of it is in the first load.

import type { Clock } from '../../core/clock';
import type { Db } from '../../core/db';
import { applyPlanChange } from '../../core/plan';
import { transact } from '../../core/records';
import { placedMessage, placeSetTimes } from '../../core/setTimes';
import type { AppSync } from '../../core/syncRunner';
import type { Say } from '../components/Toast';

export async function placeNow(app: { db: Db; clock: Clock; sync?: AppSync | undefined }, say: Say, stopped: () => boolean): Promise<void> {
  const { db, clock, sync } = app;
  await sync?.settled();
  if (stopped()) return;
  const done = await transact(db, clock, (w) => placeSetTimes(w.automatic, clock));
  if (stopped() || !done.placed.length) return;
  say(placedMessage(done.placed, clock), { undo: () => transact(db, clock, (w) => applyPlanChange(w, done)) });
}

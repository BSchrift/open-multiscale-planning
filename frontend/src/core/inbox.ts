// What the Inbox list's select mode does to many items at once. Each item gets what Process gives one, and the batch is
// one change with one exact reverse, so a single Undo puts every item back.

import type { Clock } from './clock';
import { applyPlanChange } from './plan';
import type { PlanChange, RecordWrite } from './plan';
import type { Writer } from './records';
import { setOnceDates } from './schedule';
import { closeTask } from './tasks';
import type { Fields } from './types';

/** Sends items to a project, or to One offs when projectId is null, keeping each title and estimate. */
export function sendInboxItems(w: Writer, ids: readonly string[], projectId: string | null): Promise<PlanChange> {
  // Fields merge one by one, so each kind clears the other's: another device may have sent an item the other way.
  const fields: Fields<'task'> = projectId
    ? { kind: 'project', project_id: projectId, milestone_id: null, schedule: null, next_due: null }
    : { kind: 'one_off', project_id: null, milestone_id: null, ...setOnceDates(null, null) };
  return applyPlanChange(w, { writes: ids.map((id): RecordWrite => ({ type: 'task', id, fields })) });
}

/** Deletes items as Process's Delete/done does each, freeing what they had picked or placed. */
export async function deleteInboxItems(w: Writer, ids: readonly string[], clock: Clock): Promise<PlanChange> {
  const reverse: RecordWrite[] = [];
  // The last item closed is the first put back.
  for (const id of ids) reverse.unshift(...(await closeTask(w, id, 'deleted', clock)).writes);
  return { writes: reverse };
}

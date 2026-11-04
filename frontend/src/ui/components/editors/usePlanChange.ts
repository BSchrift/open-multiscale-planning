import { useCallback } from 'react';
import { applyPlanChange } from '../../../core/plan';
import type { PlanChange, ScheduledWork } from '../../../core/plan';
import { scheduledWork } from '../../../core/tasks';
import { useApp, useMutation } from '../../app/store';
import { useToast } from '../Toast';

/**
 * Writes a plan change in one transaction and resolves to its exact reverse. Pass the ids of tasks the change closes,
 * so their scheduled time is freed too. With a message, a toast offers Undo.
 */
export function usePlanChange() {
  const { clock } = useApp();
  const toast = useToast();
  const { run } = useMutation(async (w, make: (work: ScheduledWork) => PlanChange, closing: readonly string[]) =>
    applyPlanChange(w, make(closing.length ? await scheduledWork(w.sql, closing, clock) : {})),
  );
  return useCallback(
    async (make: (work: ScheduledWork) => PlanChange, options: { closing?: readonly string[]; message?: string } = {}) => {
      const reverse = await run(make, options.closing ?? []);
      if (reverse && options.message) toast.show(options.message, { undo: () => run(() => reverse, []) });
      return reverse;
    },
    [run, toast],
  );
}

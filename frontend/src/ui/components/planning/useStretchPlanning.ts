// The stretch whose planning is due, and when its planning is set, for the Plan page and the Goals row, which show
// only that time once the Today row has done its asking.

import { formatTime, instantMs, localDate } from '../../../core/dates';
import { blockAhead, loadTaskPlanning, planningId, stretchPlanningDue } from '../../../core/planning';
import { getSettings } from '../../../core/records';
import { useApp, useQuery, useToday } from '../../app/store';
import { dayName } from '../weekgrid';

export function useStretchPlanning() {
  const { clock } = useApp();
  const on = useToday();
  const data = useQuery(
    async (sql) => {
      const due = stretchPlanningDue(await getSettings(sql), on);
      return due ? { due, ...(await loadTaskPlanning(sql, planningId(due))) } : null;
    },
    [on],
  ).data;
  const ahead = data ? blockAhead(data, clock) : undefined;
  const zone = clock.zone();
  return {
    due: data?.due ?? null,
    /** 'Planning: Sat Dec 26, 9am', once it has a time still to come. */
    at: ahead && instantMs(ahead.start) > clock.now() ? `Planning: ${dayName(localDate(ahead.start, zone))}, ${formatTime(ahead.start, zone)}` : null,
  };
}

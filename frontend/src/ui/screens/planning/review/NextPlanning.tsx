// Review's next planning row, above Finish plan: the cheapest moment to keep the habit, since the person is already
// planning. One time, Schedule, and Choose a time under it. Scheduling says so in the row, with Undo there.

import { useRef, useState } from 'react';
import { addWeeks, formatTimeOfDay, thisWeek } from '../../../../core/dates';
import { applyPlanChange } from '../../../../core/plan';
import type { PlanChange } from '../../../../core/plan';
import { blockAhead, isPlanned, loadWeekPlanning, nextPlanningTime, schedulePlanning } from '../../../../core/planning';
import { slotInstants } from '../../../../core/slots';
import type { Slot } from '../../../../core/slots';
import type { Instant, LocalDate } from '../../../../core/types';
import { useApp, useMutation, useQuery } from '../../../app/store';
import { PlanningTimes } from '../../../components/planning/PlanningTimes';
import { longTime, usePlanningTimes } from '../../../components/planning/usePlanning';
import { dayName } from '../../../components/weekgrid';

export function NextPlanning(props: { week: LocalDate; began: Instant }) {
  const { clock, layout } = useApp();
  const next = addWeeks(props.week, 1);
  const planning = usePlanningTimes(next);
  const ahead = useQuery((sql) => loadWeekPlanning(sql, next), [next]).data;
  const [done, setDone] = useState<{ slot: Slot; reverse: PlanChange } | null>(null);
  const [choosing, setChoosing] = useState(false);
  const undoRef = useRef<HTMLButtonElement>(null);
  const schedule = useMutation((w, slot: Slot) => schedulePlanning(w, next, slotInstants(slot, clock.zone()), clock));
  const undo = useMutation((w, reverse: PlanChange) => applyPlanChange(w, reverse));
  if (!planning || !ahead) return null;
  if (!done && (isPlanned(ahead) || blockAhead(ahead, clock))) return null;
  const found = done ? null : nextPlanningTime(props.week, props.began, planning.estimate.minutes, planning.input, planning.usual);
  const slot = done?.slot ?? found?.slot;
  if (!slot) return null;
  const phone = layout === 'phone';
  const when = `${dayName(slot.date)}, ${formatTimeOfDay(slot.start)}`;
  const name = next === addWeeks(thisWeek(clock), 1) ? 'next week' : 'the week after';

  const place = async () => {
    const reverse = await schedule.run(slot);
    if (!reverse) return;
    setDone({ slot, reverse });
    // The Schedule button goes with the change, so focus moves to Undo beside what it says.
    requestAnimationFrame(() => undoRef.current?.focus());
  };
  const back = async () => {
    if (done && (await undo.run(done.reverse))) setDone(null);
  };

  return (
    <section className="card stack8 nextplan" aria-label="Next planning">
      {done ? (
        <div className="between">
          <span role="status">Scheduled for {when}.</span>
          <button ref={undoRef} className={phone ? 'btn' : 'btn sm'} type="button" onClick={() => void back()}>
            Undo
          </button>
        </div>
      ) : (
        <>
          <div>
            <div className="strong">Next planning</div>
            <div>{when}</div>
            <div className="small quiet">{found?.same ? 'Same time as today' : 'Before the week starts'}</div>
          </div>
          <div className={phone ? 'stack8' : 'row'}>
            <button className="btn pri" type="button" aria-label={`Schedule planning for ${longTime(slot)}`} disabled={schedule.pending} onClick={() => void place()}>
              Schedule
            </button>
            <button className="btn" type="button" aria-label={`Choose a time to plan ${name}`} onClick={() => setChoosing(true)}>
              Choose a time
            </button>
          </div>
        </>
      )}
      {choosing && <PlanningTimes week={next} name={name} onClose={() => setChoosing(false)} />}
    </section>
  );
}

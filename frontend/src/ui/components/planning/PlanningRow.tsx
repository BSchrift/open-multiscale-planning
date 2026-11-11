// The planning row on Today, under the Now card: next week's planning task waiting for a time, with one tap to schedule
// the best time, Choose a time, and a bin that deletes the task. Once planning began and stopped, it offers Keep going
// with the time left; once its time passed unopened, it says so. Also the line that takes the prompt's place once this
// week's planning is set for later. Neither moves focus as it appears.

import { useEffect, useRef, useState } from 'react';
import { formatTime, formatWeekday, instantMs, localDate } from '../../../core/dates';
import { rowState, timeLeft, weekPlanningTitle } from '../../../core/planning';
import type { WeekPlanning } from '../../../core/planning';
import { slotInstants } from '../../../core/slots';
import type { LocalDate, TimeBlock } from '../../../core/types';
import { useApp, useStickyState } from '../../app/store';
import { BinIcon } from '../icons';
import { About } from './About';
import { PlanningTimes } from './PlanningTimes';
import { longTime, requestPlanningTimes, shortTime, usePlanningActions, usePlanningRequest, usePlanningTimes } from './usePlanning';
import './planning.css';

/** The best time becomes Start now when it's this close. */
const SOON_MS = 15 * 60_000;

/** The weekly flow's steps, as the row names where planning stopped. */
const STEP_NAMES = ['Inbox', 'Pick tasks', 'Schedule', 'Review'];

/** Next week's row. onGone is told what came after it once a tap took it away, so focus can move there. */
export function PlanningRow(props: { planning: WeekPlanning; onGone(after: Element | null): void }) {
  const { week } = props.planning;
  const { clock, layout } = useApp();
  const planning = usePlanningTimes(week);
  const act = usePlanningActions();
  const [choosing, setChoosing] = useState(false);
  // The step is kept on the device that planned, so another device can only say planning started.
  const [step] = useStickyState<number | null>(`planning.step.${week}`, null);
  const ref = useRef<HTMLElement>(null);
  // The weekly reminder's Choose a time lands here.
  const request = usePlanningRequest();
  useEffect(() => {
    if (request !== week) return;
    setChoosing(true);
    requestPlanningTimes(null);
  }, [request, week]);
  if (!planning) return null;
  const state = rowState(props.planning, clock);
  const phone = layout === 'phone';
  // Read at the tap, while the row is still there.
  const gone = () => {
    const after = ref.current?.nextElementSibling ?? null;
    return () => props.onGone(after);
  };
  const stopped = state === 'stopped';
  const minutes = stopped ? timeLeft(planning.estimate.minutes, props.planning.plan?.planning_min ?? 0) : planning.estimate.minutes;
  const best = planning.times(minutes)[0];
  const soon = stopped || (best && instantMs(slotInstants(best, clock.zone()).start) - clock.now() <= SOON_MS);
  const title = stopped ? 'Finish planning next week' : 'Plan next week';
  const where = STEP_NAMES[step ?? -1];
  const line =
    state === 'stopped' ? (
      <About minutes={minutes} before={where ? `You stopped on the ${where} step. ` : 'Started, not finished. '} after=" left." />
    ) : state === 'passed' ? (
      <About minutes={minutes} before="Your planning time passed. " after="." />
    ) : (
      <About minutes={minutes} after={planning.inbox ? ` · ${planning.inbox} in your Inbox` : ''} />
    );

  return (
    <section ref={ref} className={phone ? 'now stack planrow' : 'card stack8 planrow'} aria-label={title}>
      <div className="between">
        <div>
          <div className="strong">{title}</div>
          <div className="small quiet">{line}</div>
        </div>
        <button
          className="icbtn planbin"
          type="button"
          aria-label={`Delete planning task: ${weekPlanningTitle(week)}`}
          disabled={act.pending}
          onClick={() => void act.remove(week).then(gone())}
        >
          <BinIcon />
        </button>
      </div>
      <div className={phone ? 'stack8' : 'row'}>
        {(best || stopped) &&
          (soon ? (
            <button
              className={`btn pri${phone ? ' planbtn' : ''}`}
              type="button"
              aria-label={stopped ? 'Keep going' : 'Start planning now'}
              onClick={() => void act.start(week, minutes)}
            >
              {stopped ? 'Keep going' : 'Start now'}
            </button>
          ) : (
            <button
              className={`btn pri${phone ? ' planbtn' : ''}`}
              type="button"
              aria-label={`Schedule planning for ${longTime(best!)}`}
              disabled={act.pending}
              onClick={() => void act.schedule(week, best!).then(gone())}
            >
              Schedule for {shortTime(best!)}
            </button>
          ))}
        <button className={`btn${best || stopped ? '' : ' pri'}${phone ? ' planbtn' : ''}`} type="button" aria-label="Choose a time to plan next week" onClick={() => setChoosing(true)}>
          Choose a time
        </button>
      </div>
      {choosing && <PlanningTimes week={week} name="next week" onClose={() => setChoosing(false)} />}
    </section>
  );
}

/** In place of the prompt to plan this week, once its planning is set for later: when, and Start now. */
export function PlanningSet(props: { week: LocalDate; block: TimeBlock }) {
  const { week, block } = props;
  const { clock, layout } = useApp();
  const planning = usePlanningTimes(week);
  const act = usePlanningActions();
  const zone = clock.zone();
  const when = `${formatWeekday(localDate(block.start, zone))} ${formatTime(block.start, zone)}`;
  const title = `Planning is set for ${when}.`;
  return (
    <section className="attn planset" aria-label={title}>
      <span>{title}</span>
      <button
        className={layout === 'phone' ? 'btn' : 'btn sm'}
        type="button"
        disabled={!planning || act.pending}
        onClick={() => planning && void act.start(week, planning.estimate.minutes)}
      >
        Start now
      </button>
    </section>
  );
}

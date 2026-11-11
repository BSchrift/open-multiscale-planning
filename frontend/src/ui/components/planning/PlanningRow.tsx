// The planning row on Today, under the Now card: next week's planning task waiting for a time, with one tap to schedule
// the best time, Choose a time, and a bin that deletes the task. Also the line that takes the prompt's place once this
// week's planning is set for later. Neither moves focus as it appears.

import { useRef, useState } from 'react';
import { formatTime, formatWeekday, instantMs, localDate } from '../../../core/dates';
import { weekPlanningTitle } from '../../../core/planning';
import { slotInstants } from '../../../core/slots';
import type { LocalDate, TimeBlock } from '../../../core/types';
import { useApp } from '../../app/store';
import { BinIcon } from '../icons';
import { About } from './About';
import { PlanningTimes } from './PlanningTimes';
import { longTime, shortTime, usePlanningActions, usePlanningTimes } from './usePlanning';
import './planning.css';

/** The best time becomes Start now when it's this close. */
const SOON_MS = 15 * 60_000;

/** Next week's row. onGone is told what came after it once a tap took it away, so focus can move there. */
export function PlanningRow(props: { week: LocalDate; onGone(after: Element | null): void }) {
  const { week } = props;
  const { clock, layout } = useApp();
  const planning = usePlanningTimes(week);
  const act = usePlanningActions();
  const [choosing, setChoosing] = useState(false);
  const ref = useRef<HTMLElement>(null);
  if (!planning) return null;
  const phone = layout === 'phone';
  // Read at the tap, while the row is still there.
  const gone = () => {
    const after = ref.current?.nextElementSibling ?? null;
    return () => props.onGone(after);
  };
  const minutes = planning.estimate.minutes;
  const best = planning.times(minutes)[0];
  const soon = best && instantMs(slotInstants(best, clock.zone()).start) - clock.now() <= SOON_MS;
  const title = 'Plan next week';
  const line = planning.inbox ? ` · ${planning.inbox} in your Inbox` : '';

  return (
    <section ref={ref} className={phone ? 'now stack planrow' : 'card stack8 planrow'} aria-label={title}>
      <div className="between">
        <div>
          <div className="strong">{title}</div>
          <div className="small quiet">
            <About minutes={minutes} after={line} />
          </div>
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
        {best &&
          (soon ? (
            <button className={`btn pri${phone ? ' planbtn' : ''}`} type="button" aria-label="Start planning now" onClick={() => void act.start(week, minutes)}>
              Start now
            </button>
          ) : (
            <button
              className={`btn pri${phone ? ' planbtn' : ''}`}
              type="button"
              aria-label={`Schedule planning for ${longTime(best)}`}
              disabled={act.pending}
              onClick={() => void act.schedule(week, best).then(gone())}
            >
              Schedule for {shortTime(best)}
            </button>
          ))}
        <button className={`btn${best ? '' : ' pri'}${phone ? ' planbtn' : ''}`} type="button" aria-label="Choose a time to plan next week" onClick={() => setChoosing(true)}>
          Choose a time
        </button>
      </div>
      {choosing && <PlanningTimes week={week} which="next" onClose={() => setChoosing(false)} />}
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

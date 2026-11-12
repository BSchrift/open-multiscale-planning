// The stretch's planning row on Today, in place of the old alert: the stretch's planning task waiting for a time, with
// one tap to schedule the best time, Choose a time, and a bin that deletes the task for that stretch.

import { useRef, useState } from 'react';
import { formatDate, instantMs } from '../../../core/dates';
import { stretchPlanningTitle } from '../../../core/planning';
import type { Stretch } from '../../../core/plan';
import { slotInstants } from '../../../core/slots';
import { useApp } from '../../app/store';
import { BinIcon } from '../icons';
import { About } from './About';
import { PlanningTimes } from './PlanningTimes';
import { longTime, shortTime, usePlanningActions, usePlanningTimes } from './usePlanning';
import './planning.css';

const SOON_MS = 15 * 60_000;

export function StretchRow(props: { stretch: Stretch; first: boolean; onGone(after: Element | null): void }) {
  const { stretch, first } = props;
  const p = { stretch, first };
  const { clock, layout } = useApp();
  const planning = usePlanningTimes(p);
  const act = usePlanningActions();
  const [choosing, setChoosing] = useState(false);
  const ref = useRef<HTMLElement>(null);
  if (!planning) return null;
  const phone = layout === 'phone';
  const gone = () => {
    const after = ref.current?.nextElementSibling ?? null;
    return () => props.onGone(after);
  };
  const minutes = planning.estimate.minutes;
  const best = planning.times(minutes)[0];
  const soon = best && instantMs(slotInstants(best, clock.zone()).start) - clock.now() <= SOON_MS;
  const title = first ? 'Plan your first stretch' : 'Plan the next stretch';
  const name = first ? 'your first stretch' : 'the next stretch';
  const when = first ? `Ends ${formatDate(stretch.end)} · ` : `${formatDate(stretch.start)} to ${formatDate(stretch.end)} · `;
  const btn = phone ? ' planbtn' : '';
  return (
    <section ref={ref} className={phone ? 'now stack planrow' : 'card stack8 planrow'} aria-label={title}>
      <div className="between">
        <div>
          <div className="strong">{title}</div>
          <div className="small quiet">
            <About minutes={minutes} before={when} />
          </div>
        </div>
        <button
          className="icbtn planbin"
          type="button"
          aria-label={`Delete planning task: ${stretchPlanningTitle(stretch)}`}
          disabled={act.pending}
          onClick={() => void act.remove(p).then(gone())}
        >
          <BinIcon />
        </button>
      </div>
      <div className={phone ? 'stack8' : 'row'}>
        {best &&
          (soon ? (
            <button className={`btn pri${btn}`} type="button" aria-label="Start planning now" onClick={() => void act.start(p, minutes)}>
              Start now
            </button>
          ) : (
            <button
              className={`btn pri${btn}`}
              type="button"
              aria-label={`Schedule planning for ${longTime(best)}`}
              disabled={act.pending}
              onClick={() => void act.schedule(p, best).then(gone())}
            >
              Schedule for {shortTime(best)}
            </button>
          ))}
        <button className={`btn${best ? '' : ' pri'}${btn}`} type="button" aria-label={`Choose a time to plan ${name}`} onClick={() => setChoosing(true)}>
          Choose a time
        </button>
      </div>
      {choosing && <PlanningTimes for={p} name={name} onClose={() => setChoosing(false)} />}
    </section>
  );
}

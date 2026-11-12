// Weekly and stretch plans together: when both are due before a week starts, neither has a time and together they
// take at most 2h, one row and one block, the stretch's, which runs into the week's planning. "Plan them at separate
// times" in its sheet leaves the stretch's row alone; the week's follows once the stretch has a time or is done.

import { useRef, useState } from 'react';
import { formatDate, instantMs } from '../../../core/dates';
import { BOTH_LONGEST_MIN } from '../../../core/planning';
import type { Stretch } from '../../../core/plan';
import type { WeekPlanning } from '../../../core/planning';
import { slotInstants } from '../../../core/slots';
import { useApp, useStickyState } from '../../app/store';
import { BinIcon } from '../icons';
import { About } from './About';
import { PlanningRow } from './PlanningRow';
import { PlanningTimes } from './PlanningTimes';
import { StretchRow } from './StretchRow';
import { longTime, shortTime, usePlanningActions, usePlanningTimes } from './usePlanning';
import './planning.css';

const SOON_MS = 15 * 60_000;

export function BothRows(props: { week: WeekPlanning; stretch: Stretch; first: boolean; onGone(after: Element | null): void }) {
  const { week, stretch, first } = props;
  const s = { stretch, first };
  const { clock, layout } = useApp();
  const weekly = usePlanningTimes(week.week);
  const planning = usePlanningTimes(s);
  const act = usePlanningActions();
  const [choosing, setChoosing] = useState(false);
  // Parting them is a choice for this stretch on this device; the rows say the rest.
  const [separate, setSeparate] = useStickyState<string | null>('planning.separate', null);
  const ref = useRef<HTMLElement>(null);
  if (!weekly || !planning) return null;
  const minutes = weekly.estimate.minutes + planning.estimate.minutes;
  if (separate === stretch.start) return <StretchRow stretch={stretch} first={first} onGone={props.onGone} />;
  // Over 2h together, there's no shared row: the week's comes first, then the stretch's.
  if (minutes > BOTH_LONGEST_MIN) return <PlanningRow planning={week} onGone={props.onGone} />;

  const phone = layout === 'phone';
  const gone = () => {
    const after = ref.current?.nextElementSibling ?? null;
    return () => props.onGone(after);
  };
  const best = planning.times(minutes)[0];
  const soon = best && instantMs(slotInstants(best, clock.zone()).start) - clock.now() <= SOON_MS;
  const title = first ? 'Plan your first stretch and next week' : 'Plan the next stretch and next week';
  const dates = `${formatDate(stretch.start)} to ${formatDate(stretch.end)}, then the week of ${formatDate(week.week)} · `;
  const btn = phone ? ' planbtn' : '';
  return (
    <section ref={ref} className={phone ? 'now stack planrow' : 'card stack8 planrow'} aria-label={title}>
      <div className="between">
        <div>
          <div className="strong">{title}</div>
          <div className="small quiet">
            <About minutes={minutes} before={dates} />
          </div>
        </div>
        <button
          className="icbtn planbin"
          type="button"
          aria-label={`Delete planning tasks: ${formatDate(stretch.start)} to ${formatDate(stretch.end)} and the week of ${formatDate(week.week)}`}
          disabled={act.pending}
          onClick={() => void act.removeBoth(s, week.week).then(gone())}
        >
          <BinIcon />
        </button>
      </div>
      <div className={phone ? 'stack8' : 'row'}>
        {best &&
          (soon ? (
            <button className={`btn pri${btn}`} type="button" aria-label="Start planning now" onClick={() => void act.startBoth(s, week.week, minutes)}>
              Start now
            </button>
          ) : (
            <button
              className={`btn pri${btn}`}
              type="button"
              aria-label={`Schedule planning for ${longTime(best)}`}
              disabled={act.pending}
              onClick={() => void act.scheduleBoth(s, week.week, best).then(gone())}
            >
              Schedule for {shortTime(best)}
            </button>
          ))}
        <button className={`btn${best ? '' : ' pri'}${btn}`} type="button" aria-label="Choose a time to plan the next stretch and next week" onClick={() => setChoosing(true)}>
          Choose a time
        </button>
      </div>
      {choosing && (
        <PlanningTimes
          for={s}
          name="the next stretch and next week"
          both={{ week: week.week, minutes, onSeparate: () => setSeparate(stretch.start) }}
          onClose={() => setChoosing(false)}
        />
      )}
    </section>
  );
}

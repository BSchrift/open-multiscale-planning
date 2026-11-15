// The prompt to plan a week that has started unplanned, on Today and on Week: Start planning, Choose a time, and Skip
// for now, which is saved on the week's plan so every device keeps it, with Undo. Phone stacks the three; desktop keeps
// to one line in the planning row's shape, with Skip for now as ×.

import { useState } from 'react';
import { useApp } from '../app/store';
import { About } from './planning/About';
import { PlanningTimes } from './planning/PlanningTimes';
import { usePlanningActions, usePlanningTimes } from './planning/usePlanning';
import { Button } from './ds/Button';
import { Icon } from './ds/Icon';

export function PlanPrompt(props: { week: string; line?: string | null }) {
  const { week } = props;
  const { layout } = useApp();
  const planning = usePlanningTimes(week);
  const act = usePlanningActions();
  const [choosing, setChoosing] = useState(false);
  const phone = layout === 'phone';
  if (!planning) return null;
  const minutes = planning.estimate.minutes;
  const start = (
    <Button variant="primary" className={phone ? ' planbtn' : ''} type="button" onClick={() => void act.start(week, minutes)}>
      Start planning
    </Button>
  );
  const choose = (
    <Button className={phone ? ' planbtn' : ''} type="button" aria-label="Choose a time to plan this week" onClick={() => setChoosing(true)}>
      Choose a time
    </Button>
  );
  const text = (
    <>
      <p>
        <About minutes={minutes} before="This week isn't planned yet. " after="." />
      </p>
      {props.line && <p className={phone ? 'small quiet' : 'quiet'}>{props.line}</p>}
    </>
  );
  const times = choosing && <PlanningTimes for={week} name="this week" onClose={() => setChoosing(false)} />;

  if (phone) {
    return (
      <div className="now stack planrow">
        {text}
        <div className="stack8">
          {start}
          {choose}
          <Button className="planbtn" type="button" onClick={() => void act.skip(week)}>
            Skip for now
          </Button>
        </div>
        {times}
      </div>
    );
  }
  return (
    <div className="card stack8 planrow">
      <div className="between">
        <div>{text}</div>
        <button className="icbtn planx" type="button" aria-label="Skip planning this week" disabled={act.pending} onClick={() => void act.skip(week)}>
          <Icon name="close" />
        </button>
      </div>
      <div className="row">
        {start}
        {choose}
      </div>
      {times}
    </div>
  );
}

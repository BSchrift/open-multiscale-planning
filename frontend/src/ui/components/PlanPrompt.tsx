// The prompt to plan a week that isn't planned yet, on Today and on Week. Skipping is one choice for both: they share
// the today.skippedWeek key, which holds the week skipped.

import { useNav } from '../app/nav';
import { useApp, useStickyState } from '../app/store';

export const useSkippedWeek = () => useStickyState<string | null>('today.skippedWeek', null);

export function PlanPrompt(props: { week: string; line?: string | null }) {
  const { layout } = useApp();
  const nav = useNav();
  const [, setSkipped] = useSkippedWeek();
  const phone = layout === 'phone';
  return (
    <div className={phone ? 'now stack' : 'card stack'}>
      <p>This week isn't planned yet.</p>
      {props.line && <p className={phone ? 'small quiet' : 'quiet'}>{props.line}</p>}
      <div className={phone ? 'stack8' : 'row'}>
        <button className="btn pri" type="button" onClick={() => nav.openFlow('planning')}>
          Start planning
        </button>
        <button className="btn" type="button" onClick={() => setSkipped(props.week)}>
          Skip for now
        </button>
      </div>
    </div>
  );
}

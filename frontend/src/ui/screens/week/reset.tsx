// Reset this week's plan, or next week's: shown only while the week has something to reset, it asks first, saying what
// goes and what stays with their numbers, then takes it out with one Undo (core/weekReset.ts). Planning then starts
// fresh: the week asks to be planned again, and planning on this device opens on its first step, which Undo puts back.

import { useEffect, useId, useRef, useState } from 'react';
import type { PlanChange } from '../../../core/plan';
import { hasReset, weekReset } from '../../../core/weekReset';
import type { WeekReset } from '../../../core/weekReset';
import { useApp, useStickyState } from '../../app/store';
import { Sheet } from '../../components/Sheet';
import { Button } from '../../components/ds/Button';
import type { WeekData } from './data';
import { useWeekActions } from './useWeekActions';

const count = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** What the confirm lists, each line a sentence fragment. */
function resetLines(r: WeekReset, name: string): { goes: string[]; stays: string[] } {
  const n = r.sessions;
  const all = n === r.blocks.length;
  const sessions = !n ? '' : all ? (n === 1 ? ', a practice session' : ', all practice sessions') : n === 1 ? ', 1 of them a practice session' : `, ${n} of them practice sessions`;
  const goes = [
    ...(r.picks.length ? [`${count(r.picks.length, 'task')} picked for ${name}`] : []),
    ...(r.blocks.length ? [`${count(r.blocks.length, 'block')} still to come${sessions}`] : []),
    ...(r.aims ? [`Aims and skips set for ${name}, back to your usual`] : []),
  ];
  const stays = [
    ...(r.kept ? [`${count(r.kept, 'block')} already started, answered or gone by`] : []),
    ...(r.picks.length || r.blocks.length ? ['Your tasks and practices themselves'] : []),
  ];
  return { goes, stays };
}

/** "Reset this week's plan: 4 tasks and 6 blocks removed." The reverse has one write for each record taken out. */
function resetMessage(name: string, reverse: PlanChange): string {
  const of = (type: string) => reverse.writes.filter((w) => w.type === type).length;
  const parts = [of('week_pick') ? count(of('week_pick'), 'task') : '', of('time_block') ? count(of('time_block'), 'block') : ''].filter(Boolean);
  return `Reset ${name}'s plan${parts.length ? `: ${parts.join(' and ')} removed` : ''}.`;
}

/** The button and its confirm, for this week (offset 0) or next week (1). Nothing for other weeks or with nothing to reset. */
export function ResetWeek(props: { data: WeekData; offset: number; className?: string }) {
  const { data, offset } = props;
  const { clock, layout } = useApp();
  const act = useWeekActions();
  const [asking, setAsking] = useState(false);
  const [step, setStep] = useStickyState<number>(`planning.step.${data.week}`, 0);
  const describedBy = useId();
  const button = useRef<HTMLButtonElement>(null);
  // Undo brings the button back, and focus with it, rather than leaving it on the page.
  const refocus = useRef(false);
  const r = weekReset(data.week, data.weekPlans.find((p) => p.week_start === data.week), data.picks, data.blocks, clock.now());
  const shown = (offset === 0 || offset === 1) && hasReset(r);
  useEffect(() => {
    if (!shown || !refocus.current) return;
    refocus.current = false;
    button.current?.focus();
  }, [shown]);
  if (!shown) return null;

  const name = offset === 0 ? 'this week' : 'next week';
  const label = `Reset ${name}'s plan`;
  const { goes, stays } = resetLines(r, name);
  const btn = { className: layout === 'phone' ? 'grow' : undefined };
  const confirm = () => {
    const was = step;
    setAsking(false);
    setStep(0);
    void act.reset(
      data.week,
      (reverse) => resetMessage(name, reverse),
      () => {
        setStep(was);
        refocus.current = true;
      },
    );
  };
  return (
    <>
      <Button ref={button} variant="destructive" className={props.className} type="button" aria-haspopup="dialog" onClick={() => setAsking(true)}>
        {label}
      </Button>
      {asking && (
        <Sheet label={`${label}?`} describedBy={describedBy} onClose={() => setAsking(false)}>
          <h2>{label}?</h2>
          <div id={describedBy} className="stack8">
            {goes.length > 0 && (
              <>
                <p>This takes out:</p>
                <ul className="stack8 resetlist">
                  {goes.map((line) => (
                    <li key={line}>{line}.</li>
                  ))}
                </ul>
              </>
            )}
            {stays.length > 0 && (
              <>
                <p>It keeps:</p>
                <ul className="stack8 resetlist">
                  {stays.map((line) => (
                    <li key={line}>{line}.</li>
                  ))}
                </ul>
              </>
            )}
            <p>{cap(name)} then shows as not planned, so you can plan it again. You can undo this.</p>
          </div>
          <div className="row">
            <Button {...btn} variant="destructive" filled type="button" onClick={confirm}>
              Reset plan
            </Button>
            <Button {...btn} type="button" onClick={() => setAsking(false)}>
              Cancel
            </Button>
          </div>
        </Sheet>
      )}
    </>
  );
}

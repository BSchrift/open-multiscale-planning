// Weekly planning: Inbox, Pick tasks, Schedule and Review, as tabs that can be visited in any order. Params:
// week, the Monday to plan; with none, this week until it's planned, then next week. The step is kept on this
// device per week, so leaving part way resumes there.

import { useEffect, useRef, useState } from 'react';
import { placeWeekPractices } from '../../../core/blocks';
import { addWeeks, formatWeekRange, nowInstant, weekStart } from '../../../core/dates';
import { autoPickedOneOffs, minutesLeft } from '../../../core/plan';
import { getRecord, listRecords, setWeekPick, weekPickId, weekPlanId } from '../../../core/records';
import type { LocalDate } from '../../../core/types';
import { PlusIcon } from '../../components/icons';
import { useToast } from '../../components/Toast';
import { WeekArrows } from '../../components/WeekArrows';
import { useNav } from '../../app/nav';
import type { Layout, ScreenProps } from '../../app/registry';
import { useApp, useMutation, useQuery, useStickyState, useToday } from '../../app/store';
import { InboxStep } from './inbox/InboxStep';
import { PickStep } from './pick/PickStep';
import { ReviewStep } from './review/ReviewStep';
import { ScheduleStep } from './schedule';
import './planning.css';

const STEPS = ['1. Inbox', '2. Pick tasks', '3. Schedule', '4. Review'] as const;
const PHONE_STEPS = ['Inbox', 'Pick', 'Schedule', 'Review'] as const;
const NEXT = ['Continue to picking tasks', 'Continue to scheduling', 'Continue to review', 'Finish plan'] as const;

export default function PlanningScreen(props: ScreenProps) {
  const current = weekStart(useToday());
  const plans = useQuery((sql) => listRecords(sql, 'week_plan'), []).data;
  const [chosen, setChosen] = useState<LocalDate | null>(props.params.week ?? null);
  const planned = !!plans?.some((p) => p.week_start === current && p.finished_at);
  const week = chosen ?? (plans ? (planned ? addWeeks(current, 1) : current) : null);
  // Held once known, so finishing this week's plan from another device doesn't switch weeks underfoot.
  useEffect(() => {
    if (!chosen && week) setChosen(week);
  }, [chosen, week]);
  if (!week) return null;
  return <Flow key={week} week={week} current={current} onWeek={setChosen} layout={props.layout} close={props.close} />;
}

function Flow(props: { week: LocalDate; current: LocalDate; onWeek(week: LocalDate): void; layout: Layout; close(): void }) {
  const { week, layout, close } = props;
  const { clock } = useApp();
  const nav = useNav();
  const toast = useToast();
  const [stored, setStep] = useStickyState<number>(`planning.step.${week}`, 0);
  const step = Math.max(0, Math.min(STEPS.length - 1, Math.trunc(Number(stored)) || 0));
  const root = useRef<HTMLDivElement>(null);
  // Each step starts at its top. Focus left behind, by the screen underneath or a step's own button that went away,
  // goes to the current step's tab, which names the step.
  useEffect(() => {
    root.current?.closest('.flowpane')?.scrollTo?.({ top: 0 });
    if (!root.current?.contains(document.activeElement)) root.current?.querySelector<HTMLElement>('[aria-current="step"]')?.focus({ preventScroll: true });
  }, [step]);

  // A one off dated inside the week starts picked. One taken out keeps its removed pick, so it stays out. The week's
  // practices are placed now too, so Pick tasks counts their time before Schedule is opened. Written as automatic,
  // since this runs on opening, maybe before a pull: another device's picks and moved sessions win over it.
  const autoPick = useMutation(async ({ automatic: w }) => {
    for (const t of autoPickedOneOffs(await listRecords(w.sql, 'task'), week)) {
      if (!(await getRecord(w.sql, 'week_pick', weekPickId(week, t.id)))) await setWeekPick(w, week, t.id, minutesLeft(t));
    }
    await placeWeekPractices(w, week, clock);
  });
  const autoPickRun = autoPick.run;
  useEffect(() => {
    void autoPickRun();
  }, [autoPickRun]);

  const finish = useMutation((w) => w.create('week_plan', { week_start: week, finished_at: nowInstant(clock) }, weekPlanId(week)));
  const onFinish = async () => {
    if ((await finish.run()) === undefined) return;
    toast.show('Week planned.');
    close();
  };

  const go = (n: number) => setStep(Math.max(0, Math.min(STEPS.length - 1, n)));
  const body = [
    <InboxStep key="inbox" week={week} layout={layout} onNext={() => go(1)} />,
    <PickStep key="pick" week={week} layout={layout} onNext={() => go(2)} />,
    <ScheduleStep key="schedule" week={week} layout={layout} onContinue={() => go(3)} />,
    <ReviewStep key="review" week={week} layout={layout} onFinish={onFinish} />,
  ][step];
  const tabs = (labels: readonly string[], className: string) => (
    <nav className={className} aria-label="Planning steps">
      {labels.map((label, i) => (
        <button
          key={label}
          type="button"
          className={`${className === 'steps' ? 'steptab' : 'flowstep'}${i === step ? ' on' : ''}`}
          aria-current={i === step ? 'step' : undefined}
          onClick={() => go(i)}
        >
          {label}
        </button>
      ))}
    </nav>
  );

  if (layout === 'phone') {
    return (
      <div ref={root} className="planning pflow">
        <div className="flowtop">
          <button className="btn" type="button" onClick={close}>
            Save and exit
          </button>
          {tabs(PHONE_STEPS, 'flowsteps')}
        </div>
        <div className="pwk">
          <span className="small strong">{formatWeekRange(week)}</span>
          <WeekArrows {...props} />
        </div>
        {body}
        <div className="flowbot">
          <button className="icbtn" type="button" aria-label="Previous step" disabled={step === 0} onClick={() => go(step - 1)}>
            ‹
          </button>
          <button className="btn pri grow" type="button" onClick={step === STEPS.length - 1 ? onFinish : () => go(step + 1)}>
            {NEXT[step]}
          </button>
          <button className="flowcap" type="button" aria-label="Capture a task" onClick={() => nav.openOverlay('capture')}>
            <PlusIcon />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div ref={root} className="wide stack24 planning">
      <div className="between">
        <div className="row weekhead">
          <WeekArrows {...props} />
          <div>
            <div className="date">{formatWeekRange(week)}</div>
            <h1>Plan the week</h1>
          </div>
        </div>
        <button className="btn" type="button" onClick={close}>
          Save and exit
        </button>
      </div>
      <div className="stepsnav">
        <button className="btn sm steparrow" type="button" aria-label="Previous step" disabled={step === 0} onClick={() => go(step - 1)}>
          ‹
        </button>
        {tabs(STEPS, 'steps')}
        <button className="btn sm steparrow" type="button" aria-label="Next step" disabled={step === STEPS.length - 1} onClick={() => go(step + 1)}>
          ›
        </button>
      </div>
      {body}
    </div>
  );
}

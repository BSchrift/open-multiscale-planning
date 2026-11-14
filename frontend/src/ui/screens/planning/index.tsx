// Weekly planning: Inbox, Pick tasks, Schedule and Review, as tabs that can be visited in any order. Params:
// week, the Monday to plan; with none, this week until it's planned, then next week. step: 'schedule', to open that
// week on Schedule, or 'pick', to open on Pick tasks, as stretch planning does when nothing new has reached the Inbox
// since its own Inbox step. The step is kept on this device per week, so leaving part way resumes there.

import { useEffect, useMemo, useRef, useState } from 'react';
import { addWeeks, formatMinutes, formatTime, formatWeekRange, formatWeekday, localDate, weekStart } from '../../../core/dates';
import { applyPlanChange, autoPickedOneOffs, minutesLeft } from '../../../core/plan';
import { addPlanningMinutes, finishWeek, stopPlanning } from '../../../core/planning';
import { getRecord, listRecords, setWeekPick, weekPickId } from '../../../core/records';
import type { LocalDate } from '../../../core/types';
import { AddMenu } from '../../components/AddMenu';
import type { AddItem } from '../../components/AddMenu';
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
import { usePlanningTime } from './usePlanningTime';
import { FitContext, WeekFit } from './WeekFit';
import type { FitPreview, NextName } from './WeekFit';
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
  const start = props.params.step === 'schedule' && week === props.params.week ? 2 : props.params.step === 'pick' ? 1 : undefined;
  return <Flow key={week} week={week} current={current} start={start} onWeek={setChosen} layout={props.layout} close={props.close} />;
}

function Flow(props: { week: LocalDate; current: LocalDate; start?: number; onWeek(week: LocalDate): void; layout: Layout; close(): void }) {
  const { week, layout, close } = props;
  const { clock } = useApp();
  const nav = useNav();
  const toast = useToast();
  const [stored, setStep] = useStickyState<number>(`planning.step.${week}`, 0);
  const step = Math.max(0, Math.min(STEPS.length - 1, Math.trunc(Number(stored)) || 0));
  useEffect(() => {
    if (props.start !== undefined) setStep(props.start);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const root = useRef<HTMLDivElement>(null);
  // What the current step previews on Does it fit, and what the phone's fit line opens there.
  const [preview, setPreview] = useState<FitPreview | null>(null);
  const [onShow, setOnShow] = useState<(() => void) | null>(null);
  // What + Add offers on this step, and whether its menu is open.
  const [addItems, setAddItems] = useState<readonly AddItem[] | null>(null);
  const [menu, setMenu] = useState(false);
  const addRef = useRef<HTMLButtonElement>(null);
  // The phone's Continue, named in full by a step that has more to say, such as Pick's "6 need you".
  const [nextName, setNextName] = useState<NextName | null>(null);
  const fitHooks = useMemo(() => ({ preview: setPreview, show: (open: (() => void) | null) => setOnShow(() => open), add: setAddItems, next: setNextName }), []);
  // Each step starts at its top. Focus left behind, by the screen underneath or a step's own button that went away,
  // goes to the current step's tab, which names the step.
  useEffect(() => {
    root.current?.closest('.flowpane')?.scrollTo?.({ top: 0 });
    if (!root.current?.contains(document.activeElement)) root.current?.querySelector<HTMLElement>('[aria-current="step"]')?.focus({ preventScroll: true });
  }, [step]);

  // A one off dated inside the week starts picked. One taken out keeps its removed pick, so it stays out. Nothing is
  // placed for you: practices wait in Schedule with the rest. Written as automatic, since this runs on opening, maybe
  // before a pull: another device's picks win over it.
  const autoPick = useMutation(async ({ automatic: w }) => {
    for (const t of autoPickedOneOffs(await listRecords(w.sql, 'task'), week)) {
      if (!(await getRecord(w.sql, 'week_pick', weekPickId(week, t.id)))) await setWeekPick(w, week, t.id, minutesLeft(t));
    }
  });
  const autoPickRun = autoPick.run;
  useEffect(() => {
    void autoPickRun();
  }, [autoPickRun]);

  const time = usePlanningTime((w, minutes, began) => addPlanningMinutes(w, week, minutes, began));
  // Finishing the plan finishes its planning task, and frees what's left of its block, with Undo for all of it.
  const finish = useMutation((w) => finishWeek(w, week, clock));
  const undo = useMutation((w, reverse: Awaited<ReturnType<typeof finishWeek>>['reverse']) => applyPlanChange(w, reverse));
  const onFinish = async () => {
    await time.flush();
    const done = await finish.run();
    if (!done) return;
    const zone = clock.zone();
    const freed = done.freed && `${formatWeekday(localDate(done.freed, zone))} ${formatTime(done.freed, zone)}`;
    const message = freed ? `Week planned. ${freed} is free again.` : done.minutes ? `Week planned in ${formatMinutes(done.minutes)}.` : 'Week planned.';
    toast.show(message, { undo: () => undo.run(done.reverse) });
    close();
  };
  // Save and exit: a planning block under way ends now. Everything else is already saved.
  const stop = useMutation((w) => stopPlanning(w, week, clock));
  const exit = () => void time.flush().then(() => stop.run()).then(close);

  const go = (n: number) => setStep(Math.max(0, Math.min(STEPS.length - 1, n)));
  const body = (
    <FitContext.Provider value={fitHooks}>
      {
        [
          <InboxStep key="inbox" week={week} layout={layout} onNext={() => go(1)} />,
          <PickStep key="pick" week={week} layout={layout} onNext={() => go(2)} onInbox={() => go(0)} />,
          <ScheduleStep key="schedule" week={week} layout={layout} onContinue={() => go(3)} />,
          <ReviewStep key="review" week={week} began={time.began} layout={layout} onFinish={onFinish} />,
        ][step]
      }
    </FitContext.Provider>
  );
  const fit = <WeekFit week={week} phone={layout === 'phone'} preview={preview} onShow={onShow} />;
  // The menu item that was picked goes with the menu, so focus goes back to + Add once its form closes.
  const menuEl = menu && addItems && (
    <AddMenu
      items={addItems.map((item) => ({
        label: item.label,
        onPick: () => {
          setMenu(false);
          item.onPick();
        },
      }))}
      phone={layout === 'phone'}
      onClose={() => {
        setMenu(false);
        addRef.current?.focus();
      }}
    />
  );
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
        <h1 className="sr">Plan the week</h1>
        <div className="flowtop">
          <button className="btn" type="button" onClick={exit}>
            Save and exit
          </button>
          {tabs(PHONE_STEPS, 'flowsteps')}
          {fit}
        </div>
        {/* Pick puts the week's dates on its heading's row, so four tasks fit on its first screen. */}
        {step !== 1 && (
          <div className="pwk">
            <span className="small strong">{formatWeekRange(week)}</span>
            <WeekArrows {...props} />
          </div>
        )}
        {body}
        <div className="flowbot">
          <button className="icbtn" type="button" aria-label="Previous step" disabled={step === 0} onClick={() => go(step - 1)}>
            ‹
          </button>
          <button
            className="btn pri grow"
            type="button"
            data-continue
            aria-label={nextName?.label}
            aria-describedby={nextName?.describedBy}
            onClick={step === STEPS.length - 1 ? onFinish : () => go(step + 1)}
          >
            {NEXT[step]}
          </button>
          {/* On a step with things to add, + is Add; elsewhere it captures to the Inbox. */}
          <button
            ref={addRef}
            className="flowcap"
            type="button"
            aria-haspopup={addItems ? 'dialog' : undefined}
            aria-label={addItems ? 'Add a task, one off, milestone or project' : 'Capture a task'}
            onClick={() => (addItems ? setMenu(true) : nav.openOverlay('capture'))}
          >
            <PlusIcon />
          </button>
        </div>
        {menuEl}
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
        <div className="row">
          {addItems && (
            <div className="editrow addwrap">
              <button ref={addRef} className="btn" type="button" aria-haspopup="dialog" aria-expanded={menu} onClick={() => setMenu(!menu)}>
                + Add <span aria-hidden="true">▾</span>
              </button>
              {menuEl}
            </div>
          )}
          <button className="btn" type="button" onClick={exit}>
            Save and exit
          </button>
        </div>
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
      <div className="planpin">{fit}</div>
      {body}
    </div>
  );
}

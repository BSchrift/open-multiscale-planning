// Today: the block in progress or next, what needs attention, one offs due today and the day's timeline. When the
// week isn't planned it opens on a prompt to plan, and after time away on Welcome back.

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { formatDate, formatDayLong, thisWeek } from '../../../core/dates';
import { planningDue, planStretch } from '../../../core/plan';
import { shiftRestOfToday, welcomeBack } from '../../../core/queue';
import { useNav } from '../../app/nav';
import type { ScreenProps } from '../../app/registry';
import { useApp, useMutation, useNow, useQuery, useStickyState, useToday } from '../../app/store';
import { PlanningRow, PlanningSet } from '../../components/planning/PlanningRow';
import { useFocusLanding } from '../../components/useFocusLanding';
import { blockAhead, makeDuePlanningTasks, skipWeek, weekGate, weekRow } from '../../../core/planning';
import { useCalendarCall } from '../settings/useCalendarCall';
import { loadToday } from './data';
import type { TodayData } from './data';
import { DayTimeline } from './DayTimeline';
import { NowCard } from './NowCard';
import { OneOffsToday } from './OneOffsToday';
import { QueuePanel } from './QueuePanel';
import { ToSchedule } from './ToSchedule';
import { ShiftPanel } from './ShiftPanel';
import { usePrompts } from './usePrompts';
import { Banner, Gate, NextUp, PickOne, Welcome } from './Views';
import './today.css';

interface Alert {
  key: string;
  title: string;
  text?: string;
  warn?: boolean;
  label: string;
  /** Phone shows its action in blue, as the one to act on. */
  go?: boolean;
  act(): void;
  skip?(): void;
}

/** Desktop shows one alert at a time, with the rest a click away. */
function Alerts(props: { alerts: readonly Alert[] }) {
  const [more, setMore] = useState(false);
  const [first, ...rest] = props.alerts;
  if (!first) return null;
  const row = (a: Alert) => (
    <div key={a.key} className={`attn${a.warn ? ' warn' : ''}`} role="status">
      <div>
        <div className="strong">{a.title}</div>
        {a.text && <div className="small">{a.text}</div>}
      </div>
      <div className="row">
        <button className="btn sm" type="button" onClick={a.act}>
          {a.label}
        </button>
        {a.skip && (
          <button className="btn sm" type="button" onClick={a.skip}>
            Skip for now
          </button>
        )}
      </div>
    </div>
  );
  return (
    <div className="stack8">
      {row(first)}
      {more && rest.map(row)}
      {rest.length > 0 && (
        <div>
          <button className="link small" type="button" aria-expanded={more} onClick={() => setMore(!more)}>
            {more ? 'Hide' : 'Show'} {rest.length} more {rest.length === 1 ? 'alert' : 'alerts'}
          </button>
        </div>
      )}
    </div>
  );
}

/** Phone shows each as its own quiet row, with × beside one that can wait. */
function AttnRow(props: { alert: Alert }) {
  const { alert } = props;
  const row = (
    <button className={alert.skip ? 'attn grow' : 'attn'} type="button" onClick={alert.act}>
      <span>{alert.title}</span> <span className={alert.go ? 'attngo' : 'quiet'}>{alert.label}</span>
    </button>
  );
  if (!alert.skip) return row;
  return (
    <div className="row nowrap stretchdue">
      {row}
      <button className="icbtn" type="button" aria-label={`Skip for now: ${alert.title}`} onClick={alert.skip}>
        ×
      </button>
    </div>
  );
}

function Head(props: { date: string; title: string }) {
  const { layout } = useApp();
  return (
    <div>
      <div className={layout === 'phone' ? 'small quiet' : 'date'}>{formatDayLong(props.date)}</div>
      <h1>{props.title}</h1>
    </div>
  );
}

/** The first control at or after an element, for focus once the control that was before it has gone. */
function firstControl(from: Element | null): HTMLElement | null {
  for (let el = from; el; el = el.nextElementSibling) {
    const found = el.matches('button,a[href]') ? el : el.querySelector('button:not([disabled]),a[href]');
    if (found) return found as HTMLElement;
  }
  return null;
}

function TodayView(props: { data: TodayData; unplanned: boolean; pick: string | null }) {
  const { data, unplanned } = props;
  const { clock, layout, sync } = useApp();
  const land = useFocusLanding();
  const nav = useNav();
  const { prompt, missed } = usePrompts(data);
  const { call } = useCalendarCall();
  const [panel, setPanel] = useState<'shift' | 'queue' | null>(null);
  const [skippedStretch, setSkippedStretch] = useStickyState<string | null>('today.skippedStretch', null);
  const [skippedCalendar, setSkippedCalendar] = useStickyState<string | null>('today.skippedCalendar', null);
  const phone = layout === 'phone';

  const shift = shiftRestOfToday(data.blocks, data.events, data.settings.availability, clock);
  const clash = shift && `${shift.conflict.block.title} conflicts with ${'event' in shift.conflict ? shift.conflict.event.title : shift.conflict.running.title}.`;
  const next = planningDue(data.settings, data.date) ? planStretch(data.settings, data.date, true) : null;
  // By its end, since a first plan's start is today until planning begins.
  const stretchDue = next && skippedStretch !== next.end ? next : null;
  // Never planned, the plan is for the stretch already under way.
  const planText = !stretchDue
    ? ''
    : data.settings.plan_stretch.last_planned
      ? `Plan the next stretch. It starts ${formatDate(stretchDue.start)}.`
      : `Plan your first stretch. It ends ${formatDate(stretchDue.end)}.`;
  const queued = data.queue.length;

  const alerts: Alert[] = [];
  if (shift && !phone) alerts.push({ key: 'shift', title: 'Scheduling conflict', text: clash!, warn: true, label: 'Shift rest of today', act: () => setPanel('shift') });
  if (missed) alerts.push({ key: 'missed', title: missed.title, label: 'Review', act: missed.review });
  if (queued) {
    alerts.push(
      phone
        ? { key: 'queue', title: `${queued} ${queued === 1 ? 'task needs' : 'tasks need'} a new time`, label: 'Review', act: () => setPanel('queue') }
        : { key: 'queue', title: 'Needs a new time', text: `${queued} ${queued === 1 ? 'task' : 'tasks'} that didn't get done. Choose when it suits you.`, label: 'Review', act: () => setPanel('queue') },
    );
  }
  if (stretchDue) {
    alerts.push({ key: 'stretch', title: planText, label: 'Start', go: true, act: () => nav.openFlow('plan'), skip: () => setSkippedStretch(stretchDue.end) });
  }
  // Connecting needs a sign-in. Skipped, it asks again the next week.
  const week = thisWeek(clock);
  if (sync && data.signedIn && !data.connected && skippedCalendar !== week) {
    alerts.push({
      key: 'calendar',
      title: 'Connect Google Calendar',
      text: 'Plan around your events and see your blocks in Google.',
      label: 'Connect',
      act: () => void call(sync.connectCalendar),
      skip: () => setSkippedCalendar(week),
    });
  }

  // One planning row at a time: this week's set time, else next week's row, which also takes the place of a skipped
  // week's banner, since that week is nearly over.
  const set = weekGate(data.planning.this, clock) === 'set' ? blockAhead(data.planning.this, clock) : undefined;
  const nextRow = !set && weekRow(data.planning.next, clock);
  const skipped = unplanned && !!data.planning.this.plan?.planning_skipped_at;

  return (
    <div className={phone ? 'stack today' : 'wrap stack24 today'}>
      <Head date={data.date} title="Today" />
      {skipped && !nextRow && <Banner />}
      {phone && shift && (
        <div className="warn shiftwarn" role="status">
          <div className="grow100">
            <div className="strong">Scheduling conflict</div>
            <div>{clash}</div>
          </div>
          <button className="btn" type="button" aria-expanded={panel === 'shift'} onClick={() => setPanel(panel === 'shift' ? null : 'shift')}>
            Shift rest of today
          </button>
        </div>
      )}
      {phone ? alerts.map((a) => <AttnRow key={a.key} alert={a} />) : <Alerts alerts={alerts} />}
      {panel === 'shift' && shift && <ShiftPanel plan={shift} connected={data.connected} onClose={() => setPanel(null)} />}
      {panel === 'queue' && <QueuePanel items={data.queue} onClose={() => setPanel(null)} />}
      {unplanned && data.blocks.length === 0 ? (
        <NextUp data={data} pick={props.pick} />
      ) : (
        <NowCard blocks={data.blocks} layout={layout} />
      )}
      {set && <PlanningSet week={data.planning.this.week} block={set} />}
      {nextRow && <PlanningRow week={data.planning.next.week} onGone={(after) => land(() => firstControl(after))} />}
      <OneOffsToday data={data} />
      <ToSchedule date={data.date} />
      {(data.blocks.length > 0 || !unplanned) && <DayTimeline data={data} events={data.events} />}
      {!phone && data.connected && <p className="small quiet">Blocks mirror to the Time blocks calendar in Google, one-way. Edit them here.</p>}
      {prompt}
    </div>
  );
}

/** Every block still gets its prompts while Today asks to plan the week. */
function Prompts(props: { data: TodayData }) {
  return <>{usePrompts(props.data).prompt}</>;
}

export default function Screen(_props: ScreenProps) {
  // Re-reads the time often enough for blocks to start and end on screen; the countdown ticks on its own.
  useNow(10_000);
  const { clock, layout } = useApp();
  const { data } = useQuery((sql, c) => loadToday(sql, c), []);
  const [picking, setPicking] = useState(false);
  // Whenever this device works out Today, it saves any planning task that's due. It places no time.
  const day = useToday();
  const makeDue = useMutation(({ automatic: w }) => makeDuePlanningTasks(w, clock));
  const makeDueRun = makeDue.run;
  useEffect(() => {
    void makeDueRun();
  }, [makeDueRun, day]);
  const skip = useMutation((w) => skipWeek(w, thisWeek(clock), clock));
  const [pick, setPick] = useStickyState<{ date: string; id: string } | null>('today.pick', null);
  if (!data) return <div className={layout === 'phone' ? 'stack' : 'wrap stack24'} />;

  const welcome = welcomeBack(data.recent, data.away, clock);
  const frame = (title: string, body: ReactNode) => (
    <div className={layout === 'phone' ? 'stack' : 'wrap stack24'}>
      <Head date={data.date} title={title} />
      {body}
    </div>
  );

  if (picking) {
    return frame(
      'Pick one thing for today',
      <PickOne
        data={data}
        onPick={(id) => {
          setPick({ date: data.date, id });
          void skip.run();
          setPicking(false);
        }}
      />,
    );
  }
  if (welcome) return frame('Welcome back', <Welcome blocks={welcome.blocks} onReturned={() => setPicking(true)} />);
  if (weekGate(data.planning.this, clock) === 'gate') {
    return frame(
      'Plan your week',
      <>
        <Gate data={data} />
        <Prompts data={data} />
      </>,
    );
  }
  return <TodayView data={data} unplanned={!data.planned} pick={pick?.date === data.date ? pick.id : null} />;
}

// Today: the block in progress or next, what needs attention, one offs due today and the day's timeline, then a line
// into Done. When the week isn't planned it opens on a prompt to plan, and after time away on Welcome back. Phone has
// its own Today, the day's calendar first (Phone.tsx), where the prompt to plan is a row above the day.

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { formatDayLong, instantMs, thisWeek } from '../../../core/dates';
import { shiftRestOfToday, welcomeBack } from '../../../core/queue';
import { perf } from '../../../core/perf';
import { useDrawn } from '../../app/drawn';
import type { ScreenProps } from '../../app/registry';
import { useApp, useMutation, useNow, useQuery, useStickyState, useToday } from '../../app/store';
import { PlanningRow, PlanningSet } from '../../components/planning/PlanningRow';
import { StretchRow } from '../../components/planning/StretchRow';
import { BothRows } from '../../components/planning/BothRow';
import { useFocusLanding } from '../../components/useFocusLanding';
import { blockAhead, coveredWeek, makeDuePlanningTasks, skipWeek, stretchRow, weekGate, weekRow } from '../../../core/planning';
import { DoneLine } from '../done/DoneLine';
import { useCalendarCall } from '../settings/useCalendarCall';
import { loadToday } from './data';
import type { TodayData } from './data';
import { DayTimeline } from './DayTimeline';
import { NowCard } from './NowCard';
import { NotesToday } from '../notes/NoteList';
import { OneOffsToday } from './OneOffsToday';
import { QueuePanel } from './QueuePanel';
import { ToSchedule } from './ToSchedule';
import { ShiftPanel } from './ShiftPanel';
import { usePrompts, usePutAway } from './usePrompts';
import type { PutAway } from './usePrompts';
import { Banner, Gate, NextUp, PickOne, Welcome } from './Views';
import { firstControl, PhoneToday } from './Phone';
import './today.css';
import { Button } from '../../components/ds/Button';

interface Alert {
  key: string;
  title: string;
  text?: string;
  warn?: boolean;
  label: string;
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
        <Button size="compact" type="button" onClick={a.act}>
          {a.label}
        </Button>
        {a.skip && (
          <Button size="compact" type="button" onClick={a.skip}>
            Skip for now
          </Button>
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

function Head(props: { date: string; title: string }) {
  const { layout } = useApp();
  return (
    <div>
      <div className={layout === 'phone' ? 'small quiet' : 'date'}>{formatDayLong(props.date)}</div>
      <h1>{props.title}</h1>
    </div>
  );
}

/** Today on desktop; phone has its own (Phone.tsx). */
function TodayView(props: { data: TodayData; unplanned: boolean; pick: string | null; putAway: PutAway }) {
  const { data, unplanned } = props;
  const { clock, layout, sync } = useApp();
  const land = useFocusLanding();
  const { prompt, missed } = usePrompts(data, props.putAway);
  const { call } = useCalendarCall();
  const [panel, setPanel] = useState<'shift' | 'queue' | null>(null);
  const [skippedCalendar, setSkippedCalendar] = useStickyState<string | null>('today.skippedCalendar', null);

  const shift = shiftRestOfToday(data.blocks, data.events, data.settings.availability, clock);
  const clash = shift && `${shift.conflict.block.title} conflicts with ${'event' in shift.conflict ? shift.conflict.event.title : shift.conflict.running.title}.`;
  const queued = data.queue.length;

  const alerts: Alert[] = [];
  if (shift) alerts.push({ key: 'shift', title: 'Scheduling conflict', text: clash!, warn: true, label: 'Shift rest of today', act: () => setPanel('shift') });
  if (missed) alerts.push({ key: 'missed', title: missed.title, label: 'Review', act: missed.review });
  if (queued) {
    alerts.push({ key: 'queue', title: 'Needs a new time', text: `${queued} ${queued === 1 ? 'task' : 'tasks'} that didn't get done. Choose when it suits you.`, label: 'Review', act: () => setPanel('queue') });
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
  const stretchPlan = data.planning.stretch;
  // A stretch's block shared with next week covers the week's own row.
  const covered = !!stretchPlan && coveredWeek(stretchPlan.task) === data.planning.next.week && !!blockAhead(stretchPlan, clock);
  const nextRow = !set && !covered && weekRow(data.planning.next, clock);
  // The stretch's row waits behind next week's.
  const stretch = data.planning.stretch;
  const stretchShown = !set && !nextRow && !!stretch && stretchRow(stretch, clock);
  // An unplanned day with nothing on it but planning that's over offers Next up, as an empty day does.
  const work = data.blocks.some((b) => b.task_kind !== 'planning' || (!b.ended_at && instantMs(b.end) > clock.now()));
  const skipped = unplanned && !!data.planning.this.plan?.planning_skipped_at;

  return (
    <div className="wrap stack24 today">
      <Head date={data.date} title="Today" />
      {skipped && !nextRow && <Banner />}
      <Alerts alerts={alerts} />
      {panel === 'shift' && shift && <ShiftPanel plan={shift} connected={data.connected} onClose={() => setPanel(null)} />}
      {panel === 'queue' && <QueuePanel items={data.queue} onClose={() => setPanel(null)} />}
      {unplanned && !work ? (
        <NextUp data={data} pick={props.pick} />
      ) : (
        <NowCard blocks={data.blocks} layout={layout} />
      )}
      {set && <PlanningSet week={data.planning.this.week} block={set} />}
      {/* A first plan, due until it's made, waits behind the week's rather than joining it. */}
      {nextRow && stretchPlan && !stretchPlan.first && stretchRow(stretchPlan, clock) ? (
        <BothRows week={data.planning.next} stretch={stretchPlan.stretch} first={stretchPlan.first} onGone={(after) => land(() => firstControl(after))} />
      ) : (
        nextRow && <PlanningRow planning={data.planning.next} onGone={(after) => land(() => firstControl(after))} />
      )}
      {stretchShown && <StretchRow stretch={stretch.stretch} first={stretch.first} onGone={(after) => land(() => firstControl(after))} />}
      <OneOffsToday data={data} />
      <ToSchedule date={data.date} />
      <NotesToday />
      {(work || !unplanned) && <DayTimeline data={data} events={data.events} />}
      <DoneLine />
      {data.connected && <p className="small quiet">Blocks mirror to the Time blocks calendar in Google, one-way. Edit them here.</p>}
      {prompt}
    </div>
  );
}

/** Every block still gets its prompts while Today asks to plan the week. */
function Prompts(props: { data: TodayData; putAway: PutAway }) {
  return <>{usePrompts(props.data, props.putAway).prompt}</>;
}

export default function Screen(_props: ScreenProps) {
  // Re-reads the time often enough for blocks to start and end on screen; the countdown ticks on its own.
  useNow(10_000);
  const { clock, layout } = useApp();
  const { data } = useQuery((sql, c) => loadToday(sql, c), []);
  const [picking, setPicking] = useState(false);
  const putAway = usePutAway();
  // Whenever this device works out Today, it saves any planning task that's due. It places no time.
  const day = useToday();
  const makeDue = useMutation(({ automatic: w }) => makeDuePlanningTasks(w, clock));
  const makeDueRun = makeDue.run;
  useEffect(() => {
    void makeDueRun();
  }, [makeDueRun, day]);
  const skip = useMutation((w) => skipWeek(w, thisWeek(clock), clock));
  const [pick, setPick] = useStickyState<{ date: string; id: string } | null>('today.pick', null);
  useDrawn('nav.today', !!data);
  // Where the start KPIs end: Today drawn with its data and taking input.
  const loaded = !!data;
  useEffect(() => {
    if (loaded) perf.markAfterPaint('today:interactive');
  }, [loaded]);
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
  const todaysPick = pick?.date === data.date ? pick.id : null;
  if (layout === 'phone') return <PhoneToday data={data} unplanned={!data.planned} pick={todaysPick} putAway={putAway} />;
  if (weekGate(data.planning.this, clock) === 'gate') {
    return frame(
      'Plan your week',
      <>
        <Gate data={data} />
        <Prompts data={data} putAway={putAway} />
      </>,
    );
  }
  return <TodayView data={data} unplanned={!data.planned} pick={todaysPick} putAway={putAway} />;
}

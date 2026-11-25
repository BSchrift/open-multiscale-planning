// Today on phone: the day's calendar is the screen. Above it, the title with a menu for the view and zoom, then a few
// quiet rows: a conflict, the week's plan, what's waiting for a time, and in the evening what got done. Then what's due
// today, as chips, and the day, opening an hour before its selected block with the hours before folded into a row.
// The selected block is raised out of its lane as a card with what it can do now: the one in progress, else one that
// just ended and asks how it went, else the next when it starts within the hour. A tap selects another block, and a
// second tap or Details opens its popup. Tapping Today again goes back to where the day opens.

import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { currentBlock, nextBlock, timeLeftMs } from '../../../core/blocks';
import { addDays, formatTime, instantMs, localMinutes, thisWeek } from '../../../core/dates';
import type { LocalDate } from '../../../core/types';
import type { ScreenProps } from '../../app/registry';
import { blockAhead, coveredWeek, rowState, stretchRow, weekGate, weekRow } from '../../../core/planning';
import { shiftRestOfToday } from '../../../core/queue';
import { DRAWN_DAY, GRID, isOpen } from '../../../core/slots';
import { notesForDay } from '../../../core/queries';
import type { OneOffRow } from '../../../core/schedule';
import { PaneShown, useNav } from '../../app/nav';
import { useApp, useQuery, useStickyState, useToday } from '../../app/store';
import { Menu } from '../../components/Menu';
import type { MenuEntry } from '../../components/Menu';
import { Sheet } from '../../components/Sheet';
import { BothRows } from '../../components/planning/BothRow';
import { PlanningRow, PlanningSet } from '../../components/planning/PlanningRow';
import { PlanningTimes } from '../../components/planning/PlanningTimes';
import { StretchRow } from '../../components/planning/StretchRow';
import { About } from '../../components/planning/About';
import { usePlanningActions, usePlanningRequest, usePlanningTimes } from '../../components/planning/usePlanning';
import { useFocusLanding } from '../../components/useFocusLanding';
import { useOneOffTick } from '../../components/oneoff';
import { Button } from '../../components/ds/Button';
import { Icon } from '../../components/ds/Icon';
import { DoneLine } from '../done/DoneLine';
import { TodaysNotes } from '../notes/NoteList';
import { useCalendarCall } from '../settings/useCalendarCall';
import { LaneCard, laneCount } from '../week/lane';
import type { WeekData } from '../week/data';
import { useWeekScreen } from '../week/index';
import { PhoneWeek } from '../week/Phone';
import type { HostWeek } from '../week/Phone';
import { dayOfWeek } from './data';
import type { TodayData } from './data';
import { DayTimeline, PHONE_ZOOM, ZOOM } from './DayTimeline';
import type { PhoneDay } from './DayTimeline';
import { spoken } from './NowCard';
import { OneOffRowItem, oneOffsToday } from './OneOffsToday';
import { QueueRows } from './QueuePanel';
import { minutesWords } from './Raised';
import { defaultSelection, openMinute, raiseOf } from './selection';
import { ShiftPanel } from './ShiftPanel';
import { ToScheduleActions, useToSchedule } from './ToSchedule';
import { useLanding } from '../week/landing';
import { useWeekActions } from '../week/useWeekActions';
import { usePrompts } from './usePrompts';
import type { PutAway } from './usePrompts';
import { NextUp } from './Views';

/** The first control at or after an element, for focus once the control that was before it has gone. */
export function firstControl(from: Element | null): HTMLElement | null {
  for (let el = from; el; el = el.nextElementSibling) {
    const found = el.matches('button,a[href]') ? el : el.querySelector('button:not([disabled]),a[href]');
    if (found) return found as HTMLElement;
  }
  return null;
}

export function PhoneToday(props: { screen: ScreenProps; data: TodayData; unplanned: boolean; pick: string | null; putAway: PutAway }) {
  const { data, unplanned } = props;
  const { clock, sync } = useApp();
  const nav = useNav();
  const land = useFocusLanding();
  const day = useToday();
  const shown = useContext(PaneShown);
  const { prompt, missed } = usePrompts(data, props.putAway, { onItself: true });
  const { call } = useCalendarCall();
  const [panel, setPanel] = useState<{ kind: 'shift' | 'start' | 'plan' } | { kind: 'waiting'; day: LocalDate; add(): void } | null>(null);
  const [startUntil, setStartUntil] = useState<string | null>(null);
  const [skippedCalendar, setSkippedCalendar] = useStickyState<string | null>('today.skippedCalendar', null);
  const [view, setView] = useStickyState<'calendar' | 'list'>('today.view', 'calendar');
  const [ph, setPh] = useState(PHONE_ZOOM);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number; from: HTMLElement; week: HostWeek } | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  // Another day's selected block, which goes with its day.
  const [otherPicked, setOtherPicked] = useState<{ date: LocalDate; id: string } | null>(null);
  const [earlierOpen, setEarlierOpen] = useState(false);

  const cur = currentBlock(data.blocks, clock);
  const next = nextBlock(data.blocks, clock);
  const chosen = defaultSelection(data.blocks, data.away, clock);
  const selected = picked && data.blocks.some((b) => b.id === picked) ? picked : chosen;
  const selectedBlock = data.blocks.find((b) => b.id === selected);
  // A block picked to answer hands the selection back, to the block Today picks, once it's answered: by the card, or
  // the sheet Partly opens.
  const pickedBlock = data.blocks.find((b) => b.id === picked);
  const pickedRaise = pickedBlock ? raiseOf(pickedBlock, data.blocks, clock) : null;
  const asking = useRef(false);
  useEffect(() => {
    if (asking.current && pickedRaise !== 'answer') setPicked(null);
    asking.current = pickedRaise === 'answer';
  }, [pickedRaise]);

  // Where the day opens: an hour before the block Today picks, else now. Worked out as the day opens, when Today is
  // tapped again and on a new day, never while it's being read, so nothing moves under a finger.
  // With nothing left on the day, it opens on the last block, to show how the day went.
  const anchorNow = () => {
    const ended = !currentBlock(data.blocks, clock) && !nextBlock(data.blocks, clock);
    const b = data.blocks.find((x) => x.id === chosen) ?? (ended ? data.blocks.at(-1) : undefined);
    return openMinute(localMinutes(b ? b.start : clock.now(), clock.zone()), 0);
  };
  const [open, setOpen] = useState(anchorNow);
  const reopen = useRef(() => {});
  reopen.current = () => {
    setOpen(anchorNow());
    setPicked(null);
    setEarlierOpen(false);
  };
  useEffect(() => reopen.current(), [day]);
  // Planning started from the footer's sheet covers Today; the sheet's done once it has.
  useEffect(() => {
    if (nav.flow) setPanel((p) => (p?.kind === 'plan' ? null : p));
  }, [nav.flow]);
  const signal = useRef(nav.topSignal);
  useEffect(() => {
    if (signal.current !== nav.topSignal && shown !== false && nav.tab === 'today') reopen.current();
    signal.current = nav.topSignal;
  }, [nav.topSignal, nav.tab, shown]);

  const shift = shiftRestOfToday(data.blocks, data.events, data.settings.availability, clock);
  const clash = shift && `${shift.conflict.block.title} conflicts with ${'event' in shift.conflict ? shift.conflict.event.title : shift.conflict.running.title}.`;

  // One planning row at a time, as Today has always had them: this week's set time, else a stretch's. Planning this
  // week before it's planned, or next week once that's due, is the strip's footer.
  const gate = weekGate(data.planning.this, clock) === 'gate';
  const set = weekGate(data.planning.this, clock) === 'set' ? blockAhead(data.planning.this, clock) : undefined;
  const stretchPlan = data.planning.stretch;
  const covered = !!stretchPlan && coveredWeek(stretchPlan.task) === data.planning.next.week && !!blockAhead(stretchPlan, clock);
  const nextRow = !set && !covered && weekRow(data.planning.next, clock);
  const stretchShown = !set && !nextRow && !!stretchPlan && stretchRow(stretchPlan, clock);
  const onGone = (after: Element | null) => land(() => firstControl(after));
  const skipped = !!data.planning.this.plan?.planning_skipped_at;
  // Skipped, it stays, as a way back to planning, unless next week's planning is already due.
  const planThis = unplanned && (gate || (skipped && !nextRow));
  const plan = planThis ? ('this' as const) : nextRow ? ('next' as const) : null;
  const nextTitle = rowState(data.planning.next, clock) === 'stopped' ? 'Finish planning next week' : 'Plan next week';
  // The weekly reminder's Choose a time opens next week's planning, whose row then asks when.
  const request = usePlanningRequest();
  useEffect(() => {
    if (request && request === data.planning.next.week && plan === 'next') setPanel({ kind: 'plan' });
  }, [request, data.planning.next.week, plan]);

  // Connecting needs a sign-in. Skipped, it asks again the next week.
  const week = thisWeek(clock);
  const connect = !!sync && data.signedIn && !data.connected && skippedCalendar !== week;

  // The evening of a planned day: nothing left on it, so what got done leads. An unplanned day offers free time instead.
  const evening = !unplanned && !cur && !next && data.blocks.some((b) => b.task_kind !== 'planning');
  // Once nothing's left to answer either and the day's open time is over, Today opens on tomorrow, and Today comes back.
  const [start] = useState(() => {
    const now = localMinutes(clock.now(), clock.zone());
    const openLeft = Array.from({ length: (DRAWN_DAY.to - DRAWN_DAY.from) / GRID }, (_, k) => DRAWN_DAY.from + k * GRID).some((m) => m + GRID > now && isOpen(data.settings.availability, data.date, m, 'project'));
    return evening && !chosen && !openLeft ? addDays(data.date, 1) : undefined;
  });
  const weekProps = useWeekScreen(props.screen, 'today', start);

  const zoomIn = ZOOM.find((z) => z > ph);
  const zoomOut = [...ZOOM].reverse().find((z) => z < ph);
  const viewMenu: MenuEntry[] = [
    ...(view === 'calendar' && zoomIn ? [{ id: 'in', label: 'Zoom in', icon: 'zoom-in' as const }] : []),
    ...(view === 'calendar' && zoomOut ? [{ id: 'out', label: 'Zoom out', icon: 'zoom-out' as const }] : []),
    view === 'calendar' ? { id: 'list', label: 'Show as a list', icon: 'list' } : { id: 'calendar', label: 'Show as a calendar', icon: 'calendar' },
  ];
  const choose = (id: string, w: HostWeek) => {
    if (id === 'in' && zoomIn) setPh(zoomIn);
    if (id === 'out' && zoomOut) setPh(zoomOut);
    if (id === 'list' || id === 'calendar') setView(id);
    if (id.startsWith('week.')) w.choose(id);
  };
  const phoneDay = (w: HostWeek, current: boolean) => ({
    view,
    ph,
    setPh,
    choose: w.move,
    ...(current ? { onDrafting: w.drafting } : {}),
  });

  // Until the week's read: Today's own data is in, so only the strip and the day wait.
  if (!weekProps) return <div className="today tdphone" aria-busy="true" />;
  return (
    <PhoneWeek
      key={weekProps.data.week}
      {...weekProps}
      host={{
        className: 'today tdphone',
        busy: false,
        head: (w) => (
          <>
            <div className="tdhead">
              <h1>{w.heading.name}</h1>
              <span className="tddate">{w.heading.date}</span>
              {(w.day !== data.date || w.offset !== 0) && (
                <Button className="tdtoday" type="button" onClick={w.goToday}>
                  Today
                </Button>
              )}
              <Button
                variant="icon"
                icon="more"
                label="View and week"
                aria-haspopup="menu"
                aria-expanded={!!menuAt}
                className="tdmenu"
                type="button"
                onClick={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  setMenuAt({ x: r.right - 240, y: r.bottom + 8, from: e.currentTarget, week: w });
                }}
              />
            </div>
            {w.day === data.date && <SelectedHeading block={selectedBlock} blocks={data.blocks} />}
          </>
        ),
        above: evening && <DoneLine />,
        rows: (
          <>
            {shift && (
              <div className="warn shiftwarn" role="status">
                <div className="grow100">
                  <div className="strong">Scheduling conflict</div>
                  <div>{clash}</div>
                </div>
                <Button type="button" aria-expanded={panel?.kind === 'shift'} onClick={() => setPanel(panel?.kind === 'shift' ? null : { kind: 'shift' })}>
                  Shift rest of today
                </Button>
              </div>
            )}
            {panel?.kind === 'shift' && shift && <ShiftPanel plan={shift} connected={data.connected} onClose={() => setPanel(null)} />}
            {set && <PlanningSet week={data.planning.this.week} block={set} />}
            {stretchShown && <StretchRow stretch={stretchPlan.stretch} first={stretchPlan.first} onGone={onGone} />}
            <DueRow data={data} />
          </>
        ),
        foot: (w) =>
          w.offset >= 0 && (
            <TodayFoot
              data={data}
              day={w.day}
              plan={w.offset === 0 && plan ? (plan === 'this' ? 'Plan this week' : nextTitle) : null}
              missed={missed}
              connect={connect}
              onPlan={() => setPanel({ kind: 'plan' })}
              onWaiting={() => setPanel({ kind: 'waiting', day: w.day, add: w.add })}
            />
          ),
        day: (date, current, weekData, w) =>
          date === data.date ? (
            <DayTimeline
              data={data}
              events={data.events}
              phoneDay={{
                ...phoneDay(w, current),
                selected,
                select: setPicked,
                open,
                earlierOpen,
                setEarlierOpen,
                startSomething: (until) => {
                  setStartUntil(until);
                  setPanel({ kind: 'start' });
                },
              }}
            />
          ) : (
            weekData && (
              <OtherDay
                date={date}
                week={weekData}
                phoneDay={{
                  ...phoneDay(w, current),
                  selected: otherPicked && otherPicked.date === date ? otherPicked.id : null,
                  select: (id: string | null) => setOtherPicked(id ? { date, id } : null),
                  open: null,
                  earlierOpen: false,
                  setEarlierOpen: () => undefined,
                  startSomething: () => undefined,
                }}
              />
            )
          ),
        extra: (
          <>
            {panel?.kind === 'waiting' && (
              <WaitingSheet
                data={data}
                day={panel.day}
                missed={missed}
                connect={connect ? { go: () => void call(sync!.connectCalendar), skip: () => setSkippedCalendar(week) } : null}
                onAdd={() => {
                  panel.add();
                  setPanel(null);
                }}
                onClose={() => setPanel(null)}
              />
            )}
            {panel?.kind === 'plan' && plan === 'this' && <PlanSheet week={week} skipped={!gate} onClose={() => setPanel(null)} />}
            {panel?.kind === 'plan' && plan === 'next' && (
              <Sheet label={nextTitle} onClose={() => setPanel(null)} className="tdsheet">
                <div className="between">
                  <h2>{nextTitle}</h2>
                  <Button variant="icon" icon="close" label="Close" type="button" onClick={() => setPanel(null)} />
                </div>
                {stretchPlan && !stretchPlan.first && stretchRow(stretchPlan, clock) ? (
                  <BothRows week={data.planning.next} stretch={stretchPlan.stretch} first={stretchPlan.first} onGone={() => setPanel(null)} />
                ) : (
                  <PlanningRow planning={data.planning.next} onGone={() => setPanel(null)} />
                )}
              </Sheet>
            )}
            {panel?.kind === 'start' && (
              <Sheet label="Start something" onClose={() => setPanel(null)} tall className="tdsheet">
                <div className="between">
                  <div>
                    <h2>{startUntil ? `Free until ${formatTime(startUntil, clock.zone())}` : 'Free for the rest of the day'}</h2>
                    {startUntil && <div className="small quiet">{minutesWords(Math.max(1, Math.round((instantMs(startUntil) - clock.now()) / 60_000)))} from now</div>}
                  </div>
                  <Button variant="icon" icon="close" label="Close" type="button" onClick={() => setPanel(null)} />
                </div>
                <NextUp data={data} pick={props.pick} onStarted={() => setPanel(null)} />
                <p className="small quiet">Start puts it on the calendar from now, with Undo.</p>
              </Sheet>
            )}
            {menuAt && (
              <Menu
                label="View and week"
                entries={menuAt.week.menu.length ? [...viewMenu, 'separator', ...menuAt.week.menu] : viewMenu}
                at={menuAt}
                onClose={() => {
                  menuAt.from.focus({ preventScroll: true });
                  setMenuAt(null);
                }}
                onChoose={(id) => {
                  setMenuAt(null);
                  choose(id, menuAt.week);
                }}
              />
            )}
            {prompt}
          </>
        ),
      }}
    />
  );
}

/** Another day of the week, drawn as today is, from its week's data. Only today has a now, so nothing's under way. */
function OtherDay(props: { date: LocalDate; week: WeekData; phoneDay: PhoneDay }) {
  const { clock } = useApp();
  const zone = clock.zone();
  const data = useMemo(() => dayOfWeek(props.week, props.date, zone), [props.week, props.date, zone]);
  return <DayTimeline data={data} events={data.events} phoneDay={props.phoneDay} />;
}

/**
 * The strip footer's actions: planning this week before it's planned, or next week once that's due, then what's waiting
 * for a time on the day shown and before it, which opens one sheet.
 */
function TodayFoot(props: {
  data: TodayData;
  day: LocalDate;
  /** Plan this week, Plan next week or Finish planning next week, when one's due. */
  plan: string | null;
  missed: { title: string; count: number } | null;
  connect: boolean;
  onPlan(): void;
  onWaiting(): void;
}) {
  const { data, missed } = props;
  const lane = useToSchedule(props.day);
  const waiting = data.queue.length + (lane?.items.length ?? 0);
  const label =
    [waiting ? `${waiting} to schedule` : '', missed ? `${missed.count} missed ${missed.count === 1 ? 'block' : 'blocks'} to check in on` : ''].filter(Boolean).join(', ') ||
    (props.connect ? 'Connect Google Calendar' : '');
  return (
    <>
      {props.plan && (
        <Button type="button" aria-haspopup="dialog" onClick={props.onPlan}>
          {props.plan}
        </Button>
      )}
      {label && (
        <button className="link sfwait" type="button" aria-haspopup="dialog" onClick={props.onWaiting}>
          {label}
          <Icon name="chevron-right" size={16} />
        </button>
      )}
    </>
  );
}

/** For screen readers, after the title: the block selected, as its card says it. */
function SelectedHeading(props: { block: TodayData['blocks'][number] | undefined; blocks: TodayData['blocks'] }) {
  const { clock } = useApp();
  const { block } = props;
  if (!block) return null;
  const title = block.title ?? 'Time block';
  const raise = raiseOf(block, props.blocks, clock);
  const text =
    raise === 'now'
      ? block.started_at
        ? `Now: ${title}, ${spoken(Math.max(0, Math.ceil(timeLeftMs(block, clock.now()) / 60_000)))} left`
        : `Now: ${title}, not started`
      : raise === 'answer'
        ? `${title} ended at ${formatTime(block.ended_at ?? block.end, clock.zone())}. How did it go?`
        : raise === 'next'
          ? `Next: ${title}, at ${formatTime(block.start, clock.zone())}`
          : `Selected: ${title}, at ${formatTime(block.start, clock.zone())}`;
  return <h2 className="sr">{text}</h2>;
}

/**
 * Planning this week, from the strip's footer before it's planned: Start planning, Choose a time, and Skip, saved as
 * Skip for now is. Skipped, the footer still offers it, without Skip.
 */
function PlanSheet(props: { week: string; skipped: boolean; onClose(): void }) {
  const { week, onClose } = props;
  const planning = usePlanningTimes(week);
  const act = usePlanningActions();
  const [choosing, setChoosing] = useState(false);
  const minutes = planning?.estimate.minutes;
  return (
    <Sheet label="Plan this week" onClose={onClose} className="tdsheet">
      <div className="between">
        <div>
          <h2>{props.skipped ? "This week isn't planned" : "This week isn't planned yet"}</h2>
          {minutes !== undefined && (
            <div className="small quiet">
              <About minutes={minutes} after=" to plan" />
            </div>
          )}
        </div>
        <Button variant="icon" icon="close" label="Close" type="button" onClick={onClose} />
      </div>
      <Button variant="primary" type="button" disabled={minutes === undefined} onClick={() => minutes !== undefined && void act.start(week, minutes)}>
        Start planning
      </Button>
      <Button type="button" aria-label="Choose a time to plan this week" onClick={() => setChoosing(true)}>
        Choose a time
      </Button>
      {!props.skipped && (
        <Button
          type="button"
          disabled={act.pending}
          onClick={() => {
            onClose();
            void act.skip(week);
          }}
        >
          Skip planning this week
        </Button>
      )}
      {choosing && <PlanningTimes for={week} name="this week" onClose={() => setChoosing(false)} />}
    </Sheet>
  );
}

/**
 * What's waiting for a time, in one sheet from the strip's footer: missed blocks from earlier days to check in on, work
 * that needs a new time, the week's work for the day shown with no time yet, and connecting Google Calendar.
 */
function WaitingSheet(props: {
  data: TodayData;
  day: LocalDate;
  missed: { title: string; count: number; review(): void } | null;
  connect: { go(): void; skip(): void } | null;
  onAdd(): void;
  onClose(): void;
}) {
  const { data, missed, connect, onClose } = props;
  const lane = useToSchedule(props.day);
  const { clock } = useApp();
  const nav = useNav();
  const act = useWeekActions();
  const [openId, setOpenId] = useState<string | null>(null);
  // Held, a card lifts and the sheet steps aside, so it can be let go on the day; dropped there, it's placed.
  const [aside, setAside] = useState(false);
  const { landing, takeOff, asking } = useLanding(lane?.model.blocks ?? [], lane?.week ?? data.date);
  const item = lane?.items.find((x) => x.id === openId);
  return (
    <>
    <Sheet label="To schedule" onClose={onClose} tall className={`tdsheet${aside ? ' aside' : ''}`}>
      <div className="between">
        <div>
          <h2>To schedule</h2>
          {lane && lane.items.length > 0 && <div className="small quiet">{laneCount(lane.items)}</div>}
        </div>
        <Button variant="icon" icon="close" label="Close" type="button" onClick={onClose} />
      </div>
      {missed && (
        <div className="attn tdrow">
          <span>{missed.title}</span>
          <Button
            type="button"
            onClick={() => {
              onClose();
              missed.review();
            }}
          >
            Review
          </Button>
        </div>
      )}
      {data.queue.length > 0 && (
        <section className="stack8" aria-label="Needs a new time">
          <h3 className="tdsh">Needs a new time</h3>
          <div className="card">
            <QueueRows items={data.queue} />
          </div>
        </section>
      )}
      {lane && lane.items.length > 0 && (
        <section className="stack8" aria-label="Waiting for a day">
          <h3 className="tdsh">Waiting for a day</h3>
          <div className="lanerow">
            {lane.items.map((x) => (
              <LaneCard
                key={x.id}
                item={x}
                ctx={lane.model.ctx}
                open={false}
                draggable
                onToggle={() => setOpenId(x.id)}
                onPreview={() => undefined}
                onLift={() => setAside(true)}
                onPut={() => setAside(false)}
                onDrop={(slot) => {
                  // Still aside while a landing on a block asks first; placed, the sheet's done.
                  setAside(true);
                  void landing(x.title, slot).then(async ({ go, off }) => {
                    if (!go) return setAside(false);
                    if (await act.place(x, slot)) takeOff(off);
                    onClose();
                  });
                }}
              />
            ))}
          </div>
          <p className="small quiet">Hold a card, then drag it onto the day, or tap it for suggested times.</p>
        </section>
      )}
      <div className="row">
        {lane && lane.items.length > 0 && (
          <Button type="button" onClick={() => nav.openFlow('planning', { week: lane.week, step: 'schedule' })}>
            Schedule one at a time
          </Button>
        )}
        {lane && lane.week === thisWeek(clock) && (
          <Button type="button" onClick={props.onAdd}>
            Add a task
          </Button>
        )}
      </div>
      {connect && (
        <div className="attn tdrow">
          <div className="grow">
            <div className="strong">Connect Google Calendar</div>
            <div className="small quiet">Plan around your events and see your blocks in Google.</div>
          </div>
          <Button type="button" onClick={connect.go}>
            Connect
          </Button>
          <Button variant="icon" icon="close" label="Skip for now: Connect Google Calendar" type="button" onClick={connect.skip} />
        </div>
      )}
    </Sheet>
    {/* A card's own sheet opens over this one, so closing it comes back to the card, focus and all. */}
    {item && lane && (
      <Sheet label={item.title} onClose={() => setOpenId(null)}>
        <ToScheduleActions item={item} week={lane.week} onClose={() => setOpenId(null)} />
      </Sheet>
    )}
    {asking}
    </>
  );
}

/** What's due today, as chips above the day: each one off dated today and not on the calendar, and today's notes. */
function DueRow(props: { data: TodayData }) {
  const { data } = props;
  const { clock } = useApp();
  const day = useToday();
  const ticks = useOneOffTick();
  const land = useFocusLanding();
  const notes = useQuery((sql) => notesForDay(sql, day), [day]).data ?? [];
  const [open, setOpen] = useState<string | null>(null);
  const rows = oneOffsToday(data, clock);
  if (!rows.length && !notes.length) return null;
  const row = rows.find((r) => r.task.id === open);
  return (
    <div className="tddue" role="group" aria-label="Due today">
      <span className="tdduel" aria-hidden="true">
        Due
      </span>
      <div className="tdchips">
        {rows.map((r) => (
          <DueChip key={r.task.id} row={r} onOpen={() => setOpen(r.task.id)} />
        ))}
        {notes.length > 0 && (
          <button className="tdchip notes" type="button" aria-haspopup="dialog" onClick={() => setOpen('notes')}>
            <Icon name="notes" size={16} />
            {notes.length === 1 ? '1 note' : `${notes.length} notes`}
          </button>
        )}
      </div>
      {row && (
        <Sheet label={row.task.title} onClose={() => setOpen(null)} className="tdsheet">
          <div className="card">
            <OneOffRowItem
              row={row}
              onToggle={(box) => void ticks.toggle(row, box)}
              // A new date off today takes it off Today, and its chip with it, so focus goes to the toast's Undo.
              onSave={() => {
                setOpen(null);
                land(() => document.querySelector<HTMLElement>('[role="status"] .toastact'));
              }}
            />
          </div>
        </Sheet>
      )}
      {open === 'notes' && (
        <Sheet label="Notes for today" onClose={() => setOpen(null)} tall>
          <TodaysNotes notes={notes} />
        </Sheet>
      )}
    </div>
  );
}

function DueChip(props: { row: OneOffRow; onOpen(): void }) {
  const { row } = props;
  return (
    <button
      className={`tdchip blk k-oneoff ${row.checked ? 's-done' : 's-planned'}`}
      type="button"
      aria-haspopup="dialog"
      aria-label={`${row.task.title}, one off due today${row.checked ? ', done' : ''}`}
      onClick={props.onOpen}
    >
      {row.checked && <Icon name="done" size={16} />}
      <span className="blktitle">{row.task.title}</span>
    </button>
  );
}

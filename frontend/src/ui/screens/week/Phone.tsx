// Week on phone. A full week grid doesn't fit, so a sticky strip of seven day buttons shows each day's shape on a
// shared time axis above one day's timeline, which a swipe moves to the day before or after, on into the weeks either
// side, keeping the time of day (DayPager). Tapping a block opens its popup, its task's, practice's or planning's, with
// the block's section at its top, its length among it. Holding a block still to come lifts it, to be let
// go on another row of the day at the time under the finger. Move, or Choose another time for a
// task or for planning, makes the block draggable on the day, the strip carries it to another day, and planning's
// week arrows to another week. To schedule sits above the
// day: a card opens its suggested times, and while editing, cards drag onto the day and blocks drag back up to it.

import { useEffect, useId, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { addDays, diffDays, formatDate, formatMinutes, formatTimeOfDay, formatWeekday, localMinutes, today, weekday, weekStart } from '../../../core/dates';
import { FIRST_BLOCK_MIN } from '../../../core/plan';
import { closestFit, defaultSlot, dragResult, DRAWN_DAY, GRID, isOpen, offers, slotNotes } from '../../../core/slots';
import { SLIDER_STEP } from '../../components/EstimateSlider';
import type { Slot, SlotContext, Work } from '../../../core/slots';
import type { LocalDate, Minutes } from '../../../core/types';
import { useNav } from '../../app/nav';
import { useApp, useQuery } from '../../app/store';
import { PlanningTimes } from '../../components/planning/PlanningTimes';
import { planningWeekOf } from '../../../core/planning';
import { usePlanningActions } from '../../components/planning/usePlanning';
import { DayPager } from '../../components/week/DayPager';
import type { KeptTime } from '../../components/week/DayPager';
import { DayStrip, PackedDay, weekFree } from '../../components/week/DayStrip';
import { StripFold } from '../../components/week/StripFold';
import type { Dot } from '../../components/week/StripFold';
import type { MenuEntry } from '../../components/Menu';
import { Sheet } from '../../components/Sheet';
import { opensPopup, popFor } from '../../components/blocks/BlockName';
import type { PopFor } from '../../components/blocks/BlockName';
import { BlockSection } from '../../components/blocks/BlockSection';
import { isTaskBlock } from '../../components/blocks/describe';
import { NowLine } from '../../components/NowLine';
import { OutcomeTag } from '../../components/blocks/Outcome';
import { blockClass, BlockMarks, blockState, LOOK } from '../../components/ds/Block';
import { clearLane, columnStyle, dayName, finishedCount, holdToDrag, MORE_INSET, MORE_PX, overLane, overlapGroups, overlapNote, shownColumns, slotRange, useWidth } from '../../components/weekgrid';
import type { GridGhost, PlacedBlock } from '../../components/weekgrid';
import { MoreButton } from '../../components/weekgrid/MoreButton';
import { DraftBlock, HoldRing, overlapWords, useHoldToCreate } from '../../components/weekgrid/holdCreate';
import { DraftCapture } from '../capture/DraftCapture';
import { landOn, loadWeek, rowItem } from './data';
import type { AddRow, LaneItem, Placeable, WeekData, WeekModel } from './data';
import { LaneActions, LaneCard, laneCount } from './lane';
import type { PlacingPlanning, WeekProps } from './index';
import { PracticeAsk } from './parts';
import { ResetWeek, resetShown } from './reset';
import { useLanding } from './landing';
import { shortened, SplitAsk } from '../../components/editors/SplitAsk';
import type { Shortened } from '../../components/editors/SplitAsk';
import { useWeekActions } from './useWeekActions';
import { BlockPopup } from '../practice';
import { Button } from '../../components/ds/Button';
import { Icon } from '../../components/ds/Icon';

const { from: DAY_FROM, to: DAY_TO } = DRAWN_DAY;
const HOUR_PX = 48;
const overlaps = (list: readonly Slot[], date: LocalDate, start: number, end: number) => list.some((x) => x.date === date && x.start < end && start < x.end);

/** A block being moved, or a task or planning being placed, before Move here or Place here. */
type Placing =
  | { mode: 'move'; block: PlacedBlock; length: Minutes }
  | { mode: 'place'; item: Placeable; length: Minutes; fromDrawer: boolean }
  | { mode: 'planning'; plan: PlacingPlanning; length: Minutes };

type Open = { kind: 'pop'; pop: PopFor } | { kind: 'add' } | { kind: 'item'; id: string } | null;

const isTask = (b: PlacedBlock) => isTaskBlock(b.kind);

const LONG_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;
const longDay = (date: LocalDate) => LONG_DAYS[weekday(date)];

/** A day said from today, as the phone's Today heads it: "Today" and "Tue, Nov 24", or "Thursday" and "Nov 26". */
export function dayHeading(date: LocalDate, today: LocalDate): { name: string; date: string } {
  if (date === today) return { name: 'Today', date: `${formatWeekday(date)}, ${formatDate(date)}` };
  if (date === addDays(today, 1)) return { name: 'Tomorrow', date: formatDate(date) };
  if (date === addDays(today, -1)) return { name: 'Yesterday', date: formatDate(date) };
  return { name: longDay(date), date: formatDate(date) };
}

/**
 * The phone's Today draws a week as Week does, with its own pieces in it (today/Phone.tsx): its title, its rows on
 * today, and each day as it draws one, in place of Week's rows. Week's own jobs, placing and editing, stay Week's.
 */
export interface WeekHost {
  className: string;
  busy: boolean;
  head(w: HostWeek): ReactNode;
  /** Above the strip, on this week: the evening's Done line. */
  above: ReactNode;
  /** Below the strip, on today only: a conflict, planning rows and what's due. */
  rows: ReactNode;
  /** The strip footer's action for the day shown: planning this week or next, and what's waiting for a time. */
  foot(w: HostWeek): ReactNode;
  /** A day as Today draws it, with its week's data, or null while the week beside is read. */
  day(date: LocalDate, shown: boolean, week: WeekData | null, w: HostWeek): ReactNode;
  /** Sheets, menus and prompts. */
  extra: ReactNode;
  /** An hour's height while editing or placing, as Today draws its own day. */
  hourPx: number;
}

/** What Today's pieces get from the week. */
export interface HostWeek {
  day: LocalDate;
  offset: number;
  heading: { name: string; date: string };
  /** The week's entries for the title's menu, and what choosing one does. */
  menu: MenuEntry[];
  choose(id: string): void;
  goToday(): void;
  /** Choose another time for a block: it waits on the day, ready to drag or carry to another day on the strip. */
  move(id: string): void;
  add(): void;
  drafting(on: boolean): void;
  /** A block's Length slider and slot note for its popup, this week's blocks only. */
  length(id: string): ReactNode;
}

export function PhoneWeek(props: WeekProps & { host: WeekHost }) {
  const { data, model, offset, editing } = props;
  const { clock } = useApp();
  const nav = useNav();
  const act = useWeekActions();
  const planning = usePlanningActions();
  const isThis = offset === 0;
  const now = clock.now();
  const day0 = today(clock);
  const nowMin = localMinutes(now, clock.zone());
  // A swipe past the week's end opens the week beside it on the day it reached, with the time of day it kept.
  const [arrived] = useState(() => (props.openDay && weekStart(props.openDay.date) === data.week ? props.openDay : null));
  const arrivedTime = useRef(arrived?.time ?? null);
  useEffect(() => void (arrivedTime.current = null), []);
  const [selDay, setSelDay] = useState<LocalDate>(arrived?.date ?? (isThis ? day0 : data.week));
  // The day nearest the middle while the day is swiped, which the strip follows. The heading waits for the day to
  // change, since it's above the day and a heading that changed height mid-swipe would move the day.
  const [near, setNear] = useState<LocalDate | null>(null);
  // While a hold's draft waits on the day for Capture, swiping to another day would take it away.
  const [drafting, setDrafting] = useState(false);
  const [open, setOpen] = useState<Open>(null);
  const [placing, setPlacing] = useState<Placing | null>(null);
  const [at, setAt] = useState<Slot | null>(null);
  const [edSel, setEdSel] = useState<string | null>(null);
  const [ask, setAsk] = useState<{ blockId: string; wasMin: Minutes } | null>(null);
  // Landing on placed blocks asks first: keep both, replace them, or leave it.
  const { landing, takeOff, asking } = useLanding(model.blocks, data.week);
  // A task's block made shorter asks what about the rest, until answered or another block is opened.
  const [split, setSplit] = useState<Shortened | null>(null);
  // The phone's Today asks to reset the week from its title's menu.
  const [resetAsking, setResetAsking] = useState(false);
  // Left on today, the day shown follows it when the day turns over, as the week does.
  const [seenDay, setSeenDay] = useState(day0);
  if (seenDay !== day0) {
    setSeenDay(day0);
    if (selDay === seenDay) setSelDay(day0);
  }
  // On the phone's Today, tapping Today again comes back to today, as it does to this week.
  const signal = useRef(nav.topSignal);
  useEffect(() => {
    if (props.host && signal.current !== nav.topSignal && nav.tab === 'today' && !placing) {
      setSelDay(day0);
      setNear(null);
    }
    signal.current = nav.topSignal;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nav.topSignal]);

  const workOf = (p: Placing): Work => (p.mode === 'move' ? { kind: p.block.kind === 'one_off' ? 'one_off' : 'project' } : p.mode === 'planning' ? { kind: 'project' } : p.item.work);
  const kindOf = (p: Placing): Work['kind'] => workOf(p).kind;
  /** What the block being placed is called, and the colour it's drawn in. */
  const drawnOf = (p: Placing) => (p.mode === 'move' ? p.block : p.mode === 'planning' ? { title: p.plan.title, kind: 'planning' as const } : p.item);
  // While moving, the block's own time is free.
  const ctx: SlotContext = placing?.mode === 'move' ? { ...model.ctx, placed: model.ctx.placed.filter((s) => s.id !== placing.block.id) } : model.ctx;
  /** Time already gone is locked: all of a past day, and up to now today. */
  const floorOf = (date: LocalDate) => (!isThis || date > day0 ? DAY_FROM : date < day0 ? DAY_TO : Math.max(DAY_FROM, Math.ceil(nowMin / GRID) * GRID));

  const startPlacing = (p: Placing, slot: Slot | null) => {
    const first = slot ?? defaultSlot(p.length, workOf(p), ctx) ?? { date: selDay, start: 17 * 60, end: 17 * 60 + p.length };
    setOpen(null);
    setPlacing(p);
    setAt(first);
    setSelDay(first.date);
  };
  /** Choose a time on a card: its block waits at its first suggested time, ready to drag. */
  const chooseTime = (item: LaneItem) => startPlacing({ mode: 'place', item, length: item.length, fromDrawer: false }, item.offers[0] ? { ...item.offers[0] } : null);

  // Find a time or Place on calendar from Today: the task's block waits at its best time, ready to drag; Choose a time
  // on a card with no task row, such as a practice's session, places that card. Choose another time for planning: its
  // block waits at the time it was given or carried to, on today if that day has gone, and focus goes to it.
  const focusBlock = useRef(false);
  useEffect(() => {
    if (!props.place) return;
    const given = props.planning;
    if (given) {
      const p: Placing = { mode: 'planning', plan: given, length: given.minutes };
      const from = given.at;
      const date = from && (from.date < day0 ? day0 : from.date > given.last ? given.last : from.date);
      startPlacing(p, from && date ? landOn(date, from, kindOf(p), ctx, floorOf(date)) : null);
      focusBlock.current = true;
      return;
    }
    const row = model.addGroups.flatMap((g) => g.rows).find((r) => r.task.id === props.place);
    const waiting = model.unscheduled.find((x) => x.id === props.place);
    if (row) startPlacing({ mode: 'place', item: rowItem(row), length: Math.min(row.left, FIRST_BLOCK_MIN), fromDrawer: false }, null);
    else if (waiting) chooseTime(waiting);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.place]);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const block = focusBlock.current && root.current?.querySelector<HTMLElement>('.dragblock.draft');
    if (!block) return;
    focusBlock.current = false;
    block.focus();
  });

  const pickDay = (date: LocalDate) => {
    setSelDay(date);
    setNear(null);
    if (placing && at) setAt(landOn(date, at, kindOf(placing), ctx, floorOf(date)));
  };

  /**
   * Saves a block's new time. Cancelled on another block, or when the save fails, it resolves to nothing and changes
   * nothing else, and the day puts it back.
   */
  const changeBlock = async (b: PlacedBlock, slot: Slot) => {
    if (slot.start === b.start && slot.end === b.end && slot.date === b.date) return undefined;
    const { go, off } = await landing(b.title, slot, b.id, b);
    if (!go) return undefined;
    const saved = await act.move(b.id, slot);
    if (!saved) return undefined;
    setEdSel(b.id);
    setAsk(b.practice_id ? { blockId: b.id, wasMin: ask?.blockId === b.id ? ask.wasMin : b.end - b.start } : null);
    setSplit(shortened(b, slot, { task: isTask(b), underWay: !!b.now, week: data.week, title: b.title, open: split }));
    takeOff(off);
    return saved;
  };
  const dropCard = async (item: LaneItem, slot: Slot) => {
    const { go, off } = await landing(item.title, slot);
    if (go && (await act.place(item, slot))) takeOff(off);
  };

  const cancelPlacing = () => {
    const was = placing;
    setPlacing(null);
    setAt(null);
    if (props.place) {
      props.donePlacing();
      props.close();
    } else if (was?.mode === 'place' && was.fromDrawer) setOpen({ kind: 'add' });
  };

  const plan = placing?.mode === 'planning' ? placing.plan : null;
  const gone = !!at && isThis && (at.date < day0 || (at.date === day0 && at.start < floorOf(day0)));
  // Planning goes no later than the end of the week or stretch it plans.
  const late = !!plan && !!at && at.date > plan.last;
  const locked = gone || late;
  /**
   * Moves a placed block, from Move here or a hold on the day. Resolves to whether it moved, or was already there, so
   * false when the save failed. `undone` runs as its Undo is pressed.
   */
  const moveTo = async (b: PlacedBlock, slot: Slot, undone?: () => void) => {
    // A session moved to another day is for this week only, so nothing asks about future weeks.
    if (b.practice_id && slot.date !== b.date) return act.moveSessionDay(b, slot, model.blocks);
    if (slot.date !== b.date || slot.start !== b.start || slot.end !== b.end) {
      if (!(await act.moveWithUndo(b.id, b.title, slot, undone))) return false;
      if (b.practice_id) setAsk({ blockId: b.id, wasMin: b.end - b.start });
    }
    return true;
  };
  const finishPlacing = async () => {
    if (!placing || !at || locked) return;
    const moving = placing.mode === 'move' ? placing.block : null;
    // A day with another of a practice's sessions refuses it before anything asks.
    const refused = !!moving?.practice_id && at.date !== moving.date && model.blocks.some((x) => x.id !== moving.id && x.practice_id === moving.practice_id && x.date === at.date);
    const { go, off } = refused ? { go: true, off: [] } : await landing(drawnOf(placing).title, at, moving?.id ?? null, moving);
    if (!go) return;
    if (placing.mode === 'move') {
      if (!(await moveTo(placing.block, at))) return;
    } else if (placing.mode === 'planning') {
      if (!(await planning.place(placing.plan, at))) return;
    } else if (!(await act.place(placing.item, at))) return;
    takeOff(off);
    setPlacing(null);
    setAt(null);
    props.donePlacing();
    if (placing.mode === 'planning' && placing.plan.flow) props.close();
  };
  /** Planning carried to another week keeps its day of the week and time. */
  const carryTo = (days: number) => props.goWeek(addDays(props.week, days), plan && at ? { ...at, date: addDays(at.date, days) } : undefined);

  const blocksOn = (date: LocalDate) => model.blocks.filter((b) => b.date === date);
  const openBlock = (id: string) => {
    const row = data.blocks.find((x) => x.id === id);
    if (row && opensPopup(row)) setOpen({ kind: 'pop', pop: popFor(row) });
  };
  // The popup stays open when its block comes off the calendar; only the block's section goes.
  const popped = open?.kind === 'pop' ? open.pop : null;
  const popRow = popped && data.blocks.find((b) => b.id === popped.block);
  const popPlaced = popped && model.blocks.find((b) => b.id === popped.block);
  const popEdit = !!popPlaced && offset >= 0 && !popPlaced.past;
  const item = open?.kind === 'item' ? model.unscheduled.find((x) => x.id === open.id) : undefined;
  const [dropAt, setDropAt] = useState<{ item: LaneItem; slot: Slot } | null>(null);
  const [planningFor, setPlanningFor] = useState<string | null>(null);
  const laneItems = model.unscheduled.filter((x) => !x.dates || (x.dates.from <= selDay && selDay <= x.dates.to));
  const card = (x: LaneItem) => (
    <LaneCard
      key={x.id}
      item={x}
      ctx={model.ctx}
      open={false}
      draggable={isThis && !placing}
      onToggle={() => (planningWeekOf(x.id) ? setPlanningFor(planningWeekOf(x.id)) : setOpen({ kind: 'item', id: x.id }))}
      onPreview={(slot) => setDropAt(slot && { item: x, slot })}
      onDrop={(slot) => void dropCard(x, slot)}
    />
  );
  const dayIndex = diffDays(data.week, selDay);
  const dayTitle = dayName(selDay);
  const showDrag = !!placing || editing;

  // The week beside this one, on its first or last day or once a swipe has gone past them, so a swipe past the end draws
  // the day there and carries on into that week.
  const besideWeek = showDrag ? null : weekStart(selDay) !== data.week ? weekStart(selDay) : dayIndex === 0 ? addDays(data.week, -7) : dayIndex === 6 ? addDays(data.week, 7) : null;
  const besideData = useQuery((sql, c) => (besideWeek ? loadWeek(sql, c, besideWeek) : Promise.resolve(null)), [besideWeek]).data;
  /** Swiped to the day before or after. Past the week's ends, it goes on into the week beside, as the week arrows do. */
  const swipeTo = (date: LocalDate, time: KeptTime | null) => {
    setSelDay(date);
    setNear(null);
    if (weekStart(date) !== data.week) props.goWeek(weekStart(date), undefined, { date, time });
  };

  const placingText = placing && at
    ? `${placing.mode === 'move' ? 'Moving' : 'Placing'} ${drawnOf(placing).title}, ${formatMinutes(at.end - at.start)}${
        placing.mode === 'move' ? `, from ${formatWeekday(placing.block.date)} ${formatTimeOfDay(placing.block.start)}` : ''
      }`
    : '';
  const placingNote =
    !placing || !at
      ? ''
      : late && plan
        ? `Too late: plan it by ${dayName(plan.last)}.`
        : gone
          ? 'That time has passed.'
          : slotNotes({ ...at, id: placing.mode === 'move' ? placing.block.id : 'draft' }, workOf(placing), ctx).join(' ');
  const noFit = (date: LocalDate) => !!placing && !!at && closestFit(date, at.start, at.end - at.start, kindOf(placing), ctx) === null;
  const nextFit = noFit(selDay) ? [1, 2, 3, 4, 5, 6].map((n) => addDays(data.week, (dayIndex + n) % 7)).find((d) => !noFit(d)) : undefined;
  const edBlock = edSel ? model.blocks.find((b) => b.id === edSel) : undefined;

  const toSchedule = (
    <section className="card stack8 tosched" aria-label="To schedule" data-unscheduled>
      <div className="small">
        <span className="strong">To schedule</span>{' '}
        <span className="quiet">{model.unscheduled.length ? laneCount(model.unscheduled) : 'Everything this week is on the calendar.'}</span>
      </div>
      {laneItems.length > 0 && <div className="lanerow">{laneItems.map(card)}</div>}
      {isThis && laneItems.length > 0 && (
        <p className="small quiet">
          {editing ? 'Hold a card, then drag it down onto the day. Hold a block, then drag it up here to take it off the calendar.' : 'Hold a card, then drag it down onto the day, or tap it for suggested times.'}
        </p>
      )}
      {model.unscheduled.length > 0 && (
        <Button type="button" onClick={() => nav.openFlow('planning', { week: data.week, step: 'schedule' })}>
          Schedule one at a time
        </Button>
      )}
    </section>
  );
  const dragDay = (
    <div>
      <h3 className="wkday">{dayTitle}</h3>
      {placing && at && noFit(selDay) && (
        <button className="tlnoslot" type="button" onClick={() => nextFit && pickDay(nextFit)}>
          No {formatMinutes(at.end - at.start)} slot on {formatWeekday(selDay)}
          {nextFit ? `. Next: ${formatWeekday(nextFit)}` : ' or any other day.'}
        </button>
      )}
      <p className="small quiet wkhint">
        {placing
          ? 'Hold the block, then drag it to any time, or pick another day above. Hold its bottom edge and drag to change its length.'
          : 'Hold anything from now on, then drag to move or resize it, or tap it to change it. Changes save as you go.'}
      </p>
      <div className="card wkdaycard">
        <DragDay
          date={selDay}
          hour={props.host.hourPx}
          ctx={ctx}
          info={model.info}
          floor={floorOf(selDay)}
          blocks={blocksOn(selDay).filter((b) => !(placing?.mode === 'move' && placing.block.id === b.id))}
          moving={
            placing && at && at.date === selDay && !locked
              ? { title: drawnOf(placing).title, kind: drawnOf(placing).kind, slot: at }
              : dropAt && dropAt.slot.date === selDay
                ? { title: dropAt.item.title, kind: dropAt.item.kind, slot: dropAt.slot }
                : null
          }
          editing={editing && !placing}
          holdToCreate={!placing}
          onMoving={setAt}
          onDone={() => void finishPlacing()}
          onChange={changeBlock}
          onUnschedule={(b) => {
            setEdSel(null);
            void act.unschedule(b.id, b.title, data.week);
          }}
          onOpen={(id) => {
            if (split?.blockId !== id) setSplit(null);
            setEdSel(id);
            openBlock(id);
          }}
        />
      </div>
    </div>
  );
  const placingTray = placing && at && (
    <div className="tray dragbar">
      <div role="status">
        <div className="strong">
          {dayName(at.date)}, {slotRange(at)}
        </div>
        <div className="small">{placingText}</div>
        {placingNote && <div className="small">{placingNote}</div>}
      </div>
      <div className="row">
        <Button variant="primary" size="compact" className="grow" type="button" disabled={locked} onClick={() => void finishPlacing()}>
          {placing.mode === 'move' ? 'Move here' : 'Place here'}
        </Button>
        <Button size="compact" type="button" onClick={cancelPlacing}>
          Cancel
        </Button>
      </div>
    </div>
  );
  const editTray = (
    <div className="tray dragbar">
      <div role="status">
        {edBlock && (
          <div className="small strong">
            {edBlock.title}, {dayName(edBlock.date)}, {slotRange(edBlock)}
          </div>
        )}
        {edBlock && <div className="small">{slotNotes(edBlock, { kind: edBlock.kind === 'one_off' ? 'one_off' : 'project' }, model.ctx).join(' ')}</div>}
      </div>
      <div className="row">
        <Button
          variant="primary" size="compact" className="grow"
          type="button"
          onClick={() => {
            setEdSel(null);
            props.donePlacing();
            props.setEditing(false);
          }}
        >
          Done editing
        </Button>
        <Button size="compact" type="button" onClick={() => setOpen({ kind: 'add' })}>
          Add a task
        </Button>
      </div>
    </div>
  );
  const sheets = (
    <>
    {asking}
    {popped && (
      <BlockPopup
        pop={popped}
        close={() => setOpen(null)}
        section={
          popRow && (
            <BlockSection
              block={popRow}
              {...(popEdit && popPlaced
                ? {
                    move: { ctx: model.ctx, choose: () => startPlacing({ mode: 'move', block: popPlaced, length: popPlaced.end - popPlaced.start }, popPlaced) },
                    onRemove: () => {
                      setEdSel(null);
                      void act.remove(popPlaced.id, popPlaced.title);
                    },
                  }
                : {})}
            >
              {popPlaced && <LengthAndNote block={popPlaced} model={model} canEdit={popEdit} onLength={(end) => changeBlock(popPlaced, { date: popPlaced.date, start: popPlaced.start, end })} />}
            </BlockSection>
          )
        }
      />
    )}
    {item && (
      <Sheet label={item.title} onClose={() => setOpen(null)}>
        <LaneActions
          item={item}
          canPlace={isThis}
          onPlace={(slot) => {
            setOpen(null);
            setSelDay(slot.date);
            void act.place(item, slot);
          }}
          onChoose={() => chooseTime(item)}
          onSkipDay={() => {
            setOpen(null);
            void act.skipDay(item, data.week);
          }}
          onTakeOut={() => {
            setOpen(null);
            void act.takeOut(item, data.week);
          }}
          onDone={() => {
            setOpen(null);
            void act.markDone(item.task!);
          }}
          onClose={() => setOpen(null)}
        />
      </Sheet>
    )}
    {open?.kind === 'add' && (
      <AddDrawer
        model={model}
        onClose={() => setOpen(null)}
        onPlace={async (row, slot) => {
          if (await act.place(rowItem(row), slot)) {
            setOpen(null);
            setSelDay(slot.date);
          }
        }}
        onChoose={(row, length) => startPlacing({ mode: 'place', item: rowItem(row), length, fromDrawer: true }, null)}
      />
    )}
    </>
  );

  const host = props.host;
  if (host) {
    const words = dayHeading(selDay, day0);
    const w: HostWeek = {
      day: selDay,
      offset,
      heading: words,
      menu: [
        ...(isThis && !props.gated && !editing && !placing ? [{ id: 'week.edit', label: "Edit this week's plan", icon: 'pen' as const }] : []),
        ...(!placing && resetShown(data, offset, now) ? [{ id: 'week.reset', label: `Reset ${offset === 0 ? 'this' : 'next'} week's plan`, icon: 'undo' as const }] : []),
        ...(offset <= 0 ? [{ id: 'week.analytics', label: isThis ? "See this week's analytics" : "See that week's analytics", icon: 'week' as const }] : []),
      ],
      choose: (id) => {
        if (id === 'week.edit') {
          if (selDay < day0) setSelDay(day0);
          props.setEditing(true);
        } else if (id === 'week.reset') setResetAsking(true);
        else if (id === 'week.analytics') nav.go('analytics', { week: data.week });
      },
      goToday: () => {
        setNear(null);
        if (isThis) setSelDay(day0);
        else props.goWeek(weekStart(day0), undefined, { date: day0, time: null });
      },
      move: (id) => {
        const b = model.blocks.find((x) => x.id === id);
        if (b && offset >= 0 && !b.past) startPlacing({ mode: 'move', block: b, length: b.end - b.start }, b);
      },
      add: () => setOpen({ kind: 'add' }),
      drafting: setDrafting,
      length: (id) => {
        const b = model.blocks.find((x) => x.id === id);
        return b && <LengthAndNote block={b} model={model} canEdit={offset >= 0 && !b.past} onLength={(end) => changeBlock(b, { date: b.date, start: b.start, end })} />;
      },
    };
    const dataOn = (date: LocalDate) => (weekStart(date) === data.week ? data : weekStart(date) === besideWeek && besideData?.week === besideWeek ? besideData : null);
    // Under each day, its hours planned; before the week's planned, its hours free, as Week says.
    const plannedOn = (date: LocalDate) => {
      const mins = model.blocks.filter((b) => b.date === date && b.kind !== 'planning').reduce((sum, b) => sum + b.end - b.start, 0);
      return { text: mins ? formatMinutes(mins) : '', say: mins ? `${formatMinutes(mins)} planned` : '' };
    };
    const dots: Dot[] = [0, 1, 2, 3, 4, 5, 6].map((i) => {
      const date = addDays(data.week, i);
      return date === selDay ? 'on' : date < day0 ? 'past' : '';
    });
    return (
      <div ref={root} className={`${host.className} week tdweek`} aria-busy={host.busy}>
        {host.head(w)}
        {isThis && host.above}
        <StripFold
          label={`${props.title}, ${props.label}`}
          week={
            <div className="sfwkrow">
              {/* While placing, only planning goes to another week: from this one to the week of its last day. */}
              <Button variant="icon" icon="chevron-left" label="Previous week" type="button" disabled={!!placing && !(plan && offset > 0)} onClick={() => carryTo(-7)} />
              <div className="sfwktitle">
                <span className="strong">{props.title}</span> <span className="quiet">{props.label}</span>
                {props.planningAt && <div className="small quiet">{props.planningAt}</div>}
              </div>
              <Button variant="icon" icon="chevron-right" label="Next week" type="button" disabled={!!placing && !(plan && addDays(data.week, 7) <= plan.last)} onClick={() => carryTo(7)} />
            </div>
          }
          days={
            <DayStrip
              week={data.week}
              label="Choose a day"
              selected={near ?? selDay}
              ctx={ctx}
              placed={ctx.placed}
              draft={placing ? at : null}
              hint={(date) => ({ noFit: noFit(date), waiting: 0 })}
              {...(props.gated ? {} : { under: plannedOn })}
              onPick={pickDay}
            />
          }
          foot={
            <div className="sffootrow">
              <span className="sfsum">
                <span className="strong">{props.gated ? 'Not planned yet' : `${formatMinutes(model.planned.total)} planned`}</span>{' '}
                <span className="quiet">{formatMinutes(weekFree(data.week, ctx))} free</span>
              </span>
              {!placing && host.foot(w)}
            </div>
          }
          slim={{
            name: words.name,
            date: words.name === longDay(selDay) ? words.date : `${formatWeekday(selDay)} ${Number(selDay.slice(8))}`,
            label: `${words.name === longDay(selDay) ? '' : `${words.name}, `}${longDay(selDay)} ${Number(selDay.slice(8))}. Show the week`,
            dots,
          }}
        />
        {offset < 0 && <p className="small quiet">Past weeks can be viewed but not changed.</p>}
        <PackedDay date={selDay} ctx={ctx} />
        {ask && <PracticeAsk ask={ask} model={model} onDone={() => setAsk(null)} />}
        {split && <SplitAsk ask={split} onDone={() => setSplit(null)} />}
        {selDay === day0 && !showDrag && host.rows}
        {editing && !placing && toSchedule}
        {showDrag ? (
          dragDay
        ) : (
          <div className="tdpaged">
            {selDay < day0 && props.finished[selDay] !== undefined && (
              <button className="attn tdrow" type="button" aria-label={`Done on ${dayTitle}: ${finishedCount(props.finished[selDay]).toLowerCase()}`} onClick={() => props.openDone(selDay)}>
                <span>
                  <span className="strong">Done on {longDay(selDay)}</span> <span className="quiet">{finishedCount(props.finished[selDay])}</span>
                </span>
                <Icon name="chevron-right" size={16} className="chev" />
              </button>
            )}
            {/* Swiped sideways, the day follows the finger to the day before or after, the week's ends included. */}
            <DayPager
              className="tdpager"
              day={selDay}
              enabled={!drafting}
              onDay={swipeTo}
              onNear={(date) => setNear(date === selDay ? null : date)}
              top={() => root.current?.querySelector('.sfbg')?.getBoundingClientRect().bottom ?? 0}
              time={arrivedTime.current}
              render={(date, current) => host.day(date, current, dataOn(date), w)}
            />
          </div>
        )}
        {planningFor && <PlanningTimes for={planningFor} name={planningFor === model.current ? 'this week' : 'next week'} onClose={() => setPlanningFor(null)} />}
        {placingTray || (editing && editTray)}
        {sheets}
        <ResetWeek data={data} offset={offset} asking={{ open: resetAsking, set: setResetAsking }} />
        {host.extra}
      </div>
    );
  }
}

/**
 * A block let go at a new time, drawn there until the saved position comes back in `blocks`, so it doesn't jump back to
 * where it was while it saves. Compared by position, since callers build a new list on every render.
 */
function useLanded(blocks: readonly PlacedBlock[]) {
  const [landed, setLanded] = useState<{ id: string; slot: Slot } | null>(null);
  const placed = blocks.map((b) => `${b.id} ${b.date} ${b.start} ${b.end}`).join();
  useEffect(() => setLanded(null), [placed]);
  return [landed, setLanded] as const;
}

/**
 * The drawn day behind a drag: hours, closed time, calendar events, and the blocks that move. The planning Schedule
 * step also passes suggested times, which the moving and selected blocks snap to.
 */
const fixedLook = (b: PlacedBlock, short: boolean) => blockClass(LOOK[b.kind], blockState({ result: b.result, ended: b.ended, now: b.now }), { short });

export function DragDay(props: {
  date: LocalDate;
  ctx: SlotContext;
  info: WeekModel['info'];
  floor: number;
  blocks: PlacedBlock[];
  moving: { title: string; kind: PlacedBlock['kind']; slot: Slot } | null;
  editing: boolean;
  ghosts?: readonly GridGhost[];
  /** Drawn in full rather than calm. */
  selected?: string | null;
  onMoving(slot: Slot): void;
  onDone(): void;
  /** A save that resolves to nothing has been called off or has failed, and the block goes back to where it was. */
  onChange(b: PlacedBlock, slot: Slot): unknown;
  /** A block let go over To schedule, which takes it off the calendar. */
  onUnschedule?(b: PlacedBlock): void;
  onOpen(id: string): void;
  /** An hour's height: Week's pinch zoom, or the usual. */
  hour?: number;
  /**
   * A press held on empty time drafts an hour there and opens Capture on it. The caller leaves it off while a block is
   * selected or being placed; it's off while one is held or being placed here.
   */
  holdToCreate?: boolean;
  /** New task, from the caller: an hour from this minute, with Capture open on it, as a hold drafts one, hold on or off. */
  newAt?: { date: LocalDate; minute: number } | null;
}) {
  const { date, ctx, floor, moving, ghosts = [], hour = HOUR_PX } = props;
  const y = (m: number) => ((m - DAY_FROM) * hour) / 60;
  const { clock, layout, platform } = useApp();
  const nowMin = localMinutes(clock.now(), clock.zone());
  const targets = ghosts.map((g) => ({ date: g.date, start: g.start }));
  // A dropped block stays where it landed until the saved position comes back.
  const [preview, setPreview] = useLanded(props.blocks);
  // Blocks at the same time sit side by side, laid out where they're saved, so a block being dragged keeps its column.
  const [measure, width] = useWidth<HTMLDivElement>();
  const groups = overlapGroups(props.blocks).map((group) => ({ group, shown: shownColumns(group.cols, width && width - 4, MORE_PX) }));
  const live = (b: PlacedBlock) => props.editing && b.start >= floor && !b.past;
  const bounds = { from: floor, to: DAY_TO };
  const zones: { top: number; h: number; lock?: boolean }[] = [];
  for (let m = DAY_FROM; m < DAY_TO; m += 30) {
    if (isOpen(ctx.availability, date, m, 'project')) continue;
    const last = zones[zones.length - 1];
    if (last && !last.lock && last.top + last.h === y(m)) last.h += hour / 2;
    else zones.push({ top: y(m), h: hour / 2 });
  }
  if (floor > DAY_FROM) zones.push({ top: 0, h: y(Math.min(floor, DAY_TO)), lock: true });

  // The block a hold has lifted, drawn raised until it's let go.
  const [lifted, setLifted] = useState<string | null>(null);
  const holdNew = useHoldToCreate({
    at: (_x, py) => ({ date, minute: DAY_FROM + (py * 60) / hour }),
    move: (s, _dx, dy) => dragResult(s, 'move', 0, (dy * 60) / hour, [], bounds),
    earliest: ctx.earliest,
    off: !props.holdToCreate || !!moving || !!lifted || !!preview || !!props.selected,
  });
  const held = holdNew.draft?.slot.date === date ? holdNew.draft.slot : undefined;
  const newAt = props.newAt;
  useEffect(() => {
    if (newAt?.date === date) holdNew.create(date, newAt.minute);
    // Each New task is a new request; the day changing with it is part of the same one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newAt]);
  /** What the draft would share its time with: blocks and calendar events on the day. */
  const sharing = held ? [...props.blocks, ...ctx.busy].filter((o) => o.date === date && o.start < held.end && held.start < o.end) : [];
  // Measured from the drawn track each move, so zoom and scrolling during the drag can't shift the block.
  const track = (key: string, event: ReactPointerEvent, apply: (minutes: number) => void, done?: () => void, tap?: () => void, off?: () => void) => {
    event.preventDefault();
    event.stopPropagation();
    const day = (event.currentTarget as HTMLElement).closest('.day');
    const perPx = (DAY_TO - DAY_FROM) / (day?.getBoundingClientRect().height || y(DAY_TO));
    const leaving = (e: PointerEvent) => !!off && overLane(e.clientX, e.clientY);
    holdToDrag(event, {
      lift: () => setLifted(key),
      drag: (_dx, dy, e) => {
        if (!leaving(e)) apply(dy * perPx);
      },
      drop: (e) => {
        const out = leaving(e);
        clearLane();
        setLifted(null);
        if (out) {
          setPreview(null);
          off?.();
        } else done?.();
      },
      ...(tap ? { tap } : {}),
      cancel: () => {
        clearLane();
        setLifted(null);
        setPreview(null);
      },
      ...(platform.haptic ? { haptic: platform.haptic } : {}),
    });
  };

  const handle = (
    key: string,
    title: string,
    kind: PlacedBlock['kind'],
    slot: Slot,
    calm: boolean,
    on: { change(s: Slot): unknown; /** Saves on drop rather than following the finger. */ commit?: boolean; open?(): void; enter(): void; unschedule?(): void },
    /** Its column among blocks at the same time, and those it overlaps. */
    column?: { style: CSSProperties; others: readonly PlacedBlock[] },
  ) => {
    const len = slot.end - slot.start;
    const step = (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        on.enter();
        return;
      }
      const delta = ({ ArrowUp: -GRID, ArrowDown: GRID } as Record<string, number>)[e.key];
      if (!delta) return;
      e.preventDefault();
      const next = dragResult(slot, e.shiftKey ? 'resize' : 'move', 0, delta, [], bounds);
      if (next.start !== slot.start || next.end !== slot.end) on.change(next);
    };
    let latest = slot;
    // The block being placed, or the one selected: drawn apart, and it snaps to the suggested times.
    const chosen = key === 'moving' || key === props.selected;
    const drag = (mode: 'move' | 'resize') => (e: ReactPointerEvent) =>
      track(
        key,
        e,
        (minutes) => {
          latest = dragResult(slot, mode, 0, minutes, mode === 'move' && chosen ? targets : [], bounds);
          if (on.commit) setPreview({ id: key, slot: latest });
          else on.change(latest);
        },
        () => {
          if (!on.commit || (latest.start === slot.start && latest.end === slot.end)) return setPreview(null);
          const saved = on.change(latest);
          if (saved instanceof Promise) void saved.then((ok) => ok === undefined && setPreview(null));
        },
        mode === 'move' ? on.open : undefined,
        mode === 'move' ? on.unschedule : undefined,
      );
    const shown = preview?.id === key ? preview.slot : slot;
    // It floats beside what it overlaps, so nothing under it moves or hides; one in a column is beside them already.
    const beside = chosen && !column && overlaps([...props.blocks.filter((b) => b.id !== key), ...ctx.busy], date, shown.start, shown.end);
    const help = on.commit ? ' Hold, then drag, or use the up and down arrow keys. Shift and arrows change its length. Enter opens its options.' : ' Hold, then drag, or use the up and down arrow keys. Shift and arrows change its length. Enter saves.';
    return (
      <div
        key={key}
        className={`cev dragblock ${blockClass(LOOK[kind], chosen ? 'placing' : 'planned')}${calm ? ' calm' : ''}${chosen ? ' draft' : ''}${beside ? ' beside' : ''}${lifted === key ? ' lifted' : ''}`}
        role="slider"
        tabIndex={0}
        aria-label={(on.commit ? title : `Time for ${title}, being placed`) + '.' + overlapNote(column?.others ?? []) + help}
        // The day runs down the screen, so the value is the time left in the day after its start: Up, and VoiceOver's
        // swipe up, raise it and move the block up. aria-valuetext says the actual time.
        aria-orientation="vertical"
        aria-valuemin={len}
        aria-valuemax={DAY_TO - floor}
        aria-valuenow={DAY_TO - shown.start}
        aria-valuetext={`${dayName(date)}, ${slotRange(shown)}`}
        style={{ top: y(shown.start), height: Math.max(24, y(shown.end) - y(shown.start)), ...column?.style }}
        onPointerDown={drag('move')}
        onKeyDown={step}
      >
        <span className="cevt">{title}</span>
        <span className="rz" aria-hidden="true" onPointerDown={drag('resize')}>
          <i />
        </span>
      </div>
    );
  };

  return (
    <div className="daywrap">
      <div
        ref={measure}
        className="day dragday"
        style={{ height: y(DAY_TO), '--hour': `${hour}px` } as CSSProperties}
        data-drop-date={date}
        // Empty time is the day itself and its closed hours; a block, an event or a suggested time keeps its own press.
        onPointerDown={(e) => !(e.target as Element).closest('.cev') && holdNew.press(e)}
      >
        {zones.map((z, i) => (
          <div key={i} className={`dzone${z.lock ? ' lockz' : ''}`} style={{ top: z.top, height: z.h }} aria-hidden="true">
            {z.lock ? 'Time has passed' : ''}
          </div>
        ))}
        {Array.from({ length: (DAY_TO - DAY_FROM) / 60 }, (_, i) => DAY_FROM + i * 60).map((m) => (
          <span key={m} className="dayhr" style={{ top: y(m) }} aria-hidden="true">
            {formatTimeOfDay(m)}
          </span>
        ))}
        {/* Over closed time but before what's drawn on the day, so it passes behind events and blocks. */}
        {date === today(clock) && nowMin >= DAY_FROM && nowMin <= DAY_TO && <NowLine top={y(nowMin)} />}
        {/* Planning is busy too, but its own block is drawn instead, so the gaps between columns stay clear. */}
        {ctx.busy
          .filter((e) => e.date === date && !props.blocks.some((b) => b.id === e.id))
          .map((e, i) => (
            <div key={`b${i}`} className={`cev ${blockClass('event', 'planned')}`} style={{ top: y(e.start), height: Math.max(13, y(e.end) - y(e.start)) }}>
              {e.title || 'Busy'}
            </div>
          ))}
        {props.info
          .filter((e) => e.date === date)
          .map((e, i) => (
            <div key={`i${i}`} className={`cev ${blockClass('info', 'planned')}`} style={{ top: y(e.start), height: y(e.end) - y(e.start) }}>
              {e.title}
            </div>
          ))}
        {groups.map(({ group, shown }) => {
          const more = shown < group.cols;
          const drawn = group.items
            .filter((c) => c.col < shown)
            .map(({ item: b, col, with: others }) => {
              const column = group.cols > 1 ? { style: columnStyle(col, shown, '4px', more ? MORE_INSET : '0px'), others } : undefined;
              if (live(b)) {
                const unschedule = props.onUnschedule && (() => props.onUnschedule!(b));
                return handle(b.id, b.title, b.kind, b, b.id !== props.selected, { change: (s) => props.onChange(b, s), commit: true, open: () => props.onOpen(b.id), enter: () => props.onOpen(b.id), ...(unschedule ? { unschedule } : {}) }, column);
              }
              const h = Math.max(13, y(b.end) - y(b.start));
              return (
                <div key={b.id} className={`cev ${fixedLook(b, h < 24)}${h < 24 ? ' compact' : ''}`} style={{ top: y(b.start), height: h, ...column?.style }}>
                  <BlockMarks state={blockState({ result: b.result, ended: b.ended, now: b.now })} short={h < 24} look={LOOK[b.kind]} />
                  <OutcomeTag result={b.result} />
                  <span className="blktitle">{b.title}</span>
                </div>
              );
            });
          if (!more) return drawn;
          return [
            ...drawn,
            <MoreButton
              key={`more${group.start}`}
              group={group}
              shown={shown}
              className="cev cevmore"
              style={{ top: y(group.start), height: Math.max(44, y(group.end) - y(group.start)), left: 'auto', right: 0, width: MORE_PX }}
              canOpen={live}
              onOpen={(b) => props.onOpen(b.id)}
            />,
          ];
        })}
        {ghosts
          .filter((g) => g.date === date)
          .map((g) => (
            <button
              key={`g${g.start}`}
              type="button"
              className={`cev ghost ${blockClass('project', 'suggested')}`}
              aria-label={`Use suggested time, ${g.label}`}
              style={{ top: y(g.start), height: Math.max(28, y(g.end) - y(g.start)) }}
              onClick={g.onAccept}
            >
              <span className="cevt">Suggested {formatTimeOfDay(g.start)}</span>
            </button>
          ))}
        {moving && handle('moving', moving.title, moving.kind, moving.slot, false, { change: props.onMoving, enter: props.onDone })}
        {held && <DraftBlock hold={holdNew} top={y(held.start)} height={y(held.end) - y(held.start)} beside={sharing.length > 0} />}
        <HoldRing ring={holdNew.ring} />
      </div>
      {held && holdNew.draft!.open && (
        <DraftCapture layout={layout} close={holdNew.close} slot={holdNew.slot(overlapWords(held, sharing.map((o) => ({ title: o.title || 'Busy', start: o.start, end: o.end }))))} />
      )}
    </div>
  );
}

/** A block's length on a slider, while it can change, and what's off about its time, in its popup's block section. */
function LengthAndNote(props: { block: PlacedBlock; model: WeekModel; canEdit: boolean; onLength(end: number): void }) {
  const { block, model } = props;
  const id = useId();
  const len = block.end - block.start;
  const max = Math.max(len, Math.min(480, DAY_TO - block.start));
  const note = slotNotes(block, { kind: block.kind === 'one_off' ? 'one_off' : 'project' }, model.ctx).join(' ');
  return (
    <>
      {props.canEdit && (
        <div className="stack8">
          <div className="between">
            <label className="small quiet" htmlFor={id}>
              Length
            </label>
            <span className="strong">{formatMinutes(len)}</span>
          </div>
          <input
            id={id}
            className="wkrange"
            type="range"
            min={GRID}
            max={max}
            step={SLIDER_STEP}
            value={len}
            aria-valuetext={formatMinutes(len)}
            onChange={(e) => props.onLength(block.start + Number(e.target.value))}
          />
        </div>
      )}
      {note && (
        <p className="small" role="status">
          {note}
        </p>
      )}
    </>
  );
}

/** Tasks to add, by group, each with suggested times and Choose another time. */
function AddDrawer(props: { model: WeekModel; onClose(): void; onPlace(row: AddRow, slot: Slot): void; onChoose(row: AddRow, length: Minutes): void }) {
  const { model } = props;
  const [selected, setSelected] = useState<string | null>(null);
  const [lengths, setLengths] = useState<Record<string, Minutes>>({});
  return (
    <Sheet label="Add to this week" tall onClose={props.onClose}>
      <div className="between">
        <h2>Add to this week</h2>
        <Button type="button" onClick={props.onClose}>
          Close
        </Button>
      </div>
      {model.addGroups.length === 0 && <p className="quiet">Nothing is waiting to be added.</p>}
      {model.addGroups.map((g) => (
        <div key={g.name}>
          <h3 className={g.oneOffs ? 'mhead wkgroup' : 'wkgroup'}>{g.name}</h3>
          {g.rows.map((r) => {
            const on = selected === r.task.id;
            const len = lengths[r.task.id] ?? Math.min(r.left, FIRST_BLOCK_MIN);
            return (
              <div key={r.task.id} className="rowline wkrow">
                <button className="candbtn" type="button" aria-expanded={on} onClick={() => setSelected(on ? null : r.task.id)}>
                  <span>{r.task.title}</span>
                  <span className="small quiet">{formatMinutes(r.left)}</span>
                </button>
                {on && (
                  <AddChoice row={r} len={len} model={model} onLength={(v) => setLengths({ ...lengths, [r.task.id]: v })} onPlace={(slot) => props.onPlace(r, slot)} onChoose={() => props.onChoose(r, len)} />
                )}
              </div>
            );
          })}
        </div>
      ))}
    </Sheet>
  );
}

function AddChoice(props: { row: AddRow; len: Minutes; model: WeekModel; onLength(v: Minutes): void; onPlace(slot: Slot): void; onChoose(): void }) {
  const { row, len, model } = props;
  const id = useId();
  const found = offers(len, row.work, model.ctx).slice(0, 3);
  const most = Math.max(GRID, Math.min(row.left, 4 * 60));
  return (
    <div className="candsel stack8">
      {most > GRID && (
        <div className="stack8">
          <div className="between">
            <label className="small quiet" htmlFor={id}>
              Length
            </label>
            <span className="strong">{formatMinutes(len)}</span>
          </div>
          <input id={id} className="wkrange" type="range" min={GRID} max={most} step={SLIDER_STEP} value={len} aria-valuetext={formatMinutes(len)} onChange={(e) => props.onLength(Number(e.target.value))} />
        </div>
      )}
      {found.map((o, i) => (
        <button key={o.date} className={`offer${i === 0 ? ' first' : ''}`} type="button" onClick={() => props.onPlace({ date: o.date, start: o.start, end: o.end })}>
          <span>
            {dayName(o.date)}, {formatTimeOfDay(o.start)}
          </span>
          <span className="small">{o.note}</span>
        </button>
      ))}
      {found.length === 0 && <p className="small">No open slot fits this length.</p>}
      <Button type="button" onClick={props.onChoose}>
        Choose another time
      </Button>
      {row.left > len && (
        <p className="small quiet">
          {formatMinutes(row.left - len)} of {formatMinutes(row.left)} stays unslotted after this block.
        </p>
      )}
    </div>
  );
}

// Week on phone. A full week grid doesn't fit, so a sticky strip of seven day buttons shows each day's shape on a
// shared time axis above one day's timeline. Tapping a task's block opens the task's popup, with the block's section
// at its top, and a practice's session or planning opens its sheet. Holding a block still to come lifts it, to be let
// go on another row of the day at the time under the finger. Move, or Choose another time for a
// task or for planning, makes the block draggable on the day, the strip carries it to another day, and planning's
// week arrows to another week. To schedule sits above the
// day: a card opens its suggested times, and while editing, cards drag onto the day and blocks drag back up to it.

import { useEffect, useId, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, PointerEvent as ReactPointerEvent, ReactElement, TouchEvent } from 'react';
import { addDays, addWeeks, diffDays, formatMinutes, formatTimeOfDay, formatWeekday, localMinutes, today } from '../../../core/dates';
import { FIRST_BLOCK_MIN } from '../../../core/plan';
import { closestFit, defaultSlot, dragResult, DRAWN_DAY, GRID, isOpen, isPast, offers, slotNotes } from '../../../core/slots';
import { SLIDER_STEP } from '../../components/EstimateSlider';
import type { Slot, SlotContext, Work } from '../../../core/slots';
import type { LocalDate, Minutes } from '../../../core/types';
import { useNav } from '../../app/nav';
import { useApp } from '../../app/store';
import { PlanPrompt } from '../../components/PlanPrompt';
import { PlanningSet } from '../../components/planning/PlanningRow';
import { PlanningTimes } from '../../components/planning/PlanningTimes';
import { planningWeekOf } from '../../../core/planning';
import { usePlanningActions } from '../../components/planning/usePlanning';
import { DayStrip, PackedDay, weekFree } from '../../components/week/DayStrip';
import { fitZoom, usePinchZoom } from '../../components/week/pinch';
import { Sheet } from '../../components/Sheet';
import { TaskName } from '../../components/task/TaskName';
import { BlockSection } from '../../components/blocks/BlockSection';
import { isTaskBlock, KIND_WORD } from '../../components/blocks/describe';
import { NowLine } from '../../components/NowLine';
import { OutcomeTag } from '../../components/blocks/Outcome';
import { blockClass, BlockMarks, blockState, LOOK } from '../../components/ds/Block';
import { clearLane, columnStyle, dayName, dragCard, finishedCount, holdToDrag, MORE_INSET, MORE_PX, overLane, overlapGroups, overlapNote, shownColumns, slotRange, useWidth } from '../../components/weekgrid';
import type { GridGhost, OverlapGroup, PlacedBlock } from '../../components/weekgrid';
import { MoreButton } from '../../components/weekgrid/MoreButton';
import { DraftBlock, HoldRing, overlapWords, useHoldToCreate } from '../../components/weekgrid/holdCreate';
import { DraftCapture } from '../capture/DraftCapture';
import { landOn, rowItem } from './data';
import type { AddRow, LaneItem, Placeable, WeekModel } from './data';
import { LaneActions, LaneCard, laneCount } from './lane';
import type { PlacingPlanning, WeekProps } from './index';
import { PracticeAsk } from './parts';
import { useLanding } from './landing';
import { shortened, SplitAsk } from '../../components/editors/SplitAsk';
import type { Shortened } from '../../components/editors/SplitAsk';
import { useWeekActions } from './useWeekActions';
import { TaskPopupFor } from '../task';
import { Button } from '../../components/ds/Button';
import { Icon } from '../../components/ds/Icon';

const { from: DAY_FROM, to: DAY_TO } = DRAWN_DAY;
const HOUR_PX = 48;
const CELL_PX = 46;
const overlaps = (list: readonly Slot[], date: LocalDate, start: number, end: number) => list.some((x) => x.date === date && x.start < end && start < x.end);

/** A block being moved, or a task or planning being placed, before Move here or Place here. */
type Placing =
  | { mode: 'move'; block: PlacedBlock; length: Minutes }
  | { mode: 'place'; item: Placeable; length: Minutes; fromDrawer: boolean }
  | { mode: 'planning'; plan: PlacingPlanning; length: Minutes };

type Open = { kind: 'block'; id: string } | { kind: 'task'; block: string; task: string } | { kind: 'add' } | { kind: 'item'; id: string } | null;

/** Work, which opens the task's popup, rather than a practice's session or planning, which open their own sheet. */
const isTask = (b: PlacedBlock) => isTaskBlock(b.kind);

export function PhoneWeek(props: WeekProps) {
  const { data, model, offset, editing } = props;
  const { clock } = useApp();
  const nav = useNav();
  const act = useWeekActions();
  const planning = usePlanningActions();
  const isThis = offset === 0;
  const now = clock.now();
  const day0 = today(clock);
  const nowMin = localMinutes(now, clock.zone());
  const [selDay, setSelDay] = useState<LocalDate>(isThis ? day0 : data.week);
  const [open, setOpen] = useState<Open>(null);
  const [placing, setPlacing] = useState<Placing | null>(null);
  const [at, setAt] = useState<Slot | null>(null);
  const [edSel, setEdSel] = useState<string | null>(null);
  const [ask, setAsk] = useState<{ blockId: string; wasMin: Minutes } | null>(null);
  // Landing on placed blocks asks first: keep both, replace them, or leave it.
  const { landing, takeOff, asking } = useLanding(model.blocks, data.week);
  // A task's block made shorter asks what about the rest, until answered or another block is opened.
  const [split, setSplit] = useState<Shortened | null>(null);
  const swipe = useRef<{ x: number; y: number } | null>(null);
  // Pinching the day draws its hours taller or shorter, kept on this device. At its smallest the whole day fits between
  // the week's sticky top and whatever covers the bottom of the screen.
  const dayCard = useRef<HTMLDivElement>(null);
  const { zoom, handlers: pinch } = usePinchZoom('week.zoom', () => leastZoom(root.current, dayCard.current, zoom));

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
  /**
   * A block held on the day and let go on another asks first, as Move here does. Holds stay on their day. Resolves to
   * whether it moved, so false when the ask was cancelled or the save failed.
   */
  const holdMove = async (b: PlacedBlock, slot: Slot, undone?: () => void) => {
    const { go, off } = await landing(b.title, slot, b.id, b);
    if (!go || !(await moveTo(b, slot, undone))) return false;
    takeOff(off);
    return true;
  };
  /** Planning carried to another week keeps its day of the week and time. */
  const carryTo = (days: number) => props.goWeek(addDays(props.week, days), plan && at ? { ...at, date: addDays(at.date, days) } : undefined);

  const blocksOn = (date: LocalDate) => model.blocks.filter((b) => b.date === date);
  const opened = open?.kind === 'block' ? model.blocks.find((b) => b.id === open.id) : undefined;
  const openBlock = (id: string) => {
    const b = model.blocks.find((x) => x.id === id);
    setOpen(b?.task_id && isTask(b) ? { kind: 'task', block: id, task: b.task_id } : { kind: 'block', id });
  };
  // The popup stays open when its block comes off the calendar; only the block's section goes.
  const popped = open?.kind === 'task' ? open : null;
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

  // One finger swiped sideways changes the day; a second finger makes it a pinch instead.
  const onTouchStart = (e: TouchEvent) => {
    swipe.current = e.touches.length === 1 ? { x: e.touches[0]!.clientX, y: e.touches[0]!.clientY } : null;
  };
  const onTouchEnd = (e: TouchEvent) => {
    const from = swipe.current;
    if (!from) return;
    const dx = e.changedTouches[0]!.clientX - from.x;
    const dy = e.changedTouches[0]!.clientY - from.y;
    if (Math.abs(dx) >= 48 && Math.abs(dx) > 2 * Math.abs(dy)) {
      setSelDay(addDays(data.week, Math.max(0, Math.min(6, dayIndex + (dx < 0 ? 1 : -1)))));
    }
  };

  const capLine = `${formatMinutes(model.planned.project)} projects, ${formatMinutes(model.planned.practice)} practices, ${formatMinutes(model.planned.one_off)} one offs`;
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

  return (
    <div ref={root} className="stack8 week">
      <div className="weektop stack8">
        <div className="between">
          {/* While placing, only planning goes to another week: from this one to the week of its last day. */}
          <button className="icbtn" type="button" aria-label="Previous week" disabled={!!placing && !(plan && offset > 0)} onClick={() => carryTo(-7)}>
            <Icon name="chevron-left" />
          </button>
          <div className="wktitle">
            <div className="small quiet">{props.label}</div>
            {props.planningAt && <div className="small quiet">{props.planningAt}</div>}
            <h2>{props.title}</h2>
          </div>
          <button className="icbtn" type="button" aria-label="Next week" disabled={!!placing && !(plan && addDays(data.week, 7) <= plan.last)} onClick={() => carryTo(7)}>
            <Icon name="chevron-right" />
          </button>
        </div>
        {props.gated && <PlanPrompt week={data.week} />}
        {props.planningSet && <PlanningSet week={data.week} block={props.planningSet} />}
        {planningFor && <PlanningTimes for={planningFor} name={planningFor === model.current ? 'this week' : 'next week'} onClose={() => setPlanningFor(null)} />}
        {!isThis && !placing && (
          <div className="wkcenter">
            <Button type="button" onClick={() => props.goWeek(addDays(data.week, -7 * offset))}>
              This week
            </Button>
          </div>
        )}
        <div className="card stack8 wksum">
          <div className="small wkkeys">
            <span className="keyitem">
              <span className="skey" />
              <span className="strong">{formatMinutes(weekFree(data.week, ctx))} free</span>
              <span className="quiet"> of {formatMinutes(model.open)} available</span>
            </span>
            <span className="keyitem">
              <span className="skey planned" />
              <span>{formatMinutes(model.planned.total)} planned</span>
            </span>
            <span className="keyitem">
              <span className="skey busy" />
              <span>busy</span>
            </span>
          </div>
          <div className="small quiet">{capLine}</div>
          <DayStrip
            week={data.week}
            label="Choose a day"
            selected={selDay}
            ctx={ctx}
            placed={ctx.placed}
            draft={placing ? at : null}
            hint={(date) => ({ noFit: noFit(date), waiting: model.unscheduled.filter((x) => x.dates && x.dates.from <= date && date <= x.dates.to).length })}
            onPick={pickDay}
          />
        </div>
      </div>

      {offset < 0 && (
        <>
          <p className="small quiet">Past weeks can be viewed but not changed.</p>
          <Button type="button" onClick={() => nav.go('analytics', { week: data.week })}>
            See that week's analytics
          </Button>
        </>
      )}
      <PackedDay date={selDay} ctx={ctx} />
      {ask && <PracticeAsk ask={ask} model={model} onDone={() => setAsk(null)} />}
      {split && <SplitAsk ask={split} onDone={() => setSplit(null)} />}

      {offset >= 0 && !placing && (
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
      )}

      {showDrag ? (
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
          <div ref={dayCard} className="card wkdaycard" {...pinch}>
            <DragDay
              date={selDay}
              hour={HOUR_PX * zoom}
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
      ) : (
        <div onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
          {props.finished[selDay] !== undefined ? (
            // Today or a day gone by: what was finished, which opens Done on that day.
            <div className="between dnday">
              <h3 className="wkday">{dayTitle}</h3>
              <button className="link dnlink" type="button" aria-label={`Done on ${dayTitle}: ${finishedCount(props.finished[selDay]).toLowerCase()}`} onClick={() => props.openDone(selDay)}>
                {finishedCount(props.finished[selDay])} <Icon name="chevron-right" size={16} />
              </button>
            </div>
          ) : (
            <h3 className="wkday">{dayTitle}</h3>
          )}
          <div ref={dayCard} className="card wkdaycard" {...pinch}>
            <DayRows date={selDay} model={model} cell={CELL_PX * zoom} readOnly={offset < 0} onOpen={openBlock} onMove={holdMove} />
          </div>
          {isThis && (
            <Button className="wkstats" type="button" onClick={() => nav.go('analytics', { week: data.week })}>
              See this week's analytics
            </Button>
          )}
        </div>
      )}

      {placing && at ? (
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
      ) : editing ? (
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
      ) : isThis && !props.gated ? (
        <button
          className="tray go"
          type="button"
          onClick={() => {
            if (selDay < day0) setSelDay(day0);
            props.setEditing(true);
          }}
        >
          Edit this week's plan
        </button>
      ) : offset === 1 ? (
        <button className="tray go" type="button" onClick={() => void planning.start(model.thisPlanned ? addWeeks(model.current, 1) : model.current)}>
          {model.thisPlanned ? 'Plan next week' : 'Start planning'}
        </button>
      ) : null}

      {asking}
      {opened && (
        <BlockSheet
          block={opened}
          model={model}
          canEdit={offset >= 0 && !opened.past}
          onClose={() => setOpen(null)}
          onLength={(end) => changeBlock(opened, { date: opened.date, start: opened.start, end })}
          onMove={() => startPlacing({ mode: 'move', block: opened, length: opened.end - opened.start }, opened)}
          onRemove={() => {
            setOpen(null);
            setEdSel(null);
            void act.remove(opened.id, opened.title);
          }}
        />
      )}
      {popped && (
        <TaskPopupFor
          id={popped.task}
          close={() => setOpen(null)}
          block={
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
    </div>
  );
}

/**
 * The zoom at which the drawn day fits between the week's sticky top and whatever covers the bottom of the screen: the
 * tray and the tab bar. Rows of time that's closed or gone by keep their height, so only the rest scales.
 * shortcut: a block is never drawn under a tap target's height, so a day of many short blocks can still run a little
 * past the screen at its smallest; fit those too if it turns out to matter.
 */
function leastZoom(root: HTMLElement | null, card: HTMLElement | null, zoom: number) {
  const top = root?.querySelector('.weektop')?.getBoundingClientRect().bottom;
  if (!card || top === undefined) return 1;
  const bottom = Math.min(innerHeight, ...[...document.querySelectorAll('.tray, .tabs')].map((el) => el.getBoundingClientRect().top));
  const scales = [...card.querySelectorAll('.day, .tlfree, .tlrow > .tlblock, .tlcols')].reduce((h, el) => h + el.getBoundingClientRect().height, 0);
  if (!scales) return 1;
  const fixed = card.getBoundingClientRect().height - scales;
  return fitZoom(bottom - top - fixed, scales / zoom);
}

/** The id of a hold's draft among a day's rows, drawn as a block until Capture saves or cancels it. */
const HELD = 'holddraft';

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
 * One row per block, busy event or stretch of time, so short blocks stay readable. Cells are half hours. Blocks at the
 * same time share a row, side by side. A press held on a stretch of time drafts an hour there, in a row of its own that
 * splits the stretch around it, and opens Capture on it.
 */
function DayRows(props: {
  date: LocalDate;
  model: WeekModel;
  /** A half hour's height. */
  cell: number;
  readOnly: boolean;
  onOpen(id: string): void;
  /** Resolves to whether it moved. `undone` runs as its Undo is pressed. */
  onMove(block: PlacedBlock, slot: Slot, undone: () => void): Promise<boolean>;
}) {
  const { date, model, cell } = props;
  const { clock, layout, platform } = useApp();
  // On today, the current time is a line across the row whose time holds it, as far down it as the time is.
  const nowMin = date === today(clock) ? localMinutes(clock.now(), clock.zone()) : null;
  const { availability, busy, earliest } = model.ctx;
  // The minute under the finger, from the time the row covers and the height it's drawn, which for a closed row isn't
  // its time's. After the hold the draft moves at the rows' scale, a half hour a cell.
  const holdNew = useHoldToCreate({
    at: (_x, py, el) => {
      const [from, to] = [Number(el.dataset.dropFrom), Number(el.dataset.dropTo)];
      const tall = el.getBoundingClientRect().height || ((to - from) / 30) * cell;
      return { date, minute: from + (py / tall) * (to - from) };
    },
    move: (s, _dx, dy) => dragResult(s, 'move', 0, (dy * 30) / cell, [], { from: date === earliest.date ? Math.max(DAY_FROM, Math.ceil(earliest.minutes / GRID) * GRID) : DAY_FROM, to: DAY_TO }),
    earliest,
  });
  const held = holdNew.draft?.slot;
  const draftBlock: PlacedBlock | null = held ? { ...held, id: HELD, title: holdNew.draft!.name.trim() || 'New task', kind: 'project', draft: true, task_id: null, practice_id: null, past: false, ended: false, result: null } : null;
  const saved = model.blocks.filter((b) => b.date === date);
  // A block let go on another row is drawn at its new time while it saves.
  const [landed, setLanded] = useLanded(saved);
  const blocks = [...saved.map((b) => (b.id === landed?.id ? { ...b, ...landed.slot } : b)), ...(draftBlock?.date === date ? [draftBlock] : [])];
  const groups = overlapGroups(blocks);
  const info = model.info.filter((x) => x.date === date);
  const shown = new Set<unknown>();
  const startsIn = (m: number) => blocks.filter((b) => b.start < m + 30 && !shown.has(b)).sort((a, b) => a.start - b.start)[0];
  const busyAt = (m: number) => busy.find((b) => b.date === date && b.start <= m && m < b.end);
  const infoIn = (m: number) => info.find((x) => x.start < m + 30 && !shown.has(x));
  // Open time that has gone by shows what happened, so it's never free.
  const kindAt = (m: number) => (!isOpen(availability, date, m, 'project') ? 'closed' : isPast(date, m, model.ctx) ? 'gone' : 'free');
  const rows: ReactElement[] = [];
  // Each row says the time it covers, so a card dropped on it lands where it was let go.
  const row = (key: string, time: number, body: ReactElement, from: number, to: number, holdable = false) =>
    rows.push(
      <div key={key} className="tlrow" data-drop-date={date} data-drop-from={from} data-drop-to={to} onPointerDown={holdable ? holdNew.press : undefined}>
        <span className="tltime">{formatTimeOfDay(time)}</span>
        {body}
        {nowMin !== null && from <= nowMin && nowMin < to && <NowLine top={`${((nowMin - from) / (to - from)) * 100}%`} />}
      </div>,
    );

  // A task's block always opens, to its popup; a practice's or planning's only while it can still change.
  const shut = (block: PlacedBlock) => (props.readOnly || block.ended) && !isTask(block);
  // Held, a block still to come lifts and drags as a card does, onto whichever row it's let go over, at the time under
  // the finger there. Its own time is free while it moves. The press stays with the block, so the row under it never
  // takes it for a hold on empty time.
  const hold = (block: PlacedBlock) => (e: ReactPointerEvent<HTMLElement>) => {
    e.stopPropagation();
    dragCard(e, { length: block.end - block.start, offers: [] }, { ...model.ctx, placed: model.ctx.placed.filter((s) => s.id !== block.id) }, {
      preview: () => undefined,
      drop: (slot) => {
        const put = { id: block.id, slot };
        setLanded(put);
        // A failed save puts it back, and so does Undo pressed before the day has redrawn from the save: the day's next
        // drawing then matches the one before the move, which wouldn't redraw it.
        const back = () => setLanded((l) => (l === put ? null : l));
        void props.onMove(block, slot, back).then((moved) => moved || back());
      },
      ...(platform.haptic ? { haptic: platform.haptic } : {}),
    });
  };
  /** A block filling its row, or in its column of its group's row, whose time is `from`: one starting later says when. */
  const draw = (block: PlacedBlock, others: readonly PlacedBlock[], from: number, style: CSSProperties) => {
    if (block.id === HELD) {
      return (
        <div key={HELD} ref={holdNew.draftRef} className={`tlblock holddraft ${blockClass('project', 'placing')}${holdNew.draft!.fresh ? ' pop' : ''}`} style={style} title={slotRange(block)} aria-hidden="true">
          <span className="tlname">
            <span className="blktitle">{block.title}</span>
          </span>
          <span className="tlkind">{slotRange(block)}</span>
        </div>
      );
    }
    const word = KIND_WORD[block.kind];
    const kindLine = `${word}, ${formatMinutes(block.end - block.start)}${block.start > from ? `, from ${formatTimeOfDay(block.start)}` : ''}${block.note ? `. ${block.note}` : ''}`;
    const state = blockState({ result: block.result, ended: block.ended, now: block.now });
    const cls = `tlblock ${blockClass(LOOK[block.kind], state)}`;
    const inner = (
      <>
        <span className="tlname">
          <BlockMarks state={state} look={LOOK[block.kind]} />
          <OutcomeTag result={block.result} />
          <span className="blktitle">{block.title}</span>
        </span>
        <span className="tlkind">{kindLine}</span>
      </>
    );
    return shut(block) ? (
      <div key={block.id} className={cls} style={style}>
        {inner}
      </div>
    ) : (
      <button
        key={block.id}
        className={cls}
        type="button"
        aria-haspopup="dialog"
        style={style}
        aria-label={`${block.title}, ${slotRange(block)}, ${word}.${block.note ? ` ${block.note}.` : ''}${overlapNote(others)}`}
        onClick={() => props.onOpen(block.id)}
        onPointerDown={props.readOnly || block.past ? undefined : hold(block)}
      >
        {inner}
      </button>
    );
  };

  let m = DAY_FROM;
  while (m < DAY_TO) {
    const block = startsIn(m);
    const event = busyAt(m);
    const inf = infoIn(m);
    if (block) {
      // The row runs to the end of the last block overlapping it, so no free time shows inside them.
      const group = groups.find((g) => g.items.some((c) => c.item === block))!;
      for (const c of group.items) shown.add(c.item);
      const cells = Math.max(1, Math.ceil((group.end - m) / 30));
      row(
        block.id,
        group.start,
        group.items.length === 1 ? (
          draw(block, [], block.start, { height: cells * cell - 2 })
        ) : (
          <DayGroup group={group} from={m} cells={cells} cell={cell} draw={draw} canOpen={(b) => b.id !== HELD && !shut(b)} onOpen={props.onOpen} />
        ),
        m,
        m + cells * 30,
      );
      m += cells * 30;
      continue;
    }
    // It doesn't take up time, so a block already over it leaves the clock where it is.
    if (inf) {
      shown.add(inf);
      row(
        `i${inf.id}${inf.start}`,
        inf.start,
        <div className={`tlblock ${blockClass('info', 'planned')}`} style={{ height: cell - 2 }}>
          <span className="tlname">{inf.title}</span>
          <span className="tlkind">Information, {slotRange(inf)}</span>
        </div>,
        inf.start,
        inf.end,
      );
      m = Math.max(m, m + Math.ceil((inf.end - m) / 30) * 30);
      continue;
    }
    if (event) {
      row(`b${event.id}${m}`, event.start, <div className={`tlblock ${blockClass('event', 'planned')} small wkbusy`}>Busy, {slotRange(event)}</div>, m, event.end);
      m = event.end;
      continue;
    }
    const kind = kindAt(m);
    let n = m + 30;
    while (n < DAY_TO && kindAt(n) === kind && !busyAt(n) && !startsIn(n) && !infoIn(n)) n += 30;
    const text = `${formatTimeOfDay(m)} to ${formatTimeOfDay(n)}`;
    row(
      `f${m}`,
      m,
      kind !== 'free' ? (
        <div className="tlclosed">
          {kind === 'closed' ? 'Not available' : 'Gone by'}, {text}
        </div>
      ) : (
        <div className="tlfree" style={{ height: ((n - m) / 30) * cell - 2 }}>
          Free, {text}
        </div>
      ),
      m,
      n,
      true,
    );
    m = n;
  }
  return (
    // A finger moving the draft sideways isn't a swipe to the next day.
    <div className="tlrows" onTouchEnd={(e) => holdNew.draft && e.stopPropagation()}>
      {rows}
      <HoldRing ring={holdNew.ring} />
      {holdNew.draft?.open && (
        <DraftCapture
          layout={layout}
          close={holdNew.close}
          slot={holdNew.slot(overlapWords(holdNew.draft.slot, [...model.blocks, ...busy].filter((o) => o.date === date).map((o) => ({ title: o.title || 'Busy', start: o.start, end: o.end }))))}
        />
      )}
    </div>
  );
}

/**
 * Blocks at the same time, side by side in their row from the half hour `from`, each from its own half hour to the end
 * of its own. As many columns as stay readable are drawn; +N more under them lists the whole group.
 */
function DayGroup(props: {
  group: OverlapGroup<PlacedBlock>;
  from: number;
  cells: number;
  cell: number;
  draw(block: PlacedBlock, others: readonly PlacedBlock[], from: number, style: CSSProperties): ReactElement;
  canOpen(block: PlacedBlock): boolean;
  onOpen(id: string): void;
}) {
  const { group, from } = props;
  const [measure, width] = useWidth<HTMLDivElement>();
  const shown = shownColumns(group.cols, width);
  // shortcut: the current time's line is placed down the whole row, +N more included, so in such a row it sits up to
  // a button's height low; place it by the columns alone if three or more at once turn out common.
  return (
    <>
      <div ref={measure} className="tlcols" style={{ height: props.cells * props.cell - 2 }}>
        {group.items
          .filter((c) => c.col < shown)
          .map(({ item, col, with: others }) => {
            const top = Math.max(0, Math.floor((item.start - from) / 30));
            const cells = Math.max(1, Math.ceil((item.end - from) / 30) - top);
            return props.draw(item, others, group.start, { top: top * props.cell, height: cells * props.cell - 2, ...columnStyle(col, shown) });
          })}
      </div>
      {shown < group.cols && <MoreButton group={group} shown={shown} className="tlmore" canOpen={props.canOpen} onOpen={(b) => props.onOpen(b.id)} />}
    </>
  );
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

/** A block's length on a slider, while it can change, and what's off about its time: in its sheet, or in a task's popup. */
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

/** A tapped practice's session or planning block: its length on a slider, Move and Remove. */
function BlockSheet(props: {
  block: PlacedBlock;
  model: WeekModel;
  canEdit: boolean;
  onClose(): void;
  onLength(end: number): void;
  onMove(): void;
  onRemove(): void;
}) {
  const { block } = props;
  return (
    <Sheet label={block.title} onClose={props.onClose}>
      <div>
        <div className="small quiet">
          {dayName(block.date)}, {slotRange(block)}
        </div>
        <h2>{block.task_id ? <TaskName id={block.task_id} title={block.title} /> : block.title}</h2>
      </div>
      <LengthAndNote block={block} model={props.model} canEdit={props.canEdit} onLength={props.onLength} />
      {props.canEdit && (
        <>
          <Button variant="primary" type="button" onClick={props.onMove}>
            Move
          </Button>
          <Button type="button" onClick={props.onRemove}>
            Remove
          </Button>
        </>
      )}
      <Button type="button" onClick={props.onClose}>
        Close
      </Button>
    </Sheet>
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

// Week on phone. A full week grid doesn't fit, so a sticky strip of seven day buttons shows each day's shape on a
// shared time axis above one day's timeline. Tapping a block opens its sheet; Move, or Choose another time for a
// task, makes the block draggable on the day, and the strip carries it to another day. To schedule sits above the
// day: a card opens its suggested times, and while editing, cards drag onto the day and blocks drag back up to it.

import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent as ReactPointerEvent, ReactElement, TouchEvent } from 'react';
import { addDays, addWeeks, diffDays, formatMinutes, formatTimeOfDay, formatWeekday, localMinutes, today } from '../../../core/dates';
import { FIRST_BLOCK_MIN } from '../../../core/plan';
import { closestFit, defaultSlot, dragResult, DRAWN_DAY, fits, GRID, isOpen, isPast, offers, slotNotes } from '../../../core/slots';
import type { Slot, SlotContext, Work } from '../../../core/slots';
import type { LocalDate, Minutes } from '../../../core/types';
import { useNav } from '../../app/nav';
import { useApp } from '../../app/store';
import { PlanPrompt } from '../../components/PlanPrompt';
import { PlanningSet } from '../../components/planning/PlanningRow';
import { usePlanningActions } from '../../components/planning/usePlanning';
import { DayStrip, PackedDay, weekFree } from '../../components/week/DayStrip';
import { Sheet } from '../../components/Sheet';
import { TaskName } from '../../components/task/TaskName';
import { KIND_WORD } from '../../components/blocks/describe';
import { clearLane, dayName, overLane, slotRange } from '../../components/weekgrid';
import type { GridGhost, PlacedBlock } from '../../components/weekgrid';
import { rowItem } from './data';
import type { AddRow, LaneItem, Placeable, WeekModel } from './data';
import { LaneActions, LaneCard, laneCount } from './lane';
import type { WeekProps } from './index';
import { PracticeAsk } from './parts';
import { useWeekActions } from './useWeekActions';

const { from: DAY_FROM, to: DAY_TO } = DRAWN_DAY;
const HOUR_PX = 48;
const CELL_PX = 46;
const KIND_CLASS = { project: 'c-project', practice: 'c-practice', one_off: 'c-maint' } as const;
const y = (m: number) => ((m - DAY_FROM) * HOUR_PX) / 60;
const overlaps = (list: readonly Slot[], date: LocalDate, start: number, end: number) => list.some((x) => x.date === date && x.start < end && start < x.end);

/** A block being moved, or a task being placed, before Move here or Place here. */
type Placing =
  | { mode: 'move'; block: PlacedBlock; length: Minutes }
  | { mode: 'place'; item: Placeable; length: Minutes; fromDrawer: boolean };

type Open = { kind: 'block'; id: string } | { kind: 'add' } | { kind: 'item'; id: string } | null;

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
  const swipe = useRef<{ x: number; y: number } | null>(null);

  const kindOf = (p: Placing): Work['kind'] => (p.mode === 'move' ? (p.block.kind === 'one_off' ? 'one_off' : 'project') : p.item.work.kind);
  const workOf = (p: Placing): Work => (p.mode === 'move' ? { kind: kindOf(p) } : p.item.work);
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

  // Find a time or Place on calendar from Today: the task's block waits at its best time, ready to drag.
  useEffect(() => {
    if (!props.place) return;
    const row = model.addGroups.flatMap((g) => g.rows).find((r) => r.task.id === props.place);
    if (row) startPlacing({ mode: 'place', item: rowItem(row), length: Math.min(row.left, FIRST_BLOCK_MIN), fromDrawer: false }, null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.place]);

  const pickDay = (date: LocalDate) => {
    setSelDay(date);
    if (!placing || !at) return;
    // The block keeps its time on a new day when it fits there, and otherwise lands on the closest time that does.
    const len = at.end - at.start;
    const keep = fits(date, at.start, len, kindOf(placing), ctx);
    const start = keep ? at.start : closestFit(date, at.start, len, kindOf(placing), ctx) ?? Math.max(at.start, floorOf(date));
    setAt({ date, start, end: start + len });
  };

  const changeBlock = (b: PlacedBlock, slot: Slot) => {
    if (slot.start === b.start && slot.end === b.end && slot.date === b.date) return;
    void act.move(b.id, slot);
    setEdSel(b.id);
    setAsk(b.practice_id ? { blockId: b.id, wasMin: ask?.blockId === b.id ? ask.wasMin : b.end - b.start } : null);
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

  const locked = !!at && isThis && (at.date < day0 || (at.date === day0 && at.start < floorOf(day0)));
  const finishPlacing = async () => {
    if (!placing || !at || locked) return;
    if (placing.mode === 'move') {
      const b = placing.block;
      if (at.date !== b.date || at.start !== b.start || at.end !== b.end) {
        await act.moveWithUndo(b.id, b.title, at);
        if (b.practice_id) setAsk({ blockId: b.id, wasMin: b.end - b.start });
      }
    } else if (!(await act.place(placing.item, at))) return;
    setPlacing(null);
    setAt(null);
    props.donePlacing();
  };

  const blocksOn = (date: LocalDate) => model.blocks.filter((b) => b.date === date);
  const opened = open?.kind === 'block' ? model.blocks.find((b) => b.id === open.id) : undefined;
  const item = open?.kind === 'item' ? model.unscheduled.find((x) => x.id === open.id) : undefined;
  const [dropAt, setDropAt] = useState<{ item: LaneItem; slot: Slot } | null>(null);
  const laneItems = model.unscheduled.filter((x) => !x.dates || (x.dates.from <= selDay && selDay <= x.dates.to));
  const card = (x: LaneItem) => (
    <LaneCard
      key={x.id}
      item={x}
      ctx={model.ctx}
      open={false}
      draggable={isThis && !placing}
      onToggle={() => setOpen({ kind: 'item', id: x.id })}
      onPreview={(slot) => setDropAt(slot && { item: x, slot })}
      onDrop={(slot) => void act.place(x, slot)}
    />
  );
  const dayIndex = diffDays(data.week, selDay);
  const dayTitle = dayName(selDay);
  const showDrag = !!placing || editing;

  const onTouchStart = (e: TouchEvent) => {
    swipe.current = { x: e.touches[0]!.clientX, y: e.touches[0]!.clientY };
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
    ? `${placing.mode === 'move' ? 'Moving' : 'Placing'} ${placing.mode === 'move' ? placing.block.title : placing.item.title}, ${formatMinutes(at.end - at.start)}${
        placing.mode === 'move' ? `, from ${formatWeekday(placing.block.date)} ${formatTimeOfDay(placing.block.start)}` : ''
      }`
    : '';
  const placingNote = !placing || !at ? '' : locked ? 'That time has passed.' : slotNotes({ ...at, id: placing.mode === 'move' ? placing.block.id : 'draft' }, workOf(placing), ctx).join(' ');
  const noFit = (date: LocalDate) => !!placing && !!at && closestFit(date, at.start, at.end - at.start, kindOf(placing), ctx) === null;
  const nextFit = noFit(selDay) ? [1, 2, 3, 4, 5, 6].map((n) => addDays(data.week, (dayIndex + n) % 7)).find((d) => !noFit(d)) : undefined;
  const edBlock = edSel ? model.blocks.find((b) => b.id === edSel) : undefined;

  return (
    <div className="stack8 week">
      <div className="weektop stack8">
        <div className="between">
          <button className="icbtn" type="button" aria-label="Previous week" disabled={!!placing} onClick={() => props.goWeek(addDays(props.week, -7))}>
            ‹
          </button>
          <div className="wktitle">
            <div className="small quiet">{props.label}</div>
            <h2>{props.title}</h2>
          </div>
          <button className="icbtn" type="button" aria-label="Next week" disabled={!!placing} onClick={() => props.goWeek(addDays(props.week, 7))}>
            ›
          </button>
        </div>
        {props.gated && <PlanPrompt week={data.week} />}
        {props.planningSet && <PlanningSet week={data.week} block={props.planningSet} />}
        {!isThis && !placing && (
          <div className="wkcenter">
            <button className="btn" type="button" onClick={() => props.goWeek(addDays(data.week, -7 * offset))}>
              This week
            </button>
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
            hint={(date) => ({ noFit: noFit(date) })}
            onPick={pickDay}
          />
        </div>
      </div>

      {offset < 0 && (
        <>
          <p className="small quiet">Past weeks can be viewed but not changed.</p>
          <button className="btn" type="button" onClick={() => nav.go('analytics', { week: data.week })}>
            See that week's analytics
          </button>
        </>
      )}
      <PackedDay date={selDay} ctx={ctx} />
      {ask && <PracticeAsk ask={ask} model={model} onDone={() => setAsk(null)} />}

      {offset >= 0 && !placing && (
        <section className="card stack8 tosched" aria-label="To schedule" data-unscheduled>
          <div className="small">
            <span className="strong">To schedule</span>{' '}
            <span className="quiet">{model.unscheduled.length ? laneCount(model.unscheduled) : 'Everything this week is on the calendar.'}</span>
          </div>
          {laneItems.length > 0 && <div className="lanerow">{laneItems.map(card)}</div>}
          {isThis && laneItems.length > 0 && (
            <p className="small quiet">
              {editing ? 'Hold a card, then drag it down onto the day. Drag a block up here to take it off the calendar.' : 'Hold a card, then drag it down onto the day, or tap it for suggested times.'}
            </p>
          )}
          {model.unscheduled.length > 0 && (
            <button className="btn" type="button" onClick={() => nav.openFlow('planning', { week: data.week, step: 'schedule' })}>
              Schedule one at a time
            </button>
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
              ? 'Drag the block to any time, or pick another day above. Drag its bottom edge to change its length.'
              : 'Drag or resize anything from now on, or tap it to change it. Changes save as you go.'}
          </p>
          <div className="card wkdaycard">
            <DragDay
              date={selDay}
              ctx={ctx}
              info={model.info}
              floor={floorOf(selDay)}
              blocks={blocksOn(selDay).filter((b) => !(placing?.mode === 'move' && placing.block.id === b.id))}
              moving={
                placing && at && at.date === selDay && !locked
                  ? { title: placing.mode === 'move' ? placing.block.title : placing.item.title, kind: placing.mode === 'move' ? placing.block.kind : placing.item.kind, slot: at }
                  : dropAt && dropAt.slot.date === selDay
                    ? { title: dropAt.item.title, kind: dropAt.item.kind, slot: dropAt.slot }
                    : null
              }
              editing={editing && !placing}
              onMoving={setAt}
              onDone={() => void finishPlacing()}
              onChange={changeBlock}
              onUnschedule={(b) => {
                setEdSel(null);
                void act.unschedule(b.id, b.title, data.week);
              }}
              onOpen={(id) => {
                setEdSel(id);
                setOpen({ kind: 'block', id });
              }}
            />
          </div>
        </div>
      ) : (
        <div onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
          <h3 className="wkday">{dayTitle}</h3>
          <div className="card wkdaycard">
            <DayRows date={selDay} model={model} readOnly={offset < 0} onOpen={(id) => setOpen({ kind: 'block', id })} />
          </div>
          {isThis && (
            <button className="btn wkstats" type="button" onClick={() => nav.go('analytics', { week: data.week })}>
              See this week's analytics
            </button>
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
            <button className="btn pri sm grow" type="button" disabled={locked} onClick={() => void finishPlacing()}>
              {placing.mode === 'move' ? 'Move here' : 'Place here'}
            </button>
            <button className="btn sm" type="button" onClick={cancelPlacing}>
              Cancel
            </button>
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
            <button
              className="btn pri sm grow"
              type="button"
              onClick={() => {
                setEdSel(null);
                props.donePlacing();
                props.setEditing(false);
              }}
            >
              Done editing
            </button>
            <button className="btn sm" type="button" onClick={() => setOpen({ kind: 'add' })}>
              Add a task
            </button>
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
            onChoose={() => startPlacing({ mode: 'place', item, length: item.length, fromDrawer: false }, item.offers[0] ? { ...item.offers[0] } : null)}
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

/** One row per block, busy event or stretch of time, so short blocks stay readable. Cells are half hours. */
function DayRows(props: { date: LocalDate; model: WeekModel; readOnly: boolean; onOpen(id: string): void }) {
  const { date, model } = props;
  const { availability, busy } = model.ctx;
  const blocks = model.blocks.filter((b) => b.date === date);
  const info = model.info.filter((x) => x.date === date);
  const shown = new Set<unknown>();
  const startsIn = (m: number) => blocks.filter((b) => b.start < m + 30 && !shown.has(b)).sort((a, b) => a.start - b.start)[0];
  const busyAt = (m: number) => busy.find((b) => b.date === date && b.start <= m && m < b.end);
  const infoIn = (m: number) => info.find((x) => x.start < m + 30 && !shown.has(x));
  // Open time that has gone by shows what happened, so it's never free.
  const kindAt = (m: number) => (!isOpen(availability, date, m, 'project') ? 'closed' : isPast(date, m, model.ctx) ? 'gone' : 'free');
  const rows: ReactElement[] = [];
  // Each row says the time it covers, so a card dropped on it lands where it was let go.
  const row = (key: string, time: number, body: ReactElement, from: number, to: number) =>
    rows.push(
      <div key={key} className="tlrow" data-drop-date={date} data-drop-from={from} data-drop-to={to}>
        <span className="tltime">{formatTimeOfDay(time)}</span>
        {body}
      </div>,
    );

  let m = DAY_FROM;
  while (m < DAY_TO) {
    const block = startsIn(m);
    const event = busyAt(m);
    const inf = infoIn(m);
    if (block) {
      shown.add(block);
      const cells = Math.max(1, Math.ceil((block.end - m) / 30));
      const word = KIND_WORD[block.kind];
      const shut = props.readOnly || block.ended;
      const kindLine = `${word}, ${formatMinutes(block.end - block.start)}${block.note ? `. ${block.note}` : ''}`;
      const cls = `tlblock ${KIND_CLASS[block.kind]}${shut ? ' c-ended' : ''}`;
      const inner = (
        <>
          <span className="tlname">{block.title}</span>
          <span className="tlkind">{kindLine}</span>
        </>
      );
      row(
        block.id,
        block.start,
        shut ? (
          <div className={cls} style={{ height: cells * CELL_PX - 2 }}>
            {inner}
          </div>
        ) : (
          <button
            className={cls}
            type="button"
            style={{ height: cells * CELL_PX - 2 }}
            aria-label={`${block.title}, ${slotRange(block)}, ${word}.${block.note ? ` ${block.note}.` : ''}`}
            onClick={() => props.onOpen(block.id)}
          >
            {inner}
          </button>
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
        <div className="tlblock c-info" style={{ height: CELL_PX - 2 }}>
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
      row(`b${event.id}${m}`, event.start, <div className="tlblock c-busy small wkbusy">Busy, {slotRange(event)}</div>, m, event.end);
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
        <div className="tlfree" style={{ height: ((n - m) / 30) * CELL_PX - 2 }}>
          Free, {text}
        </div>
      ),
      m,
      n,
    );
    m = n;
  }
  return <>{rows}</>;
}

/**
 * The drawn day behind a drag: hours, closed time, calendar events, and the blocks that move. The planning Schedule
 * step also passes suggested times, which the moving and selected blocks snap to.
 */
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
  onChange(b: PlacedBlock, slot: Slot): void;
  /** A block let go over To schedule, which takes it off the calendar. */
  onUnschedule?(b: PlacedBlock): void;
  onOpen(id: string): void;
}) {
  const { date, ctx, floor, moving, ghosts = [] } = props;
  const targets = ghosts.map((g) => ({ date: g.date, start: g.start }));
  const [preview, setPreview] = useState<{ id: string; slot: Slot } | null>(null);
  // A dropped block stays where it landed until the saved position comes back.
  const placed = props.blocks.map((b) => `${b.id}${b.start}${b.end}`).join();
  useEffect(() => setPreview(null), [placed]);
  const bounds = { from: floor, to: DAY_TO };
  const zones: { top: number; h: number; lock?: boolean }[] = [];
  for (let m = DAY_FROM; m < DAY_TO; m += 30) {
    if (isOpen(ctx.availability, date, m, 'project')) continue;
    const last = zones[zones.length - 1];
    if (last && !last.lock && last.top + last.h === y(m)) last.h += HOUR_PX / 2;
    else zones.push({ top: y(m), h: HOUR_PX / 2 });
  }
  if (floor > DAY_FROM) zones.push({ top: 0, h: y(Math.min(floor, DAY_TO)), lock: true });

  // Measured from the drawn track each move, so zoom and scrolling during the drag can't shift the block.
  const track = (event: ReactPointerEvent, apply: (minutes: number) => void, done?: () => void, tap?: () => void, off?: () => void) => {
    event.preventDefault();
    event.stopPropagation();
    const day = (event.currentTarget as HTMLElement).closest('.day');
    const perPx = (DAY_TO - DAY_FROM) / (day?.getBoundingClientRect().height || y(DAY_TO));
    const y0 = event.clientY;
    let moved = false;
    const leaving = (e: PointerEvent) => !!off && overLane(e.clientX, e.clientY);
    const move = (e: PointerEvent) => {
      if (!moved && Math.abs(e.clientY - y0) < 8) return;
      moved = true;
      if (!leaving(e)) apply((e.clientY - y0) * perPx);
    };
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', stop);
      clearLane();
    };
    const up = (e: PointerEvent) => {
      const out = moved && leaving(e);
      stop();
      if (out) {
        setPreview(null);
        off?.();
      } else if (moved) done?.();
      else tap?.();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', stop);
  };

  const handle = (
    key: string,
    title: string,
    kind: PlacedBlock['kind'],
    slot: Slot,
    calm: boolean,
    on: { change(s: Slot): void; /** Saves on drop rather than following the finger. */ commit?: boolean; open?(): void; enter(): void; unschedule?(): void },
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
        e,
        (minutes) => {
          latest = dragResult(slot, mode, 0, minutes, mode === 'move' && chosen ? targets : [], bounds);
          if (on.commit) setPreview({ id: key, slot: latest });
          else on.change(latest);
        },
        () => {
          if (on.commit && (latest.start !== slot.start || latest.end !== slot.end)) on.change(latest);
          else setPreview(null);
        },
        mode === 'move' ? on.open : undefined,
        mode === 'move' ? on.unschedule : undefined,
      );
    const shown = preview?.id === key ? preview.slot : slot;
    // It floats beside what it overlaps, so nothing under it moves or hides.
    const beside = chosen && overlaps([...props.blocks.filter((b) => b.id !== key), ...ctx.busy], date, shown.start, shown.end);
    const help = on.commit ? ' Drag, or use the up and down arrow keys. Shift and arrows change its length. Enter opens its options.' : ' Drag, or use the up and down arrow keys. Shift and arrows change its length. Enter saves.';
    return (
      <div
        key={key}
        className={`cev dragblock ${KIND_CLASS[kind]}${calm ? ' calm' : ''}${chosen ? ' draft' : ''}${beside ? ' beside' : ''}`}
        role="slider"
        tabIndex={0}
        aria-label={(on.commit ? title : `Time for ${title}, being placed`) + '.' + help}
        // The day runs down the screen, so the value is the time left in the day after its start: Up, and VoiceOver's
        // swipe up, raise it and move the block up. aria-valuetext says the actual time.
        aria-orientation="vertical"
        aria-valuemin={len}
        aria-valuemax={DAY_TO - floor}
        aria-valuenow={DAY_TO - shown.start}
        aria-valuetext={`${dayName(date)}, ${slotRange(shown)}`}
        style={{ top: y(shown.start), height: Math.max(24, y(shown.end) - y(shown.start)) }}
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
      <div className="day dragday" style={{ height: y(DAY_TO) }} data-drop-date={date}>
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
        {ctx.busy
          .filter((e) => e.date === date)
          .map((e, i) => (
            <div key={`b${i}`} className="cev c-busy" style={{ top: y(e.start), height: Math.max(13, y(e.end) - y(e.start)) }}>
              {e.title || 'Busy'}
            </div>
          ))}
        {props.info
          .filter((e) => e.date === date)
          .map((e, i) => (
            <div key={`i${i}`} className="cev c-info" style={{ top: y(e.start), height: y(e.end) - y(e.start) }}>
              {e.title}
            </div>
          ))}
        {props.blocks.map((b) => {
          const live = props.editing && b.start >= floor && !b.past;
          if (live) {
            const unschedule = props.onUnschedule && (() => props.onUnschedule!(b));
            return handle(b.id, b.title, b.kind, b, b.id !== props.selected, { change: (s) => props.onChange(b, s), commit: true, open: () => props.onOpen(b.id), enter: () => props.onOpen(b.id), ...(unschedule ? { unschedule } : {}) });
          }
          const h = Math.max(13, y(b.end) - y(b.start));
          return (
            <div key={b.id} className={`cev ${KIND_CLASS[b.kind]}${props.editing ? ' c-ended' : ''}${h < 24 ? ' compact' : ''}`} style={{ top: y(b.start), height: h }}>
              {b.title}
            </div>
          );
        })}
        {ghosts
          .filter((g) => g.date === date)
          .map((g) => (
            <button
              key={`g${g.start}`}
              type="button"
              className="cev ghost"
              aria-label={`Use suggested time, ${g.label}`}
              style={{ top: y(g.start), height: Math.max(28, y(g.end) - y(g.start)) }}
              onClick={g.onAccept}
            >
              <span className="cevt">Suggested {formatTimeOfDay(g.start)}</span>
            </button>
          ))}
        {moving && handle('moving', moving.title, moving.kind, moving.slot, false, { change: props.onMoving, enter: props.onDone })}
      </div>
    </div>
  );
}

/** A tapped block: its length on a slider, Move and Remove. */
function BlockSheet(props: {
  block: PlacedBlock;
  model: WeekModel;
  canEdit: boolean;
  onClose(): void;
  onLength(end: number): void;
  onMove(): void;
  onRemove(): void;
}) {
  const { block, model } = props;
  const id = useId();
  const len = block.end - block.start;
  const max = Math.max(len, Math.min(480, DAY_TO - block.start));
  const note = slotNotes(block, { kind: block.kind === 'one_off' ? 'one_off' : 'project' }, model.ctx).join(' ');
  return (
    <Sheet label={block.title} onClose={props.onClose}>
      <div>
        <div className="small quiet">
          {dayName(block.date)}, {slotRange(block)}
        </div>
        <h2>{block.task_id ? <TaskName id={block.task_id} title={block.title} /> : block.title}</h2>
      </div>
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
            step={GRID}
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
      {props.canEdit && (
        <>
          <button className="btn pri" type="button" onClick={props.onMove}>
            Move
          </button>
          <button className="btn" type="button" onClick={props.onRemove}>
            Remove
          </button>
        </>
      )}
      <button className="btn" type="button" onClick={props.onClose}>
        Close
      </button>
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
        <button className="btn" type="button" onClick={props.onClose}>
          Close
        </button>
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
          <input id={id} className="wkrange" type="range" min={GRID} max={most} step={GRID} value={len} aria-valuetext={formatMinutes(len)} onChange={(e) => props.onLength(Number(e.target.value))} />
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
      <button className="btn" type="button" onClick={props.onChoose}>
        Choose another time
      </button>
      {row.left > len && (
        <p className="small quiet">
          {formatMinutes(row.left - len)} of {formatMinutes(row.left)} stays unslotted after this block.
        </p>
      )}
    </div>
  );
}

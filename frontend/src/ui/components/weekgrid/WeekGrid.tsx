// The desktop week: seven day columns from 6am to 11pm, with closed hours and calendar events behind the blocks, and
// blocks at the same time side by side.
// While editing, blocks drag on a 15-minute grid and snap to a suggested time within 20 minutes; the bottom edge
// changes the length, on a block tall enough to have one. A move or resize is reported once, on drop; let go over To schedule, a block comes off the
// calendar through onUnschedule. Week and the planning Schedule step share it, as HoldWeekGrid (HoldWeekGrid.tsx), where
// a press held on empty time drafts an hour there and opens Capture on it.
//
//   <WeekGrid ctx={slotContext(...)} blocks={blocks} editing onChange={(id, slot) => save(id, slot)} />
//
// Everything here is in local dates and minutes after midnight, as core/slots.ts works.

import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, MouseEvent, PointerEvent as ReactPointerEvent } from 'react';
import { diffDays, formatMinutes, formatTimeOfDay, instantMs, weekDates } from '../../../core/dates';
import type { BlockRow } from '../../../core/queries';
import { dayBaseAhead, dayFree, dragResult, DRAWN_DAY, isOpen, TIGHT_SHARE } from '../../../core/slots';
import type { Slot, SlotContext, Span } from '../../../core/slots';
import type { BlockResult, LocalDate } from '../../../core/types';
import { dayName, KIND_WORD, OUTCOME_WORD } from '../blocks/describe';
import { NowLine } from '../NowLine';
import type { BlockKind } from '../blocks/describe';
import { OutcomeTag } from '../blocks/Outcome';
import { blockClass, BlockMarks, blockState, LOOK } from '../ds/Block';
import { columnStyle, laneRows, overlapGroups, overlapNote } from './columns';
import { clearLane, holdToDrag, overLane } from './drop';
import type { useHoldToCreate } from './holdCreate';
import './weekgrid.css';
import { Icon } from '../ds/Icon';
import { hourHeight, hourLabelStep } from '../zoom';

export interface GridBlock extends Slot {
  id: string;
  title: string;
  kind: BlockKind;
  /** Said after the time, such as "Conflicts with Quiz night". */
  note?: string;
  /** Overlaps a calendar event: drawn beside it, so both stay readable. */
  clash?: boolean;
  /** Drawn, but never dragged or removed. */
  fixed?: boolean;
  /** The block being placed: solid orange over the others, and Enter places it through onOpen. */
  draft?: boolean;
  /** Answered or over: it reads as done with, drawn muted. */
  ended?: boolean;
  /** Under way: begun, not yet ended, not answered. */
  now?: boolean;
  /** How it went, once answered: said in words, and Done struck through. */
  result?: BlockResult | null;
  /** Opens a dialog, a task's popup, rather than details in place. */
  popup?: boolean;
}

/** A block already on the week, as Week and the Schedule step show it. */
export interface PlacedBlock extends GridBlock {
  task_id: string | null;
  practice_id: string | null;
  /** Answered, or begun before now: it stays where it is. */
  past: boolean;
  ended: boolean;
  result: BlockResult | null;
}

const KIND: Record<string, BlockKind> = { practice: 'practice', one_off: 'one_off', planning: 'planning', inbox: 'inbox' };

/** The placed spans of a slot context, with what their block rows say. */
export function placedBlocks(placed: readonly Span[], rows: readonly BlockRow[], now: number): PlacedBlock[] {
  const byId = new Map(rows.map((b) => [b.id, b]));
  return placed.map((s) => {
    const row = byId.get(s.id!)!;
    const answered = !!row.result || !!row.ended_at;
    return {
      id: s.id!,
      date: s.date,
      start: s.start,
      end: s.end,
      title: s.title ?? '',
      kind: KIND[s.kind ?? ''] ?? 'project',
      task_id: row.task_id,
      practice_id: row.practice_id,
      past: answered || instantMs(row.start) < now,
      ended: answered || instantMs(row.end) <= now,
      now: !answered && instantMs(row.start) <= now && now < instantMs(row.end),
      result: row.result,
    };
  });
}

/** '4 finished' under a day's heading, which opens Done on that day. */
export const finishedCount = (n: number) => (n ? `${n} finished` : 'Nothing finished');

/** '5pm to 6:30pm' */
export const slotRange = (s: { start: number; end: number }) => `${formatTimeOfDay(s.start)} to ${formatTimeOfDay(s.end)}`;

export interface GridGhost extends Slot {
  /** 'Tue Nov 3, 5pm' */
  label: string;
  onAccept(): void;
}

/** A one off with dates in the week but no time yet. */
interface GridLaneItem {
  id: string;
  title: string;
  from: LocalDate;
  to: LocalDate;
  alt: string;
  /** Planning, drawn grey rather than as a one off. */
  planning?: boolean;
  /** A practice's session for that day, drawn teal as practices are. */
  practice?: boolean;
  open: boolean;
  onToggle(): void;
  /** Dragging it onto a day places it there. */
  onPointerDown?(event: ReactPointerEvent<HTMLElement>): void;
}

export interface WeekGridProps {
  /** Open hours, busy events and placed blocks for the free time per day; earliest is now. */
  ctx: SlotContext;
  blocks: readonly GridBlock[];
  /** Events on information-only calendars, drawn dashed. */
  info?: readonly Span[];
  /** Suggested times for the selected block, which are also where a drag snaps. */
  ghosts?: readonly GridGhost[];
  lane?: readonly GridLaneItem[];
  /** Taller hours, with drag, resize and × to remove. */
  editing?: boolean;
  /** How far its hours are zoomed in, as Week's Zoom in and Zoom out step them: a multiple of the usual hour. */
  zoom?: number;
  /** Time before ctx.earliest is greyed, its blocks stay put, and nothing moves into it. */
  lockPast?: boolean;
  /**
   * A save that resolves to undefined or false has failed or been turned down, and the dropped block goes back to where
   * it was saved.
   */
  onChange?(id: string, slot: Slot): unknown;
  onRemove?(id: string): void;
  /** A block let go over To schedule, which takes it off the calendar. */
  onUnschedule?(id: string): void;
  /** A click on a block, or Enter on it. */
  onOpen?(id: string): void;
  /** The block whose details are open, when not editing. */
  openId?: string | null;
  /** Now, in the week's zone: a line marks it across today's column, when today is in the week. */
  now?: { date: LocalDate; minutes: number };
  /** How many things were finished each day up to today: those days' headings say so, and open Done. */
  done?: { finished: Readonly<Record<LocalDate, number>>; open(date: LocalDate): void };
  /** Hold to create, from HoldWeekGrid. */
  hold?: ReturnType<typeof useHoldToCreate>;
  /**
   * A right-click on empty time, with its minute, or Shift-F10 or the menu key on a day, with none: the caller opens a
   * menu at `at` and says whether it did. Each day can then take focus, for the keys.
   */
  onEmptyMenu?(date: LocalDate, minute: number | null, at: { x: number; y: number }, from: HTMLElement): boolean;
}

const { from: FROM, to: TO } = DRAWN_DAY;
export const COLUMN_GAP = 2;
// Shorter than this, a block draws no edge to change its length: the edge, at least 4px, would take more than a quarter
// of it, and most presses would change its length instead of moving it. Shift and the arrow keys still do.
const EDGE_MIN = 16;
const LANE_ROW = 28;

const same = (a: Slot, b: Slot) => a.date === b.date && a.start === b.start && a.end === b.end;
/** An hour's height: taller while editing, and at the zoom chosen. */
export const hourPx = (editing: boolean, zoom = 1) => hourHeight(editing ? 40 : 26, zoom);

export function WeekGrid(props: WeekGridProps) {
  const { ctx, blocks, info = [], ghosts = [], lane = [], editing = false, lockPast = false } = props;
  const hr = hourPx(editing, props.zoom);
  const y = (m: number) => ((Math.max(FROM, Math.min(TO, m)) - FROM) * hr) / 60;
  // held: still under the pointer, drawn lifted; a block let go stays where it landed, put down, until it's saved.
  const [drag, setDrag] = useState<{ id: string; slot: Slot; held?: boolean } | null>(null);
  const live = useRef(props);
  live.current = props;
  // A dropped block stays where it landed until the saved position comes back in blocks. Compared by position, since
  // callers build a new list on every render, including the one the save itself causes before it lands.
  const positions = blocks.map((b) => `${b.id} ${b.date} ${b.start} ${b.end}`).join();
  useEffect(() => setDrag(null), [positions]);
  // Each day draws its own blocks, so a block moved to another day by keyboard is a new element: focus follows it there.
  const grid = useRef<HTMLDivElement>(null);
  const refocus = useRef<{ id: string; slot: Slot } | null>(null);
  useEffect(() => {
    const want = refocus.current;
    const b = want && blocks.find((x) => x.id === want.id);
    if (!want || !b || !same(b, want.slot)) return;
    refocus.current = null;
    if (document.activeElement && document.activeElement !== document.body) return;
    [...(grid.current?.querySelectorAll<HTMLElement>('[data-id]') ?? [])].find((e) => e.dataset.id === want.id)?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positions]);

  const holdNew = props.hold;
  const held = holdNew?.draft?.slot;

  const days = weekDates(ctx.week);
  // Blocks at the same time sit side by side, laid out where they're saved, so one being dragged keeps its column.
  // Beside an event one of them conflicts with, they share the half of the day it leaves. The block being placed
  // floats over them instead.
  const laneOf = new Map(
    days.flatMap((date) =>
      overlapGroups(blocks.filter((b) => b.date === date && !b.draft))
        .filter((group) => group.cols > 1)
        .flatMap((group) => {
          const left = group.items.some((c) => c.item.clash) ? '50%' : '2px';
          return group.items.map((c) => [c.item.id, { style: columnStyle(c.col, group.cols, left, '2px'), with: c.with }] as const);
        }),
    ),
  );
  const isPast = (date: LocalDate, minute: number) =>
    lockPast && (date < ctx.earliest.date || (date === ctx.earliest.date && minute < ctx.earliest.minutes));
  const movable = (b: GridBlock) => editing && !b.fixed && !isPast(b.date, b.start) && !!props.onChange;
  const targets = ghosts.map((g) => ({ date: g.date, start: g.start }));

  const startDrag = (event: ReactPointerEvent, b: GridBlock, mode: 'move' | 'resize') => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    (event.currentTarget as HTMLElement).closest<HTMLElement>('.evdrag')?.focus();
    const column = (event.currentTarget as HTMLElement).closest('.colbody');
    const wide = (column?.getBoundingClientRect().width ?? 100) + COLUMN_GAP;
    let last: Slot = b;
    const leaving = (e: PointerEvent) => mode === 'move' && !!live.current.onUnschedule && overLane(e.clientX, e.clientY);
    holdToDrag(event, {
      lift: () => setDrag({ id: b.id, slot: b, held: true }),
      drag: (dx, dy, e) => {
        if (leaving(e)) return;
        const next = dragResult(b, mode, Math.round(dx / wide), (dy * 60) / hr, mode === 'move' ? targets : []);
        if (isPast(next.date, next.start)) return;
        last = next;
        setDrag({ id: b.id, slot: next, held: true });
      },
      drop: (e) => {
        const off = leaving(e);
        clearLane();
        if (off) {
          setDrag(null);
          live.current.onUnschedule?.(b.id);
        } else if (!same(last, b)) {
          setDrag({ id: b.id, slot: last });
          const saved = live.current.onChange?.(b.id, last);
          if (saved instanceof Promise) {
            void saved.then((ok) => !ok && setDrag((d) => (d?.id === b.id && same(d.slot, last) ? null : d)));
          }
        } else setDrag(null);
      },
      // A click, held or not, opens it: the block is a group, with no click of its own.
      tap: () => live.current.onOpen?.(b.id),
      cancel: () => {
        clearLane();
        setDrag(null);
      },
    });
  };

  const onKey = (event: KeyboardEvent, b: GridBlock) => {
    // Keys on the × inside belong to it: Enter removes, and arrows don't move the block.
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      props.onOpen?.(b.id);
      return;
    }
    const step = ({ ArrowUp: [0, -15], ArrowDown: [0, 15], ArrowLeft: [-1, 0], ArrowRight: [1, 0] } as const)[event.key as 'ArrowUp'];
    if (!step) return;
    event.preventDefault();
    const next = dragResult(b, event.shiftKey && step[1] ? 'resize' : 'move', step[0], step[1], []);
    if (same(next, b) || isPast(next.date, next.start)) return;
    if (next.date !== b.date) refocus.current = { id: b.id, slot: next };
    props.onChange?.(b.id, next);
  };

  // What waits above the week shares rows across days, so the strip is only as tall as its busiest day, and a practice's
  // sessions keep to one row.
  const laneAt = laneRows(
    lane.map((a) => ({ from: Math.max(0, diffDays(days[0]!, a.from)), to: Math.min(6, diffDays(days[0]!, a.to)), ...(a.practice ? { group: a.title } : {}) })),
  );
  const laneH = laneAt.count ? laneAt.count * LANE_ROW + 4 : 0;
  const gridH = (TO - FROM) * (hr / 60);
  const hours: number[] = [];
  for (let h = FROM / 60; h < TO / 60; h += hourLabelStep(hr)) hours.push(h);

  return (
    <div className="gridbox">
      <div ref={grid} className="grid" role="group" aria-label="Week calendar">
        <div className="hours" aria-hidden="true" style={{ height: gridH, marginTop: `calc(48px + ${laneH}px)` }}>
          {hours.map((h) => (
            <span key={h} style={{ top: (h * 60 - FROM) * (hr / 60) }}>
              {formatTimeOfDay(h * 60)}
            </span>
          ))}
        </div>
        {days.map((date) => {
          const base = dayBaseAhead(date, 'project', ctx);
          const free = dayFree(date, 'project', ctx);
          // Counted from now on: a day gone by shows what happened, never free time.
          const past = date < ctx.earliest.date;
          // Not while editing, which shows neither.
          const count = editing ? undefined : props.done?.finished[date];
          const closed = closedZones(date, ctx, y);
          if (lockPast && date <= ctx.earliest.date) {
            closed.push({ top: 0, h: date < ctx.earliest.date ? gridH : y(ctx.earliest.minutes), end: TO });
          }
          return (
            <div key={date}>
              {count !== undefined ? (
                <button
                  type="button"
                  className={`colhead dnhead${free < base * TIGHT_SHARE ? ' tight' : ''}`}
                  aria-label={`Done on ${dayName(date)}: ${finishedCount(count).toLowerCase()}`}
                  onClick={() => props.done!.open(date)}
                >
                  <span className="strong">{dayName(date)}</span>
                  <span className="free dnlink">
                    {finishedCount(count)} <Icon name="chevron-right" size={16} />
                  </span>
                </button>
              ) : (
                <div className={`colhead${free < base * TIGHT_SHARE ? ' tight' : ''}`}>
                  <span className="strong">{dayName(date)}</span>
                  <span className="free">{editing || past ? '' : `${formatMinutes(free)} free`}</span>
                </div>
              )}
              <div className="collane" style={{ height: laneH }} data-unscheduled>
                {lane.map((a, i) => {
                  const first = a.from < days[0]! ? days[0]! : a.from;
                  if (first !== date) return null;
                  const span = diffDays(first, a.to > days[6]! ? days[6]! : a.to) + 1;
                  return (
                    <button
                      key={a.id}
                      type="button"
                      className={a.planning ? 'oochip planchip' : a.practice ? 'oochip pracchip' : 'oochip'}
                      style={{ top: laneAt.rows[i]! * LANE_ROW + 2, width: `calc(${span} * 100% + ${(span - 1) * COLUMN_GAP}px)` }}
                      title={a.alt}
                      aria-label={a.alt}
                      aria-expanded={a.open}
                      onPointerDown={a.onPointerDown}
                      onClick={a.onToggle}
                    >
                      {a.title}
                    </button>
                  );
                })}
              </div>
              <div
                className="colbody"
                // Its hour lines, at the hour's drawn height.
                style={{ height: gridH, '--hour': `${hr}px` } as CSSProperties}
                data-drop-date={date}
                // Empty time is the day itself and its closed hours; a block, an event or a suggested time keeps its own press.
                onPointerDown={(e) => holdNew && !drag && empty(e.target) && holdNew.press(e)}
                {...(props.onEmptyMenu && {
                  tabIndex: 0,
                  role: 'group',
                  'aria-label': `${dayName(date)}. Shift-F10 opens its menu.`,
                  onContextMenu: (e: MouseEvent<HTMLElement>) => {
                    if (drag || !empty(e.target)) return;
                    const minute = FROM + ((e.clientY - e.currentTarget.getBoundingClientRect().top) * 60) / hr;
                    if (props.onEmptyMenu!(date, minute, { x: e.clientX, y: e.clientY }, e.currentTarget)) e.preventDefault();
                  },
                  onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
                    if (e.target !== e.currentTarget || !(e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10'))) return;
                    const r = e.currentTarget.getBoundingClientRect();
                    if (props.onEmptyMenu!(date, null, { x: r.left + 8, y: Math.max(0, r.top) + 8 }, e.currentTarget)) e.preventDefault();
                  },
                })}
              >
                {closed.map((z, i) => (
                  <div key={`c${i}`} className="ev ev-closed" style={{ top: z.top, height: z.h }} aria-hidden="true" />
                ))}
                {/* Over closed time but before what's drawn on the day, so it passes behind events and blocks. */}
                {props.now?.date === date && props.now.minutes >= FROM && props.now.minutes <= TO && <NowLine top={y(props.now.minutes)} />}
                {/* Planning is busy too, but its own block is drawn instead, so the gaps between columns stay clear. */}
                {ctx.busy
                  .filter((e) => e.date === date && !blocks.some((b) => b.id === e.id))
                  .map((e, i) => (
                    <div key={`b${i}`} className={`ev ${blockClass('event', 'planned')}`} style={{ top: y(e.start), height: y(e.end) - y(e.start) }}>
                      {e.title || 'Busy'}
                    </div>
                  ))}
                {info
                  .filter((e) => e.date === date)
                  .map((e, i) => (
                    <div key={`i${i}`} className={`ev ${blockClass('info', 'planned')}`} style={{ top: y(e.start), height: y(e.end) - y(e.start) }} title={e.title ?? ''}>
                      {e.title}
                    </div>
                  ))}
                {blocks.map((b) => {
                  const at = drag?.id === b.id ? { ...b, ...drag.slot } : b;
                  if (at.date !== date) return null;
                  const h = y(at.end) - y(at.start);
                  const lane = laneOf.get(b.id);
                  const style = { top: y(at.start), height: Math.max(13, h), ...lane?.style };
                  const when = `${dayName(at.date)}, ${formatTimeOfDay(at.start)} to ${formatTimeOfDay(at.end)}`;
                  const said = `${b.title}, ${when}, ${KIND_WORD[b.kind]}.${b.result ? ` ${OUTCOME_WORD[b.result]}.` : ''}${b.note ? ` ${b.note}.` : ''}${overlapNote(lane?.with ?? [])}`;
                  // The block being placed floats beside what it overlaps, so nothing under it moves or hides.
                  const beside = b.draft && [...blocks.filter((o) => !o.draft), ...ctx.busy].some((o) => o.date === at.date && o.start < at.end && at.start < o.end);
                  // Under two lines tall, the title stays on one line rather than being cut through.
                  // Being placed, or where a card would land (a draft that can't move); otherwise its answer and time.
                  const state = b.draft ? (b.fixed ? 'drop' : 'placing') : blockState({ result: b.result, ended: !!b.ended, now: b.now });
                  const look = blockClass(LOOK[b.kind], state, { short: h < 30 });
                  const cls = b.draft ? `ev evdrag evdraft${beside ? ' beside' : ''} ${look}` : `ev ${look}${b.clash ? ' clash' : ''}`;
                  if (movable(b)) {
                    const help = b.draft
                      ? ' Being placed. Arrow keys move it, Shift and arrows change its length, Enter places it.'
                      : ` Arrow keys move it, Shift and arrows change its length${b.popup ? ', Enter opens it' : ''}.`;
                    return (
                      <div
                        key={b.id}
                        data-id={b.id}
                        className={`${cls}${b.draft ? '' : ' evdrag'}${drag?.id === b.id && drag.held ? ' lifted' : ''}`}
                        tabIndex={0}
                        role="group"
                        aria-label={said + help}
                        title={b.note}
                        style={style}
                        onPointerDown={(e) => startDrag(e, at, 'move')}
                        onKeyDown={(e) => onKey(e, b)}
                      >
                        <BlockMarks state={state} short={h < 30} look={LOOK[b.kind]} />
                        <span className="blktitle">{b.draft ? `${b.title}, ${formatTimeOfDay(at.start)}` : b.title}</span>
                        {h >= EDGE_MIN && <span className="evh" onPointerDown={(e) => startDrag(e, at, 'resize')} />}
                        {!b.draft && props.onRemove && (
                          <button
                            type="button"
                            className="evx"
                            aria-label={`Remove ${b.title}`}
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={() => props.onRemove?.(b.id)}
                          >
                            <Icon name="close" />
                          </button>
                        )}
                      </div>
                    );
                  }
                  if (!editing && props.onOpen) {
                    return (
                      <button
                        key={b.id}
                        type="button"
                        data-id={b.id}
                        className={cls}
                        style={style}
                        aria-label={said}
                        {...(b.popup ? { 'aria-haspopup': 'dialog' as const } : { 'aria-expanded': props.openId === b.id })}
                        title={b.note}
                        onClick={() => props.onOpen?.(b.id)}
                      >
                        <BlockMarks state={state} short={h < 30} look={LOOK[b.kind]} />
                        <OutcomeTag result={b.result} />
                        <span className="blktitle">{b.title}</span>
                      </button>
                    );
                  }
                  return (
                    <div key={b.id} className={cls} style={style} title={said}>
                      <BlockMarks state={state} short={h < 30} look={LOOK[b.kind]} />
                      <OutcomeTag result={b.result} />
                      <span className="blktitle">{b.title}</span>
                    </div>
                  );
                })}
                {held?.date === date && (
                  <div
                    ref={holdNew!.draftRef}
                    className={`ev holddraft ${blockClass('project', 'placing', { short: y(held.end) - y(held.start) < 30 })}${sharedWith(held, blocks, ctx).length ? ' beside' : ''}${holdNew!.draft!.fresh ? ' pop' : ''}`}
                    style={{ top: y(held.start), height: Math.max(13, y(held.end) - y(held.start)) }}
                    title={slotRange(held)}
                    aria-hidden="true"
                  >
                    <span className="blktitle">{`${holdNew!.draft!.name.trim() || 'New task'}, ${formatTimeOfDay(held.start)}`}</span>
                  </div>
                )}
                {ghosts
                  .filter((g) => g.date === date)
                  .map((g) => (
                    <button
                      key={`g${g.start}`}
                      type="button"
                      className={`ev ev-ghost ${blockClass('project', 'suggested')}`}
                      style={{ top: y(g.start), height: y(g.end) - y(g.start) }}
                      aria-label={`Use suggested time, ${g.label}`}
                      onClick={g.onAccept}
                    >
                      Suggested {formatTimeOfDay(g.start)}
                    </button>
                  ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Empty time is a day itself and its closed hours, not a block, an event or a suggested time. */
const empty = (target: EventTarget) => !(target as Element).closest('.ev:not(.ev-closed), button');

/** The blocks and calendar events on a draft's day at its time. */
export const sharedWith = (held: Slot, blocks: readonly GridBlock[], ctx: SlotContext) =>
  [...blocks.filter((b) => !b.draft), ...ctx.busy].filter((o) => o.date === held.date && o.start < held.end && held.start < o.end);

/** Closed hours for project work, merged into runs of half hours. */
function closedZones(date: LocalDate, ctx: SlotContext, y: (m: number) => number) {
  const zones: { top: number; h: number; end: number }[] = [];
  for (let m = FROM; m < TO; m += 30) {
    if (isOpen(ctx.availability, date, m, 'project')) continue;
    const last = zones[zones.length - 1];
    if (last && last.end === m) {
      last.end = m + 30;
      last.h = y(m + 30) - last.top;
    } else zones.push({ top: y(m), h: y(m + 30) - y(m), end: m + 30 });
  }
  return zones;
}

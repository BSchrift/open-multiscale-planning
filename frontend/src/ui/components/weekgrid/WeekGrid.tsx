// The desktop week: seven day columns from 6am to 11pm, with closed hours and calendar events behind the blocks.
// While editing, blocks drag on a 15-minute grid and snap to a suggested time within 20 minutes; the bottom edge
// changes the length. A move or resize is reported once, on drop; let go over To schedule, a block comes off the
// calendar through onUnschedule. Week and the planning Schedule step share it.
//
//   <WeekGrid ctx={slotContext(...)} blocks={blocks} editing onChange={(id, slot) => save(id, slot)} />
//
// Everything here is in local dates and minutes after midnight, as core/slots.ts works.

import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { diffDays, formatDate, formatMinutes, formatTimeOfDay, formatWeekday, instantMs, weekDates } from '../../../core/dates';
import type { BlockRow } from '../../../core/queries';
import { dayBaseAhead, dayFree, dragResult, DRAWN_DAY, isOpen, TIGHT_SHARE } from '../../../core/slots';
import type { Slot, SlotContext, Span } from '../../../core/slots';
import type { LocalDate } from '../../../core/types';
import { KIND_WORD } from '../blocks/describe';
import type { BlockKind } from '../blocks/describe';
import { clearLane, overLane } from './drop';
import './weekgrid.css';

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
}

/** A block already on the week, as Week and the Schedule step show it. */
export interface PlacedBlock extends GridBlock {
  task_id: string | null;
  practice_id: string | null;
  /** Answered, or begun before now: it stays where it is. */
  past: boolean;
  /** Answered or over: it reads as done with. */
  ended: boolean;
}

const KIND: Record<string, BlockKind> = { practice: 'practice', one_off: 'one_off', planning: 'planning' };

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
    };
  });
}

/** 'Mon Nov 2' */
export const dayName = (date: LocalDate) => `${formatWeekday(date)} ${formatDate(date)}`;

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
  /** Time before ctx.earliest is greyed, its blocks stay put, and nothing moves into it. */
  lockPast?: boolean;
  /** A save that resolves to undefined has failed, and the dropped block goes back to where it was saved. */
  onChange?(id: string, slot: Slot): unknown;
  onRemove?(id: string): void;
  /** A block let go over To schedule, which takes it off the calendar. */
  onUnschedule?(id: string): void;
  /** A click on a block, or Enter on it. */
  onOpen?(id: string): void;
  /** The block whose details are open, when not editing. */
  openId?: string | null;
  /** How many things were finished each day up to today: those days' headings say so, and open Done. */
  done?: { finished: Readonly<Record<LocalDate, number>>; open(date: LocalDate): void };
}

const { from: FROM, to: TO } = DRAWN_DAY;
const HOURS = [6, 8, 10, 12, 14, 16, 18, 20, 22];
const KIND_CLASS: Record<BlockKind, string> = { project: 'ev-project', practice: 'ev-practice', one_off: 'ev-maint', planning: 'ev-planning' };
const COLUMN_GAP = 2;
const LANE_ROW = 28;

const same = (a: Slot, b: Slot) => a.date === b.date && a.start === b.start && a.end === b.end;

export function WeekGrid(props: WeekGridProps) {
  const { ctx, blocks, info = [], ghosts = [], lane = [], editing = false, lockPast = false } = props;
  const hr = editing ? 40 : 26;
  const y = (m: number) => ((Math.max(FROM, Math.min(TO, m)) - FROM) * hr) / 60;
  const [drag, setDrag] = useState<{ id: string; slot: Slot } | null>(null);
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

  const days = weekDates(ctx.week);
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
    const [x0, y0] = [event.clientX, event.clientY];
    let last: Slot = b;
    let moved = false;
    const leaving = (e: PointerEvent) => mode === 'move' && !!live.current.onUnschedule && overLane(e.clientX, e.clientY);
    const move = (e: PointerEvent) => {
      if (leaving(e)) return;
      const next = dragResult(b, mode, Math.round((e.clientX - x0) / wide), ((e.clientY - y0) * 60) / hr, mode === 'move' ? targets : []);
      if (same(next, b) && !moved) return;
      moved = true;
      if (isPast(next.date, next.start)) return;
      last = next;
      setDrag({ id: b.id, slot: next });
    };
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      clearLane();
    };
    const cancel = () => {
      stop();
      setDrag(null);
    };
    const up = (e: PointerEvent) => {
      const off = leaving(e);
      stop();
      if (off) {
        setDrag(null);
        live.current.onUnschedule?.(b.id);
      } else if (!moved) live.current.onOpen?.(b.id);
      else if (!same(last, b)) {
        const saved = live.current.onChange?.(b.id, last);
        if (saved instanceof Promise) {
          void saved.then((ok) => ok === undefined && setDrag((d) => (d?.id === b.id && same(d.slot, last) ? null : d)));
        }
      } else setDrag(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
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

  const laneH = lane.length ? lane.length * LANE_ROW + 4 : 0;
  const gridH = (TO - FROM) * (hr / 60);

  return (
    <div className="gridbox">
      <div ref={grid} className="grid" role="group" aria-label="Week calendar">
        <div className="hours" aria-hidden="true" style={{ height: gridH, marginTop: `calc(48px + ${laneH}px)` }}>
          {HOURS.map((h) => (
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
                    {finishedCount(count)} <span aria-hidden="true">›</span>
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
                      className={a.planning ? 'oochip planchip' : 'oochip'}
                      style={{ top: i * LANE_ROW + 2, width: `calc(${span} * 100% + ${(span - 1) * COLUMN_GAP}px)` }}
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
              <div className={`colbody${editing ? ' tall' : ''}`} style={{ height: gridH }} data-drop-date={date}>
                {closed.map((z, i) => (
                  <div key={`c${i}`} className="ev ev-closed" style={{ top: z.top, height: z.h }} aria-hidden="true" />
                ))}
                {ctx.busy
                  .filter((e) => e.date === date)
                  .map((e, i) => (
                    <div key={`b${i}`} className="ev ev-busy" style={{ top: y(e.start), height: y(e.end) - y(e.start) }}>
                      {e.title || 'Busy'}
                    </div>
                  ))}
                {info
                  .filter((e) => e.date === date)
                  .map((e, i) => (
                    <div key={`i${i}`} className="ev ev-info" style={{ top: y(e.start), height: y(e.end) - y(e.start) }} title={e.title ?? ''}>
                      {e.title}
                    </div>
                  ))}
                {blocks.map((b) => {
                  const at = drag?.id === b.id ? { ...b, ...drag.slot } : b;
                  if (at.date !== date) return null;
                  const h = y(at.end) - y(at.start);
                  const style = { top: y(at.start), height: Math.max(13, h) };
                  const when = `${dayName(at.date)}, ${formatTimeOfDay(at.start)} to ${formatTimeOfDay(at.end)}`;
                  const said = `${b.title}, ${when}, ${KIND_WORD[b.kind]}.${b.note ? ` ${b.note}.` : ''}`;
                  // The block being placed floats beside what it overlaps, so nothing under it moves or hides.
                  const beside = b.draft && [...blocks.filter((o) => !o.draft), ...ctx.busy].some((o) => o.date === at.date && o.start < at.end && at.start < o.end);
                  // Under two lines tall, the title stays on one line rather than being cut through.
                  const cls = `${b.draft ? `ev evdrag evdraft${beside ? ' beside' : ''}` : `ev ${KIND_CLASS[b.kind]}${b.clash ? ' clash' : ''}`}${h < 30 ? ' short' : ''}`;
                  if (movable(b)) {
                    const help = b.draft ? ' Being placed. Arrow keys move it, Shift and arrows change its length, Enter places it.' : ' Arrow keys move it, Shift and arrows change its length.';
                    return (
                      <div
                        key={b.id}
                        data-id={b.id}
                        className={b.draft ? cls : `${cls} evdrag`}
                        tabIndex={0}
                        role="group"
                        aria-label={said + help}
                        title={b.note}
                        style={style}
                        onPointerDown={(e) => startDrag(e, at, 'move')}
                        onKeyDown={(e) => onKey(e, b)}
                      >
                        {b.draft ? `${b.title}, ${formatTimeOfDay(at.start)}` : b.title}
                        <span className="evh" onPointerDown={(e) => startDrag(e, at, 'resize')} />
                        {!b.draft && props.onRemove && (
                          <button
                            type="button"
                            className="evx"
                            aria-label={`Remove ${b.title}`}
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={() => props.onRemove?.(b.id)}
                          >
                            ×
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
                        aria-expanded={props.openId === b.id}
                        title={b.note}
                        onClick={() => props.onOpen?.(b.id)}
                      >
                        {b.title}
                      </button>
                    );
                  }
                  return (
                    <div key={b.id} className={cls} style={style} title={said}>
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
                      className="ev ev-ghost"
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

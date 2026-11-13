// The day's timeline: a calendar column that zooms (buttons, or pinching on phone), or a list. Blocks are coloured
// by kind; calendar events are grey stripes. A block that clashes with an event is drawn beside it and says so.
// On the calendar, blocks still to start drag and resize as on Week, held first on phone so a swipe still scrolls, and
// the one under way changes its end.

import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent as ReactPointerEvent, TouchEvent } from 'react';
import { currentBlock, moveBlock } from '../../../core/blocks';
import { formatTime, formatTimeOfDay, instantMs, localDate, localMinutes, weekStart } from '../../../core/dates';
import { applyPlanChange } from '../../../core/plan';
import type { PlanChange } from '../../../core/plan';
import type { BlockRow } from '../../../core/queries';
import type { Writer } from '../../../core/records';
import { dayOffer, dragResult, DRAWN_DAY, GRID, slotContext, slotInstants, slotNotes } from '../../../core/slots';
import type { Slot } from '../../../core/slots';
import type { CalendarEvent } from '../../../core/types';
import { useApp, useMutation, useStickyState } from '../../app/store';
import { BlockDetail, BlockDetailBody } from '../../components/blocks/BlockDetail';
import { describeBlock, formatRange, KIND_WORD, OUTCOME_WORD } from '../../components/blocks/describe';
import type { BlockKind } from '../../components/blocks/describe';
import { outcomeClass, OutcomeTag } from '../../components/blocks/Outcome';
import { useOpenTask } from '../../components/task/TaskName';
import { useToast } from '../../components/Toast';
import { HOLD_MS, SLOP_PX } from '../../components/weekgrid';
import type { TodayData } from './data';

const ZOOM = [30, 48, 72, 96];
const DAY_FROM = 7 * 60;
const DAY_TO = 22 * 60;
const KIND_CLASS: Record<BlockKind, string> = { project: 'project', one_off: 'maint', practice: 'practice', planning: 'planning' };

const same = (a: Slot, b: Slot) => a.start === b.start && a.end === b.end;
const range = (s: Slot) => `${formatTimeOfDay(s.start)} to ${formatTimeOfDay(s.end)}`;

interface Item {
  id: string;
  start: string;
  from: number;
  to: number;
  title: string;
  time: string;
  block?: BlockRow;
  kind?: BlockKind;
  word?: string;
  path?: string;
  note?: string;
  clash?: boolean;
  cur?: boolean;
}

const touchGap = (e: TouchEvent) => Math.hypot(e.touches[0]!.clientX - e.touches[1]!.clientX, e.touches[0]!.clientY - e.touches[1]!.clientY);

function ZoomIcon(props: { plus?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="M15.5 15.5L21 21" />
      <path d="M8 10.5h5" />
      {props.plus && <path d="M10.5 8v5" />}
    </svg>
  );
}

export function DayTimeline(props: { data: TodayData; events: readonly CalendarEvent[] }) {
  const { data, events } = props;
  const { clock, layout } = useApp();
  const zone = clock.zone();
  const phone = layout === 'phone';
  const [view, setView] = useStickyState<'calendar' | 'list'>('today.view', 'calendar');
  const [ph, setPh] = useState(ZOOM[0]!);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const pinch = useRef<{ gap: number; ph: number } | null>(null);
  const toggle = (id: string) => setOpen((s) => (s.has(id) ? new Set([...s].filter((x) => x !== id)) : phone || view === 'calendar' ? new Set([id]) : new Set(s).add(id)));
  const toast = useToast();
  const openTask = useOpenTask();
  const { run } = useMutation((w, fn: (w: Writer) => Promise<PlanChange>) => fn(w));
  const helpId = useId();
  // Where a block being dragged, or just dropped, is drawn, and the suggested time it snaps to.
  const [drag, setDrag] = useState<{ id: string; slot: Slot; ghost: Slot | null } | null>(null);
  const droppedAt = useRef(0);
  const steps = useRef<{ id: string; at: Slot; reverse: PlanChange } | null>(null);
  // Arrow steps save one after another, each from where the last one put the block, since the day can redraw from a
  // step's save while the next is still saving and show the block a step behind.
  const stepping = useRef(Promise.resolve());
  // A dropped block stays where it landed until the saved position comes back.
  const positions = data.blocks.map((b) => `${b.id} ${b.start} ${b.end}`).join();
  useEffect(() => setDrag(null), [positions]);

  // Minutes after today's midnight, kept within the day, so an event over midnight still draws.
  const minutesOf = (at: string, edge: number) => (localDate(at, zone) === data.date ? localMinutes(at, zone) : edge);
  const cur = currentBlock(data.blocks, clock);
  const records = {
    tasks: new Map(data.tasks.map((t) => [t.id, t])),
    projects: new Map(data.projects.map((p) => [p.id, p])),
    objectives: new Map(data.objectives.map((o) => [o.id, o])),
    practices: new Map(data.practices.map((p) => [p.id, p])),
  };
  // Answered, stopped or over, as Week has it: drawn muted, with how it went.
  const ended = (b: BlockRow) => !!b.result || !!b.ended_at || instantMs(b.end) <= clock.now();
  const clashOf = (b: BlockRow) =>
    !b.result && instantMs(b.end) > clock.now() ? events.find((e) => instantMs(e.start) < instantMs(b.end) && instantMs(b.start) < instantMs(e.end)) : undefined;

  const items: Item[] = [
    ...events.map((e): Item => ({ id: `event:${e.id}`, start: e.start, from: minutesOf(e.start, 0), to: minutesOf(e.end, 1440), title: e.title, time: formatRange(e.start, e.end, zone) })),
    ...data.blocks.map((b): Item => {
      const task = records.tasks.get(b.task_id ?? '');
      const practice = records.practices.get(b.practice_id ?? '');
      const project = records.projects.get(task?.project_id ?? '');
      const objective = records.objectives.get(practice?.objective_id ?? project?.objective_id ?? '');
      const info = describeBlock(b, { task, practice, project, objective });
      const clash = clashOf(b);
      const isCur = b.id === cur?.id;
      const at = drag?.id === b.id ? drag.slot : null;
      return {
        id: b.id,
        start: b.start,
        from: at ? at.start : minutesOf(b.start, 0),
        to: at ? at.end : minutesOf(b.end, 1440),
        title: b.title ?? 'Time block',
        time: at ? range(at) : formatRange(b.start, b.end, zone),
        block: b,
        kind: info.kind,
        word: info.word,
        path: info.path,
        clash: !!clash,
        cur: isCur,
        note: b.result ? OUTCOME_WORD[b.result] : clash ? `Conflicts with ${clash.title}` : isCur ? 'Now' : '',
      };
    }),
  ].sort((a, b) => a.from - b.from || (a.block ? 1 : -1));

  const from = Math.min(DAY_FROM, ...items.map((i) => Math.floor(i.from / 60) * 60));
  const to = Math.max(DAY_TO, ...items.map((i) => Math.ceil(i.to / 60) * 60));
  const y = (m: number) => ((m - from) * ph) / 60;
  const nowMin = localMinutes(clock.now(), zone);
  const hours: number[] = [];
  for (let h = from / 60; h < to / 60; h += ph < 48 ? 2 : 1) hours.push(h);
  const alt = (i: Item) => `${i.title}, ${i.time}, ${KIND_WORD[i.kind!]}.${i.note ? ` ${i.note}.` : ''}`;
  const overlaps = (i: Item) => items.some((o) => o !== i && !o.block !== !i.block && o.from < i.to && i.from < o.to);
  const detailOf = items.find((i) => i.block && open.has(i.id) && (phone || view === 'calendar'));

  // Week's rules: an answered block stays put, one under way keeps its start, and nothing moves into time gone by.
  // shortcut: a block not drawn whole, running past midnight, stays put; until the timeline draws the next day too.
  const whole = (b: BlockRow) => instantMs(b.end) - instantMs(b.start) === (minutesOf(b.end, 1440) - minutesOf(b.start, 0)) * 60_000;
  const resizable = (b: BlockRow) => !b.result && !b.ended_at && instantMs(b.end) > clock.now() && whole(b);
  const movable = (b: BlockRow) => resizable(b) && instantMs(b.start) >= clock.now();
  const ctx = slotContext({ week: weekStart(data.date), availability: data.settings.availability, avoided: data.settings.avoided_slots, sources: data.sources, calendar: data.calendar, blocks: data.blocks, clock });
  const floor = Math.max(DRAWN_DAY.from, Math.ceil(nowMin / GRID) * GRID);
  const bounds = (s: Slot) => ({ from: floor, to: Math.max(DRAWN_DAY.to, s.end) });
  const slotOf = (i: Item): Slot => ({ date: data.date, start: i.from, end: i.to });
  const workOf = (i: Item) => ({ kind: i.kind === 'one_off' ? ('one_off' as const) : ('project' as const) });

  const save = async (i: Item, from: Slot, to: Slot, key = false) => {
    const reverse = await run((w) => moveBlock(w, i.id, slotInstants(to, zone)));
    if (!reverse) return setDrag(null);
    // Arrow steps in a row are one change, so Undo takes the block back to before the first.
    const prev = steps.current;
    const first = key && prev?.id === i.id && same(prev.at, from) ? prev.reverse : reverse;
    steps.current = key ? { id: i.id, at: to, reverse: first } : null;
    const notes = slotNotes({ ...to, id: i.id }, workOf(i), ctx);
    toast.show([`${i.title} is now ${range(to)}.`, ...notes].join(' '), { undo: () => run((w) => applyPlanChange(w, first)) });
  };

  const press = (i: Item, mode: 'move' | 'resize') => (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const slot = slotOf(i);
    const len = slot.end - slot.start;
    const start = mode === 'move' ? dayOffer(data.date, len, workOf(i), { ...ctx, placed: ctx.placed.filter((s) => s.id !== i.id) }) : null;
    const ghost = start === null ? null : { date: data.date, start, end: start + len };
    const [x0, y0, perPx] = [e.clientX, e.clientY, 60 / ph];
    let lifted = !phone;
    let moved = false;
    let last = slot;
    const hold = (ev: Event) => {
      if (lifted) ev.preventDefault();
    };
    const on: Record<string, (ev: Event) => void> = {
      pointermove: (ev) => {
        const m = ev as PointerEvent;
        if (!lifted) {
          if (Math.abs(m.clientX - x0) > SLOP_PX || Math.abs(m.clientY - y0) > SLOP_PX) stop();
          return;
        }
        last = dragResult(slot, mode, 0, (m.clientY - y0) * perPx, ghost ? [ghost] : [], bounds(slot));
        moved ||= !same(last, slot);
        if (moved) setDrag({ id: i.id, slot: last, ghost });
      },
      pointerup: () => {
        stop();
        // A click, or a tap let go before the hold: it opens the block as before.
        if (!lifted || (!phone && !moved)) return;
        droppedAt.current = Date.now();
        if (same(last, slot)) return setDrag(null);
        setDrag({ id: i.id, slot: last, ghost: null });
        void save(i, slot, last);
      },
      pointercancel: () => {
        stop();
        setDrag(null);
      },
      // While held, the page stays still and the long-press menu stays away.
      touchmove: hold,
      contextmenu: hold,
    };
    const stop = () => {
      clearTimeout(timer);
      for (const [k, f] of Object.entries(on)) window.removeEventListener(k, f);
    };
    for (const [k, f] of Object.entries(on)) window.addEventListener(k, f, k === 'touchmove' ? { passive: false } : undefined);
    const timer = phone
      ? setTimeout(() => {
          lifted = true;
          setDrag({ id: i.id, slot, ghost });
        }, HOLD_MS)
      : undefined;
  };

  const step = (i: Item, move: boolean) => (e: KeyboardEvent) => {
    // On phone that's a slider, with no click of its own for a keyboard, so Enter opens it as a tap does.
    if (e.key === 'Enter' && phone && move) return toggle(i.id);
    const delta = ({ ArrowUp: -GRID, ArrowDown: GRID } as Record<string, number>)[e.key];
    if (!delta || !(move || e.shiftKey)) return;
    e.preventDefault();
    const mode = e.shiftKey ? 'resize' : 'move';
    stepping.current = stepping.current.then(async () => {
      const last = steps.current;
      const from = last?.id === i.id ? last.at : slotOf(i);
      const next = dragResult(from, mode, 0, delta, [], bounds(from));
      if (same(next, from)) return;
      setDrag({ id: i.id, slot: next, ghost: null });
      await save(i, from, next, true);
    });
  };

  const calendar = (
    <div
      className="daywrap"
      onTouchStart={(e) => {
        if (e.touches.length === 2) pinch.current = { gap: touchGap(e), ph };
      }}
      onTouchMove={(e) => {
        if (pinch.current && e.touches.length === 2) setPh(Math.max(ZOOM[0]!, Math.min(ZOOM[ZOOM.length - 1]!, Math.round((pinch.current.ph * touchGap(e)) / pinch.current.gap))));
      }}
      onTouchEnd={() => {
        pinch.current = null;
      }}
    >
      {/* No arrow keys on phone, where VoiceOver's swipes move a block as a slider. */}
      <span id={helpId} hidden>
        {phone
          ? 'Hold it, then drag to move it, or hold its handle and drag to change its length.'
          : 'Drag to move it, or drag its bottom edge to change its length. Up and down arrow keys move it, and Shift and arrows change its length.'}
      </span>
      <span id={`${helpId}-end`} hidden>
        {phone ? 'Hold its handle and drag to change its length.' : 'Drag its bottom edge, or use Shift and the up and down arrow keys, to change its length.'}
      </span>
      <div
        className="day"
        style={{ height: y(to), background: `repeating-linear-gradient(to bottom, var(--line-soft) 0, var(--line-soft) 1px, var(--white) 1px, var(--white) ${ph}px)` }}
        data-drop-date={data.date}
        data-drop-from={from}
        data-drop-to={to}
      >
        <div className="zoomwrap">
          <div className="zoomgroup" role="group" aria-label="Calendar zoom">
            <button className="zoombtn" type="button" aria-label="Zoom out" title="Zoom out" disabled={ph <= ZOOM[0]!} onClick={() => setPh([...ZOOM].reverse().find((z) => z < ph) ?? ph)}>
              <ZoomIcon />
            </button>
            <button className="zoombtn" type="button" aria-label="Zoom in" title="Zoom in" disabled={ph >= ZOOM[ZOOM.length - 1]!} onClick={() => setPh(ZOOM.find((z) => z > ph) ?? ph)}>
              <ZoomIcon plus />
            </button>
          </div>
        </div>
        {hours.map((h) => (
          <span key={h} className="dayhr" style={{ top: y(h * 60) }} aria-hidden="true">
            {formatTimeOfDay(h * 60)}
          </span>
        ))}
        {items.map((i) => {
          const height = Math.max(13, y(i.to) - y(i.from) - 1);
          const compact = height < 24 ? ' compact' : '';
          const apart = overlaps(i);
          const style = { top: y(i.from), height, left: apart && !i.block ? '62%' : '4px', right: apart && i.block ? '40%' : '4px' };
          const time = !phone && height >= 24 && <span className="time">{i.time}</span>;
          if (!i.block) {
            return (
              <div key={i.id} className={`cev ${phone ? 'c-busy' : 'ev-busy'}${compact}`} title={i.time} style={style}>
                <span>{i.title}</span>
                {time}
              </div>
            );
          }
          const cls = phone
            ? `c-${KIND_CLASS[i.kind!]}${i.cur ? ' c-cur' : ''}${ended(i.block) ? ' c-ended' : ''}${outcomeClass(i.block.result)}`
            : `ev-${KIND_CLASS[i.kind!]}${i.cur ? ' cur' : ''}${ended(i.block) ? ' ended' : ''}${outcomeClass(i.block.result)}`;
          const move = movable(i.block);
          const resize = resizable(i.block);
          const lifted = drag?.id === i.id;
          // On phone a block that moves is a slider, as on Week, so VoiceOver's swipe up and down move it.
          const slider = phone && move;
          const Tag = slider ? 'div' : 'button';
          const last = bounds(slotOf(i)).to;
          return (
            <Tag
              key={i.id}
              className={`cev ${cls}${compact}${phone ? (resize ? ' tlhold' : '') : move ? ' evdrag' : ''}${lifted ? ' lifted' : ''}`}
              {...(slider
                ? {
                    role: 'slider',
                    tabIndex: 0,
                    // The value is the time left in the day after its start, so Up raises it and moves the block up.
                    'aria-orientation': 'vertical' as const,
                    'aria-valuemin': i.to - i.from,
                    'aria-valuemax': last - floor,
                    'aria-valuenow': last - i.from,
                    'aria-valuetext': range(slotOf(i)),
                  }
                : { type: 'button' as const, 'aria-expanded': open.has(i.id) })}
              title={i.time}
              style={style}
              aria-label={alt(i)}
              aria-describedby={move ? helpId : resize ? `${helpId}-end` : undefined}
              // The release after a drag also clicks the block; that click shouldn't open it.
              onClick={() => Date.now() - droppedAt.current >= HOLD_MS && toggle(i.id)}
              onPointerDown={move ? press(i, 'move') : undefined}
              onKeyDown={resize ? step(i, move) : undefined}
              // Steps in a row undo together; once focus leaves, the next is a change of its own.
              onBlur={() => (steps.current = null)}
            >
              <span className="cevt">
                <OutcomeTag result={i.block.result} />
                {phone && lifted ? `${i.time}, ${i.title}` : i.title}
              </span>
              {time}
              {resize && !phone && <span className="evh" aria-hidden="true" onPointerDown={press(i, 'resize')} />}
              {resize && phone && !compact && (
                <span className="rz" aria-hidden="true" onPointerDown={press(i, 'resize')}>
                  <i />
                </span>
              )}
            </Tag>
          );
        })}
        {drag?.ghost && (
          <div className={`cev ${phone ? 'ghost' : 'ev-ghost'}`} style={{ top: y(drag.ghost.start), height: y(drag.ghost.end) - y(drag.ghost.start), left: '4px', right: '4px' }} aria-hidden="true">
            Suggested {formatTimeOfDay(drag.ghost.start)}
          </div>
        )}
        {nowMin >= from && nowMin <= to && (
          <div className="nowline" style={{ top: y(nowMin) }} role="img" aria-label="Current time">
            <i />
          </div>
        )}
      </div>
    </div>
  );

  const list = items.map((i) => {
    if (!i.block) {
      return phone ? (
        <div key={i.id} className="tl">
          <span className="small quiet">{formatTime(i.start, zone)}</span>
          <span className="quiet">{i.title}</span>
        </div>
      ) : (
        <div key={i.id} className="tlrow">
          <div className="tlbusy">
            <span className="small">{i.time}</span>
            <span>{i.title}</span>
          </div>
        </div>
      );
    }
    const titleCls = i.block.result === 'done' ? 'done' : i.cur ? 'strong' : undefined;
    // Partly and Not done are said as on the calendar; Done is struck through.
    const note = i.block.result === 'partly' || i.block.result === 'not' ? <OutcomeTag result={i.block.result} /> : i.note;
    if (phone) {
      return (
        <button key={i.id} className={`tl tlbtn${i.cur ? ' cur' : ''}`} type="button" aria-label={alt(i)} onClick={() => toggle(i.id)}>
          <span className="small quiet">{formatTime(i.start, zone)}</span>
          <span className="tlwhat">
            <span className={titleCls}>{i.title}</span>
            <span className="small quiet">
              {i.kind === 'project' ? 'Project' : i.word}
              {i.note && <>, {note}</>}
            </span>
          </span>
        </button>
      );
    }
    const label = i.kind === 'project' ? (i.path ?? '').split(' > ')[0] : i.word;
    return (
      <div key={i.id} className={`tlrow${i.cur ? ' tlcur' : ''}`}>
        <button className="tlbtn" type="button" aria-expanded={open.has(i.id)} onClick={() => toggle(i.id)}>
          <span className="small quiet">{i.time}</span>
          <span className="tlwhat">
            <span className={titleCls}>{i.title}</span>
            <span className="small quiet">{label}</span>
          </span>
          <span className="small quiet">{note}</span>
        </button>
        {open.has(i.id) && (
          <div className="tldet stack8 small">
            <BlockDetailBody block={i.block} />
            {i.block.task_id && (
              <div>
                <button className="link small" type="button" aria-label={`Open ${i.title}`} onClick={() => openTask(i.block!.task_id!)}>
                  Open task
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    );
  });

  return (
    <div className={phone ? 'card' : 'tl card'} role="region" aria-label="Today's timeline">
      <div className="between tlhead">
        <h3>Timeline</h3>
        <div className="row" role="group" aria-label="Timeline view">
          {(['calendar', 'list'] as const).map((v) => (
            <button key={v} className={`dchip${view === v ? ' on' : ''}`} type="button" aria-pressed={view === v} onClick={() => setView(v)}>
              {v === 'calendar' ? 'Calendar' : 'List'}
            </button>
          ))}
        </div>
      </div>
      {view === 'calendar' ? calendar : <div className="tllist">{list}</div>}
      {detailOf?.block && <BlockDetail key={detailOf.id} block={detailOf.block} onClose={() => toggle(detailOf.id)} />}
    </div>
  );
}

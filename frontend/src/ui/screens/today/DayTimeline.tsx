// The day's timeline: a calendar column that zooms (buttons, or pinching on phone), or a list. Blocks are coloured
// by kind; calendar events are grey stripes. A block that clashes with an event is drawn beside it and says so, and
// blocks at the same time sit side by side.
// On the calendar, blocks still to start drag and resize as on Week, once held, so a click stays a click and a swipe
// still scrolls, and the one under way changes its end. A click or tap on a block, on the calendar or the list, opens
// its popup with the block's own section at its top: its task's, or its practice's or planning's (BlockPopup). A press
// held on empty time drafts an hour there and opens Capture on it.
// A task's block or a practice's session also has a quick menu of what can be done to it now, the popup's own actions:
// a right-click, or Shift-F10 or the menu key on desktop, and on phone a hold let go without moving. The Mac app has
// macOS draw it.

import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent as ReactPointerEvent, TouchEvent } from 'react';
import { currentBlock, isPaused, nextBlock } from '../../../core/blocks';
import { formatTime, formatTimeOfDay, instantMs, localDate, localMinutes, weekStart } from '../../../core/dates';
import { applyPlanChange } from '../../../core/plan';
import type { PlanChange } from '../../../core/plan';
import type { BlockRow } from '../../../core/queries';
import type { Writer } from '../../../core/records';
import { dayOffer, dragResult, DRAWN_DAY, GRID, slotContext, slotNotes } from '../../../core/slots';
import type { Slot } from '../../../core/slots';
import type { CalendarEvent } from '../../../core/types';
import { useNav } from '../../app/nav';
import { requestPrompt } from '../../app/reminders';
import { requestShowBlock, useShowBlockRequest } from '../../app/showBlock';
import { useApp, useMutation, useStickyState } from '../../app/store';
import { popFor } from '../../components/blocks/BlockName';
import type { PopFor } from '../../components/blocks/BlockName';
import { BlockSection } from '../../components/blocks/BlockSection';
import { WORDS } from '../../components/blocks/MissedSheet';
import { stageOf, useBlockCommands } from '../../components/blocks/useBlockCommands';
import { describeBlock, formatRange, isTaskBlock, KIND_WORD, OUTCOME_WORD } from '../../components/blocks/describe';
import type { BlockKind } from '../../components/blocks/describe';
import { OutcomeTag } from '../../components/blocks/Outcome';
import { blockClass, BlockMarks, blockState, LOOK } from '../../components/ds/Block';
import { shortened, SplitAsk } from '../../components/editors/SplitAsk';
import type { Shortened } from '../../components/editors/SplitAsk';
import { Menu, nativeMenu } from '../../components/Menu';
import type { MenuChoice, MenuEntry } from '../../components/Menu';
import { useToast } from '../../components/Toast';
import { NowLine } from '../../components/NowLine';
import { columnStyle, holdToDrag, MORE_INSET, MORE_PX, overlapGroups, overlapNote, overlapsText, shownColumns, useWidth } from '../../components/weekgrid';
import { MoreButton } from '../../components/weekgrid/MoreButton';
import { DraftBlock, HoldRing, overlapWords, SECOND_LINE, useHoldToCreate } from '../../components/weekgrid/holdCreate';
import { DraftCapture } from '../capture/DraftCapture';
import { BlockPopup } from '../practice';
import { DeleteTask } from '../task';
import type { TodayData } from './data';
import { ZoomButtons } from '../../components/CalendarZoom';
import { clampZoom, hourHeight, hourLabelStep, ZOOM } from '../../components/zoom';
import { Segmented } from '../../components/ds/Controls';

/** An hour's height at the first zoom. */
const HOUR_PX = 30;
/** Where a block's menu opens: on phone, this far below the block held; from the keys, this far in from its left. */
const MENU_GAP = 8;
const MENU_INSET = 24;
const DAY_FROM = 7 * 60;
const DAY_TO = 22 * 60;

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

export function DayTimeline(props: { data: TodayData; events: readonly CalendarEvent[] }) {
  const { data, events } = props;
  const { clock, layout, platform } = useApp();
  const zone = clock.zone();
  const phone = layout === 'phone';
  const [view, setView] = useStickyState<'calendar' | 'list'>('today.view', 'calendar');
  const [zoom, setZoom] = useState(ZOOM[0]!);
  const ph = hourHeight(HOUR_PX, zoom);
  const pinch = useRef<{ gap: number; ph: number } | null>(null);
  const toast = useToast();
  // Its ask, when a drag or Move to lands a block on another: keep both, replace it, or leave it.
  const actions = useBlockCommands();
  const nav = useNav();
  /** A block opened in its popup. */
  const [pop, setPop] = useState<PopFor | null>(null);
  /** A block's quick menu, open at a point, and what had focus when it opened, to give it back. */
  const [menu, setMenu] = useState<{ id: string; at: { x: number; y: number }; from: HTMLElement } | null>(null);
  /** Delete task from a block's menu, asking first. */
  const [deleting, setDeleting] = useState<{ id: string; title: string } | null>(null);
  // A task's block made shorter asks what about the rest, under the timeline, until answered.
  const [split, setSplit] = useState<Shortened | null>(null);
  const { run } = useMutation((w, fn: (w: Writer) => Promise<PlanChange>) => fn(w));
  const helpId = useId();
  // Where a block being dragged, or just dropped, is drawn, and the suggested time it snaps to.
  // held: still under the pointer, drawn lifted; one let go is put down where it landed while it saves.
  const [drag, setDrag] = useState<{ id: string; slot: Slot; ghost: Slot | null; held?: boolean } | null>(null);
  const steps = useRef<{ id: string; at: Slot; reverse: PlanChange } | null>(null);
  // Arrow steps save one after another, each from where the last one put the block, since the day can redraw from a
  // step's save while the next is still saving and show the block a step behind.
  const stepping = useRef(Promise.resolve());
  // A dropped block stays where it landed until the saved position comes back.
  const positions = data.blocks.map((b) => `${b.id} ${b.start} ${b.end}`).join();
  useEffect(() => setDrag(null), [positions]);
  // A widget's link to a block: once it's drawn, it comes into view with focus on it.
  const show = useShowBlockRequest();
  useEffect(() => {
    if (!show) return;
    const el = document.querySelector<HTMLElement>(`[data-block="${show}"]`);
    if (!el) return;
    el.scrollIntoView?.({ block: 'center' });
    el.focus({ preventScroll: true });
    requestShowBlock(null);
  }, [show, positions]);
  // A hold on empty time drafts an hour there, and a mouse dragged on it draws one, never while a block is open, moving
  // or just dropped. Its day and minutes come from the drawn day, which grows to fit the draft.
  const holdNew = useHoldToCreate({
    at: (_x, py) => ({ date: data.date, minute: from + (py / ph) * 60 }),
    move: (s, _dx, dy) => dragResult(s, 'move', 0, (dy * 60) / ph, [], { from: floor, to: DRAWN_DAY.to }),
    earliest: { date: data.date, minutes: localMinutes(clock.now(), zone) },
    off: !!drag || !!pop,
    draws: true,
  });
  const held = holdNew.draft?.slot;

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

  const blockItems = data.blocks.map((b): Item => {
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
  });
  // Blocks at the same time sit side by side, laid out where they're saved, so one being dragged keeps its column.
  const lanes = overlapGroups(blockItems.map((i) => ({ id: i.id, title: i.title, kind: i.kind!, start: minutesOf(i.block!.start, 0), end: minutesOf(i.block!.end, 1440) })));
  const laneOf = new Map(lanes.flatMap((group) => group.items.map((c) => [c.item.id, { col: c.col, with: c.with, group }] as const)));
  // By start, an event before a block, and blocks at the same time by column: the order they're read in.
  const items: Item[] = [
    ...events.map((e): Item => ({ id: `event:${e.id}`, start: e.start, from: minutesOf(e.start, 0), to: minutesOf(e.end, 1440), title: e.title, time: formatRange(e.start, e.end, zone) })),
    ...blockItems,
  ].sort((a, b) => a.from - b.from || (a.block ? 1 : 0) - (b.block ? 1 : 0) || (laneOf.get(a.id)?.col ?? 0) - (laneOf.get(b.id)?.col ?? 0));

  const drawn = held ? [...items, { from: held.start, to: held.end }] : items;
  const from = Math.min(DAY_FROM, ...drawn.map((i) => Math.floor(i.from / 60) * 60));
  const to = Math.max(DAY_TO, ...drawn.map((i) => Math.ceil(i.to / 60) * 60));
  const y = (m: number) => ((m - from) * ph) / 60;
  const nowMin = localMinutes(clock.now(), zone);
  const hours: number[] = [];
  for (let h = from / 60; h < to / 60; h += hourLabelStep(ph)) hours.push(h);
  const others = (i: Item) => laneOf.get(i.id)?.with ?? [];
  const alt = (i: Item) => `${i.title}, ${i.time}, ${KIND_WORD[i.kind!]}.${i.note ? ` ${i.note}.` : ''}${overlapNote(others(i))}`;
  const overlaps = (i: Item) => items.some((o) => o !== i && !o.block !== !i.block && o.from < i.to && i.from < o.to);
  // Each group of blocks at the same time shares the room left of any event one of them overlaps, in as many columns
  // as stay readable there, then +N more.
  const [measure, width] = useWidth<HTMLDivElement>();
  const shapes = new Map(
    lanes
      .filter((group) => group.cols > 1)
      .map((group) => {
        const clash = group.items.some((c) => overlaps(blockItems.find((i) => i.id === c.item.id)!));
        const room = width && (clash ? width * 0.6 : width - 4) - 4;
        return [group, { right: clash ? '40%' : '4px', shown: shownColumns(group.cols, room, MORE_PX) }] as const;
      }),
  );
  // A block opens its popup, as its task or practice does anywhere else, with the block's section at its top.
  const openItem = (i: Item) => {
    if (i.block) setPop(popFor(i.block));
  };
  const popBlock = pop && data.blocks.find((b) => b.id === pop.block);
  // One not yet started can come off the calendar, as Have you started's Skip takes it.
  const removable = (b: BlockRow) => !b.started_at && !b.result && !b.ended_at && instantMs(b.end) > clock.now();
  const opens = { 'aria-haspopup': 'dialog' as const };

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
    const off = await actions.landing(i, data.blocks, from, to);
    if (!off) {
      steps.current = null;
      return setDrag(null);
    }
    const reverse = await actions.moveOver(i.id, to, off);
    if (!reverse) return setDrag(null);
    // Arrow steps in a row are one change, so Undo takes the block back to before the first.
    const prev = steps.current;
    const first = key && prev?.id === i.id && same(prev.at, from) ? prev.reverse : reverse;
    steps.current = key ? { id: i.id, at: to, reverse: first } : null;
    const notes = slotNotes({ ...to, id: i.id }, workOf(i), ctx);
    // Undo can put the block back where the day last drew it, before it drew the steps, which wouldn't redraw it.
    const undo = () => {
      setDrag(null);
      return run((w) => applyPlanChange(w, first));
    };
    toast.show([`${i.title} is now ${range(to)}.`, ...actions.tookOff(off), ...notes].join(' '), { undo });
    const b = { id: i.id, task_id: i.block?.task_id ?? null, start: from.start, end: from.end };
    setSplit(shortened(b, to, { task: !!i.kind && isTaskBlock(i.kind), underWay: !!i.cur, week: weekStart(data.date), title: i.title, open: split }));
  };

  const press = (i: Item, mode: 'move' | 'resize') => (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    const slot = slotOf(i);
    const len = slot.end - slot.start;
    const start = mode === 'move' ? dayOffer(data.date, len, workOf(i), { ...ctx, placed: ctx.placed.filter((s) => s.id !== i.id) }) : null;
    const ghost = start === null ? null : { date: data.date, start, end: start + len };
    const perPx = 60 / ph;
    let last = slot;
    // A click, or a tap let go without dragging, opens the block by its own click.
    holdToDrag(e, {
      lift: () => setDrag({ id: i.id, slot, ghost, held: true }),
      drag: (_dx, dy) => {
        last = dragResult(slot, mode, 0, dy * perPx, ghost ? [ghost] : [], bounds(slot));
        setDrag({ id: i.id, slot: last, ghost, held: true });
      },
      drop: () => {
        if (same(last, slot)) return setDrag(null);
        setDrag({ id: i.id, slot: last, ghost: null });
        void save(i, slot, last);
      },
      cancel: () => setDrag(null),
      ...(phone && mode === 'move' ? { held: () => void openMenu(i, below(el), el) } : {}),
      ...(platform.haptic ? { haptic: platform.haptic } : {}),
    });
  };
  // On phone a block that doesn't move still lifts when held, so letting go opens its menu as on one that does.
  const hold = (i: Item) => (e: ReactPointerEvent) => {
    const el = e.currentTarget as HTMLElement;
    holdToDrag(e, {
      lift: () => setDrag({ id: i.id, slot: slotOf(i), ghost: null, held: true }),
      drag: () => undefined,
      drop: () => setDrag(null),
      cancel: () => setDrag(null),
      held: () => void openMenu(i, below(el), el),
      ...(platform.haptic ? { haptic: platform.haptic } : {}),
    });
  };

  const step = (i: Item, move: boolean) => (e: KeyboardEvent) => {
    // On phone that's a slider, with no click of its own for a keyboard, so Enter and Space open it as a tap does.
    if ((e.key === 'Enter' || e.key === ' ') && phone && move) {
      e.preventDefault();
      return openItem(i);
    }
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

  // The popup's Move… choices, so both move it alike; Choose a time opens Week ready to edit.
  const moveTo = (b: BlockRow): MenuChoice[] => {
    const entries = actions.moveChoices(b, ctx);
    return entries.length ? [{ id: 'move', label: 'Move to', icon: 'calendar', submenu: entries }] : [];
  };
  const chooseOnWeek = () => nav.go('week', { edit: 'this' });
  // What can be done to a block where it is in its day: the popup's own actions, with "Did it" and "Skip this session"
  // for a practice. None for a planning block, which has its own flow, nor for another calendar's event.
  const menuOf = (i: Item): MenuEntry[] | null => {
    const b = i.block;
    const practice = i.kind === 'practice';
    if (!b || !i.kind || (!isTaskBlock(i.kind) && !practice)) return null;
    const words = WORDS[practice ? 'practice' : 'task'];
    const done: MenuChoice = { id: 'done', label: words.done, icon: 'done', tone: 'ok' };
    const open: MenuChoice = { id: 'open', label: 'Open', icon: 'notes' };
    const remove: MenuChoice[] = !removable(b) ? [] : [practice ? { id: 'remove', label: 'Skip this session', icon: 'bin', tone: 'danger' } : { id: 'remove', label: 'Remove from calendar', icon: 'close' }];
    const del: MenuChoice[] = practice ? [] : [{ id: 'delete', label: 'Delete task…', icon: 'bin', tone: 'danger' }];
    const after = (rest: MenuChoice[]): MenuEntry[] => (rest.length ? ['separator', ...rest] : []);
    switch (stageOf(b, clock.now())) {
      case 'later':
        return [done, { id: 'start', label: 'Start now', icon: 'clock' }, ...moveTo(b), open, ...after([...remove, ...del])];
      case 'now': {
        const timer: MenuChoice = !b.started_at ? { id: 'start', label: 'Start', icon: 'clock' } : isPaused(b) ? { id: 'resume', label: 'Resume', icon: 'clock' } : { id: 'pause', label: 'Pause', icon: 'clock' };
        return [done, timer, ...moveTo(b), open, ...after([...remove, ...del])];
      }
      case 'gone':
        return [done, { id: 'partly', label: `${words.partly}…`, icon: 'partly' }, { id: 'not', label: words.not, icon: 'not-done' }, ...after([open, ...del])];
      case 'answered':
        return [open, ...after(del)];
    }
  };
  const act = (i: Item, id: string) => {
    const b = i.block!;
    if (id.startsWith('move:')) return void actions.moveTo(b, id, ctx, chooseOnWeek);
    switch (id) {
      case 'done':
        return void actions.done(b, nextBlock(data.blocks.filter((x) => x.id !== b.id), clock));
      case 'start':
        return void actions.startNow(b);
      case 'pause':
        return void actions.pause(b);
      case 'resume':
        return void actions.resume(b);
      // Partly asks how much is left, or for a practice how much was done, as the end of a block does.
      case 'partly':
        return requestPrompt(b.id);
      case 'not':
        return void actions.answer(b, 'not');
      case 'open':
        return openItem(i);
      case 'remove':
        return void actions.skip(b);
      case 'delete':
        return setDeleting({ id: b.task_id!, title: records.tasks.get(b.task_id!)?.title ?? i.title });
    }
  };
  const below = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.bottom + MENU_GAP };
  };
  /** Opens a block's menu, the Mac app's own or the page's, and says whether it has one. */
  const openMenu = (i: Item, at: { x: number; y: number }, from: HTMLElement) => {
    const entries = menuOf(i);
    if (!entries) return false;
    if (platform.showMenu) void platform.showMenu(nativeMenu(entries)).then((id) => id && act(i, id));
    else setMenu({ id: i.id, at, from });
    return true;
  };
  const closeMenu = () => {
    menu?.from.focus({ preventScroll: true });
    setMenu(null);
  };
  const menuItem = menu && items.find((i) => i.id === menu.id);
  const menuKeys = (i: Item) => (e: KeyboardEvent) => {
    if (!phone && (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10'))) {
      const r = e.currentTarget.getBoundingClientRect();
      if (openMenu(i, { x: r.left + MENU_INSET, y: r.bottom }, e.currentTarget as HTMLElement)) e.preventDefault();
      return;
    }
    if (resizable(i.block!)) step(i, movable(i.block!))(e);
  };

  // What a block says it does: one still to come moves, and the one under way only changes its end. A short block has
  // no edge or handle to drag, since on desktop it would take most of the block, and a press there would change the
  // length instead of moving it.
  const help: Record<string, string> = phone
    ? {
        move: 'Tap to open it. Hold it, then drag to move it, or hold its handle and drag to change its length.',
        'move-short': 'Tap to open it. Hold it, then drag to move it.',
        end: 'Hold its handle and drag to change its length.',
      }
    : {
        move: 'Hold it, then drag to move it, or hold its bottom edge and drag to change its length. Up and down arrow keys move it, and Shift and arrows change its length.',
        'move-short': 'Hold it, then drag to move it. Up and down arrow keys move it, and Shift and arrows change its length.',
        end: 'Hold its bottom edge and drag, or use Shift and the up and down arrow keys, to change its length.',
        'end-short': 'Use Shift and the up and down arrow keys to change its length.',
      };
  const helpOf = (move: boolean, resize: boolean, short: boolean) => {
    const key = move ? 'move' : resize ? 'end' : '';
    const full = `${key}${short ? '-short' : ''}`;
    return key && full in help ? `${helpId}-${full}` : undefined;
  };

  const calendar = (
    <div
      className="daywrap"
      onTouchStart={(e) => {
        if (e.touches.length === 2) pinch.current = { gap: touchGap(e), ph };
      }}
      onTouchMove={(e) => {
        // To a whole pixel of the hour, so the buttons step on from what's drawn.
        if (pinch.current && e.touches.length === 2) setZoom(clampZoom(Math.round((pinch.current.ph * touchGap(e)) / pinch.current.gap) / HOUR_PX));
      }}
      onTouchEnd={() => {
        pinch.current = null;
      }}
    >
      {/* No arrow keys on phone, where VoiceOver's swipes move a block as a slider. */}
      {Object.entries(help).map(([key, text]) => (
        <span key={key} id={`${helpId}-${key}`} hidden>
          {text}
        </span>
      ))}
      <div
        ref={measure}
        className="day"
        style={{ height: y(to), background: `repeating-linear-gradient(to bottom, var(--hairline) 0, var(--hairline) 1px, var(--card) 1px, var(--card) ${ph}px)` }}
        data-drop-date={data.date}
        data-drop-from={from}
        data-drop-to={to}
        onPointerDown={(e) => !(e.target as Element).closest('.cev') && holdNew.press(e)}
      >
        {hours.map((h) => (
          <span key={h} className="dayhr" style={{ top: y(h * 60) }} aria-hidden="true">
            {formatTimeOfDay(h * 60)}
          </span>
        ))}
        {/* Before the blocks, so it passes behind them and never strikes through the one under way. Only its dot is
            drawn in front. */}
        {nowMin >= from && nowMin <= to && <NowLine top={y(nowMin)} />}
        {items.map((i) => {
          const height = Math.max(13, y(i.to) - y(i.from) - 1);
          const compact = height < 24 ? ' compact' : '';
          const apart = overlaps(i);
          const lane = laneOf.get(i.id);
          const shape = lane && shapes.get(lane.group);
          // Behind +N more, which follows the last of its group that's drawn.
          if (lane && shape && lane.col >= shape.shown) return null;
          const hiding = !!lane && !!shape && shape.shown < lane.group.cols;
          const more = hiding && lane.group.items.filter((c) => c.col < shape.shown).at(-1)!.item.id === i.id && (
            <MoreButton
              key={`more${i.id}`}
              group={lane.group}
              shown={shape.shown}
              className="cev cevmore"
              style={{ top: y(lane.group.start), height: Math.max(44, y(lane.group.end) - y(lane.group.start)), left: 'auto', right: shape.right, width: MORE_PX }}
              onOpen={(x) => openItem(items.find((o) => o.id === x.id)!)}
            />
          );
          const style = {
            top: y(i.from),
            height,
            ...(lane && shape
              ? columnStyle(lane.col, shape.shown, '4px', hiding ? `(${shape.right} + ${MORE_INSET})` : shape.right)
              : { left: apart && !i.block ? '62%' : '4px', right: apart && i.block ? '40%' : '4px' }),
          };
          const time = !phone && height >= 24 && <span className="time">{i.time}</span>;
          if (!i.block) {
            return (
              <div key={i.id} className={`cev ${blockClass('event', 'planned', { short: !!compact })}${compact}`} title={i.time} style={style}>
                <span>{i.title}</span>
                {time}
              </div>
            );
          }
          const state = blockState({ result: i.block.result, ended: ended(i.block), now: i.cur });
          const look = LOOK[i.kind!];
          const cls = blockClass(look, state, { short: !!compact });
          // An Inbox item's block says so in words, where there's room, since no kind's colour marks it.
          const said = look === 'inbox' ? height >= SECOND_LINE[layout] && <span className="time">Inbox, {i.time}</span> : time;
          const move = movable(i.block);
          const resize = resizable(i.block);
          const lifted = drag?.id === i.id && !!drag.held;
          // On phone a block that moves is a slider, as on Week, so VoiceOver's swipe up and down move it.
          const slider = phone && move;
          const Tag = slider ? 'div' : 'button';
          const last = bounds(slotOf(i)).to;
          const drawn = (
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
                : { type: 'button' as const })}
              {...opens}
              data-block={i.block.id}
              title={i.time}
              style={style}
              aria-label={alt(i)}
              aria-describedby={helpOf(move, resize, !!compact)}
              // The release after a drag also clicks the block; press() stops that click before it gets here.
              onClick={() => openItem(i)}
              onPointerDown={move ? press(i, 'move') : phone && menuOf(i) ? hold(i) : undefined}
              onKeyDown={menuKeys(i)}
              onContextMenu={(e) => {
                if (!phone && openMenu(i, { x: e.clientX, y: e.clientY }, e.currentTarget)) e.preventDefault();
              }}
              // Steps in a row undo together; once focus leaves, the next is a change of its own.
              onBlur={() => (steps.current = null)}
            >
              <span className="cevt">
                <BlockMarks state={state} short={!!compact} look={look} />
                <OutcomeTag result={i.block.result} />
                <span className="blktitle">{phone && lifted ? `${i.time}, ${i.title}` : i.title}</span>
              </span>
              {said}
              {resize && !phone && !compact && <span className="evh" aria-hidden="true" onPointerDown={press(i, 'resize')} />}
              {resize && phone && !compact && (
                <span className="rz" aria-hidden="true" onPointerDown={press(i, 'resize')}>
                  <i />
                </span>
              )}
            </Tag>
          );
          return more ? [drawn, more] : drawn;
        })}
        {held && <DraftBlock hold={holdNew} top={y(held.start)} height={y(held.end) - y(held.start) - 1} beside={items.some((i) => i.from < held.end && held.start < i.to)} />}
        <HoldRing ring={holdNew.ring} />
        {drag?.ghost && (
          <div className={`cev ${phone ? 'ghost' : 'ev-ghost'} ${blockClass('project', 'suggested')}`} style={{ top: y(drag.ghost.start), height: y(drag.ghost.end) - y(drag.ghost.start), left: '4px', right: '4px' }} aria-hidden="true">
            Suggested {formatTimeOfDay(drag.ghost.start)}
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
    // A list has no room to draw blocks at the same time apart, so each says what it overlaps.
    const overlap = overlapsText(others(i));
    if (phone) {
      return (
        <button key={i.id} className={`tl tlbtn${i.cur ? ' cur' : ''}`} type="button" aria-label={alt(i)} {...opens} onClick={() => openItem(i)}>
          <span className="small quiet">{formatTime(i.start, zone)}</span>
          <span className="tlwhat">
            <span className={titleCls}>{i.title}</span>
            <span className="small quiet">
              {i.kind === 'project' ? 'Project' : i.word}
              {i.note && <>, {note}</>}
              {overlap && `, ${overlap}`}
            </span>
          </span>
        </button>
      );
    }
    const label = i.kind === 'project' ? (i.path ?? '').split(' > ')[0] : i.word;
    return (
      <div key={i.id} className={`tlrow${i.cur ? ' tlcur' : ''}`}>
        <button className="tlbtn" type="button" {...opens} onClick={() => openItem(i)}>
          <span className="small quiet">{i.time}</span>
          <span className="tlwhat">
            <span className={titleCls}>{i.title}</span>
            <span className="small quiet">{label}</span>
          </span>
          <span className="small quiet">
            {note}
            {note && overlap && ', '}
            {overlap}
          </span>
        </button>
      </div>
    );
  });

  return (
    <div className={phone ? 'card' : 'tl card'} role="region" aria-label="Today's timeline">
      <div className="between tlhead">
        <h3>Timeline</h3>
        <div className="row">
          {/* Beside Calendar and List, out of the calendar, so they never cover a block. */}
          {view === 'calendar' && <ZoomButtons zoom={zoom} onZoom={setZoom} />}
          <Segmented label="Timeline view" options={[['calendar', 'Calendar'], ['list', 'List']]} value={view} onChange={setView} />
        </div>
      </div>
      {view === 'calendar' ? calendar : <div className="tllist">{list}</div>}
      {actions.asking}
      {split && <SplitAsk ask={split} onDone={() => setSplit(null)} />}
      {holdNew.draft?.open && (
        <DraftCapture
          layout={layout}
          close={holdNew.close}
          slot={holdNew.slot(overlapWords(holdNew.draft.slot, items.map((i) => ({ title: i.title, start: i.from, end: i.to }))))}
        />
      )}
      {pop && (
        <BlockPopup
          pop={pop}
          close={() => setPop(null)}
          section={popBlock && <BlockSection block={popBlock} move={{ ctx, choose: chooseOnWeek }} {...(removable(popBlock) ? { onRemove: () => void actions.skip(popBlock) } : {})} />}
        />
      )}
      {menu && menuItem && (
        <Menu
          label={menuItem.title}
          entries={menuOf(menuItem) ?? []}
          at={menu.at}
          onClose={closeMenu}
          onChoose={(id) => {
            closeMenu();
            act(menuItem, id);
          }}
        />
      )}
      {deleting && <DeleteTask task={deleting} onClose={() => setDeleting(null)} />}
    </div>
  );
}

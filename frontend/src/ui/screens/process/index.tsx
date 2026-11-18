// Process: one Inbox item at a time, added to a project or One offs from one searchable field, or given a new project,
// practice or goal from its card. Every choice commits at once and keeps its exact reverse, so Undo can step back as
// far as you like, and a toast says what each did, with Undo. The desktop card and the phone card differ: on phone the
// field sits low, in thumb reach, and its list opens in a sheet, as does the form for a new home.
//
// A goal's backlog takes an item too: B, or Goal backlog, swaps the picker for the goals on desktop, and opens a sheet of
// them on phone. Beside it, K, or Save as note, makes the item a note in one tap.
//
// params.planning is the week being planned, so Add to this week adds to that plan; params.item opens on one item.
// params.stretchStart and stretchEnd are the stretch being planned: its projects come first, new projects end with it,
// and the week isn't offered, since weekly planning follows.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { formatDate, formatTime, formatWeekRange, isDay, localDate, nowInstant, thisWeek } from '../../../core/dates';
import { fileToBacklog } from '../../../core/backlog';
import { applyPlanChange, dueAfter, effectiveDue, msReached, sortedMilestones } from '../../../core/plan';
import type { PlanChange, RecordWrite, Stretch } from '../../../core/plan';
import type { InboxRow } from '../../../core/queries';
import { getRecord, setWeekPick, weekPickId } from '../../../core/records';
import type { Writer } from '../../../core/records';
import { isRepeating, onceWhen, projectDates } from '../../../core/schedule';
import { saveAsNote } from '../../../core/memos';
import { closeTask, makeHome, undoHome } from '../../../core/tasks';
import type { Home, Made } from '../../../core/tasks';
import type { Fields, LocalDate, Minutes, Task } from '../../../core/types';
import { useProcessKeys } from '../../app/processKeys';
import type { ScreenProps } from '../../app/registry';
import { useCutShares } from '../../app/shareImport';
import { useApp, useMutation, useQuery, useStickyState, useToday } from '../../app/store';
import { HomeForm } from '../../components/editors';
import type { HomeKind } from '../../components/editors';
import { EstimateSlider } from '../../components/EstimateSlider';
import { lateText } from '../../components/LateWarning';
import { emptyDraft, oneOffFields } from '../../components/oneoff';
import { useDialogFocus } from '../../components/useDialogFocus';
import { useToast } from '../../components/Toast';
import { BacklogChooser, BacklogSheet } from './BacklogChooser';
import { loadProcess } from './data';
import { Milestones } from './Milestones';
import type { MilestoneChoice } from './Milestones';
import { dayWord, formatRange } from '../../components/blocks/describe';
import { Item } from './Item';
import type { Editing } from './Item';
import type { Destination, ProcessData } from './data';
import { ONE_OFFS, Picker, placeKey, placeName } from './Picker';
import type { Place } from './Picker';
import './process.css';
import { Button } from '../../components/ds/Button';
import { Switch } from '../../components/ds/Controls';
import { Icon } from '../../components/ds/Icon';

export default function Screen(props: ScreenProps) {
  const { stretchStart, stretchEnd } = props.params;
  const stretch = useMemo<Stretch | undefined>(
    () => (isDay(stretchStart) && isDay(stretchEnd) ? { start: stretchStart, end: stretchEnd } : undefined),
    [stretchStart, stretchEnd],
  );
  const data = useQuery((sql, clock) => loadProcess(sql, clock, stretch), [stretch]).data;
  return data ? <Cards {...props} data={data} stretch={stretch} /> : null;
}

/** Where the cards are: everything Undo puts back. */
interface Step {
  idx: number;
  /** The slider, or null for the item's own estimate. */
  est: Minutes | null;
  planOn: boolean;
  sorted: number;
  /** Finished as done or deleted. */
  closed: number;
  /** A project just made from the card, which the picker holds until the item is added. */
  made: { id: string } | null;
}

const START: Step = { idx: 0, est: null, planOn: false, sorted: 0, closed: 0, made: null };

/** A home made from the card, for its Undo and the toast that reports it. */
interface HomeUndo {
  made: Made;
  itemId: string;
  item: string;
  title: string;
  /** A goal made with it, by name. */
  goal: string | null;
  /** Whether the item left the Inbox, so Undo brings it back. */
  left: boolean;
}

/** One step back: where the cards were, and the exact reverse of what was saved. */
interface Entry {
  step: Step;
  reverse: PlanChange | null;
  home?: HomeUndo;
  /** The item's title then, for the toast once it's back. */
  title: string;
}

/** Where Process remembers the place last added to, on this device. */
const LAST_KEY = 'processLast';

/** The date the item has, if it's set for a day or days. */
const onceOf = (task: Task | undefined) => (task?.schedule?.type === 'once' && task.schedule.from ? task.schedule : null);

const isField = (el: Element | null) =>
  !!el && (/^(TEXTAREA|SELECT)$/.test(el.tagName) || (el.tagName === 'INPUT' && (el as HTMLInputElement).type !== 'range'));

/** The key as Process names it. Option with a key types another character on a Mac, so its code says which key it was. */
function keyOf(event: ReactKeyboardEvent): string {
  if (!event.altKey) return event.key.toLowerCase();
  const m = /^(?:Key([A-Z])|Digit(\d))$/.exec(event.code);
  return m ? (m[1] ?? m[2]!).toLowerCase() : event.key.toLowerCase();
}

/** What the toast says once a home is made: made and kept on the card, or what the item became. */
function homeLine(home: Home, item: string, goal: string | null): string {
  if (home.keep) return `Created ${home.title}${goal ? `, under ${goal}` : ''}.`;
  return `${item} is now ${home.title === item ? `a ${home.kind}` : `the ${home.kind} ${home.title}`}.`;
}

/** What the toast says once a home is undone, or kept because another device has put tasks in it since. */
function undoneLine(home: HomeUndo, kept: boolean): string {
  const back = home.left ? ` ${home.item} is back.` : '';
  if (kept) return `Kept ${home.title}, it has other tasks now.${back}`;
  return `Undone: ${home.goal ? `${home.goal} and ` : ''}${home.title} removed.${back}`;
}

function Cards(props: ScreenProps & { data: ProcessData; stretch: Stretch | undefined }) {
  const { data, layout, close, stretch } = props;
  const planning: LocalDate | undefined = props.params.planning;
  const phone = layout === 'phone';
  const { clock } = useApp();
  const today = useToday();
  const toast = useToast();
  const [keysOn] = useProcessKeys();
  const [cutShares] = useCutShares();
  const [lastKey, setLastKey] = useStickyState(LAST_KEY, '');
  const [queue] = useState<InboxRow[]>(() => {
    const first = data.inbox.find((i) => i.id === props.params.item);
    return first ? [first, ...data.inbox.filter((i) => i !== first)] : data.inbox;
  });
  const [s, setS] = useState<Step>(START);
  // The exact reverse of what's been changed on each item, latest first, which puts it back as it arrived. Kept by item,
  // since a change can finish saving after its card has moved on.
  const [edits, setEdits] = useState<Record<string, RecordWrite[]>>({});
  const [history, setHistory] = useState<Entry[]>([]);
  const [delAsk, setDelAsk] = useState(false);
  const write = useMutation((w, fn: (w: Writer) => Promise<PlanChange>) => fn(w));
  const busy = useRef(false);
  // The form for a new home, and what opened it, by its key, which gets focus back when it closes.
  const [form, setForm] = useState<{ kind: HomeKind; name?: string; opener: string } | null>(null);
  // The goal picked last, where the next form starts.
  const [lastGoal, setLastGoal] = useState('');
  // Choosing a goal's backlog: the goals in place of the picker on desktop, a sheet on phone.
  const [choosing, setChoosing] = useState(false);
  const [lastBacklog, setLastBacklog] = useState('');
  const backlogRef = useRef<HTMLButtonElement | null>(null);
  const openers = useRef<Record<string, HTMLButtonElement | null>>({});
  // Where focus goes once the next render has drawn it: the picker, its Add to button, the title, or a form's opener.
  const refocus = useRef<string | null>('pick');
  const titleRef = useRef<HTMLElement | null>(null);
  const pickRef = useRef<HTMLElement | null>(null);
  const addRef = useRef<HTMLButtonElement | null>(null);
  const dateRef = useRef<HTMLButtonElement | null>(null);
  // A toast's Undo can come after Process has closed, or after the step it reports has been stepped back over.
  const live = useRef(true);
  const historyRef = useRef(history);
  historyRef.current = history;
  // Set on mount as well as cleared on unmount, since StrictMode mounts twice.
  useEffect(() => {
    live.current = true;
    return () => void (live.current = false);
  }, []);

  const item = queue[s.idx];
  // The item as it is now, with any changes made on the card.
  const task = useQuery((sql) => (item ? getRecord(sql, 'task', item.id) : Promise.resolve(undefined)), [item?.id]).data;
  // shortcut: until its record loads, a moment after it shows, the card draws the item from its Inbox row, with no
  // description; load whole records with the Inbox if that moment ever shows.
  const current = task?.id === item?.id ? task : item && ({ id: item.id, kind: 'inbox', title: item.title, estimate_min: item.estimate_min ?? null } as Task);
  const name = current?.title ?? '';
  // Its block, which hold to create gives it: filing keeps it, and what closes the item takes it off.
  const zone = clock.zone();
  const block = item?.block_start && item.block_end ? { start: item.block_start, end: item.block_end } : null;
  const day = block && dayWord(localDate(block.start, zone), today);
  const near = day === 'Today' || day === 'Tomorrow';
  const onCalendar = block && `On the calendar ${near ? day!.toLowerCase() : day}, ${formatRange(block.start, block.end, zone)}. It keeps this time wherever it goes.`;
  const blockAt = block && `${day === 'Today' ? '' : ` ${near ? day!.toLowerCase() : `on ${day}`}`} at ${formatTime(block.start, zone)}`;
  const stays = block ? ` Its block${blockAt} stays.` : '';
  /** Runs what closes the item, noting whether that took its block off. */
  let freed = false;
  const closing = (run: (w: Writer) => Promise<PlanChange>) => async (w: Writer) => {
    const reverse = await run(w);
    freed = reverse.writes.some((r) => r.type === 'time_block');
    return reverse;
  };
  const cameOff = () => (freed ? ` Its block${blockAt} came off the calendar.` : '');
  const est = s.est ?? current?.estimate_min ?? item?.estimate_min ?? 0;
  const itemEdits = (item && edits[item.id]) || [];
  const [editing, setEditing] = useState<Editing>(null);
  // What's typed in the card's open title, date or description and not yet saved, which goes with its item as it moves on.
  const pending = useRef<(() => Promise<boolean>) | null>(null);
  const focusTitle = () => titleRef.current?.focus();
  const focusPicker = () => pickRef.current?.focus();
  const dests = data.groups.flatMap((g) => g.dests);
  const placeOf = (key: string | undefined): Place | undefined => (key === ONE_OFFS ? null : dests.find((d) => d.plan.project.id === key));
  // The picker shows a place picked from its list for this item, else a project just made, else the place last added to
  // while it's still there.
  const [pick, setPick] = useState<{ itemId: string; key: string } | null>(null);
  const picked = pick && pick.itemId === item?.id ? placeOf(pick.key) : undefined;
  const shown = picked !== undefined ? picked : placeOf(s.made ? s.made.id : lastKey);
  // The milestone picked in the project the picker holds, for this item, else the one suggested.
  const [msPick, setMsPick] = useState<{ itemId: string; projectId: string; choice: MilestoneChoice } | null>(null);
  // The milestone each project's last item went under in this run, null for none.
  const [lastMs, setLastMs] = useState<Record<string, string | null>>({});
  const [naming, setNaming] = useState(false);

  const closeForm = () => {
    refocus.current = form?.opener ?? null;
    setForm(null);
  };
  // A field on the card closes with focus back on the title, where the keys work again.
  const closeEditing = () => {
    // Unless focus has moved on from the field meanwhile, as it can while a change saves.
    const active = document.activeElement;
    const movedOn = !!active && !!ref.current?.contains(active) && !active.closest('.pxtitleform, .pxdateform, .pxnotes');
    if (!movedOn) refocus.current = editing === 'date' ? 'date' : 'title';
    setEditing(null);
  };
  const ref = useDialogFocus<HTMLDivElement>(() => {
    if (form) closeForm();
    else if (editing) closeEditing();
    else if (delAsk) setDelAsk(false);
    // From Add to a project just made, or from its milestones, back into the picker to put the item somewhere else.
    else if ((addRef.current && document.activeElement === addRef.current) || document.activeElement?.closest('.pkms')) focusPicker();
    else if (isField(document.activeElement)) focusTitle();
    else close();
  });
  // Focus is passed on explicitly, once what it goes to is drawn: a key that opened a form left it on the card.
  useEffect(() => {
    const to = refocus.current;
    if (!to || form) return;
    const el = !item || to === 'title' ? titleRef.current : to === 'pick' ? pickRef.current : to === 'add' ? addRef.current : to === 'date' ? dateRef.current : openers.current[to];
    if (!el) return;
    refocus.current = null;
    el.focus();
  });

  /** Puts back what an entry saved, whether or not Process is still open. True when a project made stays. */
  const revert = useMutation(async (w, entry: Entry) => {
    if (!entry.reverse) return false;
    if (entry.home) return undoHome(w, entry.home.itemId, entry.home.made, entry.reverse);
    await applyPlanChange(w, entry.reverse);
    return false;
  });

  /**
   * Changes to the item on the card, each saved as it's made. Its reverse joins the item's, for one Undo. Both go to the
   * item the change was made on, by its id: the card may have moved on by the time the change saves.
   */
  const edit = useMutation((w, id: string, fields: Fields<'task'>) => w.set('task', id, fields));
  const keepReverse = (itemId: string, reverse: RecordWrite) =>
    setEdits((all) => {
      const now = all[itemId] ?? [];
      // Only the first change to a field matters: its reverse is what the item arrived with.
      const known = new Set(now.filter((r) => r.id === reverse.id).flatMap((r) => Object.keys(r.fields)));
      const fields = Object.fromEntries(Object.entries(reverse.fields).filter(([f]) => !known.has(f)));
      return Object.keys(fields).length ? { ...all, [itemId]: [{ ...reverse, fields }, ...now] } : all;
    });
  const save = async (fields: Fields<'task'>) => {
    if (!item) return false;
    const { id } = item;
    const previous = await edit.run(id, fields);
    if (!previous) return false;
    keepReverse(id, { type: 'task', id, fields: previous });
    return true;
  };
  const revertEdits = useMutation((w, writes: RecordWrite[]) => applyPlanChange(w, { writes }));

  const back = history[history.length - 1];
  const undo = async () => {
    if (busy.current) return;
    // First the item goes back as it arrived, then the step before.
    if (item && itemEdits.length) {
      busy.current = true;
      const done = await revertEdits.run(itemEdits);
      busy.current = false;
      if (!done) return;
      setS({ ...s, est: null });
      setEdits((all) => ({ ...all, [item.id]: [] }));
      setEditing(null);
      refocus.current = 'pick';
      return toast.show(`${item?.title} is back as it arrived.`);
    }
    if (!back) return;
    busy.current = true;
    const kept = await revert.run(back);
    busy.current = false;
    if (kept === undefined) return;
    setHistory((h) => h.slice(0, -1));
    setS(back.step);
    setDelAsk(false);
    setForm(null);
    setEditing(null);
    setNaming(false);
    refocus.current = 'pick';
    toast.show(back.home ? undoneLine(back.home, kept) : `${back.title} is back.`);
  };
  const undoRef = useRef(undo);
  undoRef.current = undo;
  /** The toast's Undo: the step back while it's still the last step, or once Process has closed, its reverse alone. */
  const undoFromToast = (entry: Entry) => {
    if (live.current) return historyRef.current.at(-1) === entry ? undoRef.current() : undefined;
    return revert.run(entry);
  };

  /**
   * Runs one choice as one transaction, then shows the next card, unless next() keeps this one, and says what happened
   * in a toast whose Undo steps back over it. merge folds it into the step before, as an item added to the project just
   * made from it is one step with making it. True once done.
   */
  const commit = async (
    run: ((w: Writer) => Promise<PlanChange>) | null,
    next: () => Partial<Step>,
    says: () => string,
    options: { home?: () => HomeUndo; merge?: boolean } = {},
  ) => {
    if (busy.current) return false;
    busy.current = true;
    const from = document.activeElement;
    // Anything typed on the card and not yet saved is saved to this item first.
    const kept = !pending.current || (await pending.current());
    const reverse = !kept ? undefined : run ? await write.run(run) : null;
    busy.current = false;
    if (reverse === undefined) return false;
    // Focus moved on the card while it saved, as by Esc, stays where it was put.
    const moved = document.activeElement !== from && !!ref.current?.contains(document.activeElement);
    const step: Step = { ...s, idx: s.idx + 1, est: null, planOn: false, made: null, ...next() };
    if (step.idx !== s.idx) {
      swipeAway(ref.current);
      // The next card opens with nothing being edited.
      setEditing(null);
      setNaming(false);
    }
    const prev = history[history.length - 1];
    const merged = options.merge && prev?.home;
    const entry: Entry = merged
      ? { step: prev.step, reverse: { writes: [...(reverse?.writes ?? []), ...(prev.reverse?.writes ?? [])] }, home: { ...merged, left: true }, title: prev.title }
      : { step: s, reverse, title: name, ...(options.home ? { home: options.home() } : {}) };
    setHistory((h) => [...(merged ? h.slice(0, -1) : h), entry]);
    setS(step);
    setDelAsk(false);
    if (step.made || !moved) refocus.current = step.made ? 'add' : 'pick';
    toast.show(says(), { undo: () => undoFromToast(entry) });
    if (!queue[step.idx]) finish(step);
    return true;
  };

  /**
   * After the last item, Process closes itself, and a green check over the page it was opened from says how many were
   * processed: added, made into a home, done or deleted. The last item's toast waits for it, its Undo still to hand.
   */
  const finish = (step: Step) => {
    const done = step.sorted + step.closed;
    const left = queue.length - done;
    const items = `${done} ${done === 1 ? 'item' : 'items'} processed`;
    if (left > 0) toast.check(items, `${left} still in your Inbox`, false);
    else toast.check('Inbox clear', items, true);
    close();
  };
  // Opened with nothing to process, as when another device has just emptied the Inbox, it closes again.
  useEffect(() => {
    if (!queue.length) close();
  }, []);

  /** With the week toggle on, the item is added to the week too, in the same change. It waits there for a time you choose. */
  const addToWeek = async (w: Writer, minutes: Minutes, reverse: PlanChange): Promise<PlanChange> => {
    const week = planning ?? thisWeek(clock);
    await setWeekPick(w, week, item!.id, minutes);
    return { writes: [{ type: 'week_pick', id: weekPickId(week, item!.id), fields: { deleted_at: nowInstant(clock) } }, ...reverse.writes] };
  };
  const weekWords = planning ? 'and to the plan' : 'and to this week';
  const ctx = { settings: data.settings, clock };
  /** A project's milestones still to reach, by date. */
  const openMilestones = (dest: Destination) => sortedMilestones(dest.plan, ctx).filter((m) => !m.dropped_at && !msReached(dest.plan, m));
  /** Where an item goes in a project unless another is picked: under the milestone its last item went under in this run, else the next. */
  const suggested = (dest: Destination): MilestoneChoice => {
    const open = openMilestones(dest);
    const id = dest.plan.project.id;
    if (id in lastMs && (lastMs[id] === null || open.some((m) => m.id === lastMs[id]))) return lastMs[id] ? { id: lastMs[id]! } : null;
    return open[0] ? { id: open[0].id } : null;
  };
  const msFor = (dest: Destination): MilestoneChoice =>
    msPick && msPick.itemId === item?.id && msPick.projectId === dest.plan.project.id ? msPick.choice : suggested(dest);
  const lateFor = (dest: Destination) => {
    if (!current) return null;
    const ms = msFor(dest);
    const late = dueAfter(dest.plan, { schedule: current.schedule ?? null, milestone_id: ms && 'id' in ms ? ms.id : null }, ctx);
    return late && lateText(late);
  };
  // A date the item came with, rather than one set on the card this time.
  const dated = !itemEdits.some((r) => r.id === item?.id && 'schedule' in r.fields);

  /** Adds the item to a project, under the milestone chosen there, or to One offs as null. A new milestone is made with it. */
  const send = (dest: Place) => {
    if (!item) return Promise.resolve(false);
    // shortcut: no estimate picks 30m for a one off and 1h for a project, ask later if these prove wrong.
    const minutes = est || (dest ? 60 : 30);
    const made = dest && s.made?.id === dest.plan.project.id ? s.made : null;
    const ms = dest ? msFor(dest) : null;
    let madeMs: string | null = null;
    // The item as it stands, read in the same change: a title or date saved on the card a moment ago may not show yet.
    let latest = current;
    const run = async (w: Writer): Promise<PlanChange> => {
      latest = (await getRecord(w.sql, 'task', item.id)) ?? current;
      const once = onceOf(latest);
      // Undated, as any milestone named without a date: it goes by the stretch, or the project's end, until given one.
      if (dest && ms && 'name' in ms) madeMs = await w.create('milestone', { project_id: dest.plan.project.id, title: ms.name, stretch: stretch?.start ?? null, added_on: today });
      const milestone_id = madeMs ?? (ms && 'id' in ms ? ms.id : null);
      // Fields merge one by one, so each kind clears the other's: another device may have sent this item the other way.
      const fields: Fields<'task'> = dest
        ? { kind: 'project', project_id: dest.plan.project.id, milestone_id, ...projectDates(latest ?? {}), estimate_min: est || null }
        : oneOffFields({ ...emptyDraft(today), title: latest?.title ?? name, estimate: est, ...(once ? { from: once.from ?? '', to: once.to ?? '', ranged: !!once.to } : {}) }, today);
      const filed = await applyPlanChange(w, { writes: [{ type: 'task', id: item.id, fields }] });
      const reverse = madeMs ? { writes: [...filed.writes, { type: 'milestone' as const, id: madeMs, fields: { deleted_at: nowInstant(clock) } }] } : filed;
      return s.planOn ? addToWeek(w, minutes, reverse) : reverse;
    };
    const under = !dest || !ms ? '' : 'name' in ms ? `, under the new milestone ${ms.name}` : `, under ${dest.plan.milestones.find((m) => m.id === ms.id)?.title}`;
    const says = () => {
      const once = onceOf(latest);
      const where = `${placeName(dest)}${under}${once ? `, for ${onceWhen(once)}` : ''}`;
      const repeatGoes = dest && latest && isRepeating(latest) ? " Repeats stay with One offs, so it won't repeat." : '';
      return `Added ${latest?.title ?? name} to ${where}${s.planOn ? ` ${weekWords}` : ''}.${repeatGoes}${stays}`;
    };
    return commit(run, () => ({ sorted: s.sorted + 1 }), says, { merge: !!made }).then((done) => {
      if (!done) return done;
      setLastKey(placeKey(dest));
      if (dest) setLastMs((all) => ({ ...all, [dest.plan.project.id]: madeMs ?? (ms && 'id' in ms ? ms.id : null) }));
      return done;
    });
  };

  /**
   * Makes a new home for the item, in one change with one Undo. Kept on the card, the item waits to be added: to the
   * project just made, which the picker then holds, or anywhere after a practice or goal. Otherwise the item becomes it.
   */
  const addHome = async (home: Home) => {
    if (!item) return false;
    let made: Made | undefined;
    const pick = home.kind === 'goal' ? null : home.goal;
    const goal = pick ? ('title' in pick ? pick.title : (data.goals.find((g) => g.id === pick.id)?.title ?? null)) : null;
    const run = closing(async (w: Writer): Promise<PlanChange> => {
      const result = await makeHome(w, item.id, home, clock);
      made = result.made;
      return result.reverse;
    });
    const done = await commit(
      run,
      () =>
        home.keep
          ? {
              idx: s.idx,
              est: s.est,
              planOn: s.planOn,
              made: made!.type === 'project' ? { id: made!.id } : null,
            }
          : { sorted: s.sorted + 1 },
      () => `${homeLine(home, name, goal)}${cameOff()}`,
      { home: () => ({ made: made!, itemId: item.id, item: name, title: home.title, goal: made!.goal ? goal : null, left: !home.keep }) },
    );
    if (!done || !made) return false;
    // The picker holds a project just made, over a place picked before it.
    if (home.keep && made.type === 'project') setPick(null);
    if (home.kind !== 'goal') setLastGoal(made.goal ?? (home.goal && 'id' in home.goal ? home.goal.id : ''));
    setForm(null);
    return true;
  };

  /** Adds the item to a goal's backlog, made if it's new: no milestone and no date, last in arrival order. */
  const file = (goalId: string) => {
    const goal = data.backlogs.find((g) => g.id === goalId);
    if (!item || !goal) return Promise.resolve(false);
    const minutes = est || 60;
    const once = current?.schedule?.type === 'once' && current.schedule.from;
    const run = async (w: Writer): Promise<PlanChange> => {
      const filed = await fileToBacklog(w, goalId, [item.id], clock, { estimate_min: est || null });
      return s.planOn ? addToWeek(w, minutes, filed) : filed;
    };
    const says = () => `Added ${name} to the backlog for ${goal.title}${s.planOn ? ` ${weekWords}` : ''}.${once ? ' Backlog tasks have no date, so its date was cleared.' : ''}${stays}`;
    setChoosing(false);
    return commit(run, () => ({ sorted: s.sorted + 1 }), says).then((done) => {
      if (done) setLastBacklog(goalId);
      return done;
    });
  };
  const closeChooser = () => {
    setChoosing(false);
    refocus.current = null;
    requestAnimationFrame(() => backlogRef.current?.focus());
  };

  const openForm = (kind: HomeKind, opener: string, name?: string) => setForm({ kind, opener, ...(name !== undefined ? { name } : {}) });

  const skip = () => item && void commit(null, () => ({}), () => `Skipped ${name}. It stays in your Inbox.`);
  // Done finishes the item as any task finishes, so Done lists it; Delete asks first and leaves no trace there.
  // shortcut: an item that repeats, which only a field-by-field merge from another device can make, fails to finish as
  // done and says so; give Done a repeat's own finish if that ever turns up.
  const markDone = () =>
    item && void commit(closing((w) => closeTask(w, item.id, 'done', clock)), () => ({ closed: s.closed + 1 }), () => `Marked ${name} done.${cameOff()}`);
  const remove = () =>
    item &&
    void commit(
      closing((w) => closeTask(w, item.id, 'deleted', clock)),
      () => ({ closed: s.closed + 1 }),
      () => (freed ? `Deleted ${name} and its block${blockAt}.` : `Deleted ${name}.`),
    );
  // One tap: the item becomes a note in Notes, with what was written and attached. Never on the week.
  const saveNote = () =>
    item &&
    void commit(
      closing((w) => saveAsNote(w, item.id, clock)),
      () => ({ sorted: s.sorted + 1 }),
      () => `Saved ${name} in Notes.${s.planOn ? " Notes aren't added to the week." : ''}${cameOff()}`,
    );
  const togglePlan = () => setS({ ...s, planOn: !s.planOn });

  // Single keys need the device setting, since speech input can type them; with Option or Alt they always work, in Add
  // to as well, where letters only search. Never while a form or the delete question is open, and never on a phone.
  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (form || phone) return;
    const target = event.target as HTMLElement;
    const k = keyOf(event);
    const command = event.metaKey || event.ctrlKey;
    const inPicker = target === pickRef.current;
    const run = (fn: () => unknown) => {
      event.preventDefault();
      fn();
    };
    if (delAsk && !command && ((k === 'd' && (keysOn || event.altKey)) || (k === 'enter' && target.tagName !== 'BUTTON'))) return run(remove);
    // In Add to, Cmd or Ctrl and Z steps back only while nothing is typed, else it's the field's own undo.
    if (delAsk || (isField(target) && !(inPicker && (event.altKey || (command && !target.dataset.typed))))) return;
    if (command) return k === 'z' && !event.shiftKey && !event.altKey ? run(undo) : undefined;
    const single = event.altKey || (keysOn && !inPicker);
    if (k === 'z' && single) return run(undo);
    if (!item) return;
    if (!single) return;
    const keys: Record<string, () => unknown> = {
      e: () => setEditing('title'),
      s: skip,
      f: markDone,
      d: () => setDelAsk(true),
      p: () => openForm('practice', 'p'),
      g: () => openForm('goal', 'g'),
      k: saveNote,
      ...(data.backlogs.length ? { b: () => setChoosing(true) } : {}),
      ...(stretch ? {} : { w: togglePlan }),
      ...(shown ? { m: () => setNaming(true) } : {}),
    };
    const fn = keys[k];
    if (fn) run(fn);
  };

  const total = queue.length;
  // The bar and the count say the same: on the third of four it's three quarters full.
  const at = item ? s.idx + 1 : total;
  const pos = `${at} of ${total}`;
  const pct = Math.round((at / Math.max(1, total)) * 100);
  // A switch: its name stays put, and on or off says the rest.
  const planLabel = planning ? `Add to the plan for ${formatWeekRange(planning)}` : 'Add to this week';

  // Every key on the desktop card shows on its button, with the Option or Alt it needs until Settings makes keys work alone.
  const held = useHeld();
  const cap = (k: string) =>
    !phone && (
      <kbd className="keycap" aria-hidden="true">
        {held}
        {k}
      </kbd>
    );
  // Planning a stretch, weekly planning comes next, so the week isn't offered.
  const weekToggle = !stretch && (
    <Switch className={`pxweek${s.planOn ? ' on' : ''}`} checked={s.planOn} onChange={togglePlan} label={planLabel}>
      {cap('W')}
    </Switch>
  );
  const exit = (
    <Button variant={phone ? 'secondary' : 'link'} className={phone ? undefined : 'small'} type="button" onClick={close}>
      {stretch ? 'Back to planning' : 'Exit'}
    </Button>
  );
  const makeOne = (
    <div className="pxmake" role="group" aria-label="No home yet? Make one">
      <span className="small quiet" aria-hidden="true">
        No home yet? Make one
      </span>
      <div className="pxmakes">
        {(
          [
            ['p', 'practice'],
            ['g', 'goal'],
          ] as const
        ).map(([k, kind]) => (
          <Button
            key={k}
            ref={(el) => void (openers.current[k] = el)}
            size="compact"
            type="button"
            aria-label={`New ${kind} from this item`}
            onClick={() => openForm(kind, k)}
          >
            {cap(k.toUpperCase())}
            New {kind}
          </Button>
        ))}
      </div>
    </div>
  );
  // With no goals there's no backlog to offer.
  const backlogButton = data.backlogs.length > 0 && (
    <Button ref={backlogRef} size="compact" type="button" aria-haspopup={phone ? 'dialog' : undefined} onClick={() => setChoosing(true)}>
      {cap('B')}
      Goal backlog
    </Button>
  );
  const noteButton = (
    <Button size="compact" type="button" onClick={saveNote}>
      {cap('K')}
      <Icon name="note" size={16} />
      Save as note
    </Button>
  );
  // Choices that aren't a place, side by side.
  const side = (
    <div className="pxside">
      {backlogButton}
      {noteButton}
    </div>
  );
  const chooser = !phone && choosing && item && (
    <BacklogChooser key={item.id} goals={data.backlogs} keysOn={keysOn} cap={cap} onAdd={(id) => void file(id)} onBack={closeChooser} />
  );
  const homeForm = form && item && (
    <HomeForm key={item.id} item={name} kind={form.kind} name={form.name} goals={data.goals} goal={lastGoal} end={data.end} onSave={addHome} onClose={closeForm} />
  );
  // Under a project the picker holds, its milestones.
  const milestones = item && shown && (
    <Milestones
      key={shown.plan.project.id}
      phone={phone}
      project={shown.title}
      milestones={openMilestones(shown)}
      due={(m) => formatDate(effectiveDue(shown.plan, m, ctx))}
      chosen={msFor(shown)}
      onChoose={(choice) => setMsPick({ itemId: item.id, projectId: shown.plan.project.id, choice })}
      onAdd={() => addRef.current?.click()}
      naming={naming}
      setNaming={setNaming}
      cap={cap('M')}
    />
  );
  const picker = item && (
    <Picker
      // Its own key beside the form's: a fresh field, with nothing typed, for each item.
      key={`pick ${item.id}`}
      phone={phone}
      groups={data.groups}
      value={shown}
      tag={s.planOn ? { text: planning ? '+ the plan' : '+ this week', says: weekWords } : null}
      fieldRef={pickRef}
      addRef={addRef}
      cap={
        !phone && (
          <kbd className="keycap" aria-hidden="true">
            ↩
          </kbd>
        )
      }
      late={lateFor}
      onAdd={(place) => void send(place)}
      onPick={(place) => setPick({ itemId: item.id, key: placeKey(place) })}
      onNew={(name) => openForm('project', 'pick', name)}
      milestones={milestones}
    >
      {!phone && weekToggle}
    </Picker>
  );
  // Time saves as it moves, so the item keeps it however it's handled.
  const slider = (
    <EstimateSlider
      label="Time"
      value={est}
      onChange={(m) => {
        setS({ ...s, est: m });
        void save({ estimate_min: m || null });
      }}
    />
  );
  const itemCard = (children?: ReactNode) =>
    current && (
      <Item
        task={current}
        phone={phone}
        editing={editing}
        setEditing={(next) => (next ? setEditing(next) : closeEditing())}
        titleRef={titleRef}
        dateRef={dateRef}
        dated={dated}
        cut={cutShares.includes(current.id)}
        save={save}
        pending={pending}
        onAttachment={(reverse) => keepReverse(current.id, reverse)}
        cap={cap}
        slider={slider}
        when={onCalendar}
      >
        {children}
      </Item>
    );
  const deleteAsk = (
    <span className={phone ? 'pxacts' : 'row small'} role="alert">
      <span className="strong small grow">Delete this item?</span>
      <Button variant="primary" size="compact" type="button" onClick={remove}>
        Yes, delete
      </Button>
      <Button size="compact" type="button" onClick={() => setDelAsk(false)}>
        Cancel
      </Button>
    </span>
  );
  if (phone) {
    return (
      <div ref={ref} className="pxflow" role="dialog" aria-modal="true" aria-label="Process Inbox" tabIndex={-1} onKeyDown={onKeyDown}>
        <div className="pxtop">
          {exit}
          <span className="small quiet">{pos}</span>
          <span className="pxbar" aria-hidden="true">
            <span style={{ width: `${pct}%` }} />
          </span>
        </div>
        {item ? (
          <>
            {itemCard(weekToggle)}
            <div className="pxspace" />
            {picker}
            {side}
            {choosing && <BacklogSheet goals={data.backlogs} last={lastBacklog} onAdd={(id) => void file(id)} onClose={closeChooser} />}
            {makeOne}
            {homeForm}
            {delAsk ? (
              deleteAsk
            ) : (
              <div className="pxacts">
                <Button type="button" disabled={!back && !itemEdits.length} onClick={() => void undo()} icon="undo">
                  Undo
                </Button>
                <Button type="button" onClick={skip}>
                  Skip
                </Button>
                <Button type="button" onClick={markDone}>
                  Done
                </Button>
                <Button type="button" onClick={() => setDelAsk(true)}>
                  Delete
                </Button>
              </div>
            )}
          </>
        ) : null}
      </div>
    );
  }

  return (
    // A press on the veil around the card closes Process, as Exit does.
    <div className="pxwrap" onMouseDown={(event) => event.target === event.currentTarget && close()}>
      <div ref={ref} className="pxcard" role="dialog" aria-modal="true" aria-label="Process Inbox" tabIndex={-1} onKeyDown={onKeyDown}>
        <div className="pxtop">
          <Button size="compact" type="button" disabled={!back && !itemEdits.length} onClick={() => void undo()} icon="undo">
            Undo and go back
            {cap('Z')}
          </Button>
          <span className="small quiet">{pos}</span>
          <span className="pxbar" aria-hidden="true">
            <span style={{ width: `${pct}%` }} />
          </span>
          {stretch && <span className="small quiet">{`Planning ${formatDate(stretch.start)} to ${formatDate(stretch.end)}`}</span>}
          {exit}
        </div>
        {item ? (
          <>
            {itemCard()}
            {homeForm || chooser || (
              <>
                {picker}
                <div className="pxopts">
                  {side}
                  {makeOne}
                  <div className="row">
                    <Button size="compact" type="button" onClick={skip}>
                      Skip
                      {cap('S')}
                    </Button>
                    {delAsk ? (
                      deleteAsk
                    ) : (
                      <>
                        <Button size="compact" type="button" onClick={markDone}>
                          Done
                          {cap('F')}
                        </Button>
                        <Button size="compact" type="button" onClick={() => setDelAsk(true)}>
                          Delete
                          {cap('D')}
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              </>
            )}
          </>
        ) : null}
        <div className="row small pxlastrow">
          {!keysOn && <span className="small quiet pxhint">Keys work with Option or Alt held. Settings can make them work alone.</span>}
        </div>
      </div>
    </div>
  );
}

/** What a key needs held, shown on its cap: nothing once Settings makes single keys work. */
function useHeld() {
  const [keysOn] = useProcessKeys();
  return keysOn ? '' : /Mac/.test(navigator.userAgent) ? '⌥' : 'Alt ';
}

/**
 * Sends a copy of the card off to the right, tilting, while the card itself, already showing the next item, settles up
 * from beneath. Called before React draws the next item, so the copy shows the one just processed.
 */
function swipeAway(card: HTMLElement | null) {
  if (!card || typeof card.animate !== 'function' || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  const box = card.getBoundingClientRect();
  const copy = card.cloneNode(true) as HTMLElement;
  copy.classList.add('pxghost');
  copy.removeAttribute('role');
  copy.removeAttribute('aria-label');
  copy.setAttribute('aria-hidden', 'true');
  copy.inert = true;
  for (const el of copy.querySelectorAll('[id]')) el.removeAttribute('id');
  // A sheet the choice was made in closes rather than flying off with the card.
  for (const el of copy.querySelectorAll('.sheet, .scrim')) el.remove();
  Object.assign(copy.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` });
  // Inside the layout, whose styles the copy needs.
  (card.closest('[data-layout]') ?? document.body).append(copy);
  copy
    .animate([{ transform: 'none', opacity: 1 }, { transform: 'translateX(70%) rotate(7deg)', opacity: 0 }], {
      duration: 320,
      easing: 'cubic-bezier(.4,0,1,1)',
      fill: 'forwards',
    })
    .finished.finally(() => copy.remove());
  // On a phone the card is the whole screen, and shrinking it would show the Inbox behind.
  const settle = card.closest("[data-layout='phone']") ? [{ opacity: 0.6 }, { opacity: 1 }] : [{ transform: 'scale(.94)', opacity: 0.6 }, { transform: 'none', opacity: 1 }];
  card.animate(settle, { duration: 300, easing: 'ease-out' });
}

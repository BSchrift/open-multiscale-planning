// Process: one Inbox item at a time, added to a project or One offs from one searchable field, or given a new project,
// practice or goal from its card. Every choice commits at once and keeps its exact reverse, so Undo can step back as
// far as you like, and a toast says what each did, with Undo. The desktop card and the phone card differ: on phone the
// field sits low, in thumb reach, and its list opens in a sheet, as does the form for a new home.
//
// params.planning is the week being planned, so Add to this week adds to that plan; params.item opens on one item.
// params.stretchStart and stretchEnd are the stretch being planned: its projects come first, new projects end with it,
// and the week isn't offered, since weekly planning follows.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { formatDate, formatWeekRange, isDay, nowInstant, thisWeek } from '../../../core/dates';
import { applyPlanChange } from '../../../core/plan';
import type { PlanChange, ProjectPlan, Stretch } from '../../../core/plan';
import type { InboxRow } from '../../../core/queries';
import { getRecord, setWeekPick, weekPickId } from '../../../core/records';
import type { Writer } from '../../../core/records';
import { closeTask, makeHome, undoHome } from '../../../core/tasks';
import type { Home, Made } from '../../../core/tasks';
import type { Fields, LocalDate, Minutes } from '../../../core/types';
import { useProcessKeys } from '../../app/processKeys';
import type { ScreenProps } from '../../app/registry';
import { useApp, useMutation, useQuery, useStickyState, useToday } from '../../app/store';
import { HomeForm } from '../../components/editors';
import type { HomeKind } from '../../components/editors';
import { EstimateSlider } from '../../components/EstimateSlider';
import { MilestoneDiamond } from '../../components/MilestoneDiamond';
import { emptyDraft, OneOffDates, oneOffFields } from '../../components/oneoff';
import { useDialogFocus } from '../../components/useDialogFocus';
import { useToast } from '../../components/Toast';
import { loadProcess } from './data';
import type { ProcessData } from './data';
import { ONE_OFFS, Picker, placeKey, placeName } from './Picker';
import type { Place } from './Picker';
import './process.css';

export default function Screen(props: ScreenProps) {
  const { stretchStart, stretchEnd } = props.params;
  const stretch = useMemo<Stretch | undefined>(
    () => (isDay(stretchStart) && isDay(stretchEnd) ? { start: stretchStart, end: stretchEnd } : undefined),
    [stretchStart, stretchEnd],
  );
  const data = useQuery((sql, clock) => loadProcess(sql, clock, stretch), [stretch]).data;
  return data ? <Cards {...props} data={data} stretch={stretch} /> : null;
}

interface Sent {
  id: string;
  title: string;
  project: ProjectPlan | null;
}

/** Where the cards are: everything Undo puts back. */
interface Step {
  idx: number;
  /** The slider, or null for the item's own estimate. */
  est: Minutes | null;
  planOn: boolean;
  sorted: number;
  deleted: number;
  /** A project just made from the card, which the picker holds until the item is added, with the milestone named with it. */
  made: { id: string; milestone: string | null; under: string | null } | null;
  sent: Sent | null;
}

const START: Step = { idx: 0, est: null, planOn: false, sorted: 0, deleted: 0, made: null, sent: null };

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
}

/** Where Process remembers the place last added to, on this device. */
const LAST_KEY = 'processLast';

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
  if (home.keep) {
    const ms = home.kind === 'project' && home.milestone ? `, with the milestone ${home.milestone}` : '';
    return `Created ${home.title}${goal ? `, under ${goal}` : ''}${ms}.`;
  }
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
  const [lastKey, setLastKey] = useStickyState(LAST_KEY, '');
  const [queue] = useState<InboxRow[]>(() => {
    const first = data.inbox.find((i) => i.id === props.params.item);
    return first ? [first, ...data.inbox.filter((i) => i !== first)] : data.inbox;
  });
  const [s, setS] = useState<Step>(START);
  const [history, setHistory] = useState<Entry[]>([]);
  const [delAsk, setDelAsk] = useState(false);
  const write = useMutation((w, fn: (w: Writer) => Promise<PlanChange>) => fn(w));
  const busy = useRef(false);
  // The form for a new home, and what opened it, by its key, which gets focus back when it closes.
  const [form, setForm] = useState<{ kind: HomeKind; name?: string; opener: string } | null>(null);
  // The goal picked last, where the next form starts.
  const [lastGoal, setLastGoal] = useState('');
  const openers = useRef<Record<string, HTMLButtonElement | null>>({});
  // Where focus goes once the next render has drawn it: the picker, its Add to button, the title, or a form's opener.
  const refocus = useRef<string | null>('pick');
  const titleRef = useRef<HTMLHeadingElement>(null);
  const pickRef = useRef<HTMLElement | null>(null);
  const addRef = useRef<HTMLButtonElement | null>(null);
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
  const est = s.est ?? item?.estimate_min ?? 0;
  const focusTitle = () => titleRef.current?.focus();
  const focusPicker = () => pickRef.current?.focus();
  const dests = data.groups.flatMap((g) => g.dests);
  const placeOf = (key: string | undefined): Place | undefined => (key === ONE_OFFS ? null : dests.find((d) => d.plan.project.id === key));
  // The picker shows a project just made, else the place last added to while it's still there.
  const shown = placeOf(s.made ? s.made.id : lastKey);

  const closeForm = () => {
    refocus.current = form?.opener ?? null;
    setForm(null);
  };
  const ref = useDialogFocus<HTMLDivElement>(() => {
    if (form) closeForm();
    else if (delAsk) setDelAsk(false);
    // From Add to a project just made, back into the picker to put the item somewhere else.
    else if (addRef.current && document.activeElement === addRef.current) focusPicker();
    else if (isField(document.activeElement)) focusTitle();
    else close();
  });
  // Focus is passed on explicitly, once what it goes to is drawn: a key that opened a form left it on the card.
  useEffect(() => {
    const to = refocus.current;
    if (!to || form) return;
    const el = !item || to === 'title' ? titleRef.current : to === 'pick' ? pickRef.current : to === 'add' ? addRef.current : openers.current[to];
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

  const back = history[history.length - 1];
  const undo = async () => {
    if (!back || busy.current) return;
    busy.current = true;
    const kept = await revert.run(back);
    busy.current = false;
    if (kept === undefined) return;
    setHistory((h) => h.slice(0, -1));
    setS(back.step);
    setDelAsk(false);
    setForm(null);
    refocus.current = 'pick';
    toast.show(back.home ? undoneLine(back.home, kept) : `${queue[back.step.idx]?.title} is back.`);
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
    const reverse = run ? await write.run(run) : null;
    busy.current = false;
    if (reverse === undefined) return false;
    const step: Step = { ...s, idx: s.idx + 1, est: null, planOn: false, made: null, sent: null, ...next() };
    if (step.idx !== s.idx) swipeAway(ref.current);
    const prev = history[history.length - 1];
    const merged = options.merge && prev?.home;
    const entry: Entry = merged
      ? { step: prev.step, reverse: { writes: [...(reverse?.writes ?? []), ...(prev.reverse?.writes ?? [])] }, home: { ...merged, left: true } }
      : { step: s, reverse, ...(options.home ? { home: options.home() } : {}) };
    setHistory((h) => [...(merged ? h.slice(0, -1) : h), entry]);
    setS(step);
    setDelAsk(false);
    refocus.current = step.made ? 'add' : 'pick';
    toast.show(says(), { undo: () => undoFromToast(entry) });
    return true;
  };

  /** With the week toggle on, the item is added to the week too, in the same change. It waits there for a time you choose. */
  const addToWeek = async (w: Writer, minutes: Minutes, reverse: PlanChange): Promise<PlanChange> => {
    const week = planning ?? thisWeek(clock);
    await setWeekPick(w, week, item!.id, minutes);
    return { writes: [{ type: 'week_pick', id: weekPickId(week, item!.id), fields: { deleted_at: nowInstant(clock) } }, ...reverse.writes] };
  };
  const weekWords = planning ? 'and to the plan' : 'and to this week';

  /** Adds the item to a project, or to One offs as null. One just made from the card puts it under the milestone named with it. */
  const send = (dest: Place) => {
    if (!item) return Promise.resolve(false);
    // shortcut: no estimate picks 30m for a one off and 1h for a project, ask later if these prove wrong.
    const minutes = est || (dest ? 60 : 30);
    const made = dest && s.made?.id === dest.plan.project.id ? s.made : null;
    const run = async (w: Writer): Promise<PlanChange> => {
      // Fields merge one by one, so each kind clears the other's: another device may have sent this item the other way.
      const fields: Fields<'task'> = dest
        ? { kind: 'project', project_id: dest.plan.project.id, milestone_id: made?.milestone ?? null, schedule: null, next_due: null, estimate_min: est || null }
        : oneOffFields({ ...emptyDraft(today), title: item.title, estimate: est }, today);
      const filed = await applyPlanChange(w, { writes: [{ type: 'task', id: item.id, fields }] });
      return s.planOn ? addToWeek(w, minutes, filed) : filed;
    };
    const says = () => `Added ${item.title} to ${placeName(dest)}${made?.under ? `, under ${made.under}` : ''}${s.planOn ? ` ${weekWords}` : ''}.`;
    const sent = { id: item.id, title: item.title, project: dest?.plan ?? null };
    return commit(run, () => ({ sorted: s.sorted + 1, sent }), says, { merge: !!made }).then((done) => {
      if (done) setLastKey(placeKey(dest));
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
    const run = async (w: Writer): Promise<PlanChange> => {
      const result = await makeHome(w, item.id, home, clock);
      made = result.made;
      return result.reverse;
    };
    const done = await commit(
      run,
      () =>
        home.keep
          ? {
              idx: s.idx,
              est: s.est,
              planOn: s.planOn,
              made: made!.type === 'project' ? { id: made!.id, milestone: made!.milestone ?? null, under: home.kind === 'project' ? (home.milestone ?? null) : null } : null,
            }
          : { sorted: s.sorted + 1 },
      () => homeLine(home, item.title, goal),
      { home: () => ({ made: made!, itemId: item.id, item: item.title, title: home.title, goal: made!.goal ? goal : null, left: !home.keep }) },
    );
    if (!done || !made) return false;
    if (home.kind !== 'goal') setLastGoal(made.goal ?? (home.goal && 'id' in home.goal ? home.goal.id : ''));
    setForm(null);
    return true;
  };

  const openForm = (kind: HomeKind, opener: string, name?: string) => setForm({ kind, opener, ...(name !== undefined ? { name } : {}) });

  const skip = () => item && void commit(null, () => ({}), () => `Skipped ${item.title}. It stays in your Inbox.`);
  const remove = () => item && void commit((w) => closeTask(w, item.id, 'deleted', clock), () => ({ deleted: s.deleted + 1 }), () => `Deleted ${item.title}.`);
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
    if (!item) return k === 'enter' && target.tagName !== 'BUTTON' ? run(close) : undefined;
    if (!single) return;
    const keys: Record<string, () => unknown> = {
      s: skip,
      d: () => setDelAsk(true),
      p: () => openForm('practice', 'p'),
      g: () => openForm('goal', 'g'),
      ...(stretch ? {} : { w: togglePlan }),
    };
    const fn = keys[k];
    if (fn) run(fn);
  };

  const total = queue.length;
  // The bar and the count say the same: on the third of four it's three quarters full.
  const at = item ? s.idx + 1 : total;
  const pos = `${at} of ${total}`;
  const pct = Math.round((at / Math.max(1, total)) * 100);
  const planLabel = planning
    ? `${s.planOn ? 'Adding' : 'Add'} to the plan for ${formatWeekRange(planning)}`
    : s.planOn
      ? 'Adding to this week'
      : 'Add to this week';

  const skipped = queue.filter((q) => data.inbox.some((i) => i.id === q.id)).length;
  const doneTitle = data.inbox.length ? "That's everything for now" : 'Inbox clear';
  const doneText = `${[`${s.sorted} sorted`, s.deleted ? `${s.deleted} deleted` : '', skipped ? `${skipped} skipped, still in your Inbox` : ''].filter(Boolean).join(', ')}.`;

  const titleEl = (text: string) => (
    <h1 ref={titleRef} className="pxtitle" tabIndex={-1} aria-live="polite">
      {text}
    </h1>
  );
  const followUp = s.sent && <FollowUp key={s.sent.id} sent={s.sent} />;
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
    <button className={`pxweek${s.planOn ? ' on' : ''}`} type="button" aria-pressed={s.planOn} onClick={togglePlan}>
      <span aria-hidden="true">{s.planOn ? '✓' : '+'}</span>
      {planLabel}
      {cap('W')}
    </button>
  );
  const exit = (
    <button className={phone ? 'btn' : 'link small'} type="button" onClick={close}>
      {stretch ? 'Back to planning' : 'Exit'}
    </button>
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
          <button
            key={k}
            ref={(el) => void (openers.current[k] = el)}
            className={phone ? 'btn' : 'btn sm'}
            type="button"
            aria-label={`New ${kind} from this item`}
            onClick={() => openForm(kind, k)}
          >
            {cap(k.toUpperCase())}
            New {kind}
          </button>
        ))}
      </div>
    </div>
  );
  const homeForm = form && item && (
    <HomeForm key={item.id} item={item.title} kind={form.kind} name={form.name} goals={data.goals} goal={lastGoal} end={data.end} onSave={addHome} onClose={closeForm} />
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
      onAdd={(place) => void send(place)}
      onNew={(name) => openForm('project', 'pick', name)}
    >
      {!phone && weekToggle}
    </Picker>
  );
  const slider = <EstimateSlider label="Time" value={est} onChange={(m) => setS({ ...s, est: m })} />;
  const deleteAsk = (
    <span className={phone ? 'pxacts' : 'row small'} role="alert">
      <span className="strong small grow">Delete this item?</span>
      <button className={phone ? 'btn pri' : 'btn sm pri'} type="button" onClick={remove}>
        Yes, delete
      </button>
      <button className={phone ? 'btn' : 'btn sm'} type="button" onClick={() => setDelAsk(false)}>
        Cancel
      </button>
    </span>
  );
  const doneCard = (
    <>
      {titleEl(doneTitle)}
      <p className="quiet">{doneText}</p>
    </>
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
            <div className="card stack pxitem">
              {titleEl(item.title)}
              {followUp}
              {slider}
              {weekToggle}
            </div>
            <div className="pxspace" />
            {picker}
            {makeOne}
            {homeForm}
            {delAsk ? (
              deleteAsk
            ) : (
              <div className="pxacts">
                <button className="btn" type="button" disabled={!back} onClick={() => void undo()}>
                  ‹ Undo
                </button>
                <button className="btn" type="button" onClick={skip}>
                  Skip
                </button>
                <button className="btn" type="button" onClick={() => setDelAsk(true)}>
                  Delete/done
                </button>
              </div>
            )}
          </>
        ) : (
          <>
            <div className="pxspace" />
            <div className="card stack">{doneCard}</div>
            <div className="pxspace" />
            <div className="pxacts">
              <button className="btn" type="button" disabled={!back} onClick={() => void undo()}>
                ‹ Undo
              </button>
              <button className="btn pri" type="button" onClick={close}>
                Done
              </button>
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="pxwrap">
      <div ref={ref} className="pxcard" role="dialog" aria-modal="true" aria-label="Process Inbox" tabIndex={-1} onKeyDown={onKeyDown}>
        <div className="pxtop">
          <button className="btn sm" type="button" disabled={!back} onClick={() => void undo()}>
            ‹ Undo and go back
            {cap('Z')}
          </button>
          <span className="small quiet">{pos}</span>
          <span className="pxbar" aria-hidden="true">
            <span style={{ width: `${pct}%` }} />
          </span>
          {stretch && <span className="small quiet">{`Planning ${formatDate(stretch.start)} to ${formatDate(stretch.end)}`}</span>}
          {exit}
        </div>
        {item ? (
          <>
            <div className="pxitem">
              {titleEl(item.title)}
              <div className="pxfacts">{slider}</div>
            </div>
            {homeForm || (
              <>
                {picker}
                <div className="pxopts">
                  {makeOne}
                  <div className="row">
                    <button className="btn sm" type="button" onClick={skip}>
                      Skip
                      {cap('S')}
                    </button>
                    {delAsk ? (
                      deleteAsk
                    ) : (
                      <button className="btn sm" type="button" onClick={() => setDelAsk(true)}>
                        Delete/done
                        {cap('D')}
                      </button>
                    )}
                  </div>
                </div>
              </>
            )}
          </>
        ) : (
          <div className="pxmain">
            <div className="stack8">
              {doneCard}
              <div>
                <button className="btn pri" type="button" onClick={close}>
                  Done
                </button>
              </div>
            </div>
          </div>
        )}
        <div className="row small pxlastrow">
          {followUp}
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

/** After an add, the item can still get a milestone or a date, without slowing the one-click path. */
function FollowUp(props: { sent: Sent }) {
  const { sent } = props;
  const task = useQuery((sql) => getRecord(sql, 'task', sent.id), [sent.id]).data;
  const setMilestone = useMutation((w, id: string) => w.set('task', sent.id, { milestone_id: id || null }));
  if (!task || task.deleted_at) return null;
  if (task.kind === 'one_off') return <OneOffDates task={task} />;
  const open = sent.project?.milestones.filter((m) => !m.met_at && !m.dropped_at) ?? [];
  if (task.kind !== 'project' || open.length === 0) return null;
  return (
    <span className="row small">
      <MilestoneDiamond />
      <select
        className="field pxms"
        aria-label={`Milestone for ${sent.title}`}
        value={task.milestone_id ?? ''}
        onChange={(e) => void setMilestone.run(e.target.value)}
      >
        {/* No milestone: the task sits under the project's Done. */}
        <option value="">Done</option>
        {open.map((m) => (
          <option key={m.id} value={m.id}>
            {m.title}
          </option>
        ))}
      </select>
    </span>
  );
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

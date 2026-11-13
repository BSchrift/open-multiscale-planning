// Process: one Inbox item at a time, sent to a project or One offs in one click, or given a new project, practice or
// goal from its card. Every choice commits at once and keeps its exact reverse, so Undo can step back as far as you
// like. The desktop card and the phone card differ: on phone the destinations sit low, in thumb reach, other projects
// open in a sheet, and so does the form for a new home.
//
// params.planning is the week being planned, so Add to this week adds to that plan; params.item opens on one item.
// params.stretchStart and stretchEnd are the stretch being planned: its projects come first, new projects end with it,
// and the week isn't offered, since weekly planning follows.

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode, Ref } from 'react';
import { formatDate, formatMinutes, formatWeekRange, isDay, nowInstant, thisWeek } from '../../../core/dates';
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
import { useApp, useMutation, useQuery, useToday } from '../../app/store';
import { HomeForm, ProjectAdd } from '../../components/editors';
import type { HomeKind } from '../../components/editors';
import { EstimateSlider } from '../../components/EstimateSlider';
import { MilestoneDiamond } from '../../components/MilestoneDiamond';
import { emptyDraft, OneOffDates, oneOffFields } from '../../components/oneoff';
import { Sheet } from '../../components/Sheet';
import { useDialogFocus } from '../../components/useDialogFocus';
import { loadProcess } from './data';
import type { Destination, ProcessData } from './data';
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
  last: string;
  sent: Sent | null;
}

const START: Step = { idx: 0, est: null, planOn: false, sorted: 0, deleted: 0, last: '', sent: null };

/** A home made from the card, for its Undo and the line that reports it. */
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

const isField = (el: Element | null) =>
  !!el && (/^(TEXTAREA|SELECT)$/.test(el.tagName) || (el.tagName === 'INPUT' && (el as HTMLInputElement).type !== 'range'));

/** The key as Process names it. Option with a key types another character on a Mac, so its code says which key it was. */
function keyOf(event: ReactKeyboardEvent): string {
  if (!event.altKey) return event.key.toLowerCase();
  const m = /^(?:Key([A-Z])|Digit(\d))$/.exec(event.code);
  return m ? (m[1] ?? m[2]!).toLowerCase() : event.code === 'Slash' ? '/' : event.key.toLowerCase();
}

/** What the card's line says once a home is made. */
function homeLine(home: Home, item: string, note: string): string {
  const goal = home.kind !== 'goal' && home.goal && 'title' in home.goal ? home.goal.title : null;
  if (home.keep) {
    const added = `Added ${goal ? `goal ${goal} and ` : ''}${home.kind} ${home.title}`;
    return home.kind === 'project' ? `${added}, and sent "${item}" to it${note}` : `${added}. Now file "${item}".`;
  }
  const what = home.title === item ? `a ${home.kind}` : `the ${home.kind} ${home.title}`;
  const rule = home.kind === 'practice' ? `, ${formatMinutes(home.target_min)} a ${home.per}` : '';
  return `${goal ? `Added goal ${goal}. ` : ''}"${item}" is now ${what}${rule}. It left your Inbox.`;
}

/** What the card's line says once a home is undone, or kept because another device has put tasks in it since. */
function undoneLine(home: HomeUndo, kept: boolean): string {
  const back = ` "${home.item}" is back in your Inbox.`;
  if (kept) return `Kept ${home.title}, it has other tasks now.${back}`;
  return `Undone: ${home.goal ? `${home.goal} and ` : ''}${home.title} removed${home.left ? `,${back}` : '.'}`;
}

function Cards(props: ScreenProps & { data: ProcessData; stretch: Stretch | undefined }) {
  const { data, layout, close, stretch } = props;
  const planning: LocalDate | undefined = props.params.planning;
  const phone = layout === 'phone';
  const { clock } = useApp();
  const today = useToday();
  const [keysOn] = useProcessKeys();
  const [queue] = useState<InboxRow[]>(() => {
    const first = data.inbox.find((i) => i.id === props.params.item);
    return first ? [first, ...data.inbox.filter((i) => i !== first)] : data.inbox;
  });
  const [s, setS] = useState<Step>(START);
  const [history, setHistory] = useState<{ step: Step; reverse: PlanChange | null; home?: HomeUndo }[]>([]);
  const [delAsk, setDelAsk] = useState(false);
  const [picked, setPicked] = useState('');
  const [otherOpen, setOtherOpen] = useState(false);
  const [otherQ, setOtherQ] = useState('');
  const write = useMutation((w, fn: (w: Writer) => Promise<PlanChange>) => fn(w));
  const busy = useRef(false);
  const [newOpen, setNewOpen] = useState(false);
  // The form for a new home, and the button that opened it, by its key, which gets focus back when it closes.
  const [form, setForm] = useState<{ kind: HomeKind; name?: string; opener: string } | null>(null);
  const [finder, setFinder] = useState<{ q: string; at: number } | null>(null);
  // Projects sent to this time, the latest first, for 9: the last one used that has no number.
  const [used, setUsed] = useState<string[]>([]);
  // The goal picked last, where the next form starts.
  const [lastGoal, setLastGoal] = useState('');
  const openers = useRef<Record<string, HTMLButtonElement | null>>({});
  const refocus = useRef<string | null>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const listId = useId();

  const item = queue[s.idx];
  const est = s.est ?? item?.estimate_min ?? 0;
  const focusTitle = () => titleRef.current?.focus();
  const lastUsed = used.map((id) => data.others.find((d) => d.plan.project.id === id)).find((d) => !!d);

  const closeForm = () => {
    refocus.current = form?.opener ?? null;
    setForm(null);
  };
  const closeFinder = () => {
    refocus.current = '/';
    setFinder(null);
  };
  const ref = useDialogFocus<HTMLDivElement>(() => {
    if (form) closeForm();
    else if (finder) closeFinder();
    else if (newOpen) setNewOpen(false);
    else if (delAsk) setDelAsk(false);
    else if (isField(document.activeElement)) focusTitle();
    else close();
  });
  useEffect(focusTitle, [s.idx]);
  // Focus is passed back explicitly, since a key that opened the form left it on the card rather than the button.
  useEffect(() => {
    if (form || finder || !refocus.current) return;
    const to = refocus.current;
    refocus.current = null;
    if (to === 'title') focusTitle();
    else openers.current[to]?.focus();
  }, [form, finder]);

  /** Runs one choice as one transaction, then shows the next card, unless next() keeps this one. True once done. */
  const commit = async (run: ((w: Writer) => Promise<PlanChange>) | null, next: () => Partial<Step>, home?: () => HomeUndo) => {
    if (busy.current) return false;
    busy.current = true;
    const reverse = run ? await write.run(run) : null;
    busy.current = false;
    if (reverse === undefined) return false;
    const step = { ...s, idx: s.idx + 1, est: null, planOn: false, sent: null, ...next() };
    if (step.idx !== s.idx) swipeAway(ref.current);
    setHistory((h) => [...h, { step: s, reverse, home: home?.() }]);
    setS(step);
    setDelAsk(false);
    setPicked('');
    setOtherOpen(false);
    setFinder(null);
    return true;
  };

  /** With the week toggle on, the item is added to the week too, in the same change. It waits there for a time you choose. */
  const addToWeek = async (w: Writer, minutes: Minutes, reverse: PlanChange): Promise<PlanChange> => {
    const week = planning ?? thisWeek(clock);
    await setWeekPick(w, week, item!.id, minutes);
    return { writes: [{ type: 'week_pick', id: weekPickId(week, item!.id), fields: { deleted_at: nowInstant(clock) } }, ...reverse.writes] };
  };
  const weekNote = planning ? ' and added to the plan.' : ' and added to this week, not on the calendar yet.';

  /** Sends the item to a project, or to One offs with none. A new project from the card comes as its fields. */
  const send = (dest: Destination | null, make?: Fields<'project'> & { title: string }) => {
    if (!item) return Promise.resolve(false);
    const name = make ? `new project ${make.title}` : dest ? dest.title : 'One offs';
    // shortcut: no estimate picks 30m for a one off and 1h for a project, ask later if these prove wrong.
    const minutes = est || (make || dest ? 60 : 30);
    let note = '.';
    const run = async (w: Writer): Promise<PlanChange> => {
      // Made in the same change as the send, so one Undo takes back both, and no key can reach the next item in between.
      const made = make && (await w.create('project', make));
      const projectId = made || dest?.plan.project.id;
      // Fields merge one by one, so each kind clears the other's: another device may have sent this item the other way.
      const fields: Fields<'task'> = projectId
        ? { kind: 'project', project_id: projectId, milestone_id: null, schedule: null, next_due: null, estimate_min: est || null }
        : oneOffFields({ ...emptyDraft(today), title: item.title, estimate: est }, today);
      const filed = await applyPlanChange(w, { writes: [{ type: 'task', id: item.id, fields }] });
      const reverse: PlanChange = made ? { writes: [...filed.writes, { type: 'project', id: made, fields: { deleted_at: nowInstant(clock) } }] } : filed;
      if (!s.planOn) return reverse;
      note = weekNote;
      return addToWeek(w, minutes, reverse);
    };
    return commit(run, () => ({ sorted: s.sorted + 1, last: `Sent to ${name}${note}`, sent: { id: item.id, title: item.title, project: dest?.plan ?? null } })).then((done) => {
      if (done && dest) setUsed((u) => [dest.plan.project.id, ...u.filter((id) => id !== dest.plan.project.id)]);
      return done;
    });
  };

  /**
   * Makes a new home for the item and files it, in one change with one Undo. A practice or goal the item only points
   * to keeps the card on it, to file next.
   */
  const addHome = async (home: Home) => {
    if (!item) return false;
    const stays = home.kind !== 'project' && home.keep;
    let made: Made | undefined;
    let note = '.';
    const run = async (w: Writer): Promise<PlanChange> => {
      const result = await makeHome(w, item.id, home.kind === 'project' ? { ...home, estimate: est || null } : home, clock);
      made = result.made;
      if (!(home.kind === 'project' && home.keep && s.planOn)) return result.reverse;
      note = weekNote;
      return addToWeek(w, est || 60, result.reverse);
    };
    const goal = home.kind !== 'goal' && home.goal && 'title' in home.goal ? home.goal.title : null;
    const done = await commit(
      run,
      () => ({ ...(stays ? { idx: s.idx, est: s.est, planOn: s.planOn } : { sorted: s.sorted + 1 }), last: homeLine(home, item.title, note) }),
      () => ({ made: made!, itemId: item.id, item: item.title, title: home.title, goal, left: !stays }),
    );
    if (!done || !made) return false;
    const { id, type } = made;
    if (type === 'project') setUsed((u) => [id, ...u]);
    if (home.kind !== 'goal') setLastGoal(made.goal ?? (home.goal && 'id' in home.goal ? home.goal.id : ''));
    refocus.current = 'title';
    setForm(null);
    return true;
  };

  const openForm = (kind: HomeKind, opener: string, name?: string) => {
    setFinder(null);
    setForm({ kind, opener, ...(name ? { name } : {}) });
  };
  const openFinder = () => setFinder({ q: '', at: 0 });
  const matches = useMemo(() => {
    const q = finder?.q.trim().toLowerCase() ?? '';
    return [...data.shown, ...data.others].filter((d) => !q || `${d.title} ${d.goal ?? ''}`.toLowerCase().includes(q));
  }, [finder?.q, data]);
  // The last row is always a new project, named as typed.
  const choose = (at: number) => {
    const dest = matches[at];
    if (dest) send(dest);
    else openForm('project', '/', finder?.q.trim());
  };

  const skip = () => item && void commit(null, () => ({ last: 'Skipped. It stays in your Inbox.' }));
  const newProject = newOpen && <ProjectAdd objectiveId={null} save={(fields) => send(null, fields)} onClose={() => setNewOpen(false)} />;
  const remove = () => item && void commit((w) => closeTask(w, item.id, 'deleted', clock), () => ({ deleted: s.deleted + 1, last: 'Deleted.' }));
  const togglePlan = () => setS({ ...s, planOn: !s.planOn });
  const back = history[history.length - 1];
  const undo = async () => {
    if (!back || busy.current) return;
    const { home } = back;
    let kept = false;
    if (back.reverse) {
      busy.current = true;
      const done = await write.run(async (w) => {
        if (!home) return applyPlanChange(w, back.reverse!);
        kept = await undoHome(w, home.itemId, home.made, back.reverse!);
        return { writes: [] };
      });
      busy.current = false;
      if (done === undefined) return;
    }
    setHistory((h) => h.slice(0, -1));
    setS(home ? { ...back.step, last: undoneLine(home, kept) } : back.step);
    setDelAsk(false);
    setForm(null);
    setFinder(null);
    focusTitle();
  };

  // Single keys need the device setting, since speech input can type them; with Option or Alt they always work. Never
  // while a form, the finder or the delete question is open, and never on a phone.
  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (otherOpen || newOpen || form || finder || phone) return;
    const target = event.target as HTMLElement;
    const k = keyOf(event);
    const single = keysOn || event.altKey;
    const command = event.metaKey || event.ctrlKey;
    const run = (fn: () => unknown) => {
      event.preventDefault();
      fn();
    };
    if (delAsk && !command && ((k === 'd' && single) || (k === 'enter' && target.tagName !== 'BUTTON'))) return run(remove);
    if (delAsk || isField(target)) return;
    if (command) return k === 'z' && !event.shiftKey && !event.altKey ? run(undo) : undefined;
    if (k === 'z' && single) return run(undo);
    if (!item) return k === 'enter' && target.tagName !== 'BUTTON' ? run(close) : undefined;
    if (!single) return;
    const keys: Record<string, () => unknown> = {
      o: () => send(null),
      s: skip,
      d: () => setDelAsk(true),
      n: () => openForm('project', 'n'),
      p: () => openForm('practice', 'p'),
      g: () => openForm('goal', 'g'),
      '/': openFinder,
      ...(stretch ? {} : { w: togglePlan }),
      ...(lastUsed ? { 9: () => send(lastUsed) } : {}),
    };
    const dest = /^[1-8]$/.test(k) ? data.shown[Number(k) - 1] : undefined;
    const fn = keys[k] ?? (dest && (() => send(dest)));
    if (fn) run(fn);
  };

  const total = queue.length;
  const pos = `${item ? s.idx + 1 : total} of ${total}`;
  const pct = Math.round((s.idx / Math.max(1, total)) * 100);
  const planLabel = planning
    ? `${s.planOn ? 'Adding' : 'Add'} to the plan for ${formatWeekRange(planning)}`
    : s.planOn
      ? 'Adding to this week'
      : 'Add to this week';
  const planTag = planning ? '+ the plan' : '+ this week';
  const alt = (title: string) => (s.planOn ? `${title}, ${planning ? 'add to the plan' : 'add to this week'}` : title);
  const otherDest = data.others.find((d) => d.plan.project.id === picked);

  const skipped = queue.filter((q) => data.inbox.some((i) => i.id === q.id)).length;
  const doneTitle = data.inbox.length ? "That's everything for now" : 'Inbox clear';
  const doneText = `${[`${s.sorted} sorted`, s.deleted ? `${s.deleted} deleted` : '', skipped ? `${skipped} skipped, still in your Inbox` : ''].filter(Boolean).join(', ')}.`;

  const titleEl = (text: string) => (
    <h1 ref={titleRef} className="pxtitle" tabIndex={-1} aria-live="polite">
      {text}
    </h1>
  );
  const lastLine = (
    <span className={phone ? 'small quiet pxlast' : 'quiet'} role="status">
      {s.last}
    </span>
  );
  const followUp = s.sent && <FollowUp key={s.sent.id} sent={s.sent} />;
  // Every button on the desktop card shows its key, with the Option or Alt it needs until Settings makes keys work alone.
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
    <div className="pxmake" role="group" aria-labelledby={`${listId}-make`}>
      <span id={`${listId}-make`} className="small quiet">
        No home yet? Make one
      </span>
      <div className="pxmakes">
        {(
          [
            ['n', 'project'],
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
  const finderEl = finder && (
    <div className="pxfind stack8">
      <input
        className="field"
        role="combobox"
        aria-label="Find a project"
        aria-expanded="true"
        aria-controls={listId}
        aria-activedescendant={`${listId}-${finder.at}`}
        autoFocus
        value={finder.q}
        onChange={(event) => setFinder({ q: event.target.value, at: 0 })}
        onKeyDown={(event) => {
          const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
          if (step) setFinder({ ...finder, at: Math.min(matches.length, Math.max(0, finder.at + step)) });
          else if (event.key === 'Enter') choose(finder.at);
          else return;
          event.preventDefault();
        }}
      />
      <ul id={listId} className="pxfindlist" role="listbox" aria-label="Projects">
        {[...matches, null].map((d, i) => (
          <li
            key={d?.plan.project.id ?? 'new'}
            id={`${listId}-${i}`}
            className="pxfindrow"
            role="option"
            aria-selected={i === finder.at}
            onClick={() => choose(i)}
          >
            {d ? (
              <>
                <span>{d.title}</span>
                <span className="small quiet">{d.goal ? `${d.goal}, ${d.pill}` : d.pill}</span>
              </>
            ) : finder.q.trim() ? (
              `+ New project "${finder.q.trim()}"`
            ) : (
              '+ New project'
            )}
          </li>
        ))}
      </ul>
    </div>
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
    const q = otherQ.trim().toLowerCase();
    const found = data.others.filter((d) => !q || `${d.title} ${d.goal ?? ''}`.toLowerCase().includes(q));
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
            <div className="card stack">
              {titleEl(item.title)}
              {lastLine}
              {followUp}
              {slider}
              {weekToggle}
            </div>
            <div className="pxspace" />
            <div className="pxgrid">
              {data.shown.map((d, i) => (
                <button key={d.plan.project.id} className={`pxdest${s.planOn ? ' tagged' : ''}`} type="button" aria-label={alt(d.title)} onClick={() => send(d)}>
                  <span className="pxkey" aria-hidden="true">
                    {held}
                    {i + 1}
                  </span>
                  <span className="pxmin">
                    <span className="pxname">{d.title}</span>
                    {s.planOn && <span className="pxtag">{planTag}</span>}
                  </span>
                </button>
              ))}
            </div>
            <div className="pxrow">
              <button className="pxdest maint" type="button" aria-label={alt('One offs')} onClick={() => send(null)}>
                <span className="pxmin">
                  <span className="pxname">One offs</span>
                  {s.planOn && <span className="pxtag">{planTag}</span>}
                </span>
              </button>
              {data.others.length > 0 && (
                <button className="pxdest other" type="button" onClick={() => setOtherOpen(true)}>
                  <span className="pxname">Other project</span>
                </button>
              )}
              <button className="pxdest other" type="button" onClick={() => setNewOpen(true)}>
                <span className="pxname">+ New project</span>
              </button>
            </div>
            {newProject}
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
            <div className="card stack">
              {doneCard}
              {lastLine}
            </div>
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
        {otherOpen && (
          <Sheet label="Send to another project" tall onClose={() => setOtherOpen(false)}>
            <div className="between">
              <h2>Other project</h2>
              <button className="btn" type="button" onClick={() => setOtherOpen(false)}>
                Close
              </button>
            </div>
            <input
              className="field"
              type="search"
              aria-label="Search projects"
              placeholder="Search projects"
              value={otherQ}
              onChange={(e) => setOtherQ(e.target.value)}
            />
            <div className="stack8">
              {found.map((d) => (
                <button
                  key={d.plan.project.id}
                  className="projbtn morerow pxpick"
                  type="button"
                  aria-pressed={picked === d.plan.project.id}
                  onClick={() => setPicked(d.plan.project.id)}
                >
                  <span className="pxmin pxlines">
                    <span>{d.title}</span>
                    <span className="small quiet">{d.goal ? `${d.goal}, ${d.pill}` : d.pill}</span>
                  </span>
                </button>
              ))}
            </div>
            {found.length === 0 && <p className="small quiet">No project matches.</p>}
            {otherDest && (
              <button className="btn pri" type="button" onClick={() => send(otherDest)}>
                Send
              </button>
            )}
          </Sheet>
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
            <div className="pxmain">{titleEl(item.title)}</div>
            {homeForm ||
              finderEl || (
                <>
                  <div className="pxgrid">
                    {data.shown.map((d, i) => (
                      <Dest key={d.plan.project.id} k={String(i + 1)} label={alt(d.title)} tag={s.planOn && planTag} onClick={() => send(d)}>
                        {/* Planning a stretch, each project shows its goal. */}
                        {stretch && d.goal ? (
                          <span className="pxmin pxlines">
                            <span>{d.title}</span>
                            <span className="small quiet">{d.goal}</span>
                          </span>
                        ) : (
                          <span>{d.title}</span>
                        )}
                      </Dest>
                    ))}
                    {lastUsed && (
                      <Dest k="9" label={alt(`${lastUsed.title}, last used`)} tag={s.planOn && planTag} onClick={() => send(lastUsed)}>
                        <span className="pxmin pxlines">
                          <span>{lastUsed.title}</span>
                          <span className="small quiet">Last used</span>
                        </span>
                      </Dest>
                    )}
                    <Dest k="/" ref={(el) => void (openers.current['/'] = el)} onClick={openFinder}>
                      <span>Find a project</span>
                    </Dest>
                    <button className="pxdest" type="button" onClick={() => setNewOpen(true)}>
                      <span>+ New project</span>
                    </button>
                  </div>
                  {newProject}
                  <Dest k="O" className="maint" label={alt('One offs')} tag={s.planOn && planTag} onClick={() => send(null)}>
                    <span>One offs</span>
                  </Dest>
                  {makeOne}
                  {weekToggle}
                  <div className="pxopts">
                    {slider}
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
          {lastLine}
          {followUp}
          {!keysOn && <span className="small quiet pxhint">Keys work with Option or Alt held. Settings can make them work alone.</span>}
        </div>
      </div>
    </div>
  );
}

/** A destination on the desktop card: its key, what it is, and the week's tag while that's on. */
/** What a key needs held, shown on its cap: nothing once Settings makes single keys work. */
function useHeld() {
  const [keysOn] = useProcessKeys();
  return keysOn ? '' : /Mac/.test(navigator.userAgent) ? '⌥' : 'Alt ';
}

function Dest(props: {
  k: string;
  label?: string;
  tag?: string | false;
  className?: string;
  ref?: Ref<HTMLButtonElement>;
  onClick(): void;
  children: ReactNode;
}) {
  const held = useHeld();
  return (
    <button ref={props.ref} className={`pxdest${props.className ? ` ${props.className}` : ''}`} type="button" aria-label={props.label} onClick={props.onClick}>
      <span className="pxkey" aria-hidden="true">
        {held}
        {props.k}
      </span>
      {props.children}
      {props.tag !== undefined && <span className="pxtags">{props.tag && <span>{props.tag}</span>}</span>}
    </button>
  );
}

/** After a send, the item can still get a milestone or a date, without slowing the one-click path. */
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

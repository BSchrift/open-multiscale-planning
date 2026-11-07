// Process: one Inbox item at a time, sent to a project or One offs in one click. Every choice commits at once and
// keeps its exact reverse, so Undo can step back as far as you like. The desktop card and the phone card differ:
// on phone the destinations sit low, in thumb reach, and other projects open in a sheet.
//
// params.planning is the week being planned, so Add to this week adds to that plan; params.item opens on one item.

import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { formatTimeOfDay, formatWeekday, formatWeekRange, nowInstant } from '../../../core/dates';
import { applyPlanChange } from '../../../core/plan';
import type { PlanChange, ProjectPlan } from '../../../core/plan';
import type { InboxRow } from '../../../core/queries';
import { getRecord, setWeekPick, weekPickId } from '../../../core/records';
import type { Writer } from '../../../core/records';
import { offers, slotInstants } from '../../../core/slots';
import { closeTask } from '../../../core/tasks';
import type { Fields, LocalDate, Minutes } from '../../../core/types';
import type { ScreenProps } from '../../app/registry';
import { useApp, useMutation, useQuery, useToday } from '../../app/store';
import { EstimateSlider } from '../../components/EstimateSlider';
import { MilestoneDiamond } from '../../components/MilestoneDiamond';
import { emptyDraft, OneOffDates, oneOffFields } from '../../components/oneoff';
import { Sheet } from '../../components/Sheet';
import { useDialogFocus } from '../../components/useDialogFocus';
import { loadProcess, thisWeekSlots } from './data';
import type { Destination, ProcessData } from './data';
import './process.css';

export default function Screen(props: ScreenProps) {
  const data = useQuery((sql, clock) => loadProcess(sql, clock), []).data;
  return data ? <Cards {...props} data={data} /> : null;
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

const isField = (el: Element | null) =>
  !!el && (/^(TEXTAREA|SELECT)$/.test(el.tagName) || (el.tagName === 'INPUT' && (el as HTMLInputElement).type !== 'range'));

function Cards(props: ScreenProps & { data: ProcessData }) {
  const { data, layout, close } = props;
  const planning: LocalDate | undefined = props.params.planning;
  const phone = layout === 'phone';
  const { clock } = useApp();
  const today = useToday();
  const [queue] = useState<InboxRow[]>(() => {
    const first = data.inbox.find((i) => i.id === props.params.item);
    return first ? [first, ...data.inbox.filter((i) => i !== first)] : data.inbox;
  });
  const [s, setS] = useState<Step>(START);
  const [history, setHistory] = useState<{ step: Step; reverse: PlanChange | null }[]>([]);
  const [delAsk, setDelAsk] = useState(false);
  const [picked, setPicked] = useState('');
  const [otherOpen, setOtherOpen] = useState(false);
  const [otherQ, setOtherQ] = useState('');
  const write = useMutation((w, fn: (w: Writer) => Promise<PlanChange>) => fn(w));
  const busy = useRef(false);
  const titleRef = useRef<HTMLHeadingElement>(null);

  const item = queue[s.idx];
  const est = s.est ?? item?.estimate_min ?? 0;
  const focusTitle = () => titleRef.current?.focus();

  const ref = useDialogFocus<HTMLDivElement>(() => {
    if (delAsk) setDelAsk(false);
    else if (isField(document.activeElement)) focusTitle();
    else close();
  });
  useEffect(focusTitle, [s.idx]);

  /** Runs one choice as one transaction, then shows the next card. */
  const commit = async (run: ((w: Writer) => Promise<PlanChange>) | null, next: () => Partial<Step>) => {
    if (busy.current) return;
    busy.current = true;
    const reverse = run ? await write.run(run) : null;
    busy.current = false;
    if (reverse === undefined) return;
    setHistory((h) => [...h, { step: s, reverse }]);
    setS({ ...s, idx: s.idx + 1, est: null, planOn: false, sent: null, ...next() });
    setDelAsk(false);
    setPicked('');
    setOtherOpen(false);
  };

  const send = (dest: Destination | null) => {
    if (!item) return;
    const name = dest ? dest.title : 'One offs';
    // shortcut: no estimate places 30m for a one off and 1h for a project, ask later if these prove wrong.
    const minutes = est || (dest ? 60 : 30);
    let note = '.';
    const run = async (w: Writer): Promise<PlanChange> => {
      const fields: Fields<'task'> = dest
        ? { kind: 'project', project_id: dest.plan.project.id, milestone_id: null, estimate_min: est || null }
        : oneOffFields({ ...emptyDraft(today), title: item.title, estimate: est }, today);
      const reverse = await applyPlanChange(w, { writes: [{ type: 'task', id: item.id, fields }] });
      if (!s.planOn) return reverse;
      const gone = { deleted_at: nowInstant(clock) };
      if (planning) {
        await setWeekPick(w, planning, item.id, minutes);
        note = ' and added to the plan.';
        return { writes: [{ type: 'week_pick', id: weekPickId(planning, item.id), fields: gone }, ...reverse.writes] };
      }
      const offer = offers(Math.min(minutes, 120), { kind: dest ? 'project' : 'one_off' }, await thisWeekSlots(w.sql, clock))[0];
      if (!offer) {
        note = '. No open time left this week, so it waits for planning.';
        return reverse;
      }
      const zone = clock.zone();
      const block = await w.create('time_block', { task_id: item.id, ...slotInstants(offer, zone), tz: zone });
      note = `, ${formatWeekday(offer.date)} ${formatTimeOfDay(offer.start)}.`;
      return { writes: [{ type: 'time_block', id: block, fields: gone }, ...reverse.writes] };
    };
    void commit(run, () => ({ sorted: s.sorted + 1, last: `Sent to ${name}${note}`, sent: { id: item.id, title: item.title, project: dest?.plan ?? null } }));
  };

  const skip = () => item && void commit(null, () => ({ last: 'Skipped. It stays in your Inbox.' }));
  const remove = () => item && void commit((w) => closeTask(w, item.id, 'deleted', clock), () => ({ deleted: s.deleted + 1, last: 'Deleted.' }));
  const togglePlan = () => setS({ ...s, planOn: !s.planOn });
  const back = history[history.length - 1];
  const undo = async () => {
    if (!back || busy.current) return;
    if (back.reverse) {
      busy.current = true;
      const done = await write.run((w) => applyPlanChange(w, back.reverse!));
      busy.current = false;
      if (done === undefined) return;
    }
    setHistory((h) => h.slice(0, -1));
    setS(back.step);
    setDelAsk(false);
    focusTitle();
  };

  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (otherOpen) return;
    const target = event.target as HTMLElement;
    const k = event.key.toLowerCase();
    const run = (fn: () => unknown) => {
      event.preventDefault();
      fn();
    };
    if (delAsk && (k === 'd' || (k === 'enter' && target.tagName !== 'BUTTON'))) return run(remove);
    if (isField(target) || event.metaKey || event.ctrlKey || event.altKey) return;
    if (k === 'z') return run(undo);
    if (!item) return k === 'enter' && target.tagName !== 'BUTTON' ? run(close) : undefined;
    const keys: Record<string, () => unknown> = { o: () => send(null), s: skip, d: () => setDelAsk(true), w: togglePlan };
    const dest = data.shown[Number(k) - 1];
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
  const weekToggle = (
    <button className={`pxweek${s.planOn ? ' on' : ''}`} type="button" aria-pressed={s.planOn} onClick={togglePlan}>
      <span aria-hidden="true">{s.planOn ? '✓' : '+'}</span>
      {planLabel}
    </button>
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
          <button className="btn" type="button" onClick={close}>
            Exit
          </button>
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
            </div>
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
          </button>
          <span className="small quiet">{pos}</span>
          <span className="pxbar" aria-hidden="true">
            <span style={{ width: `${pct}%` }} />
          </span>
          <button className="link small" type="button" onClick={close}>
            Exit
          </button>
        </div>
        {item ? (
          <>
            <div className="pxmain">{titleEl(item.title)}</div>
            <div className="pxgrid">
              {data.shown.map((d, i) => (
                <button key={d.plan.project.id} className="pxdest" type="button" aria-label={alt(d.title)} onClick={() => send(d)}>
                  <span className="pxkey" aria-hidden="true">
                    {i + 1}
                  </span>
                  <span>{d.title}</span>
                  <span className="pxtags">{s.planOn && <span>{planTag}</span>}</span>
                </button>
              ))}
              {data.others.length > 0 && (
                <div className="pxotherpick">
                  <select className="pxdest pxother" aria-label="Send to another project" value={picked} onChange={(e) => setPicked(e.target.value)}>
                    <option value="">Other project</option>
                    {data.others.map((d) => (
                      <option key={d.plan.project.id} value={d.plan.project.id}>
                        {`${d.title} (${d.pill})`}
                      </option>
                    ))}
                  </select>
                  {otherDest && (
                    <button className="btn pri" type="button" onClick={() => send(otherDest)}>
                      Send
                    </button>
                  )}
                </div>
              )}
            </div>
            <button className="pxdest maint" type="button" aria-label={alt('One offs')} onClick={() => send(null)}>
              <span className="pxkey" aria-hidden="true">
                O
              </span>
              <span>One offs</span>
              <span className="pxtags">{s.planOn && <span>{planTag}</span>}</span>
            </button>
            {weekToggle}
            <div className="pxopts">
              {slider}
              <div className="row">
                <button className="btn sm" type="button" onClick={skip}>
                  Skip
                </button>
                {delAsk ? (
                  deleteAsk
                ) : (
                  <button className="btn sm" type="button" onClick={() => setDelAsk(true)}>
                    Delete/done
                  </button>
                )}
              </div>
            </div>
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
        </div>
      </div>
    </div>
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

// Schedule: the week's picked work and practices, one at a time, most pressing first. Each waits as a block at its
// best time with other suggested times; it drags anywhere on a 15-minute grid and snaps to a suggestion. Place here
// puts it on the week, taking any block it lands on off to place again, and a shorter block leaves the rest to place.
// Desktop places on the week grid beside the list; phone compares days in a strip over one day, with the current task
// in a dock.

import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { keepPracticeChange, moveBlock, placeBlock, placeSession, placeWeekPractices, removeBlock, skipPractice, unscheduleBlock } from '../../../../core/blocks';
import { addDays, formatMinutes, formatTimeOfDay, formatWeekday, weekday, weekRange } from '../../../../core/dates';
import { applyPlanChange } from '../../../../core/plan';
import type { PlanChange, RecordWrite } from '../../../../core/plan';
import { weekPractices } from '../../../../core/queries';
import { sessionDay } from '../../../../core/records';
import type { Writer } from '../../../../core/records';
import { closestFit, defaultSlot, DRAWN_DAY, GRID, offers, otherOffers, placeRest, practiceSlots, slotInstants, slotNotes } from '../../../../core/slots';
import type { Slot, SlotContext, Work } from '../../../../core/slots';
import type { LocalDate, Minutes } from '../../../../core/types';
import type { Layout } from '../../../app/registry';
import { useApp, useMutation, useQuery } from '../../../app/store';
import { KeepAsk } from '../../../components/editors/KeepAsk';
import { DAY_NAMES } from '../../../components/editors/PracticeSchedule';
import type { KeepChoice } from '../../../components/editors/PracticeSchedule';
import { Sheet } from '../../../components/Sheet';
import { useToast } from '../../../components/Toast';
import { useFocusLanding } from '../../../components/useFocusLanding';
import { dayName, slotRange, WeekGrid } from '../../../components/weekgrid';
import type { GridBlock, GridGhost, PlacedBlock } from '../../../components/weekgrid';
import { DayStrip, PackedDay, weekFree } from '../../../components/week/DayStrip';
import { DragDay } from '../../week/Phone';
import { loadPlanning, weekModel } from '../model';
import { scheduleModel } from './model';
import type { SchedRow } from './model';
import './schedule.css';

interface ScheduleStepProps {
  /** The Monday being planned. */
  week: LocalDate;
  layout: Layout;
  /** Moves on to Review. */
  onContinue(): void;
}

const { from: DAY_FROM, to: DAY_TO } = DRAWN_DAY;
const same = (a: Slot, b: Slot) => a.date === b.date && a.start === b.start && a.end === b.end;
/** 'A', 'A and B', 'A, B and C' */
const listed = (names: readonly string[]) => (names.length < 2 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

export function ScheduleStep(props: ScheduleStepProps) {
  const { week, layout } = props;
  const phone = layout === 'phone';
  const { clock } = useApp();
  const toast = useToast();
  const zone = clock.zone();
  const data = useQuery((sql) => loadPlanning(sql, clock, week), [week]).data;
  const sessions = useQuery((sql) => weekPractices(sql, weekRange(week, zone)), [week]).data;
  const { run } = useMutation((w, fn: (w: Writer) => Promise<PlanChange>) => fn(w));

  /** The task chosen from the list, else the first with time to place. */
  const [selected, setSelected] = useState<string | null>(null);
  /** A placed block being changed. */
  const [editId, setEditId] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ key: string; slot: Slot } | null>(null);
  // Forgotten on leaving the step, so the guided list starts fresh.
  const [skipped, setSkipped] = useState<readonly string[]>([]);
  const [ask, setAsk] = useState<{ blockId: string; wasMin: Minutes } | null>(null);
  /** Phone: the day looked at, while it differs from the current block's. */
  const [look, setLook] = useState<{ key: string; date: LocalDate } | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [practicesOpen, setPracticesOpen] = useState(false);
  const lenFrom = useRef<PlacedBlock | null>(null);
  const lenId = useId();
  const land = useFocusLanding();
  const listRef = useRef<HTMLOListElement>(null);
  const noneRef = useRef<HTMLHeadingElement>(null);
  // The app's toast sits under a phone flow, so phone says it above the dock, as Pick tasks does.
  const [flash, setFlash] = useState<{ text: string; undo?: () => Promise<unknown> } | null>(null);
  useEffect(() => {
    if (!flash) return;
    const timer = setTimeout(() => setFlash(null), flash.undo ? 5000 : 3500);
    return () => clearTimeout(timer);
  }, [flash]);
  const notify = (text: string, undo?: () => Promise<unknown>) => (phone ? setFlash({ text, ...(undo ? { undo } : {}) }) : toast.show(text, undo ? { undo } : {}));

  if (!data || !sessions) return null;
  const model = weekModel(data, clock);
  const s = scheduleModel(data, model, sessions, clock);
  const ctx = model.slot;
  const blockOf = (id: string | null) => (id ? s.blocks.find((b) => b.id === id) : undefined);
  /** The row a block belongs to: its task's or its practice's. */
  const rowId = (x: PlacedBlock) => x.task_id ?? x.practice_id;

  // On phone, a block outside the list, such as a practice session, can be selected too.
  const edited = blockOf(editId);
  const other = phone && edited && !s.rows.some((r) => r.id === rowId(edited)) ? edited : undefined;
  const cur = other ? undefined : (s.rows.find((r) => r.id === selected) ?? s.rows.find((r) => r.toPlace > 0 && !skipped.includes(r.id)));
  const editB = other ?? (cur && (edited && rowId(edited) === cur.id ? edited : cur.toPlace <= 0 ? cur.blocks[cur.blocks.length - 1] : undefined));
  const work: Work = cur?.work ?? { kind: editB?.kind === 'one_off' ? 'one_off' : 'project' };
  // While a block changes, its own time is free.
  const ctxOut: SlotContext = editB ? { ...ctx, placed: ctx.placed.filter((p) => p.id !== editB.id) } : ctx;
  const draftKey = cur && !editB ? `${cur.id}:${cur.toPlace}` : '';
  // A practice is suggested on its own days at its usual time, as Place the rest would put it.
  const usual = cur?.practice && !editB ? practiceSlots(cur.practice, ctx, model.weekPlan?.skipped_sessions ?? []) : null;
  const draftSlot =
    !cur || editB ? null : draft?.key === draftKey ? draft.slot : (usual?.[0] ?? defaultSlot(Math.min(cur.toPlace, cur.length), cur.work, ctx));
  const b: Slot | null = editB ?? draftSlot;
  // Placing takes what the draft overlaps off the calendar, to place again. Until then it only floats over them, and
  // what's under way or done with stays.
  const bumped = !draftSlot ? [] : s.blocks.filter((x) => !x.past && x.date === draftSlot.date && x.start < draftSlot.end && draftSlot.start < x.end);
  const bumpedNames = listed([...new Set(bumped.map((x) => x.title))]);
  const len = b ? b.end - b.start : 0;
  const found = !b ? [] : usual ? usual.map((x) => ({ ...x, end: x.start + len })) : offers(len, work, ctxOut);
  const others = !b ? [] : usual ? found.filter((x) => !same(x, b)).slice(0, 4) : otherOffers(b, work, ctxOut);
  const curKey = editB ? `b${editB.id}` : cur ? `c${cur.id}` : 'none';
  const firstDay = ctx.earliest.date > week ? ctx.earliest.date : week;
  const day = look?.key === curKey ? look.date : (b?.date ?? look?.date ?? (firstDay > addDays(week, 6) ? week : firstDay));
  const rest = s.rows.filter((r) => r.toPlace > 0 && !skipped.includes(r.id));
  const placedCount = s.rows.filter((r) => r.toPlace <= 0).length;
  const progress = `${placedCount} of ${s.rows.length} placed`;

  const reset = () => {
    setDraft(null);
    setAsk(null);
    setLook(null);
  };
  const pick = (r: SchedRow) => {
    reset();
    setListOpen(false);
    setSelected(r.id);
    setEditId(r.toPlace <= 0 ? (r.blocks[r.blocks.length - 1]?.id ?? null) : null);
    setSkipped(skipped.filter((id) => id !== r.id));
  };
  const selectBlock = (x: PlacedBlock) => {
    if (!phone && !s.rows.some((r) => r.id === rowId(x))) return;
    setSelected(rowId(x));
    setEditId(x.id);
    setDraft(null);
    setLook(null);
  };
  // Desktop: placing, skipping or finishing with a task closes its row, so focus moves on to the next one.
  const landOnCurrent = () => !phone && land(() => listRef.current?.querySelector<HTMLElement>('[aria-current="step"]') ?? noneRef.current);
  const skip = () => {
    landOnCurrent();
    if (cur) setSkipped([...skipped, cur.id]);
    setSelected(null);
    setEditId(null);
    reset();
  };
  const done = () => {
    landOnCurrent();
    setEditId(null);
    setSelected(cur && cur.toPlace > 0 ? cur.id : null);
    reset();
  };

  const place = async () => {
    if (!cur || !draftSlot) return;
    landOnCurrent();
    const times = slotInstants(draftSlot, zone);
    let refused = false;
    const reverse = await run(async (w) => {
      const placed = await (cur.practice ? placeSession(w, cur.id, times, clock) : placeBlock(w, cur.id, times, clock));
      // A practice has one session a day, so a day with one refuses another, and nothing else moves either.
      if (!placed.writes.length) {
        refused = true;
        return { writes: [] };
      }
      const writes: RecordWrite[] = [];
      for (const x of bumped) writes.unshift(...(await unscheduleBlock(w, x.id, week, clock)).writes);
      return { writes: [...placed.writes, ...writes] };
    });
    if (refused) return notify(`${cur.title} is already on ${DAY_NAMES[weekday(draftSlot.date)]}.`);
    if (!reverse) return;
    if (bumped.length) notify(`Took ${bumpedNames} off the calendar to place again`, () => run((w) => applyPlanChange(w, reverse)));
    reset();
    setEditId(null);
    setSelected(cur.toPlace - len > 0 ? cur.id : null);
  };
  const remove = async (x: PlacedBlock) => {
    const reverse = await run((w) => removeBlock(w, x.id));
    if (!reverse) return;
    notify(`Removed ${x.title}`, () => run((w) => applyPlanChange(w, reverse)));
    setEditId(null);
    if (rowId(x)) setSelected(rowId(x));
    reset();
  };
  /**
   * Saves a placed block's new time, and after a practice moves, asks whether that's for every week. The task being
   * placed stays current: only a tap or click selects a block.
   */
  const changeBlock = (x: PlacedBlock, slot: Slot) => {
    if (same(x, slot)) return;
    // A session moved to another day is for this week only; a day with another of its sessions refuses it.
    if (x.practice_id && slot.date !== x.date) {
      setAsk(null);
      if (s.blocks.some((o) => o.id !== x.id && o.practice_id === x.practice_id && o.date === slot.date)) {
        return notify(`${x.title} is already on ${DAY_NAMES[weekday(slot.date)]}.`);
      }
      const day = sessionDay(x.id, x.practice_id) ?? x.date;
      const text = `Moved ${DAY_NAMES[weekday(day)]}'s ${x.title} to ${formatWeekday(slot.date)} ${formatTimeOfDay(slot.start)}, this week only.`;
      return run((w) => moveBlock(w, x.id, slotInstants(slot, zone))).then((reverse) => reverse && notify(text, () => run((w) => applyPlanChange(w, reverse))));
    }
    const saved = run((w) => moveBlock(w, x.id, slotInstants(slot, zone)));
    setAsk(x.practice_id ? { blockId: x.id, wasMin: ask?.blockId === x.id ? ask.wasMin : x.end - x.start } : null);
    return saved;
  };
  const moveTo = (o: { date: LocalDate; start: number }) => {
    const slot = { date: o.date, start: o.start, end: o.start + len };
    if (editB) changeBlock(editB, slot);
    else setDraft({ key: draftKey, slot });
    setLook({ key: curKey, date: o.date });
  };
  const keepPractice = async (choice: KeepChoice) => {
    const a = ask;
    const x = blockOf(a?.blockId ?? null);
    setAsk(null);
    if (!a || !x?.practice_id) return;
    const reverse = await run((w) => keepPracticeChange(w, a.blockId, choice.keep, clock));
    if (reverse) notify(choice.done, () => run((w) => applyPlanChange(w, reverse)));
  };
  const togglePractice = (id: string, off: boolean) => void run((w) => skipPractice(w, week, id, off, clock));
  /** Tasks at their suggested times, then the practices around them. */
  const placeTheRest = async () => {
    const { placed } = placeRest(
      rest.filter((r) => r.task).map((r) => ({ id: r.id, title: r.title, minutes: r.toPlace, ...r.work })),
      ctx,
    );
    let count = placed.length;
    const reverse = await run(async (w) => {
      const writes: RecordWrite[] = [];
      for (const p of placed) writes.unshift(...(await placeBlock(w, p.id, slotInstants(p, zone), clock)).writes);
      if (rest.some((r) => r.practice)) {
        const sessions = await placeWeekPractices(w, week, clock);
        count += sessions.writes.filter((x) => x.type === 'time_block').length;
        writes.unshift(...sessions.writes);
      }
      return { writes };
    });
    if (!reverse) return;
    if (!count) return notify('No open time is left for the rest.');
    landOnCurrent();
    setSelected(null);
    setEditId(null);
    reset();
    notify(`Placed ${count} ${count === 1 ? 'block' : 'blocks'}`, () => run((w) => applyPlanChange(w, reverse)));
  };

  // What the current task or block says about itself.
  const title = cur?.title ?? editB?.title ?? '';
  const when = b ? `${dayName(b.date)}, ${slotRange(b)} (${formatMinutes(len)})` : '';
  const context = cur ? cur.context : editB?.kind === 'practice' ? 'Practice' : editB?.kind === 'one_off' ? 'One offs' : 'Project';
  const amount =
    !cur || editB || !draftSlot
      ? ''
      : cur.estimateLeft != null && len > cur.estimateLeft
        ? `${formatMinutes(len - cur.estimateLeft)} over your estimate`
        : len < cur.toPlace
          ? `${formatMinutes(cur.toPlace - len)} more of this ${cur.practice ? 'practice' : 'task'} stays to place`
          : '';
  const notes = b ? slotNotes({ ...b, id: editB?.id ?? 'draft' }, work, { ...ctx, placed: ctx.placed.filter((p) => !bumped.some((x) => x.id === p.id)) }) : [];
  if (bumped.length) notes.push(`Placing here takes ${bumpedNames} off the calendar to place again.`);
  const skipLabel = cur?.blocks.length ? 'Leave the rest for later' : 'Skip for now';
  const none = !b && !(cur && !draftSlot);
  const noneTitle = s.rows.length ? 'All tasks are placed' : 'Nothing is picked yet';
  const noneText = s.rows.length ? `${phone ? 'Tap' : 'Click'} any task or block to change it.` : "Go back to Pick to add tasks, or carry on with what's placed.";
  const askBlock = blockOf(ask?.blockId ?? null);
  const askPractice = askBlock && data.records.practices.find((p) => p.id === askBlock.practice_id);
  const keepAsk = askBlock && askPractice && ask && (
    <KeepAsk practice={askPractice} slot={askBlock} day={weekday(askBlock.date)} wasMin={ask.wasMin} onKeep={(c) => void keepPractice(c)} onNo={() => setAsk(null)} />
  );
  // A practice's other sessions this week, as Place the rest would put them.
  const also = cur?.practice && !editB && usual && usual.length > 1 ? usual.filter((x) => !same(x, usual[0]!)) : [];
  const alsoText = also.length ? `Also this week: ${new Intl.ListFormat('en-GB').format(also.map((x) => `${formatWeekday(x.date)} ${formatTimeOfDay(x.start)}`))}.` : '';
  const oneOffCls = (cur?.oneOff ?? editB?.kind === 'one_off') ? 'mhead' : '';
  const curKind = cur?.practice ? 'practice' : cur?.oneOff ? 'one_off' : 'project';

  const rowParts = (r: SchedRow, i: number) => {
    const on = r === cur;
    const last = r.blocks[r.blocks.length - 1];
    const isSkipped = skipped.includes(r.id);
    const sub = isSkipped ? 'Skipped' : last ? `${formatWeekday(last.date)} ${formatTimeOfDay(last.start)}${r.blocks.length > 1 ? `, and ${r.blocks.length - 1} more` : ''}` : '';
    return { on, sub: on ? '' : sub, mark: on ? '▸' : r.toPlace <= 0 ? '✓' : isSkipped ? '–' : String(i + 1) };
  };

  const buttons = (cls: string) =>
    editB ? (
      <div className="row">
        <button className={`btn pri ${cls}`} type="button" onClick={done}>
          Done
        </button>
        <button className={`btn ${cls}`} type="button" onClick={() => void remove(editB)}>
          Remove from calendar
        </button>
      </div>
    ) : (
      <div className="row">
        {draftSlot && (
          <button className={`btn pri ${cls}`} type="button" onClick={() => void place()}>
            Place here
          </button>
        )}
        <button className={`btn ${cls}`} type="button" onClick={skip}>
          {skipLabel}
        </button>
      </div>
    );
  const said = (
    <>
      {amount && <div className="small">{amount}</div>}
      {alsoText && <div className="small">{alsoText}</div>}
      {cur?.practice && !editB && usual?.[0]?.note && <div className="small schnote">{usual[0].note}</div>}
      {notes.map((n) => (
        <div key={n} className="small schnote">
          {n}
        </div>
      ))}
      {cur && !draftSlot && !editB && <div className="small schnote">There's no free time left this week.</div>}
    </>
  );

  if (!phone) {
    const gridBlocks: GridBlock[] = s.blocks.map((x) => (x.id === editB?.id ? { ...x, draft: true } : { ...x, fixed: x.past }));
    if (cur && draftSlot) gridBlocks.push({ ...draftSlot, id: 'draft', title: cur.title, kind: curKind, draft: true });
    const ghosts: GridGhost[] = others.map((o) => ({ ...o, label: `${dayName(o.date)}, ${formatTimeOfDay(o.start)}`, onAccept: () => moveTo(o) }));
    return (
      <div className="planlay">
        <div className="planleft stack">
          {keepAsk}
          {none && (
            <div className="stack8">
              <h2 ref={noneRef} tabIndex={-1}>
                {noneTitle}
              </h2>
              <p className="small quiet">{noneText}</p>
              <div>
                <button className="btn pri" type="button" onClick={props.onContinue}>
                  Continue to review
                </button>
              </div>
            </div>
          )}
          <div className="stack8">
            <div className="small quiet">{progress}</div>
            <ol ref={listRef} className="schedlist card">
              {s.rows.map((r, i) => {
                const { on, sub, mark } = rowParts(r, i);
                return (
                  <li key={r.id} className={`schedrow${on ? ' cur' : ''}${r.oneOff ? ' is-maint' : ''}`}>
                    <button className="schedbtn" type="button" aria-current={on ? 'step' : undefined} onClick={() => pick(r)}>
                      <span className="schedmark" aria-hidden="true">
                        {mark}
                      </span>
                      <span>
                        <span className={`subline${on ? ' strong' : ''}`}>{r.title}</span>
                        {sub && <span className="subline small">{sub}</span>}
                      </span>
                    </button>
                    {on && (
                      <div className="scheddetail stack8">
                        <div className="small quiet">{context}</div>
                        {b && <div className="strong">{when}</div>}
                        {said}
                        {buttons('sm')}
                        <p className="small quiet">Drag the block anywhere, or click a suggested time. Drag its bottom edge to change the time.</p>
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
            {rest.length > 0 && (
              <div>
                <button className="btn sm" type="button" onClick={() => void placeTheRest()}>
                  Place the rest at suggested times
                </button>
              </div>
            )}
          </div>
          {s.practices.length > 0 && (
            <div className="stack8">
              <button className="link small schlinkbtn" type="button" aria-expanded={practicesOpen} onClick={() => setPracticesOpen(!practicesOpen)}>
                Skip a practice this week
              </button>
              {practicesOpen && (
                <div className="card stack8">
                  {s.practices.map((p) => (
                    <div key={p.id} className="small">
                      <div className="between">
                        <span>{p.title}</span>
                        <span className="quiet">{p.meta}</span>
                      </div>
                      <button className="link small" type="button" aria-label={`${p.skipped ? 'Include this week' : 'Skip this week'}, ${p.title}`} onClick={() => togglePractice(p.id, !p.skipped)}>
                        {p.skipped ? 'Include this week' : 'Skip this week'}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
        <div className="planright card">
          <WeekGrid
            ctx={ctx}
            blocks={gridBlocks}
            ghosts={ghosts}
            editing
            lockPast
            onChange={(id, slot) => {
              const x = blockOf(id);
              if (id === 'draft') setDraft({ key: draftKey, slot });
              else if (x) return changeBlock(x, slot);
            }}
            onRemove={(id) => {
              const x = blockOf(id);
              if (x) void remove(x);
            }}
            onOpen={(id) => {
              const x = blockOf(id);
              if (id === 'draft') void place();
              else if (x) selectBlock(x);
            }}
          />
        </div>
      </div>
    );
  }

  // Phone
  const kind = work.kind;
  const planned = ctx.placed.reduce((sum, p) => sum + p.end - p.start, 0);
  const floorOf = (date: LocalDate) =>
    date > ctx.earliest.date ? DAY_FROM : date < ctx.earliest.date ? DAY_TO : Math.max(DAY_FROM, Math.ceil(ctx.earliest.minutes / GRID) * GRID);
  const away = !!b && b.date !== day;
  const here = found.find((o) => o.date === day);
  const lenMax = b ? Math.max(len, Math.min(480, DAY_TO - b.start)) : 0;
  const setLength = (minutes: number) => {
    if (!b) return;
    const slot = { ...b, end: b.start + minutes };
    if (!editB) return setDraft({ key: draftKey, slot });
    lenFrom.current ??= editB;
    void run((w) => moveBlock(w, editB.id, slotInstants(slot, zone)));
  };
  // A practice asks once the slider is let go.
  const lengthDone = () => {
    const was = lenFrom.current;
    lenFrom.current = null;
    if (was?.practice_id) setAsk({ blockId: was.id, wasMin: was.end - was.start });
  };

  return (
    <>
      <div className="scroll">
        <div className="stack8">
          <div className="weektop">
            <div className="card stack8">
              <div className="small">
                <span className="strong">{formatMinutes(weekFree(week, ctx))} free</span>
                <span className="quiet"> of {formatMinutes(model.open)} available, </span>
                {formatMinutes(planned)} planned
              </div>
              <div className="small" aria-hidden="true">
                <span className="skey" />
                free
                <span className="skey planned" />
                planned
                <span className="skey busy" />
                busy
                <span className="skey draft" />
                this task
                <span className="skey sug" />
                suggested
              </div>
              <DayStrip
                week={week}
                label="Compare days"
                selected={day}
                ctx={ctx}
                placed={ctxOut.placed}
                draft={b}
                hint={(date) => {
                  const o = found.find((x) => x.date === date);
                  return { suggested: o, noFit: !!cur && !o && b?.date !== date && !!b && closestFit(date, b.start, len, kind, ctxOut) === null };
                }}
                suggestions
                onPick={(date) => setLook({ key: curKey, date })}
              />
            </div>
          </div>
          <PackedDay date={day} ctx={ctx} />
          <h3 className="schday">{dayName(day)}</h3>
          <p className="small quiet">Drag the block anywhere, or tap a suggested time. Drag its bottom edge to change the time.</p>
          <BringIntoView watch={`${curKey}|${day}`}>
            <DragDay
              date={day}
              ctx={ctx}
              info={[]}
              floor={floorOf(day)}
              blocks={s.blocks.filter((x) => x.date === day)}
              moving={cur && draftSlot && draftSlot.date === day ? { title: cur.title, kind: curKind, slot: draftSlot } : null}
              editing
              ghosts={others
                .filter((o) => o.date === day)
                .map((o) => ({ ...o, end: o.start + len, label: `${dayName(o.date)}, ${formatTimeOfDay(o.start)}`, onAccept: () => moveTo(o) }))}
              selected={editB?.id ?? null}
              onMoving={(slot) => setDraft({ key: draftKey, slot })}
              onDone={() => void place()}
              onChange={changeBlock}
              onOpen={(id) => {
                const x = blockOf(id);
                if (x) selectBlock(x);
              }}
            />
          </BringIntoView>
        </div>
      </div>
      <div className="pksum">
        {flash && (
          <div className="pktoast" role="status">
            <span>{flash.text}</span>
            {flash.undo && (
              <button
                type="button"
                onClick={() => {
                  void flash.undo?.();
                  setFlash(null);
                }}
              >
                Undo
              </button>
            )}
          </div>
        )}
        <div className="flowdock stack8">
          <button className="flowsum" type="button" aria-label={`All picked tasks, ${progress}`} onClick={() => setListOpen(true)}>
            <span className="small quiet">{progress}</span>
            <span className="small strong schlink">All tasks ›</span>
          </button>
          {none ? (
            <div>
              <div className="strong">{noneTitle}</div>
              <p className="small quiet">{noneText}</p>
            </div>
          ) : (
            <>
              <div className={oneOffCls}>
                <div className="strong">{title}</div>
                <div className="small quiet">{context}</div>
                {b && (
                  <div className="small strong" role="status">
                    {when}
                  </div>
                )}
                {said}
              </div>
              {b && (
                <div className="row schlen">
                  <label className="small quiet" htmlFor={lenId}>
                    Length
                  </label>
                  <input
                    id={lenId}
                    type="range"
                    min={GRID}
                    max={lenMax}
                    step={GRID}
                    value={len}
                    aria-valuetext={formatMinutes(len)}
                    onChange={(e) => setLength(Number(e.target.value))}
                    onPointerUp={lengthDone}
                    onKeyUp={lengthDone}
                  />
                  <span className="small strong">{formatMinutes(len)}</span>
                </div>
              )}
              {away && b ? (
                <div className="row">
                  <button className="btn pri grow" type="button" onClick={() => moveTo({ date: day, start: here?.start ?? closestFit(day, b.start, len, kind, ctxOut) ?? b.start })}>
                    Move to {dayName(day)}
                  </button>
                  <button className="btn grow" type="button" onClick={() => setLook({ key: curKey, date: b.date })}>
                    Back to {dayName(b.date)}
                  </button>
                </div>
              ) : (
                buttons('grow')
              )}
            </>
          )}
        </div>
      </div>
      {listOpen && (
        <Sheet label="All picked tasks" tall onClose={() => setListOpen(false)}>
          <div className="between">
            <div>
              <h2>All tasks</h2>
              <div className="small quiet">{progress}</div>
            </div>
            <button className="btn" type="button" onClick={() => setListOpen(false)}>
              Close
            </button>
          </div>
          {s.rows.length === 0 && <p className="small quiet">Nothing is picked yet.</p>}
          <div>
            {s.rows.map((r, i) => {
              const { on, sub, mark } = rowParts(r, i);
              return (
                <button key={r.id} className="projbtn morerow" type="button" aria-current={on ? 'step' : undefined} onClick={() => pick(r)}>
                  <span className="small schmark" aria-hidden="true">
                    {mark}
                  </span>
                  <span className={`schname${r.oneOff ? ' mhead' : ''}`}>
                    <span className={`block${on ? ' strong' : ''}`}>{r.title}</span>
                    {sub && <span className="small quiet block">{sub}</span>}
                  </span>
                </button>
              );
            })}
          </div>
          {rest.length > 0 && (
            <button className="btn" type="button" onClick={() => void placeTheRest().then(() => setListOpen(false))}>
              Place the rest at suggested times
            </button>
          )}
          {s.practices.length > 0 && (
            <div className="stack8">
              <h3>Skip a practice this week</h3>
              {s.practices.map((p) => (
                <div key={p.id} className="rowline">
                  <div className="between">
                    <span>{p.title}</span>
                    <span className="small quiet">{p.meta}</span>
                  </div>
                  <div>
                    <button className="btn" type="button" aria-label={`${p.skipped ? 'Include this week' : 'Skip this week'}, ${p.title}`} onClick={() => togglePractice(p.id, !p.skipped)}>
                      {p.skipped ? 'Include this week' : 'Skip this week'}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Sheet>
      )}
      {keepAsk && (
        <Sheet label="Use this in future weeks too?" onClose={() => setAsk(null)}>
          {keepAsk}
        </Sheet>
      )}
    </>
  );
}

/**
 * A new task or day brings its block, or else a suggested time, into view once, just below the sticky day strip.
 * Scrolling after that stays with the person.
 */
function BringIntoView(props: { watch: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const target = ref.current?.querySelector('.dragblock:not(.calm), .ghost');
    const scroller = ref.current?.closest('.scroll');
    if (!target || !scroller) return;
    const below = scroller.querySelector('.weektop')?.getBoundingClientRect().bottom ?? scroller.getBoundingClientRect().top;
    scroller.scrollTop += target.getBoundingClientRect().top - below - 24;
  }, [props.watch]);
  return (
    <div ref={ref} className="card">
      {props.children}
    </div>
  );
}

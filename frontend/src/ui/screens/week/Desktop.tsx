// Week on desktop: the header with week arrows, how the week's time is used, and the grid with To schedule above
// it. Its cards drag onto a day, or open with suggested times. A task's block opens the task's popup, with the block's
// section at its top; a practice's session or planning opens its details beside the grid. Editing adds a list of tasks
// to place on the left, and the grid's blocks drag, resize, come off with ×, or drag back to To schedule. Planning
// from Choose another time waits on the grid with Place here above it, and the week arrows carry it to another week.
// Zoom out and Zoom in above the grid step its hours as Today's calendar does.

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { addDays, addWeeks, diffDays, formatMinutes, formatTimeOfDay, localMinutes, today, weekStart } from '../../../core/dates';
import { FIRST_BLOCK_MIN } from '../../../core/plan';
import { defaultSlot, DRAWN_DAY, GRID, otherOffers, slotNotes } from '../../../core/slots';
import type { Slot, Work } from '../../../core/slots';
import { onceWhen } from '../../../core/schedule';
import type { Minutes } from '../../../core/types';
import { useNav } from '../../app/nav';
import { useApp } from '../../app/store';
import { BlockDetail } from '../../components/blocks/BlockDetail';
import { BlockSection } from '../../components/blocks/BlockSection';
import { PlanPrompt } from '../../components/PlanPrompt';
import { PlanningSet } from '../../components/planning/PlanningRow';
import { PlanningTimes } from '../../components/planning/PlanningTimes';
import { planningWeekOf } from '../../../core/planning';
import { isTaskBlock, KIND_WORD } from '../../components/blocks/describe';
import { usePlanningActions } from '../../components/planning/usePlanning';
import { TimeUse } from '../../components/week/TimeUse';
import { dayName, dragCard, slotRange } from '../../components/weekgrid';
import { HoldWeekGrid } from '../../components/weekgrid/HoldWeekGrid';
import type { GridBlock, GridGhost } from '../../components/weekgrid';
import { landOn, rowItem } from './data';
import type { AddRow, LaneItem, Placeable } from './data';
import { LaneActions, LaneCard, laneCount, laneWords } from './lane';
import type { WeekProps } from './index';
import { useWeekActions } from './useWeekActions';
import { WeekArrows } from '../../components/WeekArrows';
import { PracticeAsk } from './parts';
import { useLanding } from './landing';
import { shortened, SplitAsk } from '../../components/editors/SplitAsk';
import type { Shortened } from '../../components/editors/SplitAsk';
import { TaskPopupFor } from '../task';
import { Button } from '../../components/ds/Button';
import { Icon } from '../../components/ds/Icon';
import { ZoomButtons } from '../../components/CalendarZoom';

/** The grid's id for the planning block being placed. */
const PLANNING = 'planning';

export function DesktopWeek(props: WeekProps & { zoom: number; onZoom(zoom: number): void }) {
  const { data, model, offset, editing } = props;
  const { clock, platform } = useApp();
  const nav = useNav();
  const act = useWeekActions();
  const planning = usePlanningActions();
  const [openBlock, setOpenBlock] = useState<string | null>(null);
  /** A task's block opened in the task's popup. */
  const [pop, setPop] = useState<{ block: string; task: string } | null>(null);
  /** A block Move took from its popup, which takes focus once editing draws it, ready for the arrow keys. */
  const moving = useRef<string | null>(null);
  useEffect(() => {
    const id = moving.current;
    const el = id && right.current?.querySelector<HTMLElement>(`[data-id="${id}"]`);
    if (!el) return;
    moving.current = null;
    el.focus();
  });
  const [openItem, setOpenItem] = useState<string | null>(null);
  const [planningFor, setPlanningFor] = useState<string | null>(null);
  /** A card being dragged over a day, and where it would land. */
  const [dropAt, setDropAt] = useState<{ item: LaneItem; slot: Slot } | null>(null);
  const [selected, setSelected] = useState<string | null>(props.place);
  const [draft, setDraft] = useState<Slot | null>(null);
  const [ask, setAsk] = useState<{ blockId: string; wasMin: Minutes } | null>(null);
  // Landing on placed blocks asks first: keep both, replace them, or leave it.
  const { landing, takeOff, asking } = useLanding(model.blocks, data.week);
  // A task's block made shorter asks what about the rest, until answered or another block is chosen.
  const [split, setSplit] = useState<Shortened | null>(null);
  const [moved, setMoved] = useState<string | null>(null);
  // Edit and Done editing each go once pressed, so focus moves to the other one rather than the page.
  const editBtn = useRef<HTMLButtonElement>(null);
  const doneBtn = useRef<HTMLButtonElement>(null);
  const swapFocus = useRef(false);
  useEffect(() => {
    if (!swapFocus.current) return;
    swapFocus.current = false;
    (editing ? doneBtn : editBtn).current?.focus();
  }, [editing]);
  const right = useRef<HTMLDivElement>(null);
  const isThis = offset === 0;

  // Choose another time for planning: its block waits at the time it was given or carried to, on today if that day has
  // gone, beside the week's blocks, which stay put meanwhile. Focus goes to it, so keys move it at once.
  const plan = props.planning;
  const [planAt, setPlanAt] = useState<Slot | null>(() => {
    if (!plan) return null;
    const from = plan.at;
    if (!from) return defaultSlot(plan.minutes, { kind: 'project' }, model.ctx);
    const { earliest } = model.ctx;
    const date = from.date < earliest.date ? earliest.date : from.date > plan.last ? plan.last : from.date;
    return landOn(date, from, 'project', model.ctx, date === earliest.date ? Math.ceil(earliest.minutes / GRID) * GRID : DRAWN_DAY.from);
  });
  useEffect(() => {
    if (plan) right.current?.querySelector<HTMLElement>(`[data-id="${PLANNING}"]`)?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const late = !!plan && !!planAt && planAt.date > plan.last;
  const placePlanning = async () => {
    if (!plan || !planAt || late || !(await planning.place(plan, planAt))) return;
    setPlanAt(null);
    props.donePlacing();
    if (plan.flow) props.close();
  };
  const cancelPlanning = () => {
    props.donePlacing();
    props.close();
  };

  const rows = model.addGroups.flatMap((g) => g.rows);
  const cur = editing && selected ? rows.find((r) => r.task.id === selected) : undefined;
  // Choose a time on a card with no row to add it from, such as a practice's session.
  const curCard = editing && selected && !cur ? model.unscheduled.find((x) => x.id === selected) : undefined;
  const drafted: Placeable | undefined = cur ? rowItem(cur) : curCard;
  // A new pick starts at its best time, which never overlaps an event or another block; a card, at its first suggested
  // time.
  useEffect(() => {
    const first = curCard?.offers[0];
    if (cur) setDraft((d) => d ?? defaultSlot(Math.min(cur.left, FIRST_BLOCK_MIN), cur.work, model.ctx));
    else if (curCard) setDraft((d) => d ?? (first ? { date: first.date, start: first.start, end: first.end } : defaultSlot(curCard.length, curCard.work, model.ctx)));
    else setDraft(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drafted?.id]);

  const choose = (id: string | null) => {
    setOpenItem(null);
    setSelected(id);
    setDraft(null);
    setAsk(null);
    setSplit(null);
  };
  // The same function on every render, so the list's rows draw again only when they change.
  const chosen = useRef(choose);
  chosen.current = choose;
  const chooseLive = useCallback((id: string | null) => chosen.current(id), []);
  const stopEditing = () => {
    choose(null);
    setMoved(null);
    props.donePlacing();
    swapFocus.current = true;
    props.setEditing(false);
  };

  const onChange = async (id: string, slot: Slot) => {
    if (id === 'draft') return setDraft(slot);
    if (id === PLANNING) return setPlanAt(slot);
    const b = model.blocks.find((x) => x.id === id);
    if (!b) return;
    // A day with another of a practice's sessions refuses it before anything asks. Cancelled, the save resolves to
    // nothing, and the grid puts the block back.
    const refused = !!b.practice_id && slot.date !== b.date && model.blocks.some((x) => x.id !== b.id && x.practice_id === b.practice_id && x.date === slot.date);
    const { go, off } = refused ? { go: true, off: [] } : await landing(b.title, slot, id, b);
    if (!go) return undefined;
    // A session moved to another day is for this week only, so nothing asks about future weeks.
    if (b.practice_id && slot.date !== b.date) {
      setAsk(null);
      const moved = await act.moveSessionDay(b, slot, model.blocks);
      if (moved) takeOff(off);
      return moved;
    }
    const saved = await act.move(id, slot);
    // A failed save resolves to nothing, and the grid puts the block back; nothing else changes.
    if (!saved) return undefined;
    setMoved(id);
    setAsk(b.practice_id ? { blockId: id, wasMin: ask?.blockId === id ? ask.wasMin : b.end - b.start } : null);
    takeOff(off);
    setSplit(shortened(b, slot, { task: isTaskBlock(b.kind), underWay: !!b.now, week: data.week, title: b.title, open: split }));
    return saved;
  };
  const place = async (what: Placeable, slot: Slot) => {
    const { go, off } = await landing(what.title, slot);
    if (go && (await act.place(what, slot))) {
      takeOff(off);
      choose(null);
      props.donePlacing();
    }
  };
  const placeItem = async (item: LaneItem, slot: Slot) => {
    setOpenItem(null);
    const { go, off } = await landing(item.title, slot);
    if (go && (await act.place(item, slot))) takeOff(off);
  };
  const toggleItem = (id: string) => {
    // Planning opens its times, as it does on Today.
    if (planningWeekOf(id)) return setPlanningFor(planningWeekOf(id));
    choose(null);
    setOpenItem(openItem === id ? null : id);
  };
  const dragItem = (item: LaneItem) => ({ preview: (slot: Slot | null) => setDropAt(slot && { item, slot }), drop: (slot: Slot) => placeItem(item, slot), haptic: platform.haptic });

  const isTask = (b: GridBlock) => isTaskBlock(b.kind);
  const gridBlocks: GridBlock[] = plan ? model.blocks.map((b) => ({ ...b, fixed: true })) : model.blocks.map((b) => ({ ...b, popup: isTask(b) }));
  if (plan && planAt) gridBlocks.push({ ...planAt, id: PLANNING, title: plan.title, kind: 'planning', draft: true });
  let ghosts: GridGhost[] = [];
  const item = model.unscheduled.find((x) => x.id === openItem);
  if (item && isThis) {
    ghosts = item.offers.map((o) => ({ ...o, label: `${dayName(o.date)}, ${formatTimeOfDay(o.start)}`, onAccept: () => placeItem(item, o) }));
  }
  if (dropAt) gridBlocks.push({ ...dropAt.slot, id: 'drop', title: dropAt.item.title, kind: dropAt.item.kind, draft: true, fixed: true });
  if (drafted && draft) {
    gridBlocks.push({ ...draft, id: 'draft', title: drafted.title, kind: drafted.kind, draft: true });
    // A card's other suggested times keep a practice's session to its own day and usual time.
    const others = curCard ? curCard.offers.filter((o) => o.date !== draft.date || o.start !== draft.start) : otherOffers(draft, drafted.work, model.ctx);
    ghosts = others.map((o) => ({
      date: o.date,
      start: o.start,
      end: o.end,
      label: `${dayName(o.date)}, ${formatTimeOfDay(o.start)}`,
      onAccept: () => setDraft({ date: o.date, start: o.start, end: o.end }),
    }));
  }

  const opened = openBlock ? data.blocks.find((b) => b.id === openBlock) : undefined;
  const popRow = pop && data.blocks.find((b) => b.id === pop.block);
  const popPlaced = pop && model.blocks.find((b) => b.id === pop.block);
  // As on phone: from now on, this week or later, it can come off; this week, it moves, and Choose a time places it while
  // editing.
  const popActions =
    popPlaced && offset >= 0 && !popPlaced.past
      ? {
          onRemove: () => void act.remove(popPlaced.id, popPlaced.title),
          ...(isThis
            ? {
                move: {
                  ctx: model.ctx,
                  choose: () => {
                    moving.current = popPlaced.id;
                    props.setEditing(true);
                  },
                },
              }
            : {}),
        }
      : {};
  const lastMoved = moved ? model.blocks.find((b) => b.id === moved) : undefined;
  const anyDay = model.unscheduled.filter((x) => !x.dates);

  return (
    <div className="wide stack24 week">
      <div className="between">
        <div className="row wkhead">
          {/* Planning being placed goes to another week keeping its day and time, from this week to the week of its last day. */}
          <WeekArrows
            week={props.week}
            current={model.current}
            {...(plan ? { first: model.current, last: weekStart(plan.last) } : {})}
            onWeek={(to) => props.goWeek(to, plan && planAt ? { ...planAt, date: addDays(planAt.date, diffDays(props.week, to)) } : undefined)}
          />
          <div>
            <div className="date">{props.label}</div>
            {props.planningAt && <div className="small quiet">{props.planningAt}</div>}
            <h1>{props.title}</h1>
          </div>
        </div>
        <div className="row">
          {offset <= 0 && !editing && (
            <button className="link" type="button" onClick={() => nav.go('analytics', { week: data.week })}>
              See this week's analytics
            </button>
          )}
          {isThis && !editing && !props.gated && !plan && (
            <Button
              ref={editBtn}
              variant="primary"
              type="button"
              onClick={() => {
                swapFocus.current = true;
                props.setEditing(true);
              }}
            >
              Edit this week's plan
            </Button>
          )}
          {(offset === 0 || offset === 1) && !editing && !props.gated && !plan && (
            <Button type="button" onClick={() => void planning.start(model.thisPlanned ? addWeeks(model.current, 1) : model.current)}>
              {model.thisPlanned ? 'Plan next week' : 'Start planning'}
            </Button>
          )}
        </div>
      </div>
      {props.gated && <PlanPrompt week={data.week} />}
      {props.planningSet && <PlanningSet week={data.week} block={props.planningSet} />}
      {planningFor && <PlanningTimes for={planningFor} name={planningFor === model.current ? 'this week' : 'next week'} onClose={() => setPlanningFor(null)} />}
      {offset < 0 && <p className="small quiet">Past weeks can be viewed but not changed.</p>}

      {!editing && <TimeUse open={model.open} planned={model.planned} free={model.free} alerts={model.alerts} />}

      <div className="planlay">
        {editing && (
          <div className="planleft stack">
            <div className="stack8">
              <p className="small quiet">Hold anything from now on, then drag to move or resize it, or click <Icon name="close" size={16} /> to remove it. Changes save as you go.</p>
              <div>
                <Button ref={doneBtn} variant="primary" type="button" onClick={stopEditing}>
                  Done editing
                </Button>
              </div>
            </div>
            {ask && <PracticeAsk ask={ask} model={model} onDone={() => setAsk(null)} />}
            {split && <SplitAsk ask={split} onDone={() => setSplit(null)} />}
            {lastMoved && !drafted && (
              <div className="stack8" role="status" aria-label="Last change">
                <div className="small strong">
                  {lastMoved.title}, {dayName(lastMoved.date)}, {slotRange(lastMoved)}
                </div>
                {slotNotes(lastMoved, { kind: lastMoved.kind === 'one_off' ? 'one_off' : 'project' }, model.ctx).map((n) => (
                  <div key={n} className="small wknote">
                    {n}
                  </div>
                ))}
              </div>
            )}
            <div className="card stack">
              <div className="small quiet">Add a task to this week</div>
              {model.addGroups.map((g) => (
                <div key={g.name} className="stack8">
                  <h3>{g.name}</h3>
                  <ol className="schedlist">
                    {g.rows.map((r) =>
                      r === cur ? (
                        <AddRowItem key={r.task.id} row={r} on onChoose={chooseLive}>
                          {draft && (
                            <Placing
                              context={r.context}
                              draft={draft}
                              work={r.work}
                              model={model}
                              left={r.left}
                              hint="Hold the block, then drag it anywhere, or click a suggested time. Hold its bottom edge and drag to change the time."
                              onPlace={() => void place(rowItem(r), draft)}
                              onCancel={() => choose(null)}
                            />
                          )}
                        </AddRowItem>
                      ) : (
                        <AddRowItem key={r.task.id} row={r} on={false} onChoose={chooseLive} />
                      ),
                    )}
                  </ol>
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="planright" ref={right}>
          {plan && planAt && (
            <div className="panel wkpanel" role="group" aria-label={`Placing ${plan.title}`}>
              <Placing
                context={plan.title}
                draft={planAt}
                work={{ kind: 'project' }}
                model={model}
                problem={late ? `Too late: plan it by ${dayName(plan.last)}.` : undefined}
                hint="Hold the block, then drag it anywhere, or use the arrow keys and Enter. The week arrows take it to another week. Hold its bottom edge and drag to change its length."
                onPlace={() => void placePlanning()}
                onCancel={cancelPlanning}
              />
            </div>
          )}
          {curCard && draft && (
            <div className="panel wkpanel" role="group" aria-label={`Placing ${curCard.title}`}>
              <Placing
                context={curCard.title}
                draft={draft}
                work={curCard.work}
                model={model}
                hint="Hold the block, then drag it anywhere, or click a suggested time. Hold its bottom edge and drag to change the time."
                onPlace={() => void place(curCard, draft)}
                onCancel={() => {
                  choose(null);
                  props.donePlacing();
                }}
              />
            </div>
          )}
          {item && (
            <div className="panel stack8 wkpanel" role="group" aria-label={item.title}>
              <LaneActions
                item={item}
                canPlace={isThis}
                onPlace={(slot) => placeItem(item, slot)}
                onChoose={() => {
                  props.setEditing(true);
                  choose(item.id);
                }}
                onSkipDay={() => {
                  setOpenItem(null);
                  void act.skipDay(item, data.week);
                }}
                onTakeOut={() => {
                  setOpenItem(null);
                  void act.takeOut(item, data.week);
                }}
                onDone={() => {
                  setOpenItem(null);
                  void act.markDone(item.task!);
                }}
                onClose={() => setOpenItem(null)}
              />
            </div>
          )}
          {opened && !editing && (
            <div className="wkpanel">
              <BlockDetail
                block={opened}
                onClose={() => {
                  setOpenBlock(null);
                  right.current?.querySelector<HTMLElement>(`[data-id="${opened.id}"]`)?.focus();
                }}
              />
            </div>
          )}
          <div className="card wkgrid">
            {offset >= 0 && !plan && (
              <section className="tosched stack8" aria-label="To schedule" data-unscheduled>
                <div className="between">
                  <div className="small">
                    <span className="strong">To schedule</span>{' '}
                    <span className="quiet">{model.unscheduled.length ? laneCount(model.unscheduled) : 'Everything this week is on the calendar.'}</span>
                  </div>
                  {model.unscheduled.length > 0 && (
                    <Button size="compact" type="button" onClick={() => nav.openFlow('planning', { week: data.week, step: 'schedule' })}>
                      Schedule one at a time
                    </Button>
                  )}
                </div>
                {anyDay.length > 0 && (
                  <div className="lanerow">
                    {anyDay.map((x) => (
                      <LaneCard key={x.id} item={x} ctx={model.ctx} open={openItem === x.id} draggable={isThis} onToggle={() => toggleItem(x.id)} onPreview={(slot) => setDropAt(slot && { item: x, slot })} onDrop={(slot) => placeItem(x, slot)} />
                    ))}
                  </div>
                )}
                {isThis && (
                  <p className="small quiet">
                    {editing ? 'Hold work, then drag it onto a day to place it, or a block back here to take it off the calendar.' : 'Hold work, then drag it onto a day to place it, or click it for suggested times.'}
                  </p>
                )}
              </section>
            )}
            {/* Above the grid's right corner, as Today's are above its calendar, so they never cover a block. */}
            <div className="wkzoom">
              <ZoomButtons zoom={props.zoom} onZoom={props.onZoom} />
            </div>
            <HoldWeekGrid
              ctx={model.ctx}
              zoom={props.zoom}
              blocks={gridBlocks}
              info={model.info}
              done={{ finished: props.finished, open: props.openDone }}
              // Read on each of the screen's ticks, so the line moves with the time.
              now={{ date: today(clock), minutes: localMinutes(clock.now(), clock.zone()) }}
              ghosts={ghosts}
              editing={editing || !!plan}
              lockPast={editing || !!plan}
              // Hold to create: never while a block is open or being placed, or a card's suggested times are showing.
              holdOff={!!plan || !!drafted || !!openBlock || !!openItem}
              lane={model.unscheduled.flatMap((x) =>
                // The planning being placed is the block, not a card waiting above its days.
                x.dates && x.id !== props.place
                  ? [
                      {
                        id: x.id,
                        title: x.title,
                        from: x.dates.from,
                        to: x.dates.to,
                        alt: x.practice ? `${x.title}, Practice, ${laneWords(x)}, to schedule` : `${KIND_WORD[x.kind]}: ${x.title}, ${onceWhen({ type: 'once', ...x.dates })}, ${x.line} to schedule`,
                        planning: x.kind === 'planning',
                        practice: x.kind === 'practice',
                        open: openItem === x.id,
                        onToggle: () => toggleItem(x.id),
                        ...(isThis ? { onPointerDown: (e: ReactPointerEvent<HTMLElement>) => dragCard(e, x, model.ctx, dragItem(x)) } : {}),
                      },
                    ]
                  : [],
              )}
              onChange={onChange}
              onUnschedule={(id) => {
                const b = model.blocks.find((x) => x.id === id);
                if (b) void act.unschedule(id, b.title, data.week);
              }}
              openId={openBlock}
              onRemove={(id) => {
                const b = model.blocks.find((x) => x.id === id);
                if (b) void act.remove(id, b.title);
              }}
              onOpen={(id) => {
                const b = model.blocks.find((x) => x.id === id);
                if (id === 'draft' && drafted && draft) void place(drafted, draft);
                else if (id === PLANNING) void placePlanning();
                // A task's block opens its popup while editing too, as on phone.
                else if (b?.task_id && isTask(b)) setPop({ block: id, task: b.task_id });
                else if (!editing) setOpenBlock(openBlock === id ? null : id);
              }}
            />
            {asking}
            {pop && <TaskPopupFor id={pop.task} close={() => setPop(null)} block={popRow && <BlockSection block={popRow} {...popActions} />} />}
            {!editing && (
              <div className="legend wklegend">
                <span>
                  <i className="blk k-project" />
                  Project
                </span>
                <span>
                  <i className="blk k-practice" />
                  Practice
                </span>
                <span>
                  <i className="blk k-oneoff" />
                  One offs
                </span>
                <span>
                  <i className="blk k-event" />
                  Calendar event
                </span>
                <span>
                  <i className="keyinfo" />
                  Information only
                </span>
                <span>
                  <i className="keyclosed" />
                  Unavailable
                </span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * A task in the list to add to the week, open with what's in it when it's the one being placed. Memoised: a long
 * history lists hundreds, and Week draws again for every toast and every change elsewhere, while a row changes only
 * with Week's data.
 */
const AddRowItem = memo(function AddRowItem(props: { row: AddRow; on: boolean; onChoose(id: string | null): void; children?: ReactNode }) {
  const { row: r, on } = props;
  const last = r.placed[r.placed.length - 1];
  const sub = last ? `${dayName(last.date).slice(0, 3)} ${formatTimeOfDay(last.start)}${r.placed.length > 1 ? `, and ${r.placed.length - 1} more` : ''}` : formatMinutes(r.left);
  return (
    <li className={`schedrow${on ? ' cur' : ''}${r.work.kind === 'one_off' ? ' is-maint' : ''}`}>
      <button className="schedbtn" type="button" aria-current={on ? 'step' : undefined} aria-expanded={on} onClick={() => props.onChoose(on ? null : r.task.id)}>
        <span className="schedmark" aria-hidden="true">
          <Icon name={on ? 'chevron-right' : last ? 'done' : 'plus'} size={16} />
        </span>
        <span>
          <span className={`subline${on ? ' strong' : ''}`}>{r.task.title}</span>
          {!on && <span className="subline small">{sub}</span>}
        </span>
      </button>
      {props.children}
    </li>
  );
});

/**
 * A task or planning being placed: where its block sits, what's off about that spot, and Place here. left: a task's
 * minutes still to place. problem: why it can't go there, in place of the notes.
 */
function Placing(props: {
  context: string;
  draft: Slot;
  work: Work;
  model: WeekProps['model'];
  left?: Minutes;
  problem?: string | undefined;
  hint: string;
  onPlace(): void;
  onCancel(): void;
}) {
  const { draft, model, left } = props;
  const len = draft.end - draft.start;
  const notes = props.problem ? [props.problem] : slotNotes({ ...draft, id: 'draft' }, props.work, model.ctx);
  return (
    <div className="scheddetail stack8">
      <div className="small quiet">{props.context}</div>
      <div className="strong">
        {dayName(draft.date)}, {slotRange(draft)} ({formatMinutes(len)})
      </div>
      {left !== undefined && len < left && <div className="small">{formatMinutes(left - len)} more of this task stays to place</div>}
      {notes.map((n) => (
        <div key={n} className="small wknote">
          {n}
        </div>
      ))}
      <div className="row">
        <Button variant="primary" size="compact" type="button" disabled={!!props.problem} onClick={props.onPlace}>
          Place here
        </Button>
        <Button size="compact" type="button" onClick={props.onCancel}>
          Cancel
        </Button>
      </div>
      <p className="small quiet">{props.hint}</p>
    </div>
  );
}

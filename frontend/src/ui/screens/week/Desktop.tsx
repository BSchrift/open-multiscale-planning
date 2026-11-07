// Week on desktop: the header with week arrows, how the week's time is used, and the grid. Editing adds a list
// of tasks to place on the left, and the grid's blocks drag, resize and come off with ×.

import { useEffect, useRef, useState } from 'react';
import { formatMinutes, formatTimeOfDay } from '../../../core/dates';
import { defaultSlot, otherOffers, slotNotes } from '../../../core/slots';
import type { Slot } from '../../../core/slots';
import { onceWhen, rowLine } from '../../../core/schedule';
import type { Minutes } from '../../../core/types';
import { useNav } from '../../app/nav';
import { BlockDetail } from '../../components/blocks/BlockDetail';
import { PlanPrompt } from '../../components/PlanPrompt';
import { WeekGrid } from '../../components/weekgrid';
import type { GridBlock, GridGhost } from '../../components/weekgrid';
import { dayName, range } from './data';
import type { AddRow } from './data';
import type { WeekProps } from './index';
import { useWeekActions } from './useWeekActions';
import { WeekArrows } from '../../components/WeekArrows';
import { PracticeAsk } from './parts';

const MAX_DRAFT_MIN = 120;

export function DesktopWeek(props: WeekProps) {
  const { data, model, offset, editing } = props;
  const nav = useNav();
  const act = useWeekActions();
  const [openBlock, setOpenBlock] = useState<string | null>(null);
  const [openLane, setOpenLane] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(props.place);
  const [draft, setDraft] = useState<Slot | null>(null);
  const [ask, setAsk] = useState<{ blockId: string; wasMin: Minutes } | null>(null);
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

  const rows = model.addGroups.flatMap((g) => g.rows);
  const cur = editing && selected ? rows.find((r) => r.task.id === selected) : undefined;
  // A new pick starts at its best time, which never overlaps an event or another block.
  useEffect(() => {
    if (!cur) setDraft(null);
    else setDraft((d) => d ?? defaultSlot(Math.min(cur.left, MAX_DRAFT_MIN), cur.work, model.ctx));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cur?.task.id]);

  const choose = (id: string | null) => {
    setSelected(id);
    setDraft(null);
    setAsk(null);
  };
  const stopEditing = () => {
    choose(null);
    setMoved(null);
    props.donePlacing();
    swapFocus.current = true;
    props.setEditing(false);
  };

  const onChange = (id: string, slot: Slot) => {
    if (id === 'draft') return setDraft(slot);
    const b = model.blocks.find((x) => x.id === id);
    if (!b) return;
    const saved = act.move(id, slot);
    setMoved(id);
    setAsk(b.practice_id ? { blockId: id, wasMin: ask?.blockId === id ? ask.wasMin : b.end - b.start } : null);
    return saved;
  };
  const place = async (row: AddRow, slot: Slot) => {
    if (await act.place(row.task, slot)) {
      choose(null);
      props.donePlacing();
    }
  };

  const gridBlocks: GridBlock[] = [...model.blocks];
  let ghosts: GridGhost[] = [];
  if (cur && draft) {
    gridBlocks.push({ ...draft, id: 'draft', title: cur.task.title, kind: cur.work.kind === 'one_off' ? 'one_off' : 'project', draft: true });
    ghosts = otherOffers(draft, cur.work, model.ctx).map((o) => ({
      date: o.date,
      start: o.start,
      end: o.end,
      label: `${dayName(o.date)}, ${formatTimeOfDay(o.start)}`,
      onAccept: () => setDraft({ date: o.date, start: o.start, end: o.end }),
    }));
  }

  const opened = openBlock ? data.blocks.find((b) => b.id === openBlock) : undefined;
  const lastMoved = moved ? model.blocks.find((b) => b.id === moved) : undefined;
  const laneTask = model.lane.find((t) => t.id === openLane);
  const segs = [
    { label: 'Projects', cls: 'seg-project', min: model.planned.project },
    { label: 'Practices', cls: 'seg-practice', min: model.planned.practice },
    { label: 'One offs', cls: 'seg-maint', min: model.planned.one_off },
  ];
  const scale = Math.max(1, model.open, model.planned.total);
  const free = formatMinutes(model.free);

  return (
    <div className="wide stack24 week">
      <div className="between">
        <div className="row wkhead">
          <WeekArrows week={data.week} current={props.model.current} onWeek={props.goWeek} />
          <div>
            <div className="date">{props.label}</div>
            <h1>{props.title}</h1>
          </div>
        </div>
        <div className="row">
          {offset <= 0 && !editing && (
            <button className="link" type="button" onClick={() => nav.go('analytics', { week: data.week })}>
              See this week's analytics
            </button>
          )}
          {isThis && !editing && !props.gated && (
            <button
              ref={editBtn}
              className="btn pri"
              type="button"
              onClick={() => {
                swapFocus.current = true;
                props.setEditing(true);
              }}
            >
              Edit this week's plan
            </button>
          )}
          {(offset === 0 || offset === 1) && !editing && !props.gated && (
            <button className="btn" type="button" onClick={() => nav.openFlow('planning')}>
              {model.thisPlanned ? 'Plan next week' : 'Start planning'}
            </button>
          )}
        </div>
      </div>
      {props.gated && <PlanPrompt week={data.week} />}
      {offset < 0 && <p className="small quiet">Past weeks can be viewed but not changed.</p>}

      {!editing && (
        <section className="card stack" aria-label="How this week's time is used">
          <div className="stack8">
            <div>
              <span className="capnum">{free} free</span>
              <span className="quiet"> of {formatMinutes(model.open)} available</span>
            </div>
            <div
              className="capbar"
              role="img"
              aria-label={`${formatMinutes(model.planned.project)} projects, ${formatMinutes(model.planned.practice)} practices, ${formatMinutes(model.planned.one_off)} one offs, ${free} free`}
            >
              {segs.map((g) => (
                <span key={g.cls} className={g.cls} style={{ width: `${Math.round((g.min / scale) * 100)}%` }} title={`${g.label}: ${formatMinutes(g.min)}`} />
              ))}
            </div>
            <div className="legend">
              {segs.map((g) => (
                <span key={g.cls}>
                  <i className={g.cls} />
                  {g.label} {formatMinutes(g.min)}
                </span>
              ))}
              <span>
                <i className="keyfree" />
                Free {free}
              </span>
            </div>
            <p className="small quiet">Available is the time outside sleep, work and your other blocked times, minus calendar events, so it changes every week.</p>
          </div>
          {model.alerts.map((a) => (
            <div key={a.title} className="warn" role="status">
              <div>
                <div className="strong">{a.title}</div>
                <div>{a.text}</div>
              </div>
            </div>
          ))}
        </section>
      )}

      <div className="planlay">
        {editing && (
          <div className="planleft stack">
            <div className="stack8">
              <p className="small quiet">Drag or resize anything from now on, or click × to remove it. Changes save as you go.</p>
              <div>
                <button ref={doneBtn} className="btn pri" type="button" onClick={stopEditing}>
                  Done editing
                </button>
              </div>
            </div>
            {ask && <PracticeAsk ask={ask} model={model} onDone={() => setAsk(null)} />}
            {lastMoved && !cur && (
              <div className="stack8" role="status" aria-label="Last change">
                <div className="small strong">
                  {lastMoved.title}, {dayName(lastMoved.date)}, {range(lastMoved)}
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
                    {g.rows.map((r) => {
                      const on = r === cur;
                      const last = r.placed[r.placed.length - 1];
                      const sub = last
                        ? `${dayName(last.date).slice(0, 3)} ${formatTimeOfDay(last.start)}${r.placed.length > 1 ? `, and ${r.placed.length - 1} more` : ''}`
                        : formatMinutes(r.left);
                      return (
                        <li key={r.task.id} className={`schedrow${on ? ' cur' : ''}${r.work.kind === 'one_off' ? ' is-maint' : ''}`}>
                          <button className="schedbtn" type="button" aria-current={on ? 'step' : undefined} aria-expanded={on} onClick={() => choose(on ? null : r.task.id)}>
                            <span className="schedmark" aria-hidden="true">
                              {on ? '▸' : last ? '✓' : '+'}
                            </span>
                            <span>
                              <span className={`subline${on ? ' strong' : ''}`}>{r.task.title}</span>
                              {!on && <span className="subline small">{sub}</span>}
                            </span>
                          </button>
                          {on && draft && <Placing row={r} draft={draft} model={model} onPlace={() => place(r, draft)} onCancel={() => choose(null)} />}
                        </li>
                      );
                    })}
                  </ol>
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="planright" ref={right}>
          {laneTask && (
            <div className="panel stack8 wkpanel" role="group" aria-label={laneTask.title}>
              <div>
                <div className="strong mhead">{laneTask.title}</div>
                <div className="small quiet">{rowLine({ task: laneTask, checked: false })}</div>
              </div>
              <div className="row">
                {isThis && (
                  <button
                    className="btn sm pri"
                    type="button"
                    onClick={() => {
                      setOpenLane(null);
                      props.setEditing(true);
                      choose(laneTask.id);
                    }}
                  >
                    Find a time
                  </button>
                )}
                <button
                  className="btn sm"
                  type="button"
                  onClick={() => {
                    setOpenLane(null);
                    void act.markDone(laneTask);
                  }}
                >
                  Mark done
                </button>
                <button className="btn sm" type="button" onClick={() => setOpenLane(null)}>
                  Close
                </button>
              </div>
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
            <WeekGrid
              ctx={model.ctx}
              blocks={gridBlocks}
              info={model.info}
              ghosts={ghosts}
              editing={editing}
              lockPast={editing}
              lane={model.lane.map((t) => {
                const s = t.schedule as { type: 'once'; from: string; to?: string | null };
                return {
                  id: t.id,
                  title: t.title,
                  from: s.from,
                  to: s.to ?? s.from,
                  alt: `One off: ${t.title}, ${onceWhen(s)}`,
                  open: openLane === t.id,
                  onToggle: () => setOpenLane(openLane === t.id ? null : t.id),
                };
              })}
              onChange={onChange}
              openId={openBlock}
              onRemove={(id) => {
                const b = model.blocks.find((x) => x.id === id);
                if (b) void act.remove(id, b.title);
              }}
              onOpen={(id) => {
                if (id === 'draft' && cur && draft) void place(cur, draft);
                else if (!editing) setOpenBlock(openBlock === id ? null : id);
              }}
            />
            {!editing && (
              <div className="legend wklegend">
                <span>
                  <i className="ev-project" />
                  Project
                </span>
                <span>
                  <i className="ev-practice" />
                  Practice
                </span>
                <span>
                  <i className="ev-maint" />
                  One offs
                </span>
                <span>
                  <i className="ev-busy" />
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

/** The task being placed: where its block sits, what's off about that spot, and Place here. */
function Placing(props: { row: AddRow; draft: Slot; model: WeekProps['model']; onPlace(): void; onCancel(): void }) {
  const { row, draft, model } = props;
  const len = draft.end - draft.start;
  const notes = slotNotes({ ...draft, id: 'draft' }, row.work, model.ctx);
  return (
    <div className="scheddetail stack8">
      <div className="small quiet">{row.context}</div>
      <div className="strong">
        {dayName(draft.date)}, {range(draft)} ({formatMinutes(len)})
      </div>
      {len < row.left && <div className="small">{formatMinutes(row.left - len)} more of this task stays to place</div>}
      {notes.map((n) => (
        <div key={n} className="small wknote">
          {n}
        </div>
      ))}
      <div className="row">
        <button className="btn sm pri" type="button" onClick={props.onPlace}>
          Place here
        </button>
        <button className="btn sm" type="button" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
      <p className="small quiet">Drag the block anywhere, or click a suggested time. Drag its bottom edge to change the time.</p>
    </div>
  );
}

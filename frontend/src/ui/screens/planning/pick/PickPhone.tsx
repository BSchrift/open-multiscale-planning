// Pick tasks on phone: a board of project bars that compare at a glance, over a half-height sheet of the open
// project's tasks with ‹ › to the next. Pills show only when something needs you, and a star marks suggested work.
// Each task is a PickRow. Does it fit, in the top bar, opens In this week.

import { useState } from 'react';
import { formatMinutes, formatWeekRange } from '../../../../core/dates';
import { ONE_OFFS_BUCKET } from '../../../../core/types';
import type { Minutes } from '../../../../core/types';
import { MilestoneDiamond } from '../../../components/MilestoneDiamond';
import { Pill } from '../../../components/Pill';
import { Sheet } from '../../../components/Sheet';
import { useToast } from '../../../components/Toast';
import { TimelineAxisHead, TimelineBar } from '../../../components/TimelineBar';
import { pickWarning } from '../../../../core/capacity';
import { Aims } from './Aims';
import { aimWords, stopIndex, weekStops } from './model';
import type { PickTask } from './model';
import { OverdueFix } from './OverdueFix';
import { PastEnd, pastEndLine } from './PastEnd';
import { Legend } from './PickDesktop';
import { PickRow } from './PickRow';
import type { PickProps } from './PickStep';
import { useFit } from '../WeekFit';

/** What's suggested of a task in the Suggest sheet, '★ 2h of 3h'. */
function estText(r: PickTask): string {
  const left = r.c.left;
  const of = (m: Minutes) => (m < left ? `${formatMinutes(m)} of ${formatMinutes(left)}` : left ? formatMinutes(left) : 'No estimate');
  if (r.c.picked) return of(r.c.week);
  return r.hint ? `★ ${of(r.hint.minutes)}` : of(left);
}

function AddButton(props: PickProps & { row: PickTask }) {
  const { row: r } = props;
  const picked = r.c.picked;
  return (
    <button
      className={`tadd${picked ? ' on' : ''}`}
      type="button"
      aria-label={`Add ${r.title} to the plan`}
      aria-pressed={picked}
      onClick={() => (picked ? props.remove(r) : props.add(r))}
    >
      <span aria-hidden="true">{picked ? '✓' : '+'}</span>
    </button>
  );
}

export function PickPhone(props: PickProps) {
  const { view, model, week } = props;
  const seq = [...view.projects.map((p) => p.plan.project.id), ONE_OFFS_BUCKET];
  // Opens on the first project; after that it's whatever was tapped, or closed.
  const [chosen, setChosen] = useState<string | null | undefined>(undefined);
  const active = chosen === undefined ? seq[0]! : chosen;
  const at = active ? seq.indexOf(active) : -1;
  const [sheet, setSheet] = useState<string | null>(null);
  useFit(null, () => setSheet('planned'));
  const [fixFor, setFixFor] = useState<string | null>(null);
  const toast = useToast();
  // Listed as they were when Suggest opened, so rows don't vanish as adding one changes what's suggested.
  const [listed, setListed] = useState<Record<string, string>>({});

  const show = (id: string | null) => setChosen(id);
  const nameOf = (id: string) => (id === ONE_OFFS_BUCKET ? 'One offs' : (view.projects.find((p) => p.plan.project.id === id)?.plan.project.title ?? ''));
  const closeSheet = () => setSheet(null);
  const weekLabel = formatWeekRange(week);
  const { free } = model.use;
  const isOneOffs = active === ONE_OFFS_BUCKET;
  const trayProject = at >= 0 && !isOneOffs ? view.projects[at] : undefined;
  const trayAim = isOneOffs ? view.oneOffs.aim : trayProject?.aim;
  const allRows = [...view.projects.flatMap((p) => p.groups.flatMap((g) => g.rows)), ...view.oneOffs.rows];
  const warn = pickWarning(free, model.pushback);
  const fixProject = view.projects.find((p) => p.plan.project.id === fixFor);
  const pastNow = view.pastEnd.find((p) => sheet === `past:${p.plan.project.id}`);

  const taskRow = (r: PickTask) => <PickRow key={r.c.task.id} {...props} row={r} phone />;

  // Add all goes with its sheet, so focus goes to Undo.
  const addAll = async () => {
    const text = `Added ${formatMinutes(view.hintMin)}.`;
    closeSheet();
    const ids = await props.addSuggested();
    toast.show(text, { undo: () => props.removeAll(ids), focusUndo: true });
  };

  return (
    <>
      <div className="scroll">
        <div className="stack8">
          <div className="pkhead">
            <h2>Pick tasks</h2>
            {view.hintMin > 0 && (
              <button
                className="btn"
                type="button"
                aria-haspopup="dialog"
                onClick={() => {
                  setListed(Object.fromEntries(Object.entries(model.hints).map(([id, h]) => [id, h.why])));
                  setSheet('suggest');
                }}
              >
                Suggest {formatMinutes(view.hintMin)}
              </button>
            )}
            <button className="pkmore" type="button" aria-haspopup="dialog" aria-label="More: change aims, timeline key" onClick={() => setSheet('menu')}>
              ⋯
            </button>
          </div>
          <div className="card">
            <div className="pkaxis">
              <TimelineAxisHead axis={view.axis} week={view.weekSpan} weekLabel={weekLabel} />
            </div>
            {view.pastEnd.map(({ plan, status }) => (
              <button
                key={plan.project.id}
                className="brow"
                type="button"
                aria-haspopup="dialog"
                aria-label={`${plan.project.title}, past end date. ${pastEndLine(plan, status)}`}
                onClick={() => setSheet(`past:${plan.project.id}`)}
              >
                <span className="pline">
                  <span className="ptitle">
                    <b>{plan.project.title}</b>
                  </span>
                  <Pill tone="red">Past end date</Pill>
                </span>
              </button>
            ))}
            {view.projects.map((s, i) => {
              const { project } = s.plan;
              const on = active === project.id;
              const w = s.aim && aimWords(s.aim);
              const pill = s.status.late || s.status.pill !== 'On track' ? s.status.pill : '';
              const alt = [project.title, pill, s.status.word, w?.alt, s.hintN ? `${s.hintN} suggested` : ''].filter(Boolean).join(', ');
              return (
                <div
                  key={project.id}
                  className={`brow${on ? ' on' : ''}`}
                  onClick={(event) => {
                    if (!(event.target as HTMLElement).closest('.pillbtn')) show(seq[i]!);
                  }}
                >
                  <div className="pline">
                    <button className="ptitle" type="button" aria-expanded={on} aria-label={`${alt}. Show its tasks`}>
                      <b>{project.title}</b>
                      {s.hintN > 0 && (
                        <span className="star" aria-hidden="true">
                          ★{s.hintN}
                        </span>
                      )}
                    </button>
                    {s.status.late ? (
                      <Pill tone="red" aria-label="Overdue: move the date, drop the milestone or mark it done" aria-expanded={fixFor === project.id} onClick={() => setFixFor(project.id)}>
                        {s.status.pill} ▾
                      </Pill>
                    ) : (
                      pill && <Pill tone={s.status.tone}>{pill}</Pill>
                    )}
                    {s.aim && w && (
                      <span className="mm" role="img" aria-label={w.alt}>
                        <i className={w.cls} style={{ width: `${s.aim.pct}%` }} />
                      </span>
                    )}
                  </div>
                  <TimelineBar
                    axis={view.axis}
                    bar={{ start: project.start, end: project.end }}
                    {...(view.stretch ? { stretch: view.stretch } : {})}
                    week={view.weekSpan}
                    diamonds={s.marks}
                    alt={s.alt}
                  />
                </div>
              );
            })}
            <div className={`brow oo${isOneOffs ? ' on' : ''}`} onClick={() => show(ONE_OFFS_BUCKET)}>
              <div className="pline">
                <button
                  className="ptitle"
                  type="button"
                  aria-expanded={isOneOffs}
                  aria-label={`One offs, ${view.oneOffs.aim ? aimWords(view.oneOffs.aim).alt : `${formatMinutes(view.oneOffs.planned)} planned`}. Show them`}
                >
                  <b>One offs</b>
                </button>
                <span className="small quiet">{view.oneOffs.count ? `${view.oneOffs.count} in the plan` : ''}</span>
                {view.oneOffs.aim && (
                  <span className="mm" role="img" aria-label={aimWords(view.oneOffs.aim).alt}>
                    <i className={aimWords(view.oneOffs.aim).cls} style={{ width: `${view.oneOffs.aim.pct}%` }} />
                  </span>
                )}
              </div>
            </div>
            {view.others.map((o) => (
              <div key={o.plan.project.id} className="brow muted">
                <div className="pline">
                  <span className="ptitle">
                    <b>{o.plan.project.title}</b>
                  </span>
                  <Pill tone={o.status.tone}>{o.status.pill}</Pill>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="pkdock">
        {at >= 0 && (
          <section className={`tsheet${isOneOffs ? ' purple' : ''}`} aria-label={`Tasks in ${isOneOffs ? 'One offs' : trayProject!.plan.project.title}`}>
            <div className="thead">
              {/* Named for where they go. At either end they stay focusable, so focus isn't dropped there. */}
              <button type="button" aria-label={at === 0 ? 'Previous project' : `Previous project: ${nameOf(seq[at - 1]!)}`} aria-disabled={at === 0} onClick={() => at > 0 && show(seq[at - 1]!)}>
                ‹
              </button>
              <button
                type="button"
                aria-label={at === seq.length - 1 ? 'Next project' : `Next project: ${nameOf(seq[at + 1]!)}`}
                aria-disabled={at === seq.length - 1}
                onClick={() => at < seq.length - 1 && show(seq[at + 1]!)}
              >
                ›
              </button>
              <div className="ttl">
                <strong>{isOneOffs ? 'One offs' : trayProject!.plan.project.title}</strong>
                {trayAim && <span className="small quiet">{aimWords(trayAim).value}</span>}
              </div>
              <button type="button" aria-label="Close tasks" onClick={() => show(null)}>
                ×
              </button>
            </div>
            <div className="tbody">
              {trayProject?.change && (
                <div className="small">
                  {trayProject.change.text}{' '}
                  <button className="link small" type="button" onClick={() => props.undoChange(trayProject.plan)}>
                    Undo
                  </button>
                </div>
              )}
              {isOneOffs ? (
                <ul className="picklist">{view.oneOffs.rows.map(taskRow)}</ul>
              ) : (
                trayProject!.groups.map((g) => (
                  <div key={g.key}>
                    <h3 className={`tghead${g.late ? ' latetext' : ''}`}>
                      {g.isMs && (
                        <>
                          <MilestoneDiamond {...(g.state ? { state: g.state } : {})} />
                          Milestone:{' '}
                        </>
                      )}
                      {g.head}
                      {g.isMs && g.planned > 0 && `: ${formatMinutes(g.planned)} planned`}
                    </h3>
                    <ul className="picklist">{g.rows.map(taskRow)}</ul>
                  </div>
                ))
              )}
              {(isOneOffs ? view.oneOffs.rows.length === 0 : trayProject!.groups.length === 0) && (
                <p className="small quiet">{isOneOffs ? 'Nothing due.' : 'No open tasks.'}</p>
              )}
            </div>
          </section>
        )}
        <div className="sr" role="status">
          {props.said}
        </div>
      </div>

      {sheet === 'planned' && (
        <Sheet key="planned" label="In this week" onClose={closeSheet} tall>
          <div className="between">
            <h2>In this week</h2>
            <button className="btn" type="button" onClick={closeSheet}>
              Close
            </button>
          </div>
          {view.planned.length === 0 && <p className="small quiet">Nothing yet. Add tasks from your projects or One offs.</p>}
          {view.planned.map((r) => {
            const text = `${formatMinutes(r.c.week)} of ${formatMinutes(r.c.left)}`;
            const stops = weekStops(r.c.left);
            return (
              <div key={r.c.task.id} className={`rowline${r.oneOff ? ' mhead' : ''}`}>
                <div className="between">
                  <span className="grow">{r.title}</span>
                  <button className="btn" type="button" aria-label={`Remove ${r.title} from the plan`} onClick={() => props.remove(r)}>
                    Remove
                  </button>
                </div>
                {r.c.left > 15 ? (
                  <div className="stack8">
                    <div className="between">
                      <span className="small quiet">Time this week</span>
                      <span className="small strong">{text}</span>
                    </div>
                    <input
                      type="range"
                      className="wide-range"
                      min={0}
                      max={stops.length - 1}
                      step={1}
                      value={stopIndex(stops, r.c.week)}
                      aria-label={`Time this week for ${r.title}`}
                      aria-valuetext={text}
                      onChange={(event) => props.setMinutes(r, stops[Number(event.target.value)]!)}
                    />
                  </div>
                ) : (
                  <div className="small quiet">{formatMinutes(r.c.week)}</div>
                )}
              </div>
            );
          })}
          <div className="stack8 captop">
            <div className="between small">
              <span>Open time</span>
              <span>{formatMinutes(model.open)}</span>
            </div>
            <div className="between small">
              <span>Practices and repeating work</span>
              <span>{formatMinutes(model.repeating)}</span>
            </div>
            <div className="between small">
              <span>Tasks you added</span>
              <span className="strong">{formatMinutes(view.picked)}</span>
            </div>
            <div className={`between small${free < 0 ? ' overtext' : ''}`}>
              <span>{free < 0 ? 'Over by' : 'Left free'}</span>
              <span className="strong">{formatMinutes(Math.abs(free))}</span>
            </div>
          </div>
          {warn && <div className="warn">{warn}</div>}
        </Sheet>
      )}

      {sheet === 'suggest' && (
        <Sheet key="suggest" label="Suggested" onClose={closeSheet} tall>
          <div className="between">
            <h2>Suggested</h2>
            <button className="btn" type="button" onClick={closeSheet}>
              Close
            </button>
          </div>
          {allRows
            .filter((r) => listed[r.c.task.id])
            .map((r) => {
              const why = listed[r.c.task.id]!.replace('Suggested: ', '');
              return (
                <div key={r.c.task.id} className={`trow${r.c.picked ? ' added' : ''}${r.oneOff ? ' oo' : ''}`}>
                  <div className="tmain">
                    {r.title}
                    <small>
                      {estText(r)}. {why[0]!.toUpperCase() + why.slice(1)}
                    </small>
                  </div>
                  <AddButton {...props} row={r} />
                </div>
              );
            })}
          {view.hintMin > 0 && (
            <button className="btn pri" type="button" onClick={() => void addAll()}>
              Add all {formatMinutes(view.hintMin)}
            </button>
          )}
        </Sheet>
      )}

      {sheet === 'menu' && (
        <Sheet key="menu" label="More" onClose={closeSheet}>
          <button className="btn" type="button" onClick={() => setSheet('aims')}>
            Change aims for this week
          </button>
          <button className="btn" type="button" onClick={() => setSheet('key')}>
            Timeline key
          </button>
          <button className="btn" type="button" onClick={closeSheet}>
            Close
          </button>
        </Sheet>
      )}

      {sheet === 'key' && (
        <Sheet key="key" label="Timeline key" onClose={closeSheet}>
          <div className="between">
            <h2>Timeline key</h2>
            <button className="btn" type="button" onClick={closeSheet}>
              Close
            </button>
          </div>
          <Legend stretch={!!view.stretch} className="col" />
        </Sheet>
      )}

      {sheet === 'aims' && (
        <Sheet key="aims" label="Change aims for this week" onClose={closeSheet} tall>
          <div className="between">
            <h2>Change aims for this week</h2>
            <button className="btn" type="button" onClick={closeSheet}>
              Done
            </button>
          </div>
          <Aims {...props} withSkip />
        </Sheet>
      )}

      {pastNow && (
        <Sheet key="past" label={`${pastNow.plan.project.title}, past end date`} onClose={closeSheet} tall>
          <PastEnd
            plan={pastNow.plan}
            status={pastNow.status}
            ctx={model.ctx}
            heading
            onSkip={() => {
              props.skipPastEnd(pastNow.plan.project.id);
              closeSheet();
            }}
          />
        </Sheet>
      )}

      {fixProject?.status.late && (
        <OverdueFix
          plan={fixProject.plan}
          milestone={fixProject.status.late}
          ctx={model.ctx}
          onClose={() => setFixFor(null)}
          onSaved={() => {
            setFixFor(null);
            show(fixProject.plan.project.id);
          }}
        />
      )}

    </>
  );
}

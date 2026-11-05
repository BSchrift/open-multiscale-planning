// A project with milestones shows them on its own dates: the whole project, each milestone's diamond, a bar only
// for one with a start date, and the implicit Done last. Filled means done, so a bar filled short of
// today's line is behind.

import { formatDate, formatMinutes, formatMonth, today } from '../../../core/dates';
import { doneInPlan, effectiveDue, minutesLeft, msInPlan, msReached, planStretch, sortedMilestones } from '../../../core/plan';
import type { PlanContext, ProjectPlan } from '../../../core/plan';
import type { ProjectStatus } from '../../../core/status';
import type { Task } from '../../../core/types';
import { diamondFor, doneDiamond } from '../../components/editors';
import { MilestoneDiamond, TimelineDiamond } from '../../components/MilestoneDiamond';
import type { DiamondState } from '../../components/MilestoneDiamond';
import { axisMonths, axisPercent } from '../../components/TimelineBar';

interface Row {
  key: string;
  label: string;
  state: string;
  diamond?: DiamondState;
  late?: boolean;
  bar?: { left: number; width: number; fill: number; cls: string };
  dot?: number;
}

/** Percent of the time estimated that is done. */
function doneShare(tasks: readonly Task[]): number {
  const counted = tasks.filter((t) => !t.cancelled_at);
  const all = counted.reduce((sum, t) => sum + (t.estimate_min ?? 0), 0);
  const done = counted.reduce((sum, t) => sum + (t.done_at ? (t.estimate_min ?? 0) : Math.max(0, (t.estimate_min ?? 0) - minutesLeft(t))), 0);
  return all ? Math.round((done / all) * 100) : 0;
}

export function ProjectTimeline(props: { plan: ProjectPlan; ctx: PlanContext; st: ProjectStatus }) {
  const { plan, ctx, st } = props;
  const { project } = plan;
  const on = today(ctx.clock);
  const axis = { start: project.start, end: project.end };
  const pos = (d: string) => axisPercent(axis, d);
  const stretch = planStretch(ctx.settings, on, ctx.planning);

  const rows: Row[] = [
    {
      key: 'whole',
      label: 'Whole project',
      state: `${formatMinutes(st.doneMin)} done, ${formatMinutes(st.leftMin)} left`,
      bar: { left: 0, width: 100, fill: st.pct, cls: 'whole' },
    },
  ];
  for (const m of sortedMilestones(plan, ctx).filter((x) => !x.dropped_at)) {
    const due = effectiveDue(plan, m, ctx);
    const met = msReached(plan, m);
    const late = st.late?.id === m.id;
    const fill = met ? 100 : doneShare(plan.tasks.filter((t) => t.milestone_id === m.id));
    const state = met ? 'met' : late ? `overdue since ${formatDate(due)}` : `${m.due ? 'due' : 'by'} ${formatDate(due)}${msInPlan(plan, m, stretch) ? ', in the plan' : ''}`;
    const end = late ? Math.max(pos(due), pos(on)) : pos(due);
    rows.push({
      key: m.id,
      label: m.title,
      state: fill && !met ? `${state}, ${fill}% done` : state,
      diamond: diamondFor(plan, m, ctx),
      late,
      dot: pos(due),
      ...(m.start ? { bar: { left: pos(m.start), width: Math.max(1, end - pos(m.start)), fill, cls: late ? 'late' : '' } } : {}),
    });
  }
  // The implicit Done closes the list at the project's end, with the tasks that have no milestone.
  const fill = doneShare(plan.tasks.filter((t) => !t.milestone_id));
  const done = `due ${formatDate(project.end)}${doneInPlan(plan, stretch) ? ', in the plan' : ''}`;
  const doneMark = doneDiamond(plan, ctx);
  rows.push({ key: 'done', label: 'Done', state: fill ? `${done}, ${fill}% done` : done, diamond: doneMark, late: !!doneMark.late, dot: 100 });

  const todayAt = on >= axis.start && on <= axis.end ? pos(on) : null;
  const alt = `${formatDate(project.start)} to ${formatDate(project.end)}, today is ${formatDate(on)}. ${rows
    .map((r) => `${r.diamond ? 'Milestone ' : ''}${r.label}, ${r.state}`)
    .join('. ')}.`;

  return (
    <div className="card stack">
      <div className="gantt" role="img" aria-label={alt}>
        <div className="gline" aria-hidden="true">
          <span />
          <div className="gtrack ghead">
            {axisMonths(axis).map((month) => (
              <span key={month} style={{ left: `${pos(month)}%` }}>
                {formatMonth(month)}
              </span>
            ))}
          </div>
        </div>
        {rows.map((r) => (
          <div key={r.key} className="gline" aria-hidden="true">
            <div className="glabel">
              <span className={r.late ? 'latetext' : r.key === 'whole' ? 'strong' : undefined}>
                {r.diamond && <MilestoneDiamond state={r.diamond} />}
                {r.diamond ? `Milestone: ${r.label}` : r.label}
              </span>
              <span className="quiet gstate">{r.state}</span>
            </div>
            <div className="gtrack">
              {axisMonths(axis).map((month) => (
                <i key={month} className="gtick" style={{ left: `${pos(month)}%` }} />
              ))}
              {r.bar && (
                <div className={`gbar ${r.bar.cls}`.trim()} style={{ left: `${r.bar.left}%`, width: `${r.bar.width}%` }}>
                  <span style={{ width: `${r.bar.fill}%` }} />
                </div>
              )}
              {r.dot != null && <TimelineDiamond percent={r.dot} {...(r.diamond ? { state: r.diamond } : {})} />}
              {todayAt != null && <i className="gtoday" style={{ left: `${todayAt}%` }} />}
            </div>
          </div>
        ))}
      </div>
      <div className="ctkey small quiet" aria-hidden="true">
        <span>
          <MilestoneDiamond state={{ on: true }} />
          In this plan
        </span>
        <span>
          <MilestoneDiamond />
          Not in this plan
        </span>
        <span>
          <MilestoneDiamond state={{ met: true }} />
          Met
        </span>
        <span>
          <MilestoneDiamond state={{ late: true }} />
          Overdue
        </span>
      </div>
    </div>
  );
}

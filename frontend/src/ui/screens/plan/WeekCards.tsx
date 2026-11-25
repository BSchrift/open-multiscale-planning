// On phone, the Plan page opens with this week's and next week's cards, the jobs Week's tab had that aren't the day's:
// what's planned, editing the plan on Today, scheduling one at a time, the week's analytics and resetting it, and
// planning next week. Today draws the week itself, over its day.

import { useMemo } from 'react';
import { addDays, addWeeks, formatDate, formatMinutes, weekStart } from '../../../core/dates';
import { weekGate, weekRow } from '../../../core/planning';
import { useNav } from '../../app/nav';
import { useApp, useQuery, useToday } from '../../app/store';
import { PlanPrompt } from '../../components/PlanPrompt';
import { PlanningRow } from '../../components/planning/PlanningRow';
import { usePlanningActions } from '../../components/planning/usePlanning';
import { weekFree } from '../../components/week/DayStrip';
import { Button } from '../../components/ds/Button';
import { loadWeek, weekModel } from '../week/data';
import type { WeekData, WeekModel } from '../week/data';
import { ResetWeek } from '../week/reset';

const label = (week: string) => `${formatDate(week)} to ${formatDate(addDays(week, 6))}`;
const kinds = (m: WeekModel) => `${formatMinutes(m.planned.project)} projects, ${formatMinutes(m.planned.practice)} practices, ${formatMinutes(m.planned.one_off)} one offs.`;
const isPlanned = (data: WeekData) => data.weekPlans.some((p) => p.week_start === data.week && !!p.finished_at);

export function WeekCards() {
  const { clock } = useApp();
  const current = weekStart(useToday());
  const next = addWeeks(current, 1);
  const thisWeek = useQuery((sql, c) => loadWeek(sql, c, current), [current]).data;
  const nextWeek = useQuery((sql, c) => loadWeek(sql, c, next), [next]).data;
  const thisModel = useMemo(() => thisWeek && weekModel(thisWeek, clock), [thisWeek, clock]);
  const nextModel = useMemo(() => nextWeek && weekModel(nextWeek, clock), [nextWeek, clock]);
  if (!thisWeek || !thisModel || !nextWeek || !nextModel) return null;
  return (
    <>
      <ThisWeek data={thisWeek} model={thisModel} />
      <NextWeek data={nextWeek} model={nextModel} thisPlanned={isPlanned(thisWeek)} planning={thisWeek.nextPlanning} />
    </>
  );
}

function Head(props: { title: string; week: string }) {
  return (
    <div className="between">
      <h2>{props.title}</h2>
      <span className="small quiet">{label(props.week)}</span>
    </div>
  );
}

function ThisWeek(props: { data: WeekData; model: WeekModel }) {
  const { data, model } = props;
  const { clock } = useApp();
  const nav = useNav();
  const gate = weekGate(data.planning, clock) === 'gate';
  const waiting = model.unscheduled.length;
  return (
    <section className="card stack8 planweek" aria-label="This week">
      <Head title="This week" week={data.week} />
      {gate ? (
        <PlanPrompt week={data.week} />
      ) : (
        <>
          <p>
            {formatMinutes(model.planned.total)} planned, {formatMinutes(weekFree(data.week, model.ctx))} free{waiting ? `, ${waiting} to schedule` : ''}.
          </p>
          <p className="small quiet">{kinds(model)}</p>
          <Button type="button" onClick={() => nav.go('week', { edit: 'this' })}>
            Edit this week's plan
          </Button>
          {waiting > 0 && (
            <Button type="button" onClick={() => nav.openFlow('planning', { week: data.week, step: 'schedule' })}>
              Schedule one at a time
            </Button>
          )}
        </>
      )}
      <Button variant="quiet" type="button" onClick={() => nav.go('analytics', { week: data.week })}>
        See this week's analytics
      </Button>
      <ResetWeek data={data} offset={0} />
    </section>
  );
}

function NextWeek(props: { data: WeekData; model: WeekModel; thisPlanned: boolean; planning: WeekData['nextPlanning'] }) {
  const { data, model } = props;
  const { clock } = useApp();
  const act = usePlanningActions();
  const planned = isPlanned(data);
  // From three days before, next week's planning has its row, as on Today; before then, Plan next week starts it.
  const due = weekRow(props.planning, clock);
  return (
    <section className="card stack8 planweek" aria-label="Next week">
      <Head title="Next week" week={data.week} />
      {planned ? (
        <p>
          {formatMinutes(model.planned.total)} planned, {formatMinutes(weekFree(data.week, model.ctx))} free.
        </p>
      ) : due ? (
        <PlanningRow planning={props.planning} onGone={() => undefined} />
      ) : (
        <>
          <p>Not planned yet.</p>
          <Button type="button" disabled={act.pending} onClick={() => void act.start(data.week)}>
            {props.thisPlanned ? 'Plan next week' : 'Start planning'}
          </Button>
        </>
      )}
      <ResetWeek data={data} offset={1} />
    </section>
  );
}

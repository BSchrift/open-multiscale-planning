// The other faces of Today: Welcome back after time away, Pick one thing for today, the prompt to plan an unplanned
// week, and Next up when nothing is on the calendar.

import type { ReactNode } from 'react';
import { startTaskNow } from '../../../core/blocks';
import { formatDate, formatMinutes, formatTime, thisWeek } from '../../../core/dates';
import { gatherPlans, minutesLeft, oneOffCandidates, plannable, projectCandidates, taskDue } from '../../../core/plan';
import type { BlockRow } from '../../../core/queries';
import { returnMissedBlocks, welcomeOptions } from '../../../core/queue';
import type { Task } from '../../../core/types';
import { useNav } from '../../app/nav';
import { useApp, useMutation } from '../../app/store';
import { PlanPrompt } from '../../components/PlanPrompt';
import type { TodayData } from './data';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** 'a, b, and c.' */
function sentence(parts: readonly string[]): string {
  if (parts.length < 2) return parts.join('') + (parts.length ? '.' : '');
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}.`;
}

function Card(props: { children: ReactNode }) {
  const { layout } = useApp();
  return <div className={layout === 'phone' ? 'now stack' : 'card stack'}>{props.children}</div>;
}

export function Welcome(props: { blocks: readonly BlockRow[]; onReturned(): void }) {
  const { layout } = useApp();
  const send = useMutation((w) => returnMissedBlocks(w, props.blocks).then(() => true));
  return (
    <Card>
      <p>Your plan from before the break has passed. You don't need to go through it.</p>
      <p className={layout === 'phone' ? 'small quiet' : 'quiet'}>Missed blocks go back to their projects and aren't counted in your analytics.</p>
      <div className="row">
        <button className="btn pri" type="button" disabled={send.pending} onClick={() => void send.run().then((ok) => ok && props.onReturned())}>
          Return them and continue
        </button>
      </div>
    </Card>
  );
}

const minutesLabel = (t: Task) => (minutesLeft(t) ? formatMinutes(minutesLeft(t)) : '');

export function PickOne(props: { data: TodayData; onPick(taskId: string): void }) {
  const { data } = props;
  const { clock, layout } = useApp();
  const nav = useNav();
  const options = welcomeOptions(data.tasks, data.milestones, data.projects, clock);
  return (
    <>
      <div className="stack8">
        {options.map((t) => (
          <button key={t.id} className="offer" type="button" onClick={() => props.onPick(t.id)}>
            <span>{t.title}</span>
            <span className="small">{minutesLabel(t)}</span>
          </button>
        ))}
      </div>
      <div>
        <button className={layout === 'phone' ? 'btn' : 'link'} type="button" onClick={() => nav.openFlow('planning')}>
          Plan the rest of the week instead
        </button>
      </div>
    </>
  );
}

function gateLine(data: TodayData, clock: ReturnType<typeof useApp>['clock']): string {
  const ctx = { settings: data.settings, clock, away: data.away };
  const week = { weekStart: thisWeek(clock), picks: [], blocks: [] };
  const due = oneOffCandidates(data.tasks, week, ctx).filter((c) => taskDue(c.task, null, week.weekStart, ctx).dueDay != null).length;
  const waiting = plannable(gatherPlans(data.projects, data.milestones, data.tasks), ctx).filter((p) => projectCandidates(p, week, ctx).length > 0).length;
  return sentence(
    [
      data.inbox ? `${data.inbox} in your Inbox` : '',
      data.queue.length ? `${plural(data.queue.length, 'task that needs', 'tasks that need')} a new time` : '',
      due ? `${plural(due, 'one off', 'one offs')} due` : '',
      waiting ? `${plural(waiting, 'project', 'projects')} waiting for time` : '',
    ].filter(Boolean),
  );
}

export function Gate(props: { data: TodayData }) {
  const { clock } = useApp();
  return <PlanPrompt week={thisWeek(clock)} line={gateLine(props.data, clock)} />;
}

export function Banner() {
  const { layout } = useApp();
  const nav = useNav();
  return (
    <div className="attn">
      <span>This week isn't planned</span>
      <button className={layout === 'phone' ? 'btn' : 'btn sm'} type="button" onClick={() => nav.openFlow('planning')}>
        Start planning
      </button>
    </div>
  );
}

/** With nothing on the calendar: a few things to start, one from each project or One offs, soonest first. */
export function NextUp(props: { data: TodayData; pick: string | null }) {
  const { data, pick } = props;
  const { clock, layout } = useApp();
  const start = useMutation((w, taskId: string) => startTaskNow(w, taskId, clock));
  const tasks = new Map(data.tasks.map((t) => [t.id, t]));
  const projects = new Map(data.projects.map((p) => [p.id, p]));
  const picked = pick ? tasks.get(pick) : undefined;
  const open = picked && !picked.done_at && !picked.cancelled_at ? [picked] : [];
  const rows = [...open, ...welcomeOptions(data.tasks, data.milestones, data.projects, clock).filter((t) => t.id !== pick)];
  const sub = (t: Task) => {
    if (t.id === pick) return 'Your pick for today';
    const due = t.next_due ?? (t.schedule?.type === 'once' ? t.schedule.from : null);
    const where = t.kind === 'one_off' ? ['One off', due ? `due ${formatDate(due)}` : ''] : [projects.get(t.project_id ?? '')?.title ?? ''];
    return [...where, minutesLabel(t)].filter(Boolean).join(', ');
  };
  const busy = data.events;
  const phone = layout === 'phone';

  return (
    <section className="stack8" aria-label="Next up">
      <h3>Next up</h3>
      {rows.length === 0 && <p className="quiet">Nothing to start.</p>}
      <div className="card">
        {rows.map((t) => (
          <div key={t.id} className={phone ? 'rowline' : 'qrow'}>
            <div className={phone ? 'between' : undefined}>
              <div>
                <div>{t.title}</div>
                <div className="small quiet">{sub(t)}</div>
              </div>
              {phone && (
                <button className="btn" type="button" aria-label={`Start ${t.title}`} disabled={start.pending} onClick={() => void start.run(t.id)}>
                  Start
                </button>
              )}
            </div>
            {!phone && (
              <button className="btn sm" type="button" aria-label={`Start ${t.title}`} disabled={start.pending} onClick={() => void start.run(t.id)}>
                Start
              </button>
            )}
          </div>
        ))}
      </div>
      {busy.length > 0 && (
        <p className="small quiet">
          Busy {formatTime(busy.reduce((a, e) => (e.start < a ? e.start : a), busy[0]!.start), clock.zone())} to{' '}
          {formatTime(busy.reduce((a, e) => (e.end > a ? e.end : a), busy[0]!.end), clock.zone())}, from your calendars.
        </p>
      )}
    </section>
  );
}

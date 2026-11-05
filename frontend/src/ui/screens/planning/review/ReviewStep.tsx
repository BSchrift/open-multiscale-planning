// Review: which weekly aims the placed time doesn't reach, what was picked but not placed, and how the week's time is
// used. Aims are soft, so the plan can still finish short of them.

import { plannedByKind, weekAlerts } from '../../../../core/capacity';
import { spansAhead } from '../../../../core/slots';
import { blockMinutes, formatMinutes } from '../../../../core/dates';
import { ONE_OFFS_BUCKET } from '../../../../core/types';
import type { LocalDate } from '../../../../core/types';
import type { Layout } from '../../../app/registry';
import { useApp, useQuery } from '../../../app/store';
import { loadPlanning, weekModel } from '../model';

export function ReviewStep(props: { week: LocalDate; layout: Layout; onFinish(): void }) {
  const { week, layout } = props;
  const { clock } = useApp();
  const data = useQuery((sql) => loadPlanning(sql, clock, week), [week]).data;
  if (!data) return null;
  const m = weekModel(data, clock);
  const aims = m.aimRows(m.placedBy);
  const unmet = aims.filter((r) => r.short > 0);
  const name = (bucket: string) => (bucket === ONE_OFFS_BUCKET ? 'One offs' : (data.records.projects.find((p) => p.id === bucket)?.title ?? ''));
  const placedFor = (taskId: string) => data.blocks.filter((b) => b.task_id === taskId).reduce((sum, b) => sum + blockMinutes(b), 0);
  const left = m.picks.reduce((sum, p) => sum + Math.max(0, p.minutes - placedFor(p.task_id)), 0);

  // Set against the open time left, so only what's still ahead.
  const used = plannedByKind(spansAhead(m.slot.placed, m.slot));
  const free = Math.max(0, m.open - used.total);
  const scale = Math.max(1, m.open, used.total);
  const segs = [
    { label: 'Projects', minutes: used.project, cls: 'seg-project' },
    { label: 'Practices', minutes: used.practice, cls: 'seg-practice' },
    { label: 'One offs', minutes: used.one_off, cls: 'seg-maint' },
  ];
  const alerts = weekAlerts(m.slot, aims, m.pushback);

  return (
    <div className={layout === 'phone' ? 'scroll' : 'wrap stack'}>
      <div className="stack8">
        <h2>{unmet.length ? `${unmet.length} ${unmet.length === 1 ? 'aim' : 'aims'} not reached` : 'Ready to finish'}</h2>
        <div className="card stack8">
          {!unmet.length && <p className="quiet">All weekly aims are reached.</p>}
          {unmet.map((r) => (
            <div key={r.bucket} className="small">
              {name(r.bucket)}: {formatMinutes(r.got)} of {formatMinutes(r.aim)} aim
            </div>
          ))}
          {left > 0 && <p className="quiet">{formatMinutes(left)} of what you picked isn't scheduled. It stays on its project or in One offs.</p>}
          {data.calendar?.connected && <p className="quiet">Finishing pushes these blocks to the Time blocks calendar.</p>}
          {unmet.length > 0 && <p className="quiet">You can still finish short of an aim.</p>}
        </div>
      </div>
      <section className="card stack8" aria-label="How this week's time is used">
        <div>
          <span className="capnum">{formatMinutes(free)} free</span>
          <span className="quiet"> of {formatMinutes(m.open)} available</span>
        </div>
        <div
          className="capbar"
          role="img"
          aria-label={`${segs.map((g) => `${formatMinutes(g.minutes)} ${g.label.toLowerCase()}`).join(', ')}, ${formatMinutes(free)} free`}
        >
          {segs.map((g) => (
            <span key={g.cls} className={g.cls} style={{ width: `${Math.round((g.minutes / scale) * 100)}%` }} />
          ))}
        </div>
        <div className="legend">
          {segs.map((g) => (
            <span key={g.cls}>
              <i className={g.cls} />
              {g.label} {formatMinutes(g.minutes)}
            </span>
          ))}
          <span>
            <i className="seg-free" />
            Free {formatMinutes(free)}
          </span>
        </div>
        <p className="small quiet">Available is the time outside sleep, work and your other blocked times, minus calendar events, so it changes every week.</p>
        {alerts.map((a) => (
          <div key={a.title} className="warn" role="status">
            <div>
              <div className="strong">{a.title}</div>
              <div>{a.text}</div>
            </div>
          </div>
        ))}
      </section>
      {layout === 'desktop' && (
        <div className="row">
          <button className="btn pri" type="button" onClick={props.onFinish}>
            Finish plan
          </button>
        </div>
      )}
    </div>
  );
}

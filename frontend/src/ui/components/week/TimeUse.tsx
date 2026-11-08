// How a week's time is used: what's free of what's available, a bar of what's planned by kind, and the week's
// warnings. Week and planning's Review show it, each with its own figures.

import { formatMinutes } from '../../../core/dates';
import type { Minutes } from '../../../core/types';
import './week.css';

export function TimeUse(props: {
  open: Minutes;
  planned: { project: Minutes; practice: Minutes; one_off: Minutes; total: Minutes };
  free: Minutes;
  alerts: readonly { title: string; text: string }[];
}) {
  const { open, planned } = props;
  const segs = [
    { label: 'Projects', cls: 'seg-project', min: planned.project },
    { label: 'Practices', cls: 'seg-practice', min: planned.practice },
    { label: 'One offs', cls: 'seg-maint', min: planned.one_off },
  ];
  const scale = Math.max(1, open, planned.total);
  const free = formatMinutes(props.free);
  return (
    <section className="card stack" aria-label="How this week's time is used">
      <div className="stack8">
        <div>
          <span className="capnum">{free} free</span>
          <span className="quiet"> of {formatMinutes(open)} available</span>
        </div>
        <div className="capbar" role="img" aria-label={`${segs.map((g) => `${formatMinutes(g.min)} ${g.label.toLowerCase()}`).join(', ')}, ${free} free`}>
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
            <i className="seg-free" />
            Free {free}
          </span>
        </div>
        <p className="small quiet">Available is the time outside sleep, work and your other blocked times, minus calendar events, so it changes every week.</p>
      </div>
      {props.alerts.map((a) => (
        <div key={a.title} className="warn" role="status">
          <div>
            <div className="strong">{a.title}</div>
            <div>{a.text}</div>
          </div>
        </div>
      ))}
    </section>
  );
}

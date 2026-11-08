// Settings > Data retention: what's kept and for how long, in words, from the build's block of config/retention.yaml.
// It only informs; nothing here changes anything.

import { useEffect, useId, useRef } from 'react';
import { activeRetention } from '../../../core/retention';
import type { Period } from '../../../core/retention';
import type { Layout } from '../../app/registry';

const UNITS = [
  ['years', 'year'],
  ['months', 'month'],
  ['days', 'day'],
  ['hours', 'hour'],
  ['minutes', 'minute'],
  ['seconds', 'second'],
] as const;

/** '2 years', '30 days', '1 hour and 30 minutes'. */
export function describePeriod(p: Period): string {
  const parts = UNITS.filter(([key]) => p[key] > 0).map(([key, unit]) => `${p[key]} ${unit}${p[key] === 1 ? '' : 's'}`);
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : (parts[0] ?? '');
}

export function RetentionPage(props: { layout: Layout }) {
  const policy = activeRetention();
  const id = useId();
  // Opened from a button on the page underneath, which is hidden now, so focus starts at this page's heading.
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus({ preventScroll: true }), []);
  const text = props.layout === 'phone' ? 'small' : undefined;
  const rows = policy
    ? [
        {
          title: `${describePeriod(policy.scheduling)} after they end`,
          body: "Time blocks and your answers to them, each week's plan and picks, finishes of repeating tasks, away dates, pinned planning stretches, and entries in a project's history of changes.",
        },
        {
          title: `${describePeriod(policy.closed)} after they're closed`,
          body: 'Tasks done, cancelled or dropped, one offs included. Projects finished or dropped, with their milestones. Goals once archived.',
        },
        { title: `${describePeriod(policy.deleted)} after you delete them`, body: 'Anything you delete.' },
      ]
    : [];
  return (
    <div className={props.layout === 'phone' ? 'stack settings' : 'wrap stack32 settings'}>
      <h1 ref={heading} tabIndex={-1}>
        Data retention
      </h1>
      <p className={text}>
        Your history is kept for a set time, then removed from your devices and from the server. Items are removed within a few days of each
        period ending.
      </p>
      <section className="stack8" aria-labelledby={`${id}kept`}>
        <h2 id={`${id}kept`}>How long it's kept</h2>
        <div className="card stack8">
          {rows.map((row) => (
            <div key={row.title} className={props.layout === 'phone' ? 'rowline' : 'setrow'}>
              <div className="stack8">
                <span className="strong">{row.title}</span>
                <span className={text}>{row.body}</span>
              </div>
            </div>
          ))}
        </div>
      </section>
      <section className="stack8" aria-labelledby={`${id}always`}>
        <h2 id={`${id}always`}>Kept until you delete it</h2>
        <div className="card">
          <p className={text}>
            Open tasks and Inbox items, active and paused projects and their milestones, goals you haven't archived, practices, your settings
            and your calendars.
          </p>
        </div>
      </section>
    </div>
  );
}

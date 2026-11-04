// Analytics: one week, or the current stretch (the last 8 weeks with no cadence). Every figure comes from
// core/analytics; this file only formats and draws it.

import { useState } from 'react';
import { loadAnalyticsData, raisedEstimates, stretchAnalytics, toggleAvoidedSlot, weekAnalytics } from '../../../core/analytics';
import type { Pattern, ReliabilityCount, StretchAnalytics, TrendRow, WeekAnalytics } from '../../../core/analytics';
import { addDays, formatDate, formatMinutes as hm, nowInstant, thisWeek, today, weekStart } from '../../../core/dates';
import { applyPlanChange, currentStretch } from '../../../core/plan';
import type { PlanChange, RecordWrite } from '../../../core/plan';
import { getSettings, listRecords, updateSettings } from '../../../core/records';
import type { AvoidedSlot, LocalDate } from '../../../core/types';
import { ONE_OFFS_BUCKET } from '../../../core/types';
import type { Layout, ScreenProps } from '../../app/registry';
import { useApp, useMutation, useQuery, useToday } from '../../app/store';
import { useToast } from '../../components/Toast';
import './analytics.css';

type View = 'week' | 'stretch';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const weekLabel = (w: LocalDate) => `${formatDate(w)} to ${formatDate(addDays(w, 6))}`;
const signed = (n: number) => `${n > 0 ? '+' : ''}${n}%`;

export default function Screen({ params, layout }: ScreenProps) {
  const day = useToday();
  const phone = layout === 'phone';
  const [view, setView] = useState<View>('week');
  const [picked, setPicked] = useState<LocalDate | null>(params.week && DATE_RE.test(params.week) ? weekStart(params.week) : null);

  const { data } = useQuery(
    async (sql, clock) => {
      const [records, settings] = await Promise.all([loadAnalyticsData(sql), getSettings(sql)]);
      const now = thisWeek(clock);
      const week = picked && picked < now ? picked : now;
      const stretch = currentStretch(settings, today(clock));
      const figures: WeekAnalytics | StretchAnalytics =
        view === 'week' ? weekAnalytics(records, clock, week) : stretchAnalytics(records, clock, stretch);
      return { view, figures, stretch, week, now, projects: records.projects };
    },
    [view, picked, day],
  );

  const tabs = (
    <div className="row" role="group" aria-label="Analytics time range">
      {(['week', 'stretch'] as const).map((v) => (
        <button key={v} type="button" className={`dchip${view === v ? ' on' : ''}`} aria-pressed={view === v} onClick={() => setView(v)}>
          {v === 'week' ? 'Week' : data && !data.stretch ? 'Last 8 weeks' : 'This stretch'}
        </button>
      ))}
    </div>
  );
  const header = phone ? (
    <>
      <h1>Analytics</h1>
      {tabs}
    </>
  ) : (
    <div className="between">
      <h1>Analytics</h1>
      {tabs}
    </div>
  );
  const wrapClass = phone ? 'stack analytics' : 'wrap stack32 analytics';

  // Same root and header while loading, so focus and the heading survive the first read.
  if (!data) return <div className={wrapClass}>{header}</div>;
  // While a new view loads, data still holds the last one, so draw what it holds.
  const { figures, stretch, week, now } = data;
  const isWeek = data.view === 'week';
  const trendWeeks = figures.trend.weeks;

  return (
    <div className={wrapClass}>
      {header}
      {isWeek && (
        <WeekNav
          layout={layout}
          label={weekLabel(week)}
          sub={week === now ? 'This week, so far' : 'Past week'}
          prev={week > trendWeeks[0]! ? () => setPicked(addDays(week, -7)) : null}
          next={week < now ? () => setPicked(addDays(week, 7)) : null}
        />
      )}
      {!isWeek && (
        <div className="strong">{stretch ? `This stretch, ${formatDate(stretch.start)} to ${formatDate(stretch.end)}` : 'Last 8 weeks'}</div>
      )}
      {!isWeek && <Patterns layout={layout} patterns={(figures as StretchAnalytics).patterns} projects={data.projects} />}
      <section className="card stack8">
        <h2>Time by goal, and One offs</h2>
        <p className="small quiet">
          {hm(figures.time.delivered_min)} delivered of {hm(figures.time.planned_min)} planned
          {isWeek && figures.current ? ', with the week still in progress.' : '.'}
        </p>
        {figures.time.rows.map((r) => (
          <Bar
            key={r.id}
            layout={layout}
            kind={r.id === ONE_OFFS_BUCKET ? 'oneoff' : 'goal'}
            name={r.name}
            value={`${hm(r.delivered_min)} of ${hm(r.planned_min)}`}
            pct={r.pct}
            alt={`${r.name}: ${hm(r.delivered_min)} delivered of ${hm(r.planned_min)} planned`}
          />
        ))}
      </section>
      {figures.practices.length > 0 && (
        <section className="card stack8">
          <h2>Practices</h2>
          {figures.practices.map((r) => (
            <Bar
              key={r.id}
              layout={layout}
              kind="practice"
              name={r.name}
              value={`${hm(r.spent_min)} of ${hm(r.target_min)}`}
              pct={r.pct}
              alt={`${r.name}: ${hm(r.spent_min)} of ${hm(r.target_min)} target`}
            />
          ))}
          <p className="small quiet">Time spent against your target. Missed sessions just pass, and don't need a new time.</p>
        </section>
      )}
      <section className="card stack">
        <h2>Reliability</h2>
        <p className="small quiet">Done and Partly as a share of the blocks you answered.</p>
        <Reliability layout={layout} name="Project tasks" count={figures.reliability.project} />
        <Reliability layout={layout} name="One offs" count={figures.reliability.one_offs} oneOff />
        <p className="small quiet">
          {figures.unanswered === 1
            ? "1 block went unanswered and isn't included."
            : `${figures.unanswered} blocks went unanswered and aren't included.`}{' '}
          Moving a block before it starts doesn't count.
        </p>
      </section>
      <Trend layout={layout} figures={figures} now={now} note={trendNote(isWeek, !!stretch, phone)} delta={(r) => delta(r, isWeek, !!stretch)} />
      <Stats layout={layout} figures={figures} />
    </div>
  );
}

function trendNote(isWeek: boolean, hasStretch: boolean, phone: boolean): string {
  if (isWeek) return phone ? 'The selected week is darker, with its date in bold.' : 'The selected week is darker.';
  if (hasStretch) return phone ? 'Weeks in this plan are darker, with their dates in bold.' : 'Weeks in this plan are darker.';
  return 'All 8 weeks count.';
}

function delta(r: TrendRow, isWeek: boolean, hasStretch: boolean): string {
  const change = r.change_min;
  if (change === null) return isWeek ? '' : hasStretch ? 'this plan so far' : 'last 8 weeks';
  if (change === 0) return 'same as prior week';
  return `${change > 0 ? '+' : '-'}${hm(Math.abs(change))} vs prior week`;
}

function WeekNav(props: { layout: Layout; label: string; sub: string; prev: (() => void) | null; next: (() => void) | null }) {
  const phone = props.layout === 'phone';
  const middle = (
    <div style={{ textAlign: 'center' }}>
      <div className="strong">{props.label}</div>
      <div className="small quiet">{props.sub}</div>
    </div>
  );
  const button = (label: string, glyph: string, onClick: (() => void) | null) =>
    phone ? (
      <button type="button" className="icbtn" aria-label={label} disabled={!onClick} onClick={onClick ?? undefined}>
        {glyph}
      </button>
    ) : (
      <button type="button" className="btn sm" disabled={!onClick} onClick={onClick ?? undefined}>
        {label}
      </button>
    );
  return (
    <div className={phone ? 'between' : 'weeknav'}>
      {button('Previous week', '‹', props.prev)}
      {middle}
      {button('Next week', '›', props.next)}
    </div>
  );
}

function Patterns(props: { layout: Layout; patterns: Pattern[]; projects: { id: string; title: string }[] }) {
  const toast = useToast();
  const { clock } = useApp();
  const [raised, setRaised] = useState<string[]>([]);
  const toggle = useMutation(async (w, slot: AvoidedSlot) => {
    const settings = await getSettings(w.sql);
    await updateSettings(w, { avoided_slots: toggleAvoidedSlot(settings.avoided_slots, slot) });
  });
  // The project remembers the raise, so the work that led to it isn't offered again.
  const raise = useMutation(async (w, projectId: string, overPct: number) => {
    const tasks = raisedEstimates(await listRecords(w.sql, 'task'), projectId, overPct).map(({ id, ...fields }): RecordWrite => ({ type: 'task', id, fields }));
    return applyPlanChange(w, { writes: [...tasks, { type: 'project', id: projectId, fields: { estimates_raised_at: nowInstant(clock) } }] });
  });
  const restore = useMutation(async (w, before: PlanChange) => {
    await applyPlanChange(w, before);
    return true;
  });

  const onRaise = async (p: Extract<Pattern, { kind: 'estimate' }>) => {
    const before = await raise.run(p.project_id, p.over_pct);
    if (!before) return;
    setRaised((r) => [...r, p.project_id]);
    toast.show('Estimates raised', {
      undo: async () => {
        if (await restore.run(before)) setRaised((r) => r.filter((id) => id !== p.project_id));
      },
    });
  };

  const rows = [
    ...props.patterns
      .filter((p) => !(p.kind === 'estimate' && raised.includes(p.project_id)))
      .map((p) =>
        p.kind === 'best'
          ? { text: p.text, label: null, act: null }
          : { text: p.text, label: p.label, act: p.kind === 'estimate' ? () => void onRaise(p) : () => void toggle.run(p.slot) },
      ),
    ...raised.map((id) => ({ text: `${props.projects.find((x) => x.id === id)?.title ?? 'These'} tasks now start with longer estimates.`, label: null, act: null })),
  ];

  const phone = props.layout === 'phone';
  if (rows.length === 0) return null;
  return (
    <section className="card stack8">
      <h2>Patterns</h2>
      {rows.map((r) => (
        <div key={r.text} className={phone ? 'rowline' : 'qrow'}>
          <div>{r.text}</div>
          {r.act &&
            (phone ? (
              <div>
                <button type="button" className="btn" onClick={r.act}>
                  {r.label}
                </button>
              </div>
            ) : (
              <button type="button" className="btn sm" onClick={r.act}>
                {r.label}
              </button>
            ))}
        </div>
      ))}
    </section>
  );
}

function Bar(props: { layout: Layout; kind: 'goal' | 'oneoff' | 'practice'; name: string; value: string; pct: number; alt: string }) {
  const { kind, name, value, pct, alt } = props;
  if (props.layout === 'desktop') {
    return (
      <div className={`hbar${kind === 'oneoff' ? ' mnt' : kind === 'practice' ? ' prac' : ''}`} title={alt}>
        <span>{name}</span>
        <span className="track">
          <span className="fill" style={{ width: `${pct}%` }} />
        </span>
        <span>{value}</span>
      </div>
    );
  }
  return (
    <div className={kind === 'oneoff' ? 'amaint atop' : kind === 'practice' ? 'apractice' : undefined} role="img" aria-label={alt}>
      <div className="between small">
        <span className={kind === 'oneoff' ? 'mhead' : undefined}>{name}</span>
        <span className="strong">{value}</span>
      </div>
      <span className="abar">
        <i style={{ width: `${pct}%` }} />
      </span>
    </div>
  );
}

const PARTS = [
  ['done', 'done', 'a', 'asplit0'],
  ['partly', 'partly', 'b', 'asplit1'],
  ['not', 'not done', 'c', 'asplit2'],
] as const;

function Reliability(props: { layout: Layout; name: string; count: ReliabilityCount; oneOff?: boolean }) {
  const { name, count, oneOff } = props;
  const phone = props.layout === 'phone';
  const alt = `${name}: ${count.done} done, ${count.partly} partly, ${count.not} not done`;
  const cls = (p: (typeof PARTS)[number]) => (phone ? p[3] : p[2]);
  return (
    <div className={`stack8${oneOff ? (phone ? ' amaint' : ' mnt') : ''}`}>
      <div className="between">
        <span className={`strong${oneOff && phone ? ' mhead' : ''}`}>{name}</span>
        <span>
          <span className="strong">{count.pct}%</span>
          <span className="small quiet"> of {count.total} {count.total === 1 ? 'block' : 'blocks'}</span>
        </span>
      </div>
      <div className={phone ? 'asplit' : 'split'} role="img" aria-label={alt} title={phone ? undefined : alt}>
        {PARTS.filter((p) => count[p[0]] > 0).map((p) => (
          <span key={p[0]} className={cls(p)} style={{ flex: count[p[0]] }} />
        ))}
      </div>
      <div className="legend" aria-hidden="true">
        {PARTS.map((p) => (
          <span key={p[0]}>
            <i className={cls(p)} />
            {count[p[0]]} {p[1]}
          </span>
        ))}
      </div>
    </div>
  );
}

function Trend(props: { layout: Layout; figures: WeekAnalytics; now: LocalDate; note: string; delta(r: TrendRow): string }) {
  const [nums, setNums] = useState(false);
  const { rows, weeks } = props.figures.trend;
  const alt = (r: TrendRow) => `${r.name}: ${r.bars.map((b) => `${formatDate(b.week)} ${hm(b.min)}`).join(', ')}`;
  const oneOff = (r: TrendRow) => r.id === ONE_OFFS_BUCKET;
  const head = (
    <>
      <h2>Time spent, week over week</h2>
      <p className="small quiet">Each bar is one week, on the same scale. {props.note}</p>
    </>
  );

  if (props.layout === 'desktop') {
    return (
      <section className="card stack8">
        {head}
        <div className="gridbox">
          <div className="trend">
            <div className="trow head" aria-hidden="true">
              <span />
              {weeks.map((w) => (
                <span key={w}>{formatDate(w)}</span>
              ))}
              <span />
            </div>
            {rows.map((r) => (
              <div key={r.id} className={`trow${oneOff(r) ? ' mnt' : ''}`} role="img" aria-label={alt(r)}>
                <span>{r.name}</span>
                {r.bars.map((b) => (
                  <span key={b.week} className="tcell" title={`${formatDate(b.week)}: ${hm(b.min)}${b.week === props.now ? ' so far' : ''}`}>
                    <span className={`tb${b.on ? ' on' : ''}`} style={{ height: b.h }} />
                  </span>
                ))}
                <span className="tval">
                  <span className="strong">{hm(r.shown_min)}</span>
                  <span className="small quiet">{props.delta(r)}</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      </section>
    );
  }

  const on = rows[0]?.bars.map((b) => b.on) ?? [];
  return (
    <section className="card stack8">
      {head}
      <div>
        <button type="button" className="btn" aria-expanded={nums} onClick={() => setNums(!nums)}>
          {nums ? "Hide each week's numbers" : "Show each week's numbers"}
        </button>
      </div>
      <div className="taxis" aria-hidden="true">
        {weeks.map((w, i) => (
          <span key={w} className={on[i] ? 'on' : undefined}>
            {formatDate(w)}
          </span>
        ))}
      </div>
      {rows.map((r) => {
        const d = props.delta(r);
        return (
          <div key={r.id} className={`stack8 trendrow${oneOff(r) ? ' amaint' : ''}`}>
            <div className="between small">
              <span className={`strong${oneOff(r) ? ' mhead' : ''}`}>{r.name}</span>
              <span style={{ textAlign: 'right' }}>
                <span className="strong">{hm(r.shown_min)}</span>
                {d && <span className="quiet"> {d}</span>}
              </span>
            </div>
            <div className="tbars" role="img" aria-label={alt(r)}>
              {r.bars.map((b) => (
                <span key={b.week} className="tcol">
                  <span className={`tb${b.on ? ' on' : ''}`} style={{ height: b.h }} />
                </span>
              ))}
            </div>
            {nums && (
              <div className="taxis tnums" aria-hidden="true">
                {r.bars.map((b) => (
                  <span key={b.week}>{hm(b.min)}</span>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}

function Stats(props: { layout: Layout; figures: WeekAnalytics | StretchAnalytics }) {
  const f = props.figures;
  const stats: [string, string][] = [];
  if (f.started_on_time !== null) stats.push([`${f.started_on_time}%`, 'Blocks started within 10 minutes']);
  if ('milestones_met' in f && f.milestones_met.total) {
    stats.push([`${f.milestones_met.met} of ${f.milestones_met.total}`, 'Milestones met on their original date']);
  }
  if ('estimate_drift' in f && f.estimate_drift !== null) stats.push([signed(f.estimate_drift), 'Actual time compared with estimates']);
  if (!stats.length) return null;
  const phone = props.layout === 'phone';
  return (
    <section className={phone ? 'card stack' : 'card stats'}>
      {stats.map(([value, label]) => (
        <div key={label}>
          <div className={phone ? 'anum' : 'num'}>{value}</div>
          <div className="small quiet">{label}</div>
        </div>
      ))}
    </section>
  );
}

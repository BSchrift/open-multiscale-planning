// Done: one day's list of what was finished and the time worked, any day up to today, stepped a day at a time as Week
// steps weeks. Totals first, then Finished, Time worked, and the blocks that ended with no answer, each in the order it
// happened. Mark how it went asks such a block the missed blocks question, whose answer moves it into the list, with
// Undo. Nothing here is stored: it's all read from the records (core/done.ts). Params: day, to open on that day, as
// Today's line and Week's day headings do.

import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { addDays, formatDayLong, formatMinutes, formatTime } from '../../../core/dates';
import type { DoneBlock, DoneDay, DoneFinish, DoneKind, DoneWork } from '../../../core/done';
import type { LocalDate } from '../../../core/types';
import { useNav } from '../../app/nav';
import type { ScreenProps } from '../../app/registry';
import { useApp, useQuery, useToday } from '../../app/store';
import { formatRange, KIND_WORD } from '../../components/blocks/describe';
import { MissedSheet } from '../../components/blocks/MissedSheet';
import { MilestoneDiamond } from '../../components/MilestoneDiamond';
import { TaskName } from '../../components/task/TaskName';
import { useFocusLanding } from '../../components/useFocusLanding';
import { DayArrows } from '../../components/WeekArrows';
import { loadDoneDay } from './data';
import '../week/week.css';
import './done.css';

/** Week's colours for each kind. */
const SWATCH: Record<DoneKind, string> = { project: 'ev-project', practice: 'ev-practice', one_off: 'ev-maint', planning: 'ev-planning' };
const SEGMENTS: { kind: DoneKind; label: string; cls: string }[] = [
  { kind: 'project', label: 'Projects', cls: 'seg-project' },
  { kind: 'practice', label: 'Practices', cls: 'seg-practice' },
  { kind: 'one_off', label: 'One offs', cls: 'seg-maint' },
  { kind: 'planning', label: 'Planning', cls: 'seg-planning' },
];

/** A task's name opens its popup, unless it was deleted since. */
function Name(props: { item: DoneBlock | DoneFinish; title: string; taskId: string | null }) {
  const { item, title, taskId } = props;
  const opens = !!taskId && !item.deleted && (item.kind === 'project' || item.kind === 'one_off');
  return (
    <span>
      {opens ? <TaskName id={taskId} title={title} className="rowname" /> : title}
      {item.deleted && <span className="donedel">deleted</span>}
    </span>
  );
}

function Group(props: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className="stack8" aria-labelledby={id}>
      <h3 id={id}>{props.title}</h3>
      <ul className="card donelist">{props.children}</ul>
    </section>
  );
}

function Totals(props: { done: DoneDay }) {
  const { finished, worked_min, by_kind } = props.done.total;
  const shown = SEGMENTS.filter((s) => by_kind[s.kind] > 0);
  return (
    <section className="card donetot" aria-label="Totals">
      <div className="donetotline">
        <span className="strong">{finished} finished</span>
        {worked_min > 0 && (
          <>
            {' · '}
            <span className="strong">{formatMinutes(worked_min)}</span> worked
          </>
        )}
      </div>
      {worked_min > 0 && (
        <>
          <div className="capbar" role="img" aria-label={shown.map((s) => `${formatMinutes(by_kind[s.kind])} ${s.label.toLowerCase()}`).join(', ')}>
            {shown.map((s) => (
              <span key={s.kind} className={s.cls} style={{ width: `${(by_kind[s.kind] / worked_min) * 100}%` }} />
            ))}
          </div>
          <div className="legend">
            {shown.map((s) => (
              <span key={s.kind}>
                <i className={SWATCH[s.kind]} />
                {s.label} {formatMinutes(by_kind[s.kind])}
              </span>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

export default function DoneScreen(props: ScreenProps) {
  const { layout } = useApp();
  const nav = useNav();
  const today = useToday();
  const phone = layout === 'phone';
  const [day, setDay] = useState<LocalDate>(() => (props.params.day && props.params.day < today ? props.params.day : today));
  // Left on today, the page follows it when the day turns over; a day stepped to stays.
  const [seen, setSeen] = useState(today);
  if (seen !== today) {
    setSeen(today);
    if (day === seen) setDay(today);
  }
  // Choosing Done again in the sidebar comes back to today.
  const signal = useRef(nav.topSignal);
  useEffect(() => {
    if (signal.current !== nav.topSignal && nav.tab === 'done') setDay(today);
    signal.current = nav.topSignal;
  }, [nav.topSignal, nav.tab, today]);

  const done = useQuery((sql, clock) => loadDoneDay(sql, clock, day), [day]).data;
  const [marking, setMarking] = useState<string | null>(null);
  const land = useFocusLanding();
  const root = useRef<HTMLDivElement>(null);
  const asked = marking ? done?.unmarked.find((u) => u.block.id === marking) : undefined;
  // Once answered, the block has left Not marked yet: focus follows it into the list, or else to the day's heading.
  useEffect(() => {
    if (!marking || !done || asked) return;
    setMarking(null);
    land(() => root.current?.querySelector<HTMLElement>(`[data-block="${marking}"]`)?.closest('li') ?? root.current?.querySelector<HTMLElement>('.donehead h1, .donehead h2'));
  }, [marking, done, asked, land]);

  const className = phone ? 'stack donepage' : 'wrap stack24 donepage';
  if (!done) return <div className={className} />;
  const date = done.date;
  const title = formatDayLong(date);
  const range = (b: DoneBlock) => formatRange(b.block.start, b.block.end, b.zone);
  const where = (b: DoneBlock) => (b.kind === 'project' ? (b.project ?? KIND_WORD.project) : KIND_WORD[b.kind]);
  const finishedWhere = (f: DoneFinish) =>
    f.type === 'milestone' ? ['Milestone reached', f.project].filter(Boolean).join(', ') : f.kind === 'one_off' ? KIND_WORD.one_off : [f.project, f.milestone].filter(Boolean).join(', ');

  const head = phone ? (
    <div className="stack8 donehead">
      <div className="between">
        <button className="icbtn" type="button" aria-label="Previous day" onClick={() => setDay(addDays(day, -1))}>
          ‹
        </button>
        <div className="wktitle">
          <div className="small quiet">Done</div>
          <h2 tabIndex={-1}>{title}</h2>
        </div>
        <button className="icbtn" type="button" aria-label="Next day" disabled={day >= today} onClick={() => setDay(addDays(day, 1))}>
          ›
        </button>
      </div>
      {day !== today && (
        <div className="wkcenter">
          <button className="btn" type="button" onClick={() => setDay(today)}>
            Today
          </button>
        </div>
      )}
    </div>
  ) : (
    <div className="row wkhead donehead">
      <DayArrows day={day} today={today} last={today} onDay={setDay} />
      <div>
        <div className="date">Done</div>
        <h1 tabIndex={-1}>{title}</h1>
      </div>
    </div>
  );

  const work = (w: DoneWork) => (
    <li key={w.block.id} className="donerow" data-block={w.block.id} tabIndex={-1}>
      <span className="donetime">{formatTime(w.block.start, w.zone)}</span>
      <span className="donemark" aria-hidden="true">
        <i className={`sw ${SWATCH[w.kind]}`} />
      </span>
      <span className="donewhat">
        <Name item={w} title={w.block.title ?? ''} taskId={w.block.task_id} />
        <span className="small quiet">
          {where(w)}
          {!phone && `, ${range(w)}`}
        </span>
      </span>
      <span className="doneend">
        <b>{formatMinutes(w.minutes)}</b>
        {w.left != null && `${formatMinutes(w.left)} left`}
      </span>
    </li>
  );

  return (
    <div ref={root} className={className}>
      {head}
      {done.total.finished > 0 ? (
        <Totals done={done} />
      ) : (
        <div className="card doneempty">{date === today ? 'Nothing finished yet today' : `Nothing finished on ${title.split(',')[0]}`}</div>
      )}
      {done.finished.length > 0 && (
        <Group title="Finished">
          {done.finished.map((f) => (
            <li key={f.id} className="donerow" tabIndex={-1}>
              <span className="donetime">{formatTime(f.at, f.zone)}</span>
              <span className="donemark" aria-hidden="true">
                {f.type === 'milestone' ? <MilestoneDiamond state={{ met: true }} /> : <i className="tick" />}
              </span>
              <span className="donewhat">
                <Name item={f} title={f.title} taskId={f.task_id} />
                <span className="small quiet">{finishedWhere(f)}</span>
                {f.work.map((w) => (
                  <span key={w.block.id} className="donesub small quiet" data-block={w.block.id}>
                    <i className={`sw ${SWATCH[w.kind]}`} aria-hidden="true" />
                    {range(w)} · {formatMinutes(w.minutes)}
                  </span>
                ))}
              </span>
            </li>
          ))}
        </Group>
      )}
      {done.worked.length > 0 && <Group title="Time worked">{done.worked.map(work)}</Group>}
      {done.unmarked.length > 0 && (
        <Group title="Not marked yet">
          {done.unmarked.map((u) => (
            <li key={u.block.id} className="donerow unmarked" data-block={u.block.id} tabIndex={-1}>
              <span className="donetime">{formatTime(u.block.start, u.zone)}</span>
              <span className="donemark" aria-hidden="true">
                <i className={`sw ${SWATCH[u.kind]}`} />
              </span>
              <span className="donewhat">
                <Name item={u} title={u.block.title ?? ''} taskId={u.block.task_id} />
                <span className="small quiet">
                  {where(u)}, {phone ? `until ${formatTime(u.block.end, u.zone)}` : range(u)}
                </span>
              </span>
              <button className={phone ? 'btn' : 'btn sm'} type="button" aria-label={`Mark how ${u.block.title ?? 'this block'} went`} onClick={() => setMarking(u.block.id)}>
                Mark how it went
              </button>
            </li>
          ))}
        </Group>
      )}
      {asked && <MissedSheet blocks={[asked.block]} onClose={() => setMarking(null)} />}
    </div>
  );
}

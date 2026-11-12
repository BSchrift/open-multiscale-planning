// The block in progress with its countdown and time-spent ring, or the next one with Start early. The ring is also
// Pause and Resume: a tap stops the countdown and the ring together, and the sign inside says which a tap will do.
// During a task's block the card also shows the first lines of its description and how many attachments it has, and a
// task's name opens its popup.

import { useId, useRef, useState } from 'react';
import { currentBlock, isPaused, nextBlock, pauseWords, ringFill, timeLeftMs, timeSpentMs } from '../../../core/blocks';
import { formatMinutes, formatTime, instantMs } from '../../../core/dates';
import { notesLines } from '../../../core/notes';
import { taskAttachments } from '../../../core/queries';
import type { BlockRow } from '../../../core/queries';
import { getRecord } from '../../../core/records';
import type { Layout } from '../../app/registry';
import { useApp, useNow, useQuery } from '../../app/store';
import { formatRange } from '../../components/blocks/describe';
import { useBlockActions } from '../../components/blocks/useBlockActions';
import { InfoIcon } from '../../components/icons';
import { TaskName } from '../../components/task/TaskName';
import { PlanningNow } from './PlanningNow';

const pad = (n: number) => String(n).padStart(2, '0');
const MINUTE_MS = 60_000;

function Countdown(props: { block: BlockRow; now: number }) {
  const left = Math.floor(timeLeftMs(props.block, props.now) / 1000);
  const h = Math.floor(left / 3600);
  const m = Math.floor(left / 60) % 60;
  return (
    <div className={`clock${isPaused(props.block) ? ' quiet' : ''}`} role="timer">
      {h ? `${h}:${pad(m)}` : m}:{pad(left % 60)}
    </div>
  );
}

/** '22 minutes', '1 hour 4 minutes', for screen readers, which read '1h 4m' letter by letter. */
function spoken(minutes: number): string {
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return [h ? unit(h, 'hour') : '', m || !h ? unit(m, 'minute') : ''].filter(Boolean).join(' ');
}

/** What a tap on the ring does: two bars to pause, a triangle to resume. */
function Sign(props: { paused: boolean }) {
  return (
    <svg className="sign" viewBox="0 0 12 12" aria-hidden="true">
      {props.paused ? <path className="play" d="M3 1.5L10.5 6L3 10.5Z" /> : <path className="bars" d="M4 2V10M8 2V10" />}
    </svg>
  );
}

const R = 27;
const C = 2 * Math.PI * R;
/** A stroke dash filling a share of a circle's length. Lengths rather than pathLength, which older WebKit ignores on circles. */
const dash = (share: number, length: number) => `${(share * length).toFixed(1)} ${length.toFixed(1)}`;

/**
 * The ring, which fills toward the block's end, and the control that pauses and resumes it. It never disables while
 * saving, which would drop its focus to the page; a tap that lands meanwhile finds Pause or Resume already done.
 */
function SpentRing(props: { block: BlockRow; now: number; onToggle(): void }) {
  const { block, now } = props;
  const paused = isPaused(block);
  const spent = Math.floor(timeSpentMs(block, now) / MINUTE_MS);
  const fill = ringFill(block, now);
  // The name says what a tap does first, then what the ring shows: the time spent, and the percent it isn't showing.
  const label = `${paused ? 'Resume' : 'Pause'}, ${spoken(spent)} spent, ${Math.round(fill * 100)}% of the block`;
  return (
    <button type="button" className={`spentring${paused ? ' paused' : ''}`} aria-label={label} onClick={props.onToggle}>
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <circle className="rtrack" cx="32" cy="32" r={R} />
        <circle className="rfill" cx="32" cy="32" r={R} strokeDasharray={dash(fill, C)} />
      </svg>
      <span className="rmid" aria-hidden="true">
        {formatMinutes(spent)}
        <Sign paused={paused} />
      </span>
    </button>
  );
}

/** The label over the countdown, with the ⓘ that opens the key to the ring inside the card. */
function ClockLabel(props: { block: BlockRow; now: number }) {
  const { block, now } = props;
  const [open, setOpen] = useState(false);
  const keyId = useId();
  const paused = isPaused(block);
  const pausedFor = paused ? Math.floor((now - instantMs(block.paused_at!)) / MINUTE_MS) : 0;
  return (
    <>
      <div className="small quiet nowlabel">
        {!paused ? 'In progress, time left' : pausedFor ? `Paused for ${pauseWords(pausedFor)}` : 'Paused'}
        <button
          type="button"
          className="nowinfo"
          aria-label="What the ring means"
          aria-expanded={open}
          aria-controls={keyId}
          onClick={() => setOpen((o) => !o)}
        >
          <InfoIcon />
        </button>
      </div>
      {open && (
        <div id={keyId} className="nowkey" role="group" aria-label="Key">
          <div className="nowkeyrow">
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <circle className="rtrack" cx="8" cy="8" r="6" />
              <circle className="rfill" cx="8" cy="8" r="6" strokeDasharray={dash(0.38, 2 * Math.PI * 6)} />
            </svg>
            Time spent, filling toward the end
          </div>
          <div className="nowkeyrow">
            <Sign paused={false} />
            Tap the ring to pause the countdown
          </div>
          <div className="nowkeyrow">
            <Sign paused />
            Resume, and the end moves later
          </div>
        </div>
      )}
    </>
  );
}

export function NowCard(props: { blocks: readonly BlockRow[]; layout: Layout }) {
  const { blocks, layout } = props;
  const { clock } = useApp();
  const now = useNow(1000);
  const actions = useBlockActions();
  const head = useRef<HTMLHeadingElement>(null);
  // Start, Start early and Do next block instead go once pressed, so focus moves to the card's heading, not the page.
  const thenFocus = (done: Promise<unknown>) => void done.then(() => head.current?.focus());
  const zone = clock.zone();
  const cur = currentBlock(blocks, clock);
  const next = nextBlock(blocks, clock);
  const phone = layout === 'phone';
  const taskId = cur?.task_id ?? null;
  const details = useQuery(
    async (sql) => (taskId ? { task: await getRecord(sql, 'task', taskId), attached: (await taskAttachments(sql, taskId)).length } : null),
    [taskId],
  ).data;
  const glance = details?.task?.notes ? notesLines(details.task.notes, 2) : [];
  const attached = details?.attached ?? 0;

  if (cur?.task_kind === 'planning') return <PlanningNow block={cur} layout={layout} />;
  if (cur) {
    const started = !!cur.started_at;
    const paused = isPaused(cur);
    const markDone = (
      <button className="btn" type="button" disabled={actions.pending} onClick={() => void actions.markDoneNow(cur, next)}>
        Mark done now
      </button>
    );
    return (
      <section className={`now stack${started ? ' timed' : ''}`} aria-label="Current block">
        <div className="small quiet">Now, {formatRange(cur.start, cur.end, zone)}</div>
        <h2 ref={head} tabIndex={-1}>
          {cur.task_id ? <TaskName id={cur.task_id} title={cur.title ?? ''} /> : cur.title}
        </h2>
        {glance.length > 0 && <p className="nownotes">{glance.join('\n')}</p>}
        {attached > 0 && <div className="small quiet">{attached === 1 ? '1 attachment' : `${attached} attachments`}</div>}
        {started && (
          <SpentRing block={cur} now={now} onToggle={() => void (paused ? actions.resume(cur) : actions.pause(cur))} />
        )}
        {started && (
          <div>
            <ClockLabel block={cur} now={now} />
            <Countdown block={cur} now={now} />
            {paused && <div className="small quiet">Ends at {formatTime(cur.end, zone)} unless you resume.</div>}
          </div>
        )}
        {phone && started && markDone}
        {(!phone || !started) && (
          <div className="row">
            {!started && (
              <>
                <button className={`btn pri${phone ? ' grow' : ''}`} type="button" disabled={actions.pending} onClick={() => thenFocus(actions.start(cur))}>
                  Start
                </button>
                {next && (
                  <button className="btn" type="button" disabled={actions.pending} onClick={() => thenFocus(actions.swap(cur, next))}>
                    Do next block instead
                  </button>
                )}
              </>
            )}
            {!phone && markDone}
          </div>
        )}
      </section>
    );
  }

  if (next) {
    const free = `Free until ${formatTime(next.start, zone)}`;
    return (
      <section className="now stack" aria-label="Current block">
        <div className="small quiet">{phone ? `${free}. Next:` : free}</div>
        <h2 ref={head} tabIndex={-1}>
          {!phone && 'Next: '}
          {next.task_id ? <TaskName id={next.task_id} title={next.title ?? ''} /> : next.title}
        </h2>
        <div className="row">
          <button className={phone ? 'btn pri' : 'btn'} type="button" disabled={actions.pending} onClick={() => thenFocus(actions.startEarly(next))}>
            Start early
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="now stack" aria-label="Current block">
      <div className="small quiet">Nothing else planned today.</div>
    </section>
  );
}

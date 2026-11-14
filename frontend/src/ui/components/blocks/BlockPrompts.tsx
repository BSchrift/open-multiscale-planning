// The questions a block asks as it happens: "Have you started?", the end-of-block prompt (Task finished, Partly with the
// time left, Not done) and a practice's time logged. Several missed blocks share one sheet, MissedSheet. On desktop
// these sit in the corner over the page; on phone they're sheets. Focus moves in, and back to where it was when they
// close. One that opens while you're typing or in another dialog waits until you're done.

import { useEffect, useId, useState } from 'react';
import type { ReactNode } from 'react';
import { isPaused, partlyLeft, spentLine, timeLeftMs, workMinutes } from '../../../core/blocks';
import { formatMinutes, instantMs, localDate } from '../../../core/dates';
import type { BlockRow } from '../../../core/queries';
import { getRecord } from '../../../core/records';
import { useOverlay } from '../../app/nav';
import { STILL_GOING_MIN } from '../../app/reminders';
import { useApp, useQuery } from '../../app/store';
import { EstimateSlider } from '../EstimateSlider';
import { Sheet } from '../Sheet';
import { useDialogFocus } from '../useDialogFocus';
import { useBlockActions } from './useBlockActions';

function DesktopPrompt(props: { label: string; onClose(): void; children: ReactNode }) {
  const ref = useDialogFocus<HTMLDivElement>(props.onClose);
  return (
    <div ref={ref} className="prompt stack" role="dialog" aria-label={props.label} tabIndex={-1}>
      {props.children}
    </div>
  );
}

/** Someone typing, or working in another dialog, whose keys a prompt opening on its own, or Today's P, would take. */
export const busy = () =>
  !!document.querySelector('[aria-modal="true"]') ||
  !!document.activeElement?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="dialog"]');

/**
 * The corner panel on desktop, a sheet on phone, or with `sheet` a sheet on both, with that class. It waits while you're
 * busy, looking again each time it re-renders.
 */
export function PromptFrame(props: { label: string; onClose(): void; tall?: boolean; sheet?: string; children: ReactNode }) {
  const { layout } = useApp();
  const [ready, setReady] = useState(false);
  // Read only to render again when Capture or Process closes, which renders nothing else here.
  useOverlay();
  // After commit, so a prompt this one replaces has already gone.
  useEffect(() => {
    if (!ready && !busy()) setReady(true);
  });
  if (!ready) return null;
  if (layout === 'phone' || props.sheet) {
    return (
      <Sheet label={props.label} onClose={props.onClose} {...(props.tall ? { tall: true } : {})} {...(props.sheet ? { className: props.sheet } : {})}>
        {props.children}
      </Sheet>
    );
  }
  return <DesktopPrompt {...props} />;
}

function useTask(block: BlockRow) {
  return useQuery((sql) => (block.task_id ? getRecord(sql, 'task', block.task_id) : Promise.resolve(undefined)), [block.task_id]).data;
}

function Heading(props: { over: string; title: ReactNode }) {
  const { layout } = useApp();
  return (
    <div>
      <div className="small quiet">{props.over}</div>
      {layout === 'phone' ? <h2>{props.title}</h2> : <div className="strong">{props.title}</div>}
    </div>
  );
}

function PartlyStep(props: { block: BlockRow; onClose(): void }) {
  const { block } = props;
  const task = useTask(block);
  const actions = useBlockActions();
  const [left, setLeft] = useState<number | null>(null);
  const value = left ?? (task ? partlyLeft(task, block) : null);
  return (
    <PromptFrame label="How much is left?" onClose={props.onClose}>
      <Heading over={block.title ?? ''} title="How much is left?" />
      <EstimateSlider label="Time left" value={value} noneLabel="Choose a time" onChange={setLeft} />
      <div className="row">
        <button
          className="btn pri"
          type="button"
          disabled={!value || actions.pending}
          onClick={() => void actions.answer(block, { result: 'partly', remaining_min: value }).then(props.onClose)}
        >
          Save
        </button>
      </div>
    </PromptFrame>
  );
}

function PracticeLog(props: { block: BlockRow; onClose(): void }) {
  const { block } = props;
  const actions = useBlockActions();
  const id = useId();
  const length = Math.max(5, workMinutes(block));
  const [minutes, setMinutes] = useState(length);
  const answer = (logged: number) =>
    void actions.answer(block, logged ? { result: 'done', logged_min: logged } : { result: 'not', logged_min: 0 }).then(props.onClose);
  return (
    <PromptFrame label="Block finished" onClose={props.onClose}>
      <Heading over="Block ended" title={block.title} />
      <div className="stack8">
        <div className="between">
          <label className="small quiet" htmlFor={id}>
            How much did you do?
          </label>
          <span className="strong">{formatMinutes(minutes)}</span>
        </div>
        <input
          id={id}
          className="logrange"
          type="range"
          min={5}
          max={length}
          step={5}
          value={minutes}
          aria-valuetext={formatMinutes(minutes)}
          onChange={(event) => setMinutes(Number(event.target.value))}
        />
      </div>
      <div className="row">
        <button className="btn pri" type="button" disabled={actions.pending} onClick={() => answer(minutes)}>
          {minutes === length ? `All ${formatMinutes(length)}` : `Log ${formatMinutes(minutes)}`}
        </button>
        <button className="btn" type="button" disabled={actions.pending} onClick={() => answer(0)}>
          Skipped
        </button>
      </div>
    </PromptFrame>
  );
}

/**
 * The end-of-block prompt. Work asks Task finished, Partly or Not done, with Partly setting the time left; a practice logs
 * how much was done. onClose without an answer means "Answer later".
 */
export function EndPrompt(props: { block: BlockRow; onClose(): void; partly?: boolean }) {
  const { block } = props;
  const { clock } = useApp();
  const actions = useBlockActions();
  const [partly, setPartly] = useState(!!props.partly);
  if (block.practice_id) return <PracticeLog block={block} onClose={props.onClose} />;
  if (partly) return <PartlyStep block={block} onClose={props.onClose} />;
  const answer = (result: 'done' | 'not') => void actions.answer(block, { result }).then(props.onClose);
  const now = clock.now();
  const spent = spentLine(block, clock.zone(), now);
  const paused = isPaused(block);
  // Resume would stretch an earlier day's block into today, so only the day's own block offers it.
  const resumable = paused && localDate(block.start, clock.zone()) === localDate(now, clock.zone());
  return (
    <PromptFrame label="Block finished" onClose={props.onClose}>
      <Heading over="Block ended" title={block.title} />
      {spent && <div className="small">{spent}</div>}
      <div className="stack8">
        <div className="row">
          <button className="btn pri" type="button" disabled={actions.pending} onClick={() => answer('done')}>
            Task finished
          </button>
          <button className="btn" type="button" onClick={() => setPartly(true)}>
            Partly
          </button>
          <button className="btn" type="button" disabled={actions.pending} onClick={() => answer('not')}>
            Not done
          </button>
        </div>
        <div className="row">
          {resumable ? (
            <button className="link small" type="button" disabled={actions.pending} onClick={() => void actions.resume(block).then(props.onClose)}>
              Resume, {formatMinutes(Math.round(timeLeftMs(block, now) / 60_000))} left
            </button>
          ) : (
            !paused && (
              <button className="link small" type="button" disabled={actions.pending} onClick={() => void actions.stillGoing(block).then(props.onClose)}>
                Still going, add {formatMinutes(STILL_GOING_MIN)}
              </button>
            )
          )}
          <button className="link small" type="button" onClick={props.onClose}>
            Answer later
          </button>
        </div>
      </div>
    </PromptFrame>
  );
}

/** "Have you started?", a few minutes into a block that hasn't been started. */
export function StartCheck(props: { block: BlockRow; next: BlockRow | undefined; onClose(): void }) {
  const { block, next } = props;
  const { clock } = useApp();
  const actions = useBlockActions();
  const ago = Math.max(1, Math.round((clock.now() - instantMs(block.start)) / 60_000));
  return (
    <PromptFrame label="Have you started?" onClose={props.onClose}>
      <Heading over={`Started ${ago} ${ago === 1 ? 'minute' : 'minutes'} ago`} title={`Have you started ${block.title ?? 'this block'}?`} />
      <div className="stack8">
        <div className="row">
          <button className="btn pri" type="button" disabled={actions.pending} onClick={() => void actions.start(block).then(props.onClose)}>
            Yes, started
          </button>
          <button
            className="btn"
            type="button"
            onClick={() => {
              actions.snooze(block);
              props.onClose();
            }}
          >
            Ask again in 10 minutes
          </button>
        </div>
        <div className="row">
          {next && (
            <button className="link small" type="button" disabled={actions.pending} onClick={() => void actions.swap(block, next).then(props.onClose)}>
              Do next block instead
            </button>
          )}
          <button className="link small" type="button" disabled={actions.pending} onClick={() => void actions.skip(block).then(props.onClose)}>
            Skip, choose a new time later
          </button>
        </div>
      </div>
    </PromptFrame>
  );
}

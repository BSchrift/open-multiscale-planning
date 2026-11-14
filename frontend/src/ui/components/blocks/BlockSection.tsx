// A task's block, at the top of the task's popup when a calendar opens the popup from it: when it is, how it went and
// what it belongs to, as its details panel said, then what can be done to it. Start, or Start now for one later today,
// for one not yet started today; How did it go for one gone by with no answer, as the missed blocks sheet asks it; and
// what the calendar it opened from can do, such as Move and Remove from calendar. Each saves at once with Undo, as the
// popup's attachments do, rather than on Save.

import { createContext, useContext, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { partlyLeft, workMinutes } from '../../../core/blocks';
import type { BlockAnswer } from '../../../core/blocks';
import { formatTime, instantMs, localDate } from '../../../core/dates';
import { applyPlanChange } from '../../../core/plan';
import type { PlanChange } from '../../../core/plan';
import type { BlockRow } from '../../../core/queries';
import { getRecord } from '../../../core/records';
import type { Minutes } from '../../../core/types';
import { useApp, useMutation, useQuery } from '../../app/store';
import { useToast } from '../Toast';
import { useFocusLanding } from '../useFocusLanding';
import { dayName } from '../weekgrid';
import { BlockDetailBody } from './BlockDetail';
import { formatRange } from './describe';
import { answerFor, CHOICES, saidOf, Stepper, WORDS } from './MissedSheet';
import { useBlockActions } from './useBlockActions';

/**
 * The popup's own way out, for an action that leaves it for the calendar, such as Move: with changes not yet saved it
 * stays open and says so. Returns whether it closed.
 */
export const LeavePopup = createContext<(() => boolean) | null>(null);

const MINUTE_MS = 60_000;

export function BlockSection(props: { block: BlockRow; onMove?(): void; onRemove?(): void; children?: ReactNode }) {
  const { block } = props;
  const { clock } = useApp();
  const toast = useToast();
  const actions = useBlockActions();
  const undo = useMutation((w, reverse: PlanChange) => applyPlanChange(w, reverse));
  const leave = useContext(LeavePopup);
  // A control that answers or starts goes once it's pressed, so focus lands on the section rather than the page.
  const land = useFocusLanding();
  const ref = useRef<HTMLElement>(null);
  const askId = useId();
  const task = useQuery((sql) => (block.task_id ? getRecord(sql, 'task', block.task_id) : Promise.resolve(undefined)), [block.task_id]).data;
  /** The time left while Partly asks for it. */
  const [left, setLeft] = useState<Minutes | null>(null);

  const zone = clock.zone();
  const now = clock.now();
  const name = block.title ?? 'the block';
  const date = localDate(block.start, zone);
  const gone = !!block.ended_at || instantMs(block.end) <= now;
  const asking = gone && !block.result;
  const startable = date === localDate(now, zone) && !block.started_at && !block.result && !gone;
  const early = instantMs(block.start) > now;

  const start = async () => {
    land(() => ref.current);
    const reverse = await (early ? actions.startEarly(block) : actions.start(block));
    if (!reverse) return;
    // Started early, it moves to now and keeps its length, as startEarly has it.
    const from = Math.floor(now / MINUTE_MS) * MINUTE_MS;
    const runs = early ? ` It now runs ${formatTime(from, zone)} to ${formatTime(from + instantMs(block.end) - instantMs(block.start), zone)}.` : '';
    toast.show(`Started ${name}.${runs}`, { undo: () => undo.run(reverse) });
  };
  const answer = (choice: BlockAnswer['result'], minutes = 0) => {
    land(() => ref.current);
    void actions
      .answerAll([{ blockId: block.id, answer: answerFor(block, choice, minutes) }], (freed) => saidOf(block, choice, minutes, freed))
      .then((saved) => saved && setLeft(null));
  };
  const move = () => {
    if (leave?.() ?? true) props.onMove?.();
  };

  return (
    <section ref={ref} className="blocksec stack8" aria-label="Time block" tabIndex={-1}>
      <div className="strong">
        {dayName(date)}, {formatRange(block.start, block.end, zone)}
      </div>
      <div className="stack8 small">
        <BlockDetailBody block={block} />
      </div>
      {props.children}
      {asking && (
        <div className="stack8" role="group" aria-labelledby={askId}>
          <div id={askId} className="small quiet">
            How did it go?
          </div>
          {left === null ? (
            <div className="row blocksecacts">
              {CHOICES.map((c) => (
                <button
                  key={c}
                  className={`btn sm${c === 'done' ? ' pri' : ''}`}
                  type="button"
                  disabled={actions.pending}
                  onClick={() => (c === 'partly' ? setLeft(task ? partlyLeft(task, block) : workMinutes(block)) : answer(c))}
                >
                  {WORDS.task[c]}
                </button>
              ))}
            </div>
          ) : (
            <div className="row blocksecacts">
              <Stepper block={block} value={left} onChange={setLeft} />
              <button className="btn sm pri" type="button" disabled={actions.pending} onClick={() => answer('partly', left)}>
                Save Partly
              </button>
              <button className="btn sm" type="button" onClick={() => setLeft(null)}>
                Back
              </button>
            </div>
          )}
        </div>
      )}
      {(startable || props.onMove || props.onRemove) && (
        <div className="row blocksecacts">
          {startable && (
            <button className="btn sm pri" type="button" disabled={actions.pending} onClick={() => void start()}>
              {early ? 'Start now' : 'Start'}
            </button>
          )}
          {props.onMove && (
            <button className="btn sm" type="button" onClick={move}>
              Move
            </button>
          )}
          {props.onRemove && (
            <button className="btn sm" type="button" onClick={props.onRemove}>
              Remove from calendar
            </button>
          )}
        </div>
      )}
    </section>
  );
}

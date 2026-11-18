// A task's block, at the top of the task's popup when a calendar opens the popup from it: when it is, how it went and
// what it belongs to, as its details panel said, then what can be done to it. Start, or Start now for one later today,
// for one not yet started today; Done for one later today or under way, and Pause or Resume once that one's started;
// How did it go for one gone by with no answer, as the missed blocks sheet asks it; and
// what the calendar it opened from can do, such as Move and Remove from calendar. Each saves at once with Undo, as the
// popup's attachments do, rather than on Save.

import { createContext, useContext, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { isPaused, nextBlock, partlyLeft, workMinutes } from '../../../core/blocks';
import type { BlockAnswer } from '../../../core/blocks';
import { dayRange, instantMs, localDate } from '../../../core/dates';
import { blocksInRange } from '../../../core/queries';
import type { BlockRow } from '../../../core/queries';
import { getRecord } from '../../../core/records';
import type { Minutes } from '../../../core/types';
import { useApp, useQuery } from '../../app/store';
import { useFocusLanding } from '../useFocusLanding';
import { dayName } from '../weekgrid';
import { BlockDetailBody } from './BlockDetail';
import { formatRange } from './describe';
import { CHOICES, Stepper, WORDS } from './MissedSheet';
import { useBlockCommands } from './useBlockCommands';
import { Button } from '../ds/Button';
import { Icon } from '../ds/Icon';

/**
 * The popup's own way out, for an action that leaves it for the calendar, such as Move: with changes not yet saved it
 * stays open and says so. Returns whether it closed.
 */
export const LeavePopup = createContext<(() => boolean) | null>(null);

export function BlockSection(props: { block: BlockRow; onMove?(): void; onRemove?(): void; children?: ReactNode }) {
  const { block } = props;
  const { clock } = useApp();
  const actions = useBlockCommands();
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
  const date = localDate(block.start, zone);
  const gone = !!block.ended_at || instantMs(block.end) <= now;
  const asking = gone && !block.result;
  const today = date === localDate(now, zone);
  const startable = today && !block.started_at && !block.result && !gone;
  const early = instantMs(block.start) > now;
  // Done for a block still to come today, or the one under way, beside Start. One gone by has it in How did it go.
  const doable = today && !block.result && !gone;
  const underWay = doable && !early;
  // Mark done now says when the next block is, as the Now card does.
  const day = useQuery((sql) => (underWay ? blocksInRange(sql, dayRange(date, zone)) : Promise.resolve(undefined)), [underWay, date, zone]).data;

  const start = () => {
    land(() => ref.current);
    void actions.startNow(block);
  };
  const answer = (choice: BlockAnswer['result'], minutes = 0) => {
    land(() => ref.current);
    void actions.answer(block, choice, minutes).then((saved) => saved && setLeft(null));
  };
  // Under way, it ends now, as Mark done now does; still to come, the task finishes and its time is freed.
  const done = () => {
    land(() => ref.current);
    void actions.done(block, day && nextBlock(day.filter((b) => b.id !== block.id), clock));
  };
  const paused = isPaused(block);
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
                <Button
                  key={c}
                  variant={c === 'done' ? 'primary' : 'secondary'} size="compact"
                  type="button"
                  disabled={actions.pending}
                  onClick={() => (c === 'partly' ? setLeft(task ? partlyLeft(task, block) : workMinutes(block)) : answer(c))}
                >
                  <Icon name={c === 'not' ? 'not-done' : c} size={16} />
                  {WORDS.task[c]}
                </Button>
              ))}
            </div>
          ) : (
            <div className="row blocksecacts">
              <Stepper block={block} value={left} onChange={setLeft} />
              <Button variant="primary" size="compact" type="button" disabled={actions.pending} onClick={() => answer('partly', left)}>
                Save Partly
              </Button>
              <Button size="compact" type="button" onClick={() => setLeft(null)}>
                Back
              </Button>
            </div>
          )}
        </div>
      )}
      {(doable || props.onMove || props.onRemove) && (
        <div className="row blocksecacts">
          {startable && (
            <Button variant="primary" size="compact" type="button" disabled={actions.pending} onClick={start}>
              {early ? 'Start now' : 'Start'}
            </Button>
          )}
          {doable && (
            <Button size="compact" type="button" disabled={actions.pending} onClick={done}>
              <Icon name="done" size={16} />
              Done
            </Button>
          )}
          {underWay && block.started_at && (
            <Button size="compact" type="button" disabled={actions.pending} onClick={() => void (paused ? actions.resume(block) : actions.pause(block))}>
              {paused ? 'Resume' : 'Pause'}
            </Button>
          )}
          {props.onMove && (
            <Button size="compact" type="button" onClick={move}>
              Move
            </Button>
          )}
          {props.onRemove && (
            <Button size="compact" type="button" onClick={props.onRemove}>
              Remove from calendar
            </Button>
          )}
        </div>
      )}
    </section>
  );
}

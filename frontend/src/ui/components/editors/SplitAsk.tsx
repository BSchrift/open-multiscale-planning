// "What about the other 30m?" after a task's placed block was made shorter: on Week while editing, in planning's
// Schedule step and on Today, in the place a practice's session asks KeepAsk's question. Split it keeps the rest of the
// task to schedule, as a shorter block always did, so leaving the question unanswered is the same. Change the estimate
// takes the rest off the task's estimate and its plan for the week instead. It never blocks: it's announced as it
// appears rather than taking focus, and from inside it, Escape is Split it. A task with no estimate never asks.

import { useEffect, useId, useState } from 'react';
import { moveBlock } from '../../../core/blocks';
import { formatMinutes } from '../../../core/dates';
import { applyPlanChange } from '../../../core/plan';
import type { PlanChange } from '../../../core/plan';
import { getRecord } from '../../../core/records';
import type { Writer } from '../../../core/records';
import { GRID, slotInstants } from '../../../core/slots';
import type { Slot } from '../../../core/slots';
import { shortenEstimate } from '../../../core/tasks';
import type { LocalDate, Minutes } from '../../../core/types';
import { useApp, useMutation, useQuery } from '../../app/store';
import { useToast } from '../Toast';
import { Button } from '../ds/Button';
import { Sheet } from '../Sheet';

/** A task's block made shorter, and how long it was when the shortening began, so steps in a row add up. */
export interface Shortened {
  blockId: string;
  taskId: string;
  title: string;
  /** Where it is now. */
  slot: Slot;
  wasMin: Minutes;
  /** The week whose plan Change the estimate takes the minutes from. */
  week: LocalDate;
}

/**
 * Whether a block's new time asks the question, and from what length: a task's block, not under way, that got shorter.
 * Counts from the length it had when an unanswered question about it began.
 */
export function shortened(
  block: { id: string; task_id?: string | null; start: Minutes; end: Minutes },
  slot: Slot,
  opts: { task: boolean; underWay: boolean; week: LocalDate; title: string; open: Shortened | null },
): Shortened | null {
  if (!opts.task || !block.task_id || opts.underWay) return null;
  const wasMin = opts.open?.blockId === block.id ? opts.open.wasMin : block.end - block.start;
  if (slot.end - slot.start >= wasMin) return null;
  return { blockId: block.id, taskId: block.task_id, title: opts.title, slot, wasMin, week: opts.week };
}

/** `sheet`: over the page, as on phone where the question has no room beside the day. Closed unanswered, it's a split. */
export function SplitAsk(props: { ask: Shortened; sheet?: boolean; onDone(): void }) {
  const { ask } = props;
  const { layout, clock } = useApp();
  const toast = useToast();
  const id = useId();
  const { run } = useMutation((w: Writer, fn: (w: Writer) => Promise<PlanChange>) => fn(w));
  const estimate = useQuery((sql) => getRecord(sql, 'task', ask.taskId), [ask.taskId]).data?.estimate_min;
  const by = ask.wasMin - (ask.slot.end - ask.slot.start);
  const rest = formatMinutes(by);
  const question = `What about the other ${rest}?`;
  const what = `${ask.title} is now ${formatMinutes(ask.slot.end - ask.slot.start)} on the calendar.`;
  // Set after it appears, so a screen reader hears it.
  const [said, setSaid] = useState('');
  useEffect(() => setSaid(`${what} ${question}`), [what, question]);
  if (!estimate) return null;

  const split = () => {
    props.onDone();
    // Undo puts the block back to its length before the shortening.
    const back = { ...ask.slot, end: ask.slot.start + ask.wasMin };
    toast.show(`Split ${ask.title}: ${rest} stays to schedule.`, { undo: () => run((w) => moveBlock(w, ask.blockId, slotInstants(back, clock.zone()))) });
  };
  const change = async () => {
    props.onDone();
    const reverse = await run((w) => shortenEstimate(w, ask.taskId, by, ask.week));
    if (!reverse) return;
    // The reverse holds the estimate it replaced.
    const was = reverse.writes.find((x) => x.type === 'task')?.fields.estimate_min as Minutes;
    toast.show(`${ask.title} is now ${formatMinutes(Math.max(GRID, was - by))}. Its estimate was ${formatMinutes(was)}.`, {
      undo: () => run((w) => applyPlanChange(w, reverse)),
    });
  };
  const btn = { size: 'compact' as const, className: layout === 'phone' ? 'grow' : undefined };
  const asked = (
    <div
      className="panel stack8 wkask"
      role="group"
      aria-labelledby={`${id}-q`}
      aria-describedby={`${id}-what`}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        split();
      }}
    >
      <div id={`${id}-what`}>{what}</div>
      <div className="strong small" id={`${id}-q`}>
        {question}
      </div>
      <div className={layout === 'phone' ? 'stack8' : 'row'}>
        <Button {...btn} variant="primary" type="button" onClick={split}>
          Split it
        </Button>
        <Button {...btn} type="button" onClick={() => void change()}>
          Change the estimate
        </Button>
      </div>
      <div className="small quiet">Split it keeps {rest} to schedule. Change the estimate takes it off the task.</div>
      <div className="sr" role="status">
        {said}
      </div>
    </div>
  );
  return props.sheet ? (
    <Sheet label={question} onClose={props.onDone}>
      {asked}
    </Sheet>
  ) : (
    asked
  );
}

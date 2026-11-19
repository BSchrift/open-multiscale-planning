// Add something you did: a quiet row under a day's finished list that opens one line, for something done that the app
// didn't capture, with the time it took if you like. Enter adds it to that day and Esc puts the line away. Done goes no
// further than today, so a day to come can't take one.

import { useEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import { answerBlock } from '../../../core/blocks';
import { captureTitle, MAX_TITLE } from '../../../core/captureTitle';
import type { Clock } from '../../../core/clock';
import { dayRange, formatDayLong, instantMs, localToInstant, nowInstant, toInstant, today } from '../../../core/dates';
import { applyPlanChange } from '../../../core/plan';
import type { PlanChange, RecordWrite } from '../../../core/plan';
import type { Writer } from '../../../core/records';
import { tickOneOff } from '../../../core/tasks';
import type { LocalDate, Minutes } from '../../../core/types';
import { useApp, useMutation } from '../../app/store';
import { Button } from '../../components/ds/Button';
import { EstimateSlider } from '../../components/EstimateSlider';
import { emptyDraft, oneOffFields } from '../../components/oneoff/draft';
import { useToast } from '../../components/Toast';

/**
 * Something done that the app didn't capture, added to a day: a one off finished then, now for today and at the day's
 * last minute for a day gone by, so it comes last. With the time it took, a block that long ends then, answered Done,
 * which finishes the task as any block's Done does, so the time counts as worked here and in Analytics. Ordinary
 * records, so every app, older ones too, shows a finished one off, and they expire as finished ones do. Returns the
 * reverse, for Undo, which deletes what it made.
 */
export async function addDone(w: Writer, day: LocalDate, title: string, minutes: Minutes, clock: Clock): Promise<PlanChange> {
  const zone = clock.zone();
  const at = day === today(clock) ? nowInstant(clock) : localToInstant(day, 24 * 60 - 1, zone);
  const task = await w.create('task', oneOffFields({ ...emptyDraft(day), title, estimate: 0 }, day));
  const gone = { deleted_at: nowInstant(clock) };
  const deleted: RecordWrite = { type: 'task', id: task, fields: gone };
  if (!minutes) return { writes: [...(await tickOneOff(w, task, clock, at)).writes, deleted] };
  // Within the day, so its time shows on the day it was added to; the minutes logged still count in full.
  const start = toInstant(Math.max(instantMs(dayRange(day, zone).from_utc), instantMs(at) - minutes * 60_000));
  const block = await w.create('time_block', { task_id: task, start, end: at, tz: zone });
  const answered = await answerBlock(w, block, { result: 'done', logged_min: minutes }, clock);
  return { writes: [...answered.writes, { type: 'time_block', id: block, fields: gone }, deleted] };
}

export function AddDone(props: { day: LocalDate }) {
  const { day } = props;
  const { clock } = useApp();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [minutes, setMinutes] = useState<Minutes>(0);
  const add = useMutation((w, title: string, minutes: Minutes) => addDone(w, day, title, minutes, clock));
  const undo = useMutation((w, change: PlanChange) => applyPlanChange(w, change));
  const root = useRef<HTMLDivElement>(null);
  // Put away, the line gives focus back to the row that opens it, ready for the next one.
  const refocus = useRef(false);
  useEffect(() => {
    if (open || !refocus.current) return;
    refocus.current = false;
    root.current?.querySelector('button')?.focus();
  }, [open]);

  const close = () => {
    refocus.current = true;
    setOpen(false);
    setText('');
    setMinutes(0);
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const title = captureTitle(text);
    if (!title || add.pending) return;
    const change = await add.run(title, minutes);
    if (change === undefined) return;
    toast.show(`Added ${title} to Done on ${formatDayLong(day)}.`, { undo: () => undo.run(change) });
    close();
  };
  const escape = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    close();
  };

  return (
    <div ref={root} className="doneadd">
      {open ? (
        <form className="card doneaddform" aria-label="Add something you did" noValidate onSubmit={submit} onKeyDown={escape}>
          <input
            className="field"
            autoFocus
            aria-label="What you did"
            placeholder="What did you do?"
            maxLength={MAX_TITLE}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          <div className="doneaddfoot">
            <EstimateSlider label="Time it took" noneLabel="No time" value={minutes} onChange={setMinutes} />
            <div className="row">
              <Button variant="primary" size="compact" type="submit">
                Add
              </Button>
              <Button size="compact" type="button" onClick={close}>
                Cancel
              </Button>
            </div>
          </div>
        </form>
      ) : (
        <Button variant="quiet" icon="plus" type="button" onClick={() => setOpen(true)}>
          Add something you did
        </Button>
      )}
    </div>
  );
}

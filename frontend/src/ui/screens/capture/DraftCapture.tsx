// Capture on a time drafted on a calendar, which can take a task you already have as well as a new one. It reads the
// draft's week as Week does and offers what existing.ts finds. Picking one places it there by Week's own paths, a new
// block as a To schedule card's drop makes or a block moved as a drag moves it, so it asks "Schedule both at the same
// time?" first where it lands on a block, and its toast has Undo. A new task's draft never asks: it keeps its overlap.
// Apart from Capture, which the app's first chunk carries, so Week's data loads only with a calendar.

import { useMemo } from 'react';
import { weekStart } from '../../../core/dates';
import { DRAWN_DAY } from '../../../core/slots';
import type { Layout } from '../../app/registry';
import { useApp, useQuery } from '../../app/store';
import { loadWeek, weekModel } from '../week/data';
import { useLanding } from '../week/landing';
import { useWeekActions } from '../week/useWeekActions';
import { findable, search } from './existing';
import { Capture } from '.';
import type { CaptureSlot, TaskFinder } from '.';

/** The calendar's day ends here, so a task placed late keeps within it. */
const to = DRAWN_DAY.to;

export function DraftCapture(props: { layout: Layout; close(): void; slot: CaptureSlot | undefined }) {
  return props.slot ? <Draft {...props} slot={props.slot} /> : null;
}

function Draft(props: { layout: Layout; close(): void; slot: CaptureSlot }) {
  const { slot, close } = props;
  const { clock } = useApp();
  const at = slot.slot;
  const week = weekStart(at.date);
  const data = useQuery((sql, c) => loadWeek(sql, c, week), [week]).data;
  const model = useMemo(() => data && weekModel(data, clock), [data, clock]);
  const act = useWeekActions();
  const { landing, takeOff, asking } = useLanding(model?.blocks ?? [], week);
  const found = useMemo(() => (data && model ? findable(data, model, at, to) : null), [data, model, at]);

  const finder: TaskFinder = {
    find: (typed) => (found ? search(found, typed) : []),
    place: async (key) => {
      const x = found && [...found.todo, ...found.other].find((f) => f.key === key);
      if (!x) return false;
      // At the draft's start, for the task's own length, within the day.
      const there = { date: at.date, start: at.start, end: Math.min(to, at.start + x.length) };
      if ('block' in x) {
        const { go, off } = await landing(x.title, there, x.block.id, x.block);
        if (!go || !(await act.moveWithUndo(x.block.id, x.title, there))) return false;
        takeOff(off);
        return true;
      }
      const { go, off } = await landing(x.title, there);
      if (!go || !(await act.place(x.item, there))) return false;
      takeOff(off);
      return true;
    },
  };
  return (
    <>
      <Capture layout={props.layout} close={close} slot={{ ...slot, finder }} />
      {asking}
    </>
  );
}

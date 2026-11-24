// What a block's popup section and Today's quick menu both do to a block, so each says and undoes the same: Done as
// fits where the block is in its day, an answer for one gone by, Start now (from useBlockActions) with where it now
// runs, and Move to's new times. A new time that lands on other blocks asks first, as a drag does, with the question in
// `asking` for the caller to draw.

import { moveBlock, unscheduleBlock } from '../../../core/blocks';
import type { BlockAnswer } from '../../../core/blocks';
import { addDays, dayRange, formatTimeOfDay, instantMs, localDate, localMinutes, weekStart } from '../../../core/dates';
import { applyPlanChange } from '../../../core/plan';
import type { PlanChange, RecordWrite } from '../../../core/plan';
import { blocksInRange } from '../../../core/queries';
import type { BlockRow } from '../../../core/queries';
import { DRAWN_DAY, fits, GRID, slotInstants } from '../../../core/slots';
import type { Slot, SlotContext } from '../../../core/slots';
import type { Minutes } from '../../../core/types';
import { useApp, useMutation } from '../../app/store';
import type { MenuEntry } from '../Menu';
import { useToastOr } from '../Toast';
import type { Say } from '../Toast';
import { dayName } from '../weekgrid';
import { landsOn, useBothAsk } from './BothAsk';
import { answerFor, saidOf } from './MissedSheet';
import { useBlockActions } from './useBlockActions';

const MINUTE_MS = 60_000;

/** Where a block is in its day: answered, gone by with no answer, under way, or still to come. */
export type Stage = 'answered' | 'gone' | 'now' | 'later';

export function stageOf(block: BlockRow, now: number): Stage {
  if (block.result) return 'answered';
  if (block.ended_at || instantMs(block.end) <= now) return 'gone';
  return instantMs(block.start) <= now ? 'now' : 'later';
}

/** say: where its messages go instead of the app's toast, as useBlockActions takes it. */
export function useBlockCommands(say?: Say) {
  const { clock, db } = useApp();
  const toast = useToastOr(say);
  const actions = useBlockActions(say);
  const undo = useMutation((w, reverse: PlanChange) => applyPlanChange(w, reverse));
  const both = useBothAsk();
  /** Moves a block and takes off those it replaces, as one change, so one Undo puts them all back. */
  const moveOver = useMutation(async (w, id: string, to: Slot, off: readonly { id: string }[]): Promise<PlanChange> => {
    const moved = await moveBlock(w, id, slotInstants(to, clock.zone()));
    const back: RecordWrite[] = [];
    for (const x of off) back.unshift(...(await unscheduleBlock(w, x.id, weekStart(to.date), clock)).writes);
    return { writes: [...back, ...moved.writes] };
  });
  const zone = clock.zone();
  const tomorrow = addDays(localDate(clock.now(), zone), 1);

  /** One block's answer, as the missed blocks sheet saves a row. Resolves to whether it saved. */
  const answer = (block: BlockRow, choice: BlockAnswer['result'], minutes: Minutes = 0) =>
    actions.answerAll([{ blockId: block.id, answer: answerFor(block, choice, minutes) }], (freed) => saidOf(block, choice, minutes, freed));

  /** Where a block sits on its day, in minutes. */
  const slotOf = (block: BlockRow): Slot => {
    const start = localMinutes(block.start, zone);
    return { date: localDate(block.start, zone), start, end: start + (instantMs(block.end) - instantMs(block.start)) / MINUTE_MS };
  };
  /** The first time after it, that day, that it fits as it is, as a drag would land without a note. */
  const nextFree = (block: BlockRow, ctx: SlotContext): Slot | null => {
    const { date, start, end } = slotOf(block);
    const length = end - start;
    const kind = block.task_kind === 'one_off' ? 'one_off' : 'project';
    const others = { ...ctx, placed: ctx.placed.filter((s) => s.id !== block.id) };
    for (let at = end; at + length <= Math.max(DRAWN_DAY.to, end); at += GRID) if (fits(date, at, length, kind, others)) return { date, start: at, end: at + length };
    return null;
  };
  /** The next day at the same time, while that's still in its week, whose picks and To schedule it's part of. */
  const nextDay = (block: BlockRow): Slot | null => {
    const slot = slotOf(block);
    const date = addDays(slot.date, 1);
    return weekStart(date) === weekStart(slot.date) ? { ...slot, date } : null;
  };
  /** A day as Move to says it: tomorrow by name, and another by its date. */
  const dayOf = (date: string) => (date === tomorrow ? 'Tomorrow' : dayName(date));
  /**
   * Asks first when a block lands on others on its new time's day, from that day's blocks where they're saved; one under
   * way or answered can only be kept. Resolves to the blocks to take off as it moves, or null when cancelled.
   */
  const landing = async (self: { id: string; title: string }, blocks: readonly BlockRow[], from: Slot | null, to: Slot) => {
    const now = clock.now();
    const minutesOn = (at: string, edge: number) => (localDate(at, zone) === to.date ? localMinutes(at, zone) : edge);
    const saved = blocks.map((b) => {
      const stage = stageOf(b, now);
      return { id: b.id, title: b.title ?? 'Time block', date: to.date, start: minutesOn(b.start, 0), end: minutesOn(b.end, 1440), fixed: stage === 'answered' || stage === 'gone' || !!b.started_at };
    });
    const on = landsOn(saved, self.id, to, from);
    const answer = on.length ? await both.ask(self.title, on) : 'keep';
    return answer === 'cancel' ? null : answer === 'replace' ? on.filter((x) => !x.fixed) : [];
  };
  const tookOff = (off: readonly { title: string }[]) => (off.length ? [`Took ${new Intl.ListFormat('en-GB').format(off.map((x) => x.title))} off the calendar.`] : []);

  return {
    ...actions,
    answer,
    asking: both.asking,
    landing,
    moveOver: moveOver.run,
    tookOff,
    /**
     * Done: for one gone by, its answer; for the one under way, Mark done now; for a task's block still to come, the
     * task finishes and frees its time. A practice's session still to come is logged as done, as Did it would be after.
     */
    done: (block: BlockRow, next: BlockRow | undefined): Promise<unknown> => {
      const stage = stageOf(block, clock.now());
      if (stage === 'now') return actions.markDoneNow(block, next);
      if (stage === 'later' && block.task_id) return actions.finish(block);
      return answer(block, 'done');
    },
    /**
     * Move to's choices, none for a block that stays where it is: one started, answered or gone by, or one running past
     * midnight. The next free time that day, the next day at the same time, back to To schedule for a task's block, and
     * Choose a time… to place it by hand, which Week can't do once its time has come.
     */
    moveChoices: (block: BlockRow, ctx: SlotContext): MenuEntry[] => {
      const stage = stageOf(block, clock.now());
      if (block.started_at || (stage !== 'later' && stage !== 'now') || slotOf(block).end > 1440) return [];
      const next = nextFree(block, ctx);
      const day = nextDay(block);
      return [
        ...(next ? [{ id: 'move:next', label: `Next free time, ${formatTimeOfDay(next.start)}`, icon: 'clock' as const }] : []),
        ...(day ? [{ id: 'move:tomorrow', label: `${dayOf(day.date)}, ${formatTimeOfDay(day.start)}`, icon: 'calendar' as const }] : []),
        // A practice's session comes off with Skip this session.
        ...(block.task_id ? [{ id: 'move:back', label: 'Back to To schedule', icon: 'inbox' as const }] : []),
        ...(stage === 'later' ? (['separator', { id: 'move:choose', label: 'Choose a time…', icon: 'week' }] as const) : []),
      ];
    },
    /**
     * One of Move to's choices, saved at once with Undo, asking first if it lands on other blocks. Choose a time is the
     * screen's own: Today opens Week for it.
     */
    moveTo: async (block: BlockRow, id: string, ctx: SlotContext, choose: () => void): Promise<unknown> => {
      const to = id === 'move:next' ? nextFree(block, ctx) : id === 'move:tomorrow' ? nextDay(block) : null;
      if (to) {
        // Today draws only today, so the new time's day is read for the ask.
        const there = await blocksInRange(db, dayRange(to.date, zone)).catch((error: unknown) => {
          console.error('Read failed', error);
          toast.show("Couldn't move that. Try again.");
          return null;
        });
        const off = there && (await landing({ id: block.id, title: block.title ?? 'Time block' }, there, slotOf(block), to));
        const reverse = off && (await moveOver.run(block.id, to, off));
        if (!off || !reverse) return;
        const when = to.date === localDate(clock.now(), zone) ? '' : `${to.date === tomorrow ? 'tomorrow' : dayName(to.date)}, `;
        return toast.show([`Moved ${block.title ?? 'the block'} to ${when}${formatTimeOfDay(to.start)}.`, ...tookOff(off)].join(' '), { undo: () => undo.run(reverse) });
      }
      if (id === 'move:back') return actions.skip(block);
      if (id === 'move:choose') choose();
    },
  };
}

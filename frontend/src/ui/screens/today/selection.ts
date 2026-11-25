// Which block Today's phone day has selected, and so raises out of its lane as a card: the one in progress, else the one
// that just ended and needs an answer, else the next one when it starts within the hour, so Start early shows in the
// morning without a popup. A tap selects another; a tap on empty time hands the selection back to this one.
// Also where the day opens: an hour before the selected block, else now, with the hours before that folded into one row.

import type { Clock } from '../../../core/clock';
import { currentBlock, nextBlock } from '../../../core/blocks';
import { formatTimeOfDay, instantMs, localDate, localMinutes } from '../../../core/dates';
import type { BlockRow } from '../../../core/queries';
import { missedBlocks, practicesToLog } from '../../../core/reminders';
import type { AwayPeriod, LocalDate } from '../../../core/types';

/** Earlier hours fold into a row only when that saves at least this much of the day, more than the row takes. */
export const MIN_FOLD_MIN = 120;
/** The next block is selected when Today opens only this close to its start. */
export const NEXT_WITHIN_MS = 60 * 60_000;

/** What the raised card says and offers: the block in progress, one that ended unanswered, the next one, or any other. */
export type Raise = 'now' | 'answer' | 'next' | 'sel';

/** Today's blocks that have ended with no answer yet, oldest first: a task's, or a practice's, which asks on itself too. */
export function toAnswer(blocks: readonly BlockRow[], away: readonly AwayPeriod[], clock: Clock): BlockRow[] {
  const day = localDate(clock.now(), clock.zone());
  const today = blocks.filter((b) => localDate(b.start, clock.zone()) === day);
  return [...missedBlocks(today, away, clock), ...practicesToLog(today, away, clock)].sort((a, b) => instantMs(a.start) - instantMs(b.start));
}

/** The block that ended last, when it still needs an answer: one passed over for a later answered block isn't "just". */
function justEnded(blocks: readonly BlockRow[], away: readonly AwayPeriod[], clock: Clock): BlockRow | undefined {
  const now = clock.now();
  const endOf = (b: BlockRow) => instantMs(b.ended_at ?? b.end);
  const last = blocks.filter((b) => b.task_kind !== 'planning' && endOf(b) <= now).sort((a, b) => endOf(b) - endOf(a))[0];
  return last && toAnswer(blocks, away, clock).some((b) => b.id === last.id) ? last : undefined;
}

export function defaultSelection(blocks: readonly BlockRow[], away: readonly AwayPeriod[], clock: Clock): string | null {
  const cur = currentBlock(blocks, clock);
  if (cur) return cur.id;
  const ended = justEnded(blocks, away, clock);
  if (ended) return ended.id;
  const next = nextBlock(blocks, clock);
  return next && instantMs(next.start) - clock.now() <= NEXT_WITHIN_MS ? next.id : null;
}

export function raiseOf(block: BlockRow, blocks: readonly BlockRow[], clock: Clock): Raise {
  const now = clock.now();
  const cur = currentBlock(blocks, clock);
  if (cur?.id === block.id) return 'now';
  if (!block.result && block.task_kind !== 'planning' && instantMs(block.ended_at ?? block.end) <= now) return 'answer';
  // Start early is for the time free before it; with a block under way, the next one offers Move like any other, as
  // does one on another day, drawn on the phone's Today from the strip.
  const today = localDate(now, clock.zone());
  if (!cur && localDate(block.start, clock.zone()) === today && nextBlock(blocks, clock)?.id === block.id) return 'next';
  return 'sel';
}

/** The minute the day opens at: the hour before `anchor`, on the hour, never before the drawn day's start. */
export function openMinute(anchor: number, drawnFrom: number): number {
  return Math.max(drawnFrom, Math.floor(anchor / 60) * 60 - 60);
}

export interface EarlierRow {
  from: number;
  to: number;
  blocks: number;
  toAnswer: number;
  label: string;
}

const count = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** The row today's hours before `open` fold into, saying what they hold, or null when nothing is folded. */
export function earlierRow(
  blocks: readonly BlockRow[],
  o: { from: number; open: number; zone: string; date: LocalDate; answer: ReadonlySet<string> },
): EarlierRow | null {
  if (o.open - o.from < MIN_FOLD_MIN) return null;
  const folded = blocks.filter((b) => localDate(b.start, o.zone) !== o.date || localMinutes(b.start, o.zone) < o.open);
  const asking = folded.filter((b) => o.answer.has(b.id)).length;
  const parts = [`Earlier, ${formatTimeOfDay(o.from)} to ${formatTimeOfDay(o.open)}`, folded.length ? count(folded.length, 'block') : '', asking ? `${asking} to answer` : ''];
  return { from: o.from, to: o.open, blocks: folded.length, toAnswer: asking, label: parts.filter(Boolean).join(' · ') };
}

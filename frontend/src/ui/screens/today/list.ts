// The phone's day as a list (option C): Today's List view, and the day by itself at the accessibility text sizes, where
// a row grows with its words and a calendar's fixed hours can't. Each block and event in order of time, free time
// between them as rows that add a task there, and on today, with nothing under way, a Now row where now falls.

import { useEffect, useState } from 'react';

/** Free time shorter than this isn't a row of its own. */
export const MIN_FREE_MIN = 30;

export type ListRow =
  | { kind: 'item'; id: string }
  /** Now, free until `until` (null: the rest of the day), or not free, during an event. */
  | { kind: 'now'; free: boolean; until: number | null }
  | { kind: 'free'; start: number; end: number };

/**
 * The list's rows, from items in order of start, in minutes of the day. Free time is counted from `from` (today's now,
 * or another day's start; null on a day gone by) to `to`. With nothing under way on today, `now` places the Now row,
 * which says how long it's free, so the free time it covers isn't a row too.
 */
export function listRows(items: readonly { id: string; from: number; to: number }[], o: { now: number | null; from: number | null; to: number }): ListRow[] {
  const rows: ListRow[] = [];
  let at = o.from;
  let now = o.now;
  const free = (end: number) => {
    if (at !== null && end - at >= MIN_FREE_MIN) rows.push({ kind: 'free', start: at, end });
  };
  const nowRow = (until: number | null) => {
    const isFree = at === null || at <= now!;
    rows.push({ kind: 'now', free: isFree, until });
    if (isFree && at !== null) at = until ?? o.to;
    now = null;
  };
  for (const i of items) {
    if (now !== null && i.from >= now) nowRow(i.from);
    free(i.from);
    rows.push({ kind: 'item', id: i.id });
    if (at !== null) at = Math.max(at, i.to);
  }
  if (now !== null) nowRow(null);
  free(o.to);
  return rows;
}

/**
 * Body text past the largest of the usual sizes (23pt at xxxL) is one of the accessibility sizes, from 28pt at AX1. The
 * iPhone app's text follows the phone's setting (docs/design.md); on the web it stays at 17px.
 */
const LARGEST_USUAL_PX = 23;
const largeText = () => parseFloat(getComputedStyle(document.querySelector('[data-layout]') ?? document.body).fontSize) > LARGEST_USUAL_PX;

/**
 * Whether the text is at an accessibility size. Read as Today opens and as the app comes back to the front, from Settings
 * where the size is changed.
 * shortcut: a size changed from Control Center while the app stays in front applies when Today next opens; watch the
 * text's size if that's wanted.
 */
export function useLargeText(): boolean {
  const [large, setLarge] = useState(largeText);
  useEffect(() => {
    const check = () => setLarge(largeText());
    document.addEventListener('visibilitychange', check);
    return () => document.removeEventListener('visibilitychange', check);
  }, []);
  return large;
}

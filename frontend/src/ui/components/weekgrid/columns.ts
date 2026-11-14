// Blocks whose times overlap, drawn side by side as a calendar draws them: Week's grid and phone day, Today's calendar,
// and the planning Schedule step share it. Blocks that overlap, directly or through another, make a group, from its
// first start to its last end. Each block takes the leftmost column free at its start, and the group is as many equal
// columns wide as it needed. On a narrow screen, columns narrower than MIN_COLUMN_PX would cut names to a letter or
// two, so a group draws as many as fit and +N more (MoreButton.tsx) lists the rest.

import { useLayoutEffect, useState } from 'react';
import type { CSSProperties } from 'react';

/** The narrowest column a block's name and kind stay readable in: two fit on a 320pt phone's day, not three. */
export const MIN_COLUMN_PX = 96;
/** The strip +N more takes beside a group on a drawn day, a tap target wide. */
export const MORE_PX = 48;
const GAP = 4;
/** What the columns leave on their right for that strip. */
export const MORE_INSET = `${MORE_PX + GAP}px`;

export interface Columned<T> {
  item: T;
  col: number;
  /** The blocks it overlaps itself, by start. */
  with: T[];
}

export interface OverlapGroup<T> {
  start: number;
  end: number;
  cols: number;
  /** By start, then column: the order they're drawn and read in. */
  items: Columned<T>[];
}

export function overlapGroups<T extends { start: number; end: number }>(list: readonly T[]): OverlapGroup<T>[] {
  const groups: OverlapGroup<T>[] = [];
  let ends: number[] = [];
  for (const item of [...list].sort((a, b) => a.start - b.start || b.end - a.end)) {
    let group = groups[groups.length - 1];
    if (!group || item.start >= group.end) {
      group = { start: item.start, end: item.end, cols: 0, items: [] };
      groups.push(group);
      ends = [];
    }
    let col = ends.findIndex((end) => end <= item.start);
    if (col < 0) col = ends.length;
    ends[col] = item.end;
    group.end = Math.max(group.end, item.end);
    group.cols = Math.max(group.cols, col + 1);
    group.items.push({ item, col, with: [] });
  }
  for (const { items } of groups) {
    for (const c of items) c.with = items.filter((o) => o !== c && o.item.start < c.item.end && c.item.start < o.item.end).map((o) => o.item);
  }
  return groups;
}

/**
 * How many of a group's columns are drawn in a width: all of them while each gets MIN_COLUMN_PX, and before anything
 * is measured. Otherwise as many as fit beside `aside` pixels kept for +N more, and at least one.
 */
export function shownColumns(cols: number, width: number, aside = 0): number {
  const fit = (w: number) => Math.floor((w + GAP) / (MIN_COLUMN_PX + GAP));
  if (!width || fit(width) >= cols) return cols;
  return Math.max(1, Math.min(cols - 1, fit(aside ? width - aside - GAP : width)));
}

/** The col'th of cols equal columns between the insets, GAP apart, as a block's left and width. */
export function columnStyle(col: number, cols: number, left = '0px', right = '0px'): CSSProperties {
  const span = `(100% - ${left} - ${right} + ${GAP}px)`;
  return { left: `calc(${left} + ${span} * ${col} / ${cols})`, width: `calc(${span} / ${cols} - ${GAP}px)`, right: 'auto' };
}

const names = new Intl.ListFormat('en-GB');

/** 'Overlaps Plan the week of Nov 16', or nothing. */
export const overlapsText = (others: readonly { title: string }[]) => (others.length ? `Overlaps ${names.format(others.map((o) => o.title))}` : '');

/** Said after a block's time: ' Overlaps Plan the week of Nov 16.' */
export const overlapNote = (others: readonly { title: string }[]) => (others.length ? ` ${overlapsText(others)}.` : '');

/** An element's width, read before it's painted and again as it resizes; 0 where nothing is laid out, as in tests. */
export function useWidth<E extends HTMLElement>(): [(el: E | null) => void, number] {
  const [el, setEl] = useState<E | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (!el) return;
    const read = () => setWidth(el.getBoundingClientRect().width);
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const watch = new ResizeObserver(read);
    watch.observe(el);
    return () => watch.disconnect();
  }, [el]);
  return [setEl, width];
}

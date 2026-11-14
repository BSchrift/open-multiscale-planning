import { describe, expect, it } from 'vitest';
import { overlapGroups, overlapNote, shownColumns } from './columns';

const b = (title: string, from: string, to: string) => {
  const m = (t: string) => Number(t.split(':')[0]) * 60 + Number(t.split(':')[1] ?? 0);
  return { title, start: m(from), end: m(to) };
};
const laid = (list: ReturnType<typeof b>[]) => overlapGroups(list).map((g) => ({ cols: g.cols, at: g.items.map((c) => `${c.item.title}:${c.col}`) }));

describe('overlapGroups', () => {
  it('puts two blocks at the same time side by side, the longer first, and leaves the rest alone', () => {
    const meals = b('Meals', '17:30', '18:30');
    const plan = b('Plan', '17:30', '18:45');
    const later = b('Later', '18:45', '19:30');
    const groups = overlapGroups([meals, later, plan]);
    expect(laid([meals, later, plan])).toEqual([
      { cols: 2, at: ['Plan:0', 'Meals:1'] },
      { cols: 1, at: ['Later:0'] },
    ]);
    expect(groups[0]).toMatchObject({ start: 17 * 60 + 30, end: 18 * 60 + 45 });
    expect(groups[0]!.items.map((c) => c.with)).toEqual([[meals], [plan]]);
    expect(groups[1]!.items[0]!.with).toEqual([]);
  });

  it('gives three at once a column each', () => {
    expect(laid([b('A', '17:00', '18:00'), b('B', '17:00', '18:00'), b('C', '17:30', '18:00')])).toEqual([{ cols: 3, at: ['A:0', 'B:1', 'C:2'] }]);
  });

  it('chains partial overlaps into one group, reusing a column once it frees up', () => {
    const [a, c, d] = [b('A', '17:00', '18:00'), b('C', '17:30', '18:30'), b('D', '18:00', '19:00')];
    expect(laid([a, c, d])).toEqual([{ cols: 2, at: ['A:0', 'C:1', 'D:0'] }]);
    // A and D only touch, so neither overlaps the other.
    expect(overlapGroups([a, c, d])[0]!.items.map((x) => x.with.map((o) => o.title))).toEqual([['C'], ['A', 'D'], ['C']]);
  });
});

describe('shownColumns', () => {
  it('draws every column while each gets 96px, or before anything is measured', () => {
    expect(shownColumns(2, 272)).toBe(2);
    expect(shownColumns(2, 196)).toBe(2);
    expect(shownColumns(5, 0)).toBe(5);
  });

  it('past that, draws as many as fit, beside room kept for +N more, and always one', () => {
    // A 390pt phone's day row is 272px wide, and a 320pt phone's 202px.
    expect(shownColumns(3, 272)).toBe(2);
    expect(shownColumns(3, 202)).toBe(2);
    expect(shownColumns(2, 150)).toBe(1);
    expect(shownColumns(3, 272, 48)).toBe(2);
    expect(shownColumns(3, 202, 48)).toBe(1);
    expect(shownColumns(2, 60, 48)).toBe(1);
  });
});

describe('overlapNote', () => {
  it('names what a block overlaps', () => {
    expect(overlapNote([])).toBe('');
    expect(overlapNote([{ title: 'Plan the week' }])).toBe(' Overlaps Plan the week.');
    expect(overlapNote([{ title: 'A' }, { title: 'B' }, { title: 'C' }])).toBe(' Overlaps A, B and C.');
  });
});

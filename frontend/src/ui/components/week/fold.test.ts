import { describe, expect, it } from 'vitest';
import { FOLD, foldPaint, foldProgress, settleTo, springAt, springDone } from './fold';

describe("the week strip's fold on the phone's Today", () => {
  it('folds over the 72pt of scroll after the day row docks, both ways', () => {
    expect(FOLD).toBe(72);
    expect(foldProgress(100, 129, false)).toBe(0);
    expect(foldProgress(129, 129, false)).toBe(0);
    expect(foldProgress(129 + 36, 129, false)).toBe(0.5);
    expect(foldProgress(129 + 72, 129, false)).toBe(1);
    expect(foldProgress(900, 129, false)).toBe(1);
  });

  it('with reduced motion, switches at once 45pt after docking', () => {
    expect(foldProgress(129 + 44, 129, true)).toBe(0);
    expect(foldProgress(129 + 45, 129, true)).toBe(1);
  });

  it('paints with transform and opacity only, so the calendar never moves faster than the finger', () => {
    const open = foldPaint(0);
    expect(open).toMatchObject({ rowScale: 1, cardOpacity: 1, slimBgOpacity: 0, daysOpacity: 1, daysShift: 0, daysScale: 1, slimOpacity: 0, slimShift: 8, dotScale: 0.4, folded: false });
    const shut = foldPaint(1);
    // 100pt to 56pt: at most 44pt of content shows while 72pt has scrolled under.
    expect(shut.rowScale).toBeCloseTo(0.56);
    expect(shut).toMatchObject({ cardOpacity: 0, slimBgOpacity: 1, daysOpacity: 0, daysShift: -10, slimOpacity: 1, slimShift: 0, dotScale: 1, folded: true });
    expect(shut.daysScale).toBeCloseTo(0.8);
    expect(foldPaint(0.5).folded).toBe(true);
    expect(foldPaint(0.49).folded).toBe(false);
  });

  it('settles a stop half folded to the nearer end, and leaves one at either end', () => {
    expect(settleTo(129 + 20, 129)).toBe(129);
    expect(settleTo(129 + 50, 129)).toBe(129 + 72);
    expect(settleTo(129 + 0.5, 129)).toBeNull();
    expect(settleTo(129 + 71.5, 129)).toBeNull();
    expect(settleTo(40, 129)).toBeNull();
  });

  it('springs critically damped, about 1% short at 0.3s', () => {
    expect(springAt(0, 100, 0)).toBe(0);
    expect(Math.abs(springAt(0, 100, 300) - 100)).toBeLessThan(1.1);
    expect(springDone(0, 100, 300)).toBe(false);
    expect(springDone(0, 100, 600)).toBe(true);
  });
});

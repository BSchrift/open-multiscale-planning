import { describe, expect, it } from 'vitest';
import { decayOffset, pickTarget, project, projection, reach, rubber, rubberInverse, rubberSlope, spring, stretch, stretchSlope, unstretch, velocity } from './swipePhysics';

const near = (a: number, b: number, tol: number) => expect(Math.abs(a - b), `${a} not within ${tol} of ${b}`).toBeLessThanOrEqual(tol);
const W = 306;
const base = { width: W, rate: 0.998, flick: 0.3, min: -Infinity, max: Infinity };

describe("the day swipe's physics", () => {
  it("projects as UIScrollView's normal rate does, carrying v * 499 ms", () => {
    near(projection(1, 0.998), 499, 1e-9);
    near(projection(-2, 0.99), -198, 1e-9);
    near(project(100, 0.5, 0.998), 349.5, 1e-9);
    // A glide's offset tends to the projection.
    near(decayOffset(1, 0.998, 20000), 499, 1e-6);
    near(decayOffset(1, 0.998, 0), 0, 1e-12);
  });

  it('moves a day for a quick flick though the finger moved only a little', () => {
    expect(pickTarget({ ...base, start: 3, pos: 3 * W + 20, v: 1.2 }).target).toBe(4);
    expect(pickTarget({ ...base, start: 3, pos: 3 * W - 15, v: -0.9 }).target).toBe(2);
  });

  it('moves a day for a flick over the flick speed even when momentum falls short of halfway', () => {
    const pos = 3 * W + 5;
    // At the quick-stop rate, 0.31 px/ms projects only 31 px, far short of halfway; the flick rule still moves a day.
    expect(Math.round(project(pos, 0.31, 0.99) / W)).toBe(3);
    expect(pickTarget({ ...base, start: 3, pos, v: 0.31, rate: 0.99 }).target).toBe(4);
    // Below the flick speed, the projection decides.
    expect(pickTarget({ ...base, start: 3, pos, v: 0.25, rate: 0.99 }).target).toBe(3);
  });

  it('moves for a slow drag past halfway and snaps back from a slow small one', () => {
    expect(pickTarget({ ...base, start: 3, pos: 3 * W + 0.6 * W, v: 0 }).target).toBe(4);
    expect(pickTarget({ ...base, start: 3, pos: 3 * W + 0.2 * W, v: 0 }).target).toBe(3);
    expect(pickTarget({ ...base, start: 3, pos: 3 * W - 0.6 * W, v: 0 }).target).toBe(2);
  });

  it('picks the day from where momentum would carry the page, not where the finger let go', () => {
    // 30% across, let go at 0.2 px/ms (under the flick speed): momentum adds 100 px, past halfway.
    const r = pickTarget({ ...base, start: 3, pos: 3 * W + 0.3 * W, v: 0.2 });
    near(r.projected, 3 * W + 0.3 * W + 99.8, 1e-9);
    expect(r.target).toBe(4);
  });

  it('returns to the start day for a flick back toward it, not a day further', () => {
    expect(pickTarget({ ...base, start: 3, pos: 3 * W + 0.7 * W, v: -0.6 }).target).toBe(3);
  });

  it('ends a hard flick exactly one day away, measured from the start day', () => {
    expect(pickTarget({ ...base, start: 3, pos: 3 * W + 30, v: 3 }).target).toBe(4);
    expect(pickTarget({ ...base, start: 3, pos: 3 * W - 30, v: -6 }).target).toBe(2);
    // A flick late in a long drag still stops one day away.
    expect(pickTarget({ ...base, start: 3, pos: 3 * W + 0.95 * W, v: 5 }).target).toBe(4);
  });

  it('ends a long drag exactly one day away, measured from the start day', () => {
    // Shown past the next day (only a stretched page can be), slow or flicked on: the next day, never the one after.
    expect(pickTarget({ ...base, start: 3, pos: 3 * W + 1.3 * W, v: 0 }).target).toBe(4);
    expect(pickTarget({ ...base, start: 3, pos: 3 * W + 1.6 * W, v: 2 }).target).toBe(4);
    expect(pickTarget({ ...base, start: 3, pos: 3 * W - 1.6 * W, v: -2 }).target).toBe(2);
  });

  it('reaches the start day and one either side, inside the range', () => {
    expect(reach(3, 0, 6)).toEqual([2, 4]);
    expect(reach(6, 0, 6)).toEqual([5, 6]);
    expect(reach(0, 0, 6)).toEqual([0, 1]);
    expect(reach(10, -Infinity, Infinity)).toEqual([9, 11]);
  });

  it('keeps the target inside the range', () => {
    expect(pickTarget({ ...base, start: 6, pos: 6 * W + 40, v: 2, min: 0, max: 6 }).target).toBe(6);
    expect(pickTarget({ ...base, start: 0, pos: -40, v: -2, min: 0, max: 6 }).target).toBe(0);
  });

  it('rubber-bands a drag past one day from the start, as at an edge', () => {
    const c = 0.55;
    const [lo, hi] = [2 * W, 4 * W];
    // Within one day either side, 1:1.
    expect(stretch(3 * W + 200, lo, hi, W, c)).toBe(3 * W + 200);
    expect(stretchSlope(3 * W + 200, lo, hi, W, c)).toBe(1);
    // A finger 1.5 days on shows the next day and a stretched sliver past it, by the rubber band's formula.
    const shown = stretch(4.5 * W, lo, hi, W, c);
    near(shown, hi + rubber(0.5 * W, W, c), 1e-9);
    expect(shown - hi).toBeLessThan(0.5 * W * c);
    // However far the finger goes, the day after next never comes fully into view.
    expect(stretch(4 * W + 1e6, lo, hi, W, c)).toBeLessThan(5 * W);
    expect(stretch(2 * W - 1e6, lo, hi, W, c)).toBeGreaterThan(1 * W);
    // Undoing the stretch gives back the finger, and the slope is the formula's derivative.
    for (const raw of [4 * W + 30, 4 * W + 250, 2 * W - 120]) {
      near(unstretch(stretch(raw, lo, hi, W, c), lo, hi, W, c), raw, 1e-6);
      const sh = stretch(raw, lo, hi, W, c);
      const h = 1e-3;
      near(stretchSlope(sh, lo, hi, W, c), (stretch(raw + h, lo, hi, W, c) - stretch(raw - h, lo, hi, W, c)) / (2 * h), 1e-6);
    }
  });

  it('starts the spring where and as fast as asked, under, critically and over damped', () => {
    for (const z of [0.6, 0.9, 1, 1.3]) {
      const f = spring(-200, 1500, 0.38, z);
      near(f(0)[0], -200, 1e-9);
      near(f(0)[1], 1500, 1e-6);
      // Its velocity is the derivative of its position.
      for (const t of [0.02, 0.1, 0.25]) {
        const h = 1e-6;
        const d = (f(t + h)[0] - f(t - h)[0]) / (2 * h);
        near(f(t)[1], d, Math.abs(d) * 1e-4 + 1e-3);
      }
    }
  });

  it('settles the spring within about a second at 0.3 to 0.45 s response', () => {
    for (const response of [0.3, 0.38, 0.45]) {
      for (const z of [0.85, 1]) {
        const [x, v] = spring(-306, -2000, response, z)(1.2);
        expect(Math.abs(x), `response ${response} z ${z}: x`).toBeLessThan(0.5);
        expect(Math.abs(v), `response ${response} z ${z}: v`).toBeLessThan(12);
      }
    }
  });

  it('never overshoots critically damped from rest; underdamped, a little', () => {
    const crit = spring(-306, 0, 0.38, 1);
    for (let t = 0; t <= 2; t += 0.005) expect(crit(t)[0]).toBeLessThanOrEqual(1e-9);
    const under = spring(-306, 0, 0.38, 0.6);
    let max = -Infinity;
    for (let t = 0; t <= 2; t += 0.005) max = Math.max(max, under(t)[0]);
    expect(max).toBeGreaterThan(1);
    expect(max).toBeLessThan(0.15 * 306);
  });

  it("rubber-bands by iOS's formula, gently at first and never past one page", () => {
    const c = 0.55;
    expect(rubber(0, W, c)).toBe(0);
    near(rubber(1, W, c), c, 0.01);
    near(rubber(W, W, c), (1 - 1 / (c + 1)) * W, 1e-9);
    expect(rubber(1e6, W, c)).toBeLessThan(W);
    for (const x of [5, 50, 200, 900]) {
      near(rubberInverse(rubber(x, W, c), W, c), x, 1e-6);
      const h = 1e-4;
      near(rubberSlope(x, W, c), (rubber(x + h, W, c) - rubber(x - h, W, c)) / (2 * h), 1e-6);
    }
    expect(rubber(50, W, 0)).toBe(0);
  });

  it("reads the finger's speed from a straight line through its last 80 ms, and 0 when it rested first", () => {
    const s = [];
    for (let t = 0; t <= 200; t += 8) s.push({ t, x: 400 - 1.5 * t });
    near(velocity(s, 204), -1.5, 1e-9);
    expect(velocity(s, 200 + 71)).toBe(0);
    expect(velocity([{ t: 0, x: 0 }], 5)).toBe(0);
    // Only the last 80 ms count: a slow start then a fast finish reads as fast.
    const mixed = [];
    for (let t = 0; t <= 300; t += 10) mixed.push({ t, x: t < 200 ? 0.1 * t : 20 + 2 * (t - 200) });
    near(velocity(mixed, 300), 2, 1e-9);
  });
});

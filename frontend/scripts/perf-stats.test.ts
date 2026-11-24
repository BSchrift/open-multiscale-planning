import { describe, expect, it } from 'vitest';
import { compare, mannWhitney, percentile, summarize } from './perf-stats';

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

describe('percentiles', () => {
  it('takes the nearest rank, so p99 of 100 samples is the 99th', () => {
    expect(percentile(range(1, 100), 0.5)).toBe(50);
    expect(percentile(range(1, 100), 0.95)).toBe(95);
    expect(percentile(range(1, 100), 0.99)).toBe(99);
    expect(percentile([7], 0.99)).toBe(7);
  });

  it('summarizes samples in any order, rounded to a tenth', () => {
    expect(summarize([3.14159, 1, 2])).toEqual({ n: 3, p50: 2, p95: 3.1, p99: 3.1 });
  });
});

describe('the Mann-Whitney test', () => {
  it('finds two samples of one spread alike, and two apart different', () => {
    const a = range(1, 100);
    expect(mannWhitney(a, [...a].reverse())).toBeGreaterThan(0.9);
    expect(mannWhitney(a, range(60, 159))).toBeLessThan(0.001);
  });

  it('copes with ties', () => {
    expect(mannWhitney([5, 5, 5, 5], [5, 5, 5, 5])).toBe(1);
  });
});

describe('a change', () => {
  const base = range(40, 139);

  it('is slower only when it differs, its p95 is more than 10% over, and by more than the floor', () => {
    expect(compare(base, base.map((x) => x * 1.5), 5).verdict).toBe('slower');
    // 10% over but under the floor.
    expect(compare(range(1, 100), range(1, 100).map((x) => x * 1.2), 25).verdict).toBe('unchanged');
    // Within 10%.
    expect(compare(base, base.map((x) => x * 1.05), 1).verdict).toBe('unchanged');
  });

  it('is faster by the same rule the other way', () => {
    const r = compare(base, base.map((x) => x * 0.6), 5);
    expect(r.verdict).toBe('faster');
    expect(r.change).toBeCloseTo(-0.4, 1);
  });
});

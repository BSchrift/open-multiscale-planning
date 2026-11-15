// The numbers behind the performance KPIs (docs/performance.md): each sample set's percentiles, and whether a change made
// one slower: the samples differ (Mann-Whitney, p < 0.01), and its p95 is more than 10% over the other's and more than
// the KPI's floor. The PR check asks it twice, of fresh samples, and calls a KPI slower only when both agree.

export interface Summary {
  n: number;
  p50: number;
  p95: number;
  p99: number;
}

/** The nearest-rank percentile: the smallest sample with at least q of them at or below it. */
export function percentile(samples: readonly number[], q: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)]!;
}

const tenth = (x: number) => Math.round(x * 10) / 10;

export function summarize(samples: readonly number[]): Summary {
  return { n: samples.length, p50: tenth(percentile(samples, 0.5)), p95: tenth(percentile(samples, 0.95)), p99: tenth(percentile(samples, 0.99)) };
}

/** The standard normal's distribution function, by Abramowitz and Stegun 7.1.26: within 1.5e-7. */
function normal(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const k = 1 / (1 + 0.3275911 * x);
  const erf = 1 - ((((1.061405429 * k - 1.453152027) * k + 1.421413741) * k - 0.284496736) * k + 0.254829592) * k * Math.exp(-x * x);
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

/** The two-sided p-value of the Mann-Whitney U test, by the normal approximation with ties corrected for. */
export function mannWhitney(a: readonly number[], b: readonly number[]): number {
  const all = [...a.map((v) => ({ v, a: true })), ...b.map((v) => ({ v, a: false }))].sort((x, y) => x.v - y.v);
  const n = all.length;
  let rankA = 0;
  let ties = 0;
  for (let i = 0; i < n; ) {
    let j = i;
    while (j < n && all[j]!.v === all[i]!.v) j++;
    const rank = (i + 1 + j) / 2;
    for (let k = i; k < j; k++) if (all[k]!.a) rankA += rank;
    const t = j - i;
    ties += t * t * t - t;
    i = j;
  }
  const [n1, n2] = [a.length, b.length];
  const u = rankA - (n1 * (n1 + 1)) / 2;
  const sigma = Math.sqrt(((n1 * n2) / 12) * (n + 1 - ties / (n * (n - 1))));
  if (sigma === 0) return 1;
  const z = (Math.abs(u - (n1 * n2) / 2) - 0.5) / sigma;
  return Math.min(1, 2 * (1 - normal(Math.max(0, z))));
}

export type Verdict = 'slower' | 'faster' | 'unchanged';

/** How after compares with before, by the rule above. change is p95's, as a fraction of before's. */
export function compare(before: readonly number[], after: readonly number[], floorMs: number): { verdict: Verdict; p: number; change: number } {
  const p = mannWhitney(before, after);
  const [b, a] = [percentile(before, 0.95), percentile(after, 0.95)];
  const change = b > 0 ? a / b - 1 : 0;
  const differs = p < 0.01;
  if (differs && a > b * 1.1 && a - b > floorMs) return { verdict: 'slower', p, change };
  if (differs && b > a * 1.1 && b - a > floorMs) return { verdict: 'faster', p, change };
  return { verdict: 'unchanged', p, change };
}

import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { addRun, baseline, readRuns, regressions } from './perf-data';
import type { Run } from './perf-data';

const row = (p95: number) => ({ kpi: 'capture.save', platform: 'web-desktop' as const, scenario: 'one-year', n: 500, p50: p95 / 2, p95, p99: p95 * 1.5 });
const run = (kind: Run['kind'], at: string, p95: number): Run => ({ kind, commit: 'abcdef1234', runner: 'ubuntu-latest', at, rows: [row(p95)] });

describe('perf-data', () => {
  it('keeps each run in a file by day, and reads them back oldest first, or since a time', () => {
    const dir = mkdtempSync(join(tmpdir(), 'perf-data-'));
    expect(readRuns(dir)).toEqual([]);
    expect(addRun(dir, run('main', '2026-11-15T09:30:05.000Z', 60))).toBe(join('runs', '2026-11-15', '093005-main-abcdef1.json'));
    addRun(dir, run('nightly', '2026-11-14T06:00:00.000Z', 70));
    expect(readRuns(dir).map((r) => r.kind)).toEqual(['nightly', 'main']);
    expect(readRuns(dir, '2026-11-15T00:00:00.000Z').map((r) => r.kind)).toEqual(['main']);
    expect(existsSync(join(dir, 'baseline.json'))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, 'baseline.json'), 'utf8'))[0]).toMatchObject({ kpi: 'capture.save', p95: 60, runs: 1 });
  });

  it("takes the baseline as the median of main's last 10 runs, leaving out the others", () => {
    const runs = [
      ...Array.from({ length: 12 }, (_, i) => run('main', `2026-11-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`, i < 2 ? 1000 : 50 + i)),
      run('nightly', '2026-11-13T00:00:00.000Z', 5000),
    ];
    const [b] = baseline(runs);
    expect(b).toMatchObject({ runs: 10, n: 5000 });
    // 52..61, so 56.5.
    expect(b!.p95).toBe(56.5);
  });

  it("finds a nightly KPI more than 10% and its floor over main's baseline, at p95", () => {
    const base = baseline([run('main', '2026-11-01T00:00:00.000Z', 60)]);
    expect(regressions(base, [row(80)])).toEqual(['capture.save on web-desktop, one-year: p95 80 ms against a baseline of 60 ms (+33%)']);
    // 10% over but within capture.save's 5 ms floor.
    expect(regressions(baseline([run('main', '2026-11-01T00:00:00.000Z', 30)]), [row(34)])).toEqual([]);
    expect(regressions(base, [row(62)])).toEqual([]);
  });
});


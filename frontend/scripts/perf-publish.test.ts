import { describe, expect, it } from 'vitest';
import { batches, metricData } from './perf-publish';
import type { Run } from './perf-data';

const run = (kind: Run['kind'], at: string): Run => ({
  kind,
  commit: 'abcdef1',
  runner: 'ubuntu-latest',
  at,
  rows: [
    { kpi: 'capture.save', platform: 'web-desktop', scenario: 'one-year', n: 500, p50: 30, p95: 60, p99: 90 },
    { kpi: 'mem.heap', platform: 'mac', scenario: 'five-year', n: 1, p50: 108, p95: 108, p99: 108 },
    { kpi: 'not.a.kpi', platform: 'mac', scenario: 'one-year', n: 1, p50: 1, p95: 1, p99: 1 },
  ],
});

describe('publishing to CloudWatch', () => {
  it("sends each run's p50, p95 and p99 as metrics by KPI, platform and scenario, at the run's time, in the KPI's unit", () => {
    const data = metricData([run('main', '2026-11-14T09:00:00.000Z')]);
    expect(data).toHaveLength(6);
    expect(data[1]).toEqual({
      MetricName: 'p95',
      Dimensions: [{ Name: 'KPI', Value: 'capture.save' }, { Name: 'Platform', Value: 'web-desktop' }, { Name: 'Scenario', Value: 'one-year' }],
      Timestamp: '2026-11-14T09:00:00.000Z',
      Value: 60,
      Unit: 'Milliseconds',
    });
    expect(data[3]).toMatchObject({ MetricName: 'p50', Value: 108, Unit: 'Megabytes' });
  });

  it("leaves out the A/A runs, whose builds are the same, and splits into CloudWatch's 1,000 a request", () => {
    expect(metricData([run('aa', '2026-11-14T09:00:00.000Z')])).toEqual([]);
    const many = Array.from({ length: 400 }, (_, i) => run('main', `2026-11-14T09:00:${String(i % 60).padStart(2, '0')}.000Z`));
    expect(batches(metricData(many)).map((b) => b.length)).toEqual([1000, 1000, 400]);
  });
});

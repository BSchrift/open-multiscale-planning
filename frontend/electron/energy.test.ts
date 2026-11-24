import type { ProcessMetric } from 'electron';
import { describe, expect, it } from 'vitest';
import { processEnergy } from './energy';

const metric = (type: ProcessMetric['type'], percentCPUUsage: number, idleWakeupsPerSecond: number) =>
  ({ type, cpu: { percentCPUUsage, idleWakeupsPerSecond } }) as ProcessMetric;

describe('processEnergy', () => {
  it("sums each kind's CPU and idle wakeups: the main process, the pages and the GPU", () => {
    const metrics = [metric('Browser', 0.5, 3), metric('Tab', 1.25, 10), metric('Tab', 0.25, 2), metric('GPU', 0.1, 1), metric('Utility', 4, 40)];
    expect(processEnergy(metrics)).toEqual([
      { process: 'main', cpuPercent: 0.5, idleWakeupsPerSecond: 3 },
      { process: 'renderer', cpuPercent: 1.5, idleWakeupsPerSecond: 12 },
      { process: 'gpu', cpuPercent: 0.1, idleWakeupsPerSecond: 1 },
    ]);
  });

  it('leaves out a kind with no process running, such as a GPU process where there is none', () => {
    expect(processEnergy([metric('Browser', 0, 0)]).map((p) => p.process)).toEqual(['main']);
  });
});

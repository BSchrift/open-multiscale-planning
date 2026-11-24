// What the Mac app's processes cost the battery, for telemetry's app.energy.sample each minute (docs/performance.md,
// Battery): each kind of process's CPU and idle wakeups, which macOS's Energy Impact is mostly made of.

import type { ProcessMetric } from 'electron';
import type { ProcessEnergy } from '../src/core/telemetry';

const KINDS: Partial<Record<ProcessMetric['type'], ProcessEnergy['process']>> = { Browser: 'main', Tab: 'renderer', GPU: 'gpu' };

/**
 * Each kind's CPU percent and idle wakeups a second, summed over its processes, such as the main window's and the
 * capture window's pages. Electron measures both since the last time it was asked, so a call each minute gives the
 * minute's. Other kinds, such as the network service, are left out.
 */
export function processEnergy(metrics: readonly ProcessMetric[]): ProcessEnergy[] {
  const totals = new Map<ProcessEnergy['process'], ProcessEnergy>();
  for (const metric of metrics) {
    const kind = KINDS[metric.type];
    if (!kind) continue;
    const total = totals.get(kind) ?? { process: kind, cpuPercent: 0, idleWakeupsPerSecond: 0 };
    total.cpuPercent += metric.cpu.percentCPUUsage;
    total.idleWakeupsPerSecond += metric.cpu.idleWakeupsPerSecond;
    totals.set(kind, total);
  }
  return [...totals.values()];
}

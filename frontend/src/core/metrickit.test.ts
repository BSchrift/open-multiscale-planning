import { describe, expect, it } from 'vitest';
import { dailyAttributes, exceptionAttributes, topFrame } from './metrickit';
import type { MetricException } from './metrickit';

// The shape of MXCallStackTree's JSON: each stack rooted at its newest frame, with what called it below.
const tree: MetricException['callStackTree'] = {
  callStacks: [
    { threadAttributed: false, callStackRootFrames: [{ binaryName: 'WebKit', offsetIntoBinaryTextSegment: 4096, sampleCount: 50 }] },
    {
      threadAttributed: true,
      callStackRootFrames: [
        { binaryName: 'App', offsetIntoBinaryTextSegment: 166460, sampleCount: 30, subFrames: [{ binaryName: 'libdyld.dylib', offsetIntoBinaryTextSegment: 6948, sampleCount: 30 }] },
        { binaryName: 'UIKitCore', offsetIntoBinaryTextSegment: 1024, sampleCount: 10 },
      ],
    },
  ],
};

describe('MetricKit reports', () => {
  it("names a day's totals, rounded, and leaves out what MetricKit didn't measure", () => {
    expect(
      dailyAttributes({ day: '2026-11-15', cpuSeconds: 100.004, gpuSeconds: 20, cellularBytes: 150_000_000, wifiBytes: 110_000_000, foregroundSeconds: 700, backgroundSeconds: 40, hangSeconds: 1.456 }),
    ).toEqual({
      'energy.day': '2026-11-15',
      'energy.cpu_seconds': 100,
      'energy.gpu_seconds': 20,
      'energy.cellular_bytes': 150_000_000,
      'energy.wifi_bytes': 110_000_000,
      'energy.foreground_seconds': 700,
      'energy.background_seconds': 40,
      'energy.hang_seconds': 1.46,
    });
    expect(dailyAttributes({ day: '2026-11-15', cpuSeconds: 3 })).toEqual({ 'energy.day': '2026-11-15', 'energy.cpu_seconds': 3 });
  });

  it('blames the frame the thread it charges sampled most, as its binary and offset, and nothing else of the stack', () => {
    expect(topFrame(tree)).toBe('App+0x28a3c');
    expect(topFrame({ callStacks: [{ callStackRootFrames: [{ binaryName: 'App', offsetIntoBinaryTextSegment: 16 }] }] })).toBe('App+0x10');
    expect(topFrame({ callStacks: [] })).toBeUndefined();
    expect(topFrame(undefined)).toBeUndefined();
  });

  it('reports a CPU or disk exception by its kind, its size and its top frame', () => {
    expect(exceptionAttributes({ kind: 'cpu', cpuSeconds: 90.126, callStackTree: tree })).toEqual({
      'energy.exception.kind': 'cpu',
      'energy.exception.cpu_seconds': 90.13,
      'code.function': 'App+0x28a3c',
    });
    expect(exceptionAttributes({ kind: 'disk', diskBytes: 2_147_483_648.4 })).toEqual({ 'energy.exception.kind': 'disk', 'energy.exception.disk_bytes': 2_147_483_648 });
  });
});

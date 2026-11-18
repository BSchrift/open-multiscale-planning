import { describe, expect, it } from 'vitest';
import { iphoneRaw } from './perf-ios';

describe("the iPhone run's numbers", () => {
  it('turns the PERF line into samples: the measures, each launch to Today interactive, and memory', () => {
    const line = `noise\nPERF iphone ${JSON.stringify({
      launched: [1000, 5000, 9000],
      measures: { 'capture.save': [60, 70], 'nav.week': [120], 'today:interactive@': [2500, 5900, 9800] },
      peakMb: 180,
      warnings: 0,
    })}\nmore noise`;
    const raw = iphoneRaw(line, 'one-year', 410);
    expect(raw).toEqual({
      target: 'this',
      platform: 'iphone',
      scenario: 'one-year',
      samples: { 'capture.save': [60, 70], 'nav.week': [120], 'start.cold': [1500], 'start.warm': [900, 800], 'mem.app': [180], 'mem.events': [0], 'mem.webview': [410] },
    });
  });

  it('says so when the test printed no numbers', () => {
    expect(() => iphoneRaw('nothing here', 'one-year')).toThrow(/no PERF iphone line/);
  });
});

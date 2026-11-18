import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inputTime, KEEP, KEPT, MEASURE_LIMIT, perf, watchPointers } from './perf';

const measures = (name?: string) => performance.getEntriesByType('measure').filter((m) => !name || m.name === name);

beforeEach(() => {
  performance.clearMeasures();
  perf.reset();
});
afterEach(() => vi.unstubAllGlobals());

describe('perf', () => {
  it('measures from a start to its stop, once', () => {
    perf.start('capture.save', performance.now() - 20);
    perf.stop('capture.save', { records: 3 });
    perf.stop('capture.save');
    const [m] = measures('capture.save');
    expect(measures()).toHaveLength(1);
    expect(m!.duration).toBeGreaterThanOrEqual(20);
    expect((m as PerformanceMeasure).detail).toEqual({ records: 3 });
  });

  it('ignores a stop with no start, and a start again replaces the first', () => {
    perf.stop('nav.week');
    expect(measures()).toHaveLength(0);
    perf.start('nav.week', 0);
    perf.start('nav.week', performance.now());
    perf.stop('nav.week');
    expect(measures('nav.week')[0]!.startTime).toBeGreaterThan(0);
  });

  it('drops a start that is cancelled', () => {
    perf.start('sync.pull');
    perf.cancel('sync.pull');
    perf.stop('sync.pull');
    expect(measures()).toHaveLength(0);
  });

  it('tells whether a start is waiting', () => {
    expect(perf.pending('sync.push')).toBeUndefined();
    perf.start('sync.push', 5);
    expect(perf.pending('sync.push')).toBe(5);
  });

  it('stops after the next frame is painted', async () => {
    let frame: FrameRequestCallback | undefined;
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      frame = cb;
      return 1;
    });
    perf.start('capture.open');
    perf.stopAfterPaint('capture.open');
    expect(measures()).toHaveLength(0);
    frame!(performance.now());
    await vi.waitFor(() => expect(measures('capture.open')).toHaveLength(1));
  });

  it('measures each of two starts stopped before the same frame', async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
    perf.start('capture.key');
    perf.stopAfterPaint('capture.key');
    perf.start('capture.key');
    perf.stopAfterPaint('capture.key');
    for (const frame of frames) frame(performance.now());
    await vi.waitFor(() => expect(measures('capture.key')).toHaveLength(2));
  });

  it('marks once, after the next frame', async () => {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 0));
    perf.markAfterPaint('today:interactive');
    perf.markAfterPaint('today:interactive');
    await vi.waitFor(() => expect(performance.getEntriesByName('today:interactive', 'mark')).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(performance.getEntriesByName('today:interactive', 'mark')).toHaveLength(1);
    performance.clearMarks('today:interactive');
  });

  it('counts only what the page still holds, so a reader that clears them never loses one to the limit', () => {
    // Three keys an action, as the runner types, cleared after each.
    for (let i = 0; i < MEASURE_LIMIT; i++) {
      for (let key = 0; key < 3; key++) {
        perf.start('capture.key');
        perf.stop('capture.key');
      }
      expect(measures('capture.key')).toHaveLength(3);
      performance.clearMeasures();
    }
  });

  it('keeps memory flat: past the limit the oldest measures go', () => {
    for (let i = 0; i <= MEASURE_LIMIT; i++) {
      perf.start('drag.frame');
      perf.stop('drag.frame');
    }
    expect(measures().length).toBeLessThanOrEqual(MEASURE_LIMIT);
  });
});

describe('keeping measures for the iPhone runner', () => {
  it('keeps each measure, and when Today was interactive, where the test page reads them, once asked to', async () => {
    const stored = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => void stored.set(k, v) });
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 0));
    perf.start('nav.week');
    perf.stop('nav.week');
    expect(stored.get(KEPT)).toBeUndefined();
    stored.set(KEEP, '1');
    perf.reset();
    perf.start('nav.week', performance.now() - 12);
    perf.stop('nav.week');
    perf.markAfterPaint('today:interactive');
    await vi.waitFor(() => expect(JSON.parse(stored.get(KEPT)!)).toHaveLength(2));
    const [week, interactive] = JSON.parse(stored.get(KEPT)!) as [string, number][];
    expect(week![0]).toBe('nav.week');
    expect(week![1]).toBeGreaterThanOrEqual(12);
    // The mark as a wall-clock time, since the test measures the launch from its own clock.
    expect(interactive![0]).toBe('today:interactive@');
    expect(Math.abs(interactive![1] - Date.now())).toBeLessThan(5000);
    performance.clearMarks('today:interactive');
  });
});

describe('inputTime', () => {
  it("takes a pointer click from its pointerdown, and a key or a keyboard's click from itself", () => {
    const target = new EventTarget();
    watchPointers(target);
    const down = new Event('pointerdown');
    target.dispatchEvent(down);
    expect(inputTime({ type: 'click', timeStamp: down.timeStamp + 80, detail: 1 })).toBe(down.timeStamp);
    expect(inputTime({ type: 'click', timeStamp: down.timeStamp + 80, detail: 0 })).toBe(down.timeStamp + 80);
    expect(inputTime({ type: 'keydown', timeStamp: down.timeStamp + 90 })).toBe(down.timeStamp + 90);
  });
});

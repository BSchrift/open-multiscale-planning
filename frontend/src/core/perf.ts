// How long the flows people use most take, as User Timing measures: each KPI in docs/performance.md is a measure of
// the same name, from its start event to its stop event. Always on, behind no flag: a start costs a map write, and only
// the last MEASURE_LIMIT measures are kept, so memory stays flat. The browser and Mac app tests read them with
// performance.getEntriesByType('measure'), the iPhone's from its check page, and the browser's DevTools and Safari's
// Web Inspector show them on their timelines.

/** Past this many, every measure is cleared: whoever reads them reads more often. */
export const MEASURE_LIMIT = 500;

const started = new Map<string, number>();
let measured = 0;
let lastDown = 0;

/** Remembers when the last pointer went down, so a click can be timed from its pointerdown. */
export function watchPointers(target: Pick<EventTarget, 'addEventListener'>): void {
  target.addEventListener('pointerdown', (event) => (lastDown = event.timeStamp), { capture: true, passive: true });
}
if (typeof window !== 'undefined') watchPointers(window);

/**
 * When the input behind an event began, on the performance timeline: a pointer's click from its pointerdown, and a key
 * or a keyboard's click (detail 0) from the event itself. Its own timestamp, so time spent waiting to run counts.
 */
export function inputTime(event: { type: string; timeStamp: number; detail?: number }): number {
  return event.type === 'click' && (event.detail ?? 0) > 0 && lastDown > 0 && lastDown <= event.timeStamp ? lastDown : event.timeStamp;
}

function record(name: string, start: number, detail?: Record<string, unknown>) {
  if (++measured > MEASURE_LIMIT) {
    performance.clearMeasures();
    measured = 1;
  }
  try {
    performance.measure(name, { start, end: performance.now(), ...(detail ? { detail } : {}) });
  } catch {
    // A start from before this page's time origin, such as a launch: nothing to measure.
  }
}

/** After the next frame is painted: the frame's callback runs before paint, and a message after it runs once it's done. */
function afterPaint(then: () => void) {
  const frame = globalThis.requestAnimationFrame ?? ((cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 0));
  frame(() => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      then();
    };
    channel.port2.postMessage(null);
  });
}

export const perf = {
  /** Starts a KPI, at an event's timeStamp when there is one. A second start before its stop replaces the first. */
  start(name: string, at = performance.now()): void {
    started.set(name, at);
  },
  /** The start waiting for its stop, if any. */
  pending(name: string): number | undefined {
    return started.get(name);
  },
  cancel(name: string): void {
    started.delete(name);
  },
  /** Ends a KPI now. Nothing happens without a start, so a stop can sit wherever the result shows. */
  stop(name: string, detail?: Record<string, unknown>): void {
    const start = started.get(name);
    if (start === undefined) return;
    started.delete(name);
    record(name, start, detail);
  },
  /**
   * Ends a KPI once the next frame is painted, so the person can see the result. Its start is taken now, so keys typed
   * faster than frames are each measured.
   */
  stopAfterPaint(name: string, detail?: Record<string, unknown>): void {
    const start = started.get(name);
    if (start === undefined) return;
    started.delete(name);
    afterPaint(() => record(name, start, detail));
  },
  /** A measure whose start the caller kept, such as a push's first change. */
  measure(name: string, start: number, detail?: Record<string, unknown>): void {
    record(name, start, detail);
  },
  /** A mark once per page load, after the next frame: today:interactive, which the start KPIs end at. */
  markAfterPaint(name: string): void {
    if (started.has(`mark:${name}`) || performance.getEntriesByName(name, 'mark').length > 0) return;
    started.set(`mark:${name}`, 0);
    afterPaint(() => performance.mark(name));
  },
  /** For tests. */
  reset(): void {
    started.clear();
    measured = 0;
  },
};

// Time sources. `Clock` is wall-clock time, injected everywhere so that code and tests can fix "now".
// The rest is the hybrid logical clock that orders field writes across devices.
//
// A hybrid clock is the string `<epoch ms, 13 digits>-<counter, 6 digits>-<device id>`. Comparing two clocks
// as plain strings orders them: time, then counter, with the device id breaking ties. The server uses the
// same format and comparison, and device ids must be printable ASCII with no space.

export interface Clock {
  /** Epoch milliseconds. */
  now(): number;
  /** IANA time zone, such as 'America/Chicago'. */
  zone(): string;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  zone: () => Intl.DateTimeFormat().resolvedOptions().timeZone,
};

/** A clock stuck at one instant, for tests. Call set to move it. */
export function fixedClock(at: string | number, zone = 'UTC'): Clock & { set(at: string | number): void } {
  let ms = typeof at === 'number' ? at : Date.parse(at);
  return {
    now: () => ms,
    zone: () => zone,
    set(next) {
      ms = typeof next === 'number' ? next : Date.parse(next);
    },
  };
}

export interface Hlc {
  wall: number;
  counter: number;
  device: string;
}

const COUNTER_LIMIT = 999_999;
const CLOCK_RE = /^(\d{13})-(\d{6})-([\x21-\x7e]+)$/;

export function formatClock({ wall, counter, device }: Hlc): string {
  return `${String(wall).padStart(13, '0')}-${String(counter).padStart(6, '0')}-${device}`;
}

export function parseClock(clock: string): Hlc {
  const m = CLOCK_RE.exec(clock);
  if (!m) throw new Error(`Malformed clock: ${clock}`);
  return { wall: Number(m[1]), counter: Number(m[2]), device: m[3]! };
}

export function isClock(value: unknown): value is string {
  return typeof value === 'string' && CLOCK_RE.test(value);
}

/** Whether a field written at `incoming` replaces one written at `current`. Equal clocks are the same write. */
export function clockWins(incoming: string, current: string | null | undefined): boolean {
  return current == null || incoming > current;
}

/** The clock for a local write: after both the last one issued here and the wall clock. */
export function nextClock(last: string | null | undefined, nowMs: number, device: string): string {
  const prev = last ? parseClock(last) : null;
  if (!prev || nowMs > prev.wall) return formatClock({ wall: nowMs, counter: 0, device });
  if (prev.counter >= COUNTER_LIMIT) return formatClock({ wall: prev.wall + 1, counter: 0, device });
  return formatClock({ wall: prev.wall, counter: prev.counter + 1, device });
}

/** The highest clock this device has seen, after reading a remote one. Later local writes sort above it. */
export function observeClock(last: string | null | undefined, remote: string): string {
  return !last || remote > last ? remote : last;
}

// The physics of swiping from day to day: pure functions of where the finger is and how fast it moves, so the feel is
// tested apart from the page. Positions are px and speeds px per ms; a CSS px is an iPhone point. The values are the
// ones the owner approved in the prototype, tuned on an iPhone.

/** The approved feel. */
export const SWIPE = {
  /** A drag no further from level than this, in degrees, swipes; a steeper one scrolls the hours. */
  lockAngle: 35,
  /** The share of its speed momentum keeps each ms: UIScrollView's normal deceleration rate. */
  rate: 0.998,
  /** The spring that settles on a day: its response, the undamped period in seconds, and its damping ratio. */
  response: 0.38,
  damping: 0.9,
  /** Let go faster than this, in px per ms (300 pt/s), and the day always changes. */
  flick: 0.3,
  /** How far the page follows the finger past one day: iOS's rubber band. */
  rubber: 0.55,
} as const;

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** How far momentum carries a release at v when the speed falls by `rate` each ms, as UIScrollView's does. */
export const projection = (v: number, rate: number) => (v * rate) / (1 - rate);
export const project = (pos: number, v: number, rate: number) => pos + projection(v, rate);
/** How far a momentum scroll at v has gone after t ms. */
export const decayOffset = (v: number, rate: number, t: number) => (v * rate * (1 - rate ** t)) / (1 - rate);

/** iOS's rubber band: `over` px past an edge, the page shows (1 - 1 / (over * c / dim + 1)) * dim. */
export function rubber(over: number, dim: number, c: number) {
  if (over <= 0 || c <= 0) return 0;
  return (over * dim * c) / (dim + c * over);
}
/** How fast the stretched page moves per px of finger, `over` px past the edge. */
export function rubberSlope(over: number, dim: number, c: number) {
  if (c <= 0) return 0;
  const k = dim + c * Math.max(0, over);
  return (dim * dim * c) / (k * k);
}
/** The finger's distance past the edge for a page shown `shown` px past it. */
export function rubberInverse(shown: number, dim: number, c: number) {
  if (shown <= 0 || c <= 0) return 0;
  const s = Math.min(shown, dim * 0.999);
  return (s * dim) / (c * (dim - s));
}

/** The page shown for a finger at `raw` px, rubber-banded past `lo` and `hi` as past an edge. */
export function stretch(raw: number, lo: number, hi: number, dim: number, c: number) {
  if (raw < lo) return lo - rubber(lo - raw, dim, c);
  if (raw > hi) return hi + rubber(raw - hi, dim, c);
  return raw;
}
export function unstretch(shown: number, lo: number, hi: number, dim: number, c: number) {
  if (shown < lo) return lo - rubberInverse(lo - shown, dim, c);
  if (shown > hi) return hi + rubberInverse(shown - hi, dim, c);
  return shown;
}
/** How fast the shown page moves per px of finger there. */
export function stretchSlope(shown: number, lo: number, hi: number, dim: number, c: number) {
  const raw = unstretch(shown, lo, hi, dim, c);
  if (raw < lo) return rubberSlope(lo - raw, dim, c);
  if (raw > hi) return rubberSlope(raw - hi, dim, c);
  return 1;
}

/** The days a swipe that started on day `start` can reach: that day and one either side, inside `min` to `max`. */
export const reach = (start: number, min: number, max: number): [number, number] => [Math.max(min, start - 1), Math.min(max, start + 1)];

/**
 * The day to settle on, chosen from where momentum would carry the page, not where the finger let go. A release
 * faster than `flick` always goes at least to the next day its way. However long the drag or hard the flick, it ends
 * on the day the swipe started on or one either side.
 */
export function pickTarget(o: { pos: number; v: number; width: number; rate: number; flick: number; start: number; min: number; max: number }) {
  const frac = o.pos / o.width;
  const eps = 1e-3;
  const [lo, hi] = reach(o.start, o.min, o.max);
  const projected = project(o.pos, o.v, o.rate);
  let target = Math.round(projected / o.width);
  if (o.v !== 0 && Math.abs(o.v) >= o.flick) {
    target = o.v > 0 ? Math.max(target, Math.ceil(frac - eps)) : Math.min(target, Math.floor(frac + eps));
  }
  return { target: clamp(target, lo, hi), projected };
}

/**
 * A spring of unit mass, set as SwiftUI's is by its response (s, the undamped period) and damping ratio. It starts x0
 * px from rest moving at v0 px per s, and gives t (s) to [x, v], solved exactly, so frame timing never changes its path.
 */
export function spring(x0: number, v0: number, response: number, damping: number): (t: number) => [number, number] {
  const w0 = (2 * Math.PI) / response;
  const z = damping;
  if (Math.abs(z - 1) < 1e-4) {
    const B = v0 + w0 * x0;
    return (t) => {
      const e = Math.exp(-w0 * t);
      return [e * (x0 + B * t), e * (v0 - w0 * B * t)];
    };
  }
  if (z < 1) {
    const a = z * w0;
    const wd = w0 * Math.sqrt(1 - z * z);
    const C = (v0 + a * x0) / wd;
    return (t) => {
      const [e, c, s] = [Math.exp(-a * t), Math.cos(wd * t), Math.sin(wd * t)];
      return [e * (x0 * c + C * s), e * ((C * wd - a * x0) * c - (x0 * wd + a * C) * s)];
    };
  }
  const r = w0 * Math.sqrt(z * z - 1);
  const [r1, r2] = [-z * w0 + r, -z * w0 - r];
  const c2 = (v0 - r1 * x0) / (r2 - r1);
  const c1 = x0 - c2;
  return (t) => {
    const [e1, e2] = [Math.exp(r1 * t), Math.exp(r2 * t)];
    return [c1 * e1 + c2 * e2, r1 * c1 * e1 + r2 * c2 * e2];
  };
}

/** A point the finger passed: its time in ms and its position in px along the axis that counts. */
export interface Sample {
  t: number;
  x: number;
}

/** The finger's speed as it let go at `upAt`, in px per ms: a straight line through its last 80 ms, or 0 if it rested over 70 ms first. */
export function velocity(samples: readonly Sample[], upAt: number) {
  const last = samples.at(-1);
  if (!last || samples.length < 2 || upAt - last.t > 70) return 0;
  let pts = samples.filter((s) => last.t - s.t <= 80);
  if (pts.length < 2) pts = samples.slice(-2);
  const mt = pts.reduce((sum, p) => sum + p.t, 0) / pts.length;
  const mx = pts.reduce((sum, p) => sum + p.x, 0) / pts.length;
  const num = pts.reduce((sum, p) => sum + (p.t - mt) * (p.x - mx), 0);
  const den = pts.reduce((sum, p) => sum + (p.t - mt) ** 2, 0);
  return den > 0 ? num / den : 0;
}

// The week strip's fold on the phone's Today (strip-fold-spec.md, approved Nov 25). The title and the week row scroll
// away 1:1 with the day; once the day row reaches the top it docks, and over the next 72pt of scroll folds into a 44pt
// slim bar, following the scroll both ways. Each frame paints transform and opacity only, so nothing changes layout.
// Stopped half folded, the scroll springs to the nearer end in about 0.3s. With reduced motion it switches at once.

/** The scroll over which the docked day row folds. */
export const FOLD = 72;
/** The day row's height, and the slim bar's band it folds to. */
const ROW = 100;
const BAR = 56;
/** With reduced motion, how far past docking the bar takes the day row's place, at once. */
const REDUCED_AT = 45;
/** The spring's stiffness, per second: critically damped, about 1% short at 0.3s. */
const OMEGA = 22;

const clamp = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** How far folded the day row is, 0 open to 1 the slim bar, from the scroll and where the day row docks. */
export function foldProgress(scrollTop: number, dock: number, reduced: boolean): number {
  if (reduced) return scrollTop - dock >= REDUCED_AT ? 1 : 0;
  return clamp((scrollTop - dock) / FOLD);
}

export interface FoldPaint {
  /** The ground and card behind the day row, scaled from the top: 100pt to 56pt. */
  rowScale: number;
  cardOpacity: number;
  slimBgOpacity: number;
  daysOpacity: number;
  /** In points. */
  daysShift: number;
  daysScale: number;
  slimOpacity: number;
  slimShift: number;
  dotScale: number;
  /** Past halfway: the bar, not the seven days, is what taps and screen readers reach. */
  folded: boolean;
}

/** What each layer draws at a fold. The ground band reveals at most 44pt while 72pt scrolls under, so no gap opens. */
export function foldPaint(p: number): FoldPaint {
  const q = clamp((p - 0.4) / 0.6);
  return {
    rowScale: 1 - ((ROW - BAR) / ROW) * p,
    cardOpacity: 1 - clamp((p - 0.6) / 0.4),
    slimBgOpacity: q,
    daysOpacity: 1 - clamp(p / 0.5),
    daysShift: 0 - 10 * p,
    daysScale: 1 - 0.2 * p,
    slimOpacity: q,
    slimShift: 8 * (1 - q),
    dotScale: 0.4 + 0.6 * q,
    folded: p >= 0.5,
  };
}

/** Where a scroll stopped half folded settles: the nearer end, or nowhere when it's already at one. */
export function settleTo(scrollTop: number, dock: number): number | null {
  const x = (scrollTop - dock) / FOLD;
  if (x <= 0.01 || x >= 0.99) return null;
  return x < 0.5 ? dock : dock + FOLD;
}

const decay = (ms: number) => {
  const t = (OMEGA * ms) / 1000;
  return (1 + t) * Math.exp(-t);
};
/** A critically damped spring from `from` to `to`, `ms` in. */
export const springAt = (from: number, to: number, ms: number) => to + (from - to) * decay(ms);
/** Close enough to stop: under 0.3% of the way left. */
export const springDone = (_from: number, _to: number, ms: number) => decay(ms) < 0.003;

// The capacity ring: the week's used time against its open time, popping up on each add or removal with the change
// in the middle, then fading. It shades from blue toward red as it fills, and past full it's red with the excess
// hatched. It's drawn for sighted users only; announce the same numbers in a live region beside it.

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ringColor } from '../../../core/capacity';
import { formatMinutes } from '../../../core/dates';
import type { Minutes } from '../../../core/types';
import './ring.css';

export interface RingPop {
  /** The solid arc, which catches up last. */
  shownOld: Minutes;
  /** The pale arc, which moves first. */
  shownNew: Minutes;
  /** Used time after the change. */
  to: Minutes;
  /** The change since the ring popped up, summing rapid taps. */
  delta: Minutes;
  fading: boolean;
}

const R = 36;
const C = 2 * Math.PI * R;

export function CapacityRing(props: { pop: RingPop; open: Minutes; small?: boolean }) {
  const { pop, open, small } = props;
  const hatch = useId();
  const cap = open || 1;
  const over = pop.to - open;
  const dash = (m: Minutes) => `${((Math.max(0, Math.min(m, cap)) / cap) * C).toFixed(1)} ${C.toFixed(1)}`;
  const color = ringColor(pop.to / cap);
  const label = over > 0 ? `${formatMinutes(over)} over` : pop.delta < 0 ? `−${formatMinutes(-pop.delta)}` : `+${formatMinutes(pop.delta)}`;
  return (
    <div className={`donut${small ? ' small' : ''}${pop.fading ? ' fading' : ''}`} aria-hidden="true">
      <span className="disc" />
      <svg viewBox="0 0 88 88">
        <defs>
          <pattern id={hatch} width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="5" height="5" style={{ fill: 'var(--red-tint)' }} />
            <rect width="2.5" height="5" style={{ fill: 'var(--red)' }} />
          </pattern>
        </defs>
        <circle className="dtrack" cx="44" cy="44" r={R} />
        <circle className="dnew" cx="44" cy="44" r={R} style={{ stroke: color, strokeDasharray: dash(pop.shownNew) }} />
        <circle className="dold" cx="44" cy="44" r={R} style={{ stroke: color, strokeDasharray: dash(pop.shownOld) }} />
        {over > 0 && <circle className="dover" cx="44" cy="44" r={R} style={{ stroke: `url(#${hatch})`, strokeDasharray: dash(over) }} />}
      </svg>
      <span className="dlabel">{label}</span>
    </div>
  );
}

/** The ring's state. pulse(before, after) on each change; changes in quick succession add up in one ring. */
export function useRingPop() {
  const [pop, setPop] = useState<RingPop | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const pulse = useCallback((before: Minutes, after: Minutes, over: boolean) => {
    timers.current.forEach(clearTimeout);
    setPop((p) => ({
      shownOld: Math.min(p ? p.shownOld : before, after),
      shownNew: p ? p.shownNew : before,
      to: after,
      delta: (p?.delta ?? 0) + after - before,
      fading: false,
    }));
    const hold = over ? 2500 : 1500;
    const later = (ms: number, change: Partial<RingPop> | null) =>
      setTimeout(() => setPop((p) => p && change && { ...p, ...change }), ms);
    timers.current = [later(30, { shownNew: after }), later(900, { shownOld: after }), later(hold, { fading: true }), later(hold + 300, null)];
  }, []);

  return { pop, pulse };
}

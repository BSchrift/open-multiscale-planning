// Does it fit: the week's time against its open time, pinned under the steps on desktop and in the top bar on phone,
// on every step. Each change shows beside it for a few seconds, "+1h" or "2h freed", which screen readers skip: the
// step that made the change says it. A step can preview a change before it's made, such as what a selection would add.

import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { formatMinutes } from '../../../core/dates';
import type { LocalDate, Minutes } from '../../../core/types';
import { useApp, useQuery } from '../../app/store';
import { loadFit, weekFit } from './model';

const DELTA_MS = 3000;

/** A change a step is about to make: its minutes show as a pale part of the bar, and its words beside it. */
export interface FitPreview {
  minutes: Minutes;
  text: string;
}

interface FitHooks {
  preview(p: FitPreview | null): void;
  /** What the phone's fit line opens on this step, if anything. */
  show(open: (() => void) | null): void;
}

export const FitContext = createContext<FitHooks>({ preview: () => {}, show: () => {} });

/** For a step: shows its preview while it has one, and gives the phone's fit line something to open. */
export function useFit(preview: FitPreview | null, open?: () => void) {
  const hooks = useContext(FitContext);
  const text = preview ? `${preview.minutes}:${preview.text}` : '';
  useEffect(() => {
    hooks.preview(preview);
    return () => hooks.preview(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);
  const opener = useRef(open);
  opener.current = open;
  useEffect(() => {
    if (!opener.current) return;
    hooks.show(() => opener.current?.());
    return () => hooks.show(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!open]);
}

const pct = (share: number) => `${(share * 100).toFixed(1)}%`;

export function WeekFit(props: { week: LocalDate; phone: boolean; preview: FitPreview | null; onShow: (() => void) | null }) {
  const { clock } = useApp();
  const data = useQuery((sql) => loadFit(sql, clock, props.week), [props.week]).data;
  const fit = useMemo(() => data && weekFit(data, clock), [data, clock]);
  const used = fit?.use.used;
  // The last change, until it's had its few seconds.
  const [delta, setDelta] = useState<Minutes | null>(null);
  const before = useRef<Minutes | undefined>(undefined);
  useEffect(() => {
    if (used === undefined) return;
    if (before.current !== undefined && used !== before.current) setDelta(used - before.current);
    before.current = used;
  }, [used]);
  useEffect(() => {
    if (delta === null) return;
    const timer = setTimeout(() => setDelta(null), DELTA_MS);
    return () => clearTimeout(timer);
  }, [delta]);
  if (!fit || used === undefined) return null;

  const { open } = fit;
  const free = open - used;
  const over = free < 0;
  const left = over ? `${formatMinutes(-free)} over` : `${formatMinutes(free)} free`;
  const { preview } = props;
  // Just added shows pale at the end of the bar, just freed as an outline after it, and a preview pale after it.
  const added = preview ? 0 : Math.max(0, delta ?? 0);
  const freed = preview ? 0 : Math.max(0, -(delta ?? 0));
  const extra = preview?.minutes ?? added;
  const fill = used - added;
  const scale = Math.max(fill + extra + freed, open, 1);
  const note = preview?.text ?? (delta ? (delta > 0 ? `+${formatMinutes(delta)}` : `${formatMinutes(-delta)} freed`) : null);
  const words = `${formatMinutes(used)} of ${formatMinutes(open)}`;
  const body = (
    <>
      <span className="strong fitname">Does it fit?</span>
      <span className="mmeter" aria-hidden="true">
        <span className={`mfill${over ? '' : ' calm'}`} style={{ width: pct(fill / scale) }} />
        {extra > 0 && <span className="mnew" style={{ left: pct(fill / scale), width: pct(extra / scale) }} />}
        {freed > 0 && <span className="mgone" style={{ left: pct(fill / scale), width: pct(freed / scale) }} />}
        <span className="mtick" style={{ left: pct(open / scale) }} />
      </span>
      <span className={over ? 'over' : undefined}>
        {words} · {left}
      </span>
      {note && (
        <span key={note} className="fdelta" aria-hidden="true">
          {note}
        </span>
      )}
    </>
  );

  if (props.phone && props.onShow) {
    return (
      <button className="fitline" type="button" aria-label={`Does it fit? ${words}, ${left}. Show This week`} onClick={props.onShow}>
        {body}
        <span className="fend" aria-hidden="true">
          ›
        </span>
      </button>
    );
  }
  return (
    <section className={props.phone ? 'fitline' : 'fitbar'} aria-label="Does it fit?">
      {body}
      {over && !props.phone && <span className="fwhy">What doesn't fit stays on its project or in One offs.</span>}
    </section>
  );
}

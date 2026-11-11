// The minutes someone is active in weekly planning: the flow in front, with a tap, key or scroll in the last 5 minutes.
// They're added to the week's plan each time the flow closes, by Save and exit, Finish or leaving the app, so the
// estimate learns how long planning takes. Three minutes of reading still count; a longer gap doesn't.

import { useEffect, useRef } from 'react';
import { nowInstant } from '../../../core/dates';
import { addPlanningMinutes } from '../../../core/planning';
import type { LocalDate } from '../../../core/types';
import { useApp, useMutation } from '../../app/store';

const IDLE_MS = 5 * 60_000;
const MINUTE_MS = 60_000;
const INPUTS = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll'] as const;

export function usePlanningTime(week: LocalDate) {
  const { clock } = useApp();
  const add = useMutation((w, minutes: number, began: string) => addPlanningMinutes(w, week, minutes, began));
  const opened = clock.now();
  const s = useRef({ began: nowInstant(clock), mark: opened, last: opened, active: 0, shown: true });

  /** Counts the time since the last count, up to 5 minutes after the last input, while the flow is in front. */
  const credit = () => {
    const now = clock.now();
    const until = Math.min(now, s.current.last + IDLE_MS);
    if (s.current.shown && until > s.current.mark) s.current.active += until - s.current.mark;
    s.current.mark = now;
  };
  const flush = async () => {
    credit();
    const minutes = Math.round(s.current.active / MINUTE_MS);
    s.current.active = 0;
    await add.run(minutes, s.current.began);
  };
  const latest = useRef(flush);
  latest.current = flush;

  useEffect(() => {
    const input = () => {
      credit();
      s.current.last = clock.now();
    };
    const shown = () => {
      if (document.visibilityState === 'hidden') {
        void latest.current();
        s.current.shown = false;
      } else {
        s.current.shown = true;
        s.current.mark = clock.now();
      }
    };
    for (const name of INPUTS) document.addEventListener(name, input, { capture: true, passive: true });
    document.addEventListener('visibilitychange', shown);
    return () => {
      for (const name of INPUTS) document.removeEventListener(name, input, { capture: true });
      document.removeEventListener('visibilitychange', shown);
      void latest.current();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { flush, began: s.current.began };
}

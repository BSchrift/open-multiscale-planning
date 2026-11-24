// What's new, once on each iPhone: the lines (src/whatsNew.ts) an update brought that this phone hasn't seen, under a
// line saying when Multiscale was updated. It waits until the app is idle on a screen: no flow such as planning, no
// Capture or Process, no prompt or other sheet, nobody typing. Got it, Esc, the backdrop or a swipe down puts it away
// and records the newest line as seen. Shell loads it only on the iPhone, so the web app's first load doesn't carry it.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { formatDate, localDate } from '../../core/dates';
import { newestId, readSeen, unseenEntries, writeSeen } from '../../core/whatsNew';
import type { WhatsNewEntry } from '../../core/whatsNew';
import { WHATS_NEW } from '../../whatsNew';
import { busy } from '../components/blocks/BlockPrompts';
import { Button } from '../components/ds/Button';
import { Sheet } from '../components/Sheet';
import { useNav, useOverlay } from './nav';
import { useApp } from './store';

/** How often it looks again while the app is busy, as a waiting prompt does. */
const CHECK_MS = 250;
/** How long the app is idle before it shows, so the questions a launch asks come first. */
const SETTLE_MS = 1500;
/** A swipe down at least this far, and mostly down, puts it away, as a sideways one changes Week's day. */
const SWIPE_PX = 48;

/** A new install has seen every line, which are for updates. Shell calls it during first-run setup. */
export function markAllSeen(): void {
  writeSeen(newestId(WHATS_NEW));
}

export function WhatsNew() {
  const nav = useNav();
  const overlay = useOverlay();
  const [lines, setLines] = useState<WhatsNewEntry[] | null>(null);
  const [done, setDone] = useState(false);
  const away = !!nav.flow || !!overlay;
  useEffect(() => {
    if (lines || done || away) return;
    let idle = 0;
    const timer = setInterval(() => {
      idle = document.visibilityState === 'visible' && !busy() ? idle + CHECK_MS : 0;
      if (idle < SETTLE_MS) return;
      clearInterval(timer);
      // Read now rather than at launch, once setup has had its chance to record a new install's.
      const unseen = unseenEntries(WHATS_NEW, readSeen());
      if (unseen.length) setLines(unseen);
      else setDone(true);
    }, CHECK_MS);
    return () => clearInterval(timer);
  }, [lines, done, away]);
  if (!lines) return null;
  const close = () => {
    writeSeen(newestId(WHATS_NEW));
    setLines(null);
    setDone(true);
  };
  return <WhatsNewSheet lines={lines} onClose={close} />;
}

function WhatsNewSheet(props: { lines: readonly WhatsNewEntry[]; onClose(): void }) {
  const { build, clock } = useApp();
  const heading = useRef<HTMLHeadingElement>(null);
  const close = useRef(props.onClose);
  close.current = props.onClose;
  // What's behind is inert while it's open, as VoiceOver doesn't reliably keep to aria-modal. Before the sheet's own
  // focus handling gives focus back on close, which it can't to an inert element.
  useLayoutEffect(() => {
    const behind = Array.from(document.querySelectorAll<HTMLElement>('[data-layout] > .mainarea, [data-layout] > .tabs, [data-layout] > .fab'));
    for (const element of behind) element.setAttribute('inert', '');
    return () => {
      for (const element of behind) element.removeAttribute('inert');
    };
  }, []);
  // Opened at launch, it has nothing to give focus back to, so focus goes to the page it was over.
  useEffect(
    () => () =>
      queueMicrotask(() => {
        if (!document.activeElement || document.activeElement === document.body) document.querySelector<HTMLElement>('.pane[aria-hidden="false"]')?.focus({ preventScroll: true });
      }),
    [],
  );
  // A swipe down from the top of the sheet puts it away, as people expect of a sheet on iPhone.
  useEffect(() => {
    const sheet = heading.current?.closest<HTMLElement>('[role="dialog"]');
    if (!sheet) return;
    let from: { x: number; y: number } | null = null;
    const start = (event: TouchEvent) => {
      const touch = event.touches[0];
      from = event.touches.length === 1 && touch && sheet.scrollTop === 0 ? { x: touch.clientX, y: touch.clientY } : null;
    };
    const end = (event: TouchEvent) => {
      const touch = event.changedTouches[0];
      if (!from || !touch) return;
      const dx = touch.clientX - from.x;
      const dy = touch.clientY - from.y;
      if (dy >= SWIPE_PX && dy > 2 * Math.abs(dx)) close.current();
    };
    sheet.addEventListener('touchstart', start, { passive: true });
    sheet.addEventListener('touchend', end);
    return () => {
      sheet.removeEventListener('touchstart', start);
      sheet.removeEventListener('touchend', end);
    };
  }, []);
  // The day this update was built, which is the day it was released: never a version.
  const date = build ? formatDate(localDate(build * 1000, clock.zone())) : null;
  return (
    <Sheet label="What's new" onClose={props.onClose}>
      <h2 ref={heading}>What's new</h2>
      {date && <p className="quiet">Multiscale was updated on {date}.</p>}
      <ul className="whatsnew">
        {props.lines.map((line) => (
          <li key={line.id}>{line.text}</li>
        ))}
      </ul>
      <Button variant="primary" type="button" onClick={props.onClose}>
        Got it
      </Button>
    </Sheet>
  );
}

// Keeps the iPhone's widgets in step with the plan, applies what their buttons queued, and opens the screens their links
// name. Mounted once, in the Shell, beside the reminders, so the two never disagree: the snapshot is rewritten a second
// after any change to the records (a sync's included), when the app comes to the front or goes to the background, at
// midnight while it's open, and when iOS wakes it to refresh the widgets. Queued actions apply when the app opens or
// comes back, after a sync, so each is checked against the newest plan (core/widgetActions.ts).

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { AppLink } from '../../core/appLinks';
import { addDays, dayRange, instantMs, today } from '../../core/dates';
import { applyPlanChange } from '../../core/plan';
import type { PlanChange } from '../../core/plan';
import { applyWidgetAction, parseWidgetAction, recentStarts, recordOutcome } from '../../core/widgetActions';
import type { AppliedWidgetAction, WidgetAction, WidgetActionOutcome } from '../../core/widgetActions';
import { buildWidgetSnapshot, loadWidgetData } from '../../core/widgetSnapshot';
import type { WidgetData } from '../../core/widgetSnapshot';
import { useToast } from '../components/Toast';
import { useNav } from './nav';
import { useApp, useMutation, useQuery } from './store';

/** As long as a change waits before the snapshot is rewritten, so a burst of edits writes once. */
export const WIDGET_WRITE_DELAY_MS = 1000;
/** How long applying waits for a sync first, as a reminder's answer does. */
const SYNC_WAIT_MS = 2000;

// What this device applied from the widget in the last day: kept on this device only, like snoozes. At worst, with
// storage blocked, a file seen twice says it couldn't apply, and the widget stops offering Undo sooner.
const HISTORY_KEY = 'multiscale.widgetActions';
let historyCache: AppliedWidgetAction[] = [];
let historyUnsaved = false;

export function readWidgetHistory(): AppliedWidgetAction[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (raw) historyCache = JSON.parse(raw) as AppliedWidgetAction[];
    // Nothing kept: none applied yet, or storage cleared, unless this session's last save didn't go through.
    else if (!historyUnsaved) historyCache = [];
  } catch {
    // Unreadable or blocked: this session's copy stands.
  }
  return historyCache;
}

function writeWidgetHistory(history: AppliedWidgetAction[]): void {
  historyCache = history;
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    historyUnsaved = false;
  } catch {
    // Kept for this session in the cache.
    historyUnsaved = true;
  }
}

// A widget's link to a block on Today asks Today to bring it into view, as a notification asks for a prompt.
let blockRequest: string | null = null;
const blockListeners = new Set<() => void>();

export function requestShowBlock(blockId: string | null): void {
  blockRequest = blockId;
  for (const notify of blockListeners) notify();
}

/** The block a widget asked Today to show, if any. Clear it with requestShowBlock(null) once shown. */
export function useShowBlockRequest(): string | null {
  return useSyncExternalStore(
    (notify) => {
      blockListeners.add(notify);
      return () => void blockListeners.delete(notify);
    },
    () => blockRequest,
  );
}

/** What the toast says about one batch: what applied, then what didn't and why. */
function batchMessage(outcomes: readonly WidgetActionOutcome[]): string {
  const said = outcomes.flatMap((o) => (o.kind === 'duplicate' ? [] : [o.message]));
  return said.join(' ');
}

export function WidgetSync(): null {
  const { platform, clock, db, sync } = useApp();
  const widgets = platform.widgets;
  const nav = useNav();
  const toast = useToast();
  const [wake, setWake] = useState(0);
  useEffect(() => platform.lifecycle.onForeground(() => setWake((n) => n + 1)), [platform]);

  // Midnight while the app is open: a new today, and tomorrow's blocks come into the snapshot.
  useEffect(() => {
    const midnight = instantMs(dayRange(addDays(today(clock), 1), clock.zone()).from_utc);
    const timer = setTimeout(() => setWake((n) => n + 1), Math.max(0, midnight - clock.now()) + 1000);
    return () => clearTimeout(timer);
  }, [clock, wake]);

  const { data } = useQuery((sql, c) => (widgets ? loadWidgetData(sql, c) : Promise.resolve(null)), [widgets, wake]);

  // One write at a time and in order, so an older snapshot never lands after a newer one.
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const write = useCallback(
    (fresh?: WidgetData | null) => {
      if (!widgets) return chain.current;
      chain.current = chain.current
        .then(async () => {
          const source = fresh ?? (await loadWidgetData(db, clock));
          const snapshot = buildWidgetSnapshot(source, { clock, fromWidget: recentStarts(readWidgetHistory(), clock.now()) });
          await widgets.write(JSON.stringify(snapshot));
        })
        .catch((error: unknown) => console.error('Writing the widget snapshot failed', error));
      return chain.current;
    },
    [widgets, db, clock],
  );

  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (!data) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = undefined;
      void write(data);
    }, WIDGET_WRITE_DELAY_MS);
  }, [data, write]);
  // Leaving, it writes at once with whatever changed since, as iOS may suspend the app before the delay is up.
  useEffect(
    () =>
      platform.lifecycle.onBackground(() => {
        clearTimeout(timer.current);
        timer.current = undefined;
        void write();
      }),
    [platform, write],
  );
  useEffect(() => () => clearTimeout(timer.current), []);

  useEffect(
    () =>
      widgets?.onRefresh(async () => {
        await sync?.syncNow();
        await write();
      }),
    [widgets, sync, write],
  );

  const apply = useMutation(async (w, actions: readonly WidgetAction[]) => {
    let history = readWidgetHistory();
    const outcomes: WidgetActionOutcome[] = [];
    for (const action of actions) {
      const outcome = await applyWidgetAction(w, action, history, clock.zone());
      history = recordOutcome(history, outcome, clock.now());
      outcomes.push(outcome);
    }
    return { outcomes, history };
  });
  const undo = useMutation(async (w, reverses: readonly PlanChange[]) => {
    for (const reverse of [...reverses].reverse()) await applyPlanChange(w, reverse);
  });

  const applying = useRef<Promise<void>>(Promise.resolve());
  const applyQueue = useCallback(() => {
    if (!widgets) return;
    applying.current = applying.current.then(async () => {
      const items = await widgets.actions().catch(() => []);
      if (items.length === 0) return;
      // What other devices changed, if it comes quickly, so each action is checked against it.
      await Promise.race([sync?.syncNow(), new Promise((resolve) => setTimeout(resolve, SYNC_WAIT_MS))]);
      const actions = items.flatMap(({ id, text }) => parseWidgetAction(id, text) ?? []).sort((a, b) => a.id.localeCompare(b.id));
      const result = actions.length ? await apply.run(actions) : { outcomes: [], history: readWidgetHistory() };
      // A failed save keeps the files, to try again at the next open. One unreadable is dropped, as nothing could read it.
      if (!result) return;
      writeWidgetHistory(result.history);
      await widgets.remove(items.map((i) => i.id));
      const reverses = result.outcomes.flatMap((o) => (o.kind === 'applied' ? [o.applied.reverse] : []));
      const message = batchMessage(result.outcomes);
      if (message) {
        // Made out of sight, from the widget, so it stays until the next tap rather than going while unread.
        toast.show(message, {
          stay: true,
          ...(reverses.length
            ? {
                undo: async () => {
                  const ids = new Set(result.outcomes.flatMap((o) => (o.kind === 'applied' ? [o.action.id] : [])));
                  writeWidgetHistory(readWidgetHistory().map((h) => (ids.has(h.id) ? { ...h, undone: true as const } : h)));
                  await undo.run(reverses);
                },
              }
            : {}),
        });
      }
      // The widget shows the plan as it now is, without waiting out the delay.
      clearTimeout(timer.current);
      timer.current = undefined;
      await write();
    });
  }, [widgets, sync, apply, undo, toast, write]);
  const latestApply = useRef(applyQueue);
  latestApply.current = applyQueue;
  useEffect(() => {
    void latestApply.current();
    return platform.lifecycle.onForeground(() => void latestApply.current());
  }, [platform]);

  const open = useCallback(
    (link: AppLink) => {
      nav.closeOverlay();
      // Plan your week, as Today's own button opens it.
      if (link.screen === 'plan') return nav.openFlow('planning');
      nav.selectTab(link.screen);
      if (link.screen === 'today' && link.block) requestShowBlock(link.block);
    },
    [nav],
  );
  const latestOpen = useRef(open);
  latestOpen.current = open;
  useEffect(() => platform.onAppLink?.((link) => latestOpen.current(link)), [platform]);

  return null;
}

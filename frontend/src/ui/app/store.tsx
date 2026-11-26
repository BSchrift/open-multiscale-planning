// How screens get data. There's no state library: everything lives in SQLite, and hooks re-read it when it changes.
//
//   const { data } = useQuery((sql) => inboxTasks(sql), []);
//   const capture = useMutation(async (w, title: string) => w.create('task', { kind: 'inbox', title }));
//
// useQuery re-runs on every database change, whether from this screen, another window or a sync. Pass everything
// the query depends on in deps. useMutation groups one user action into one transaction and surfaces failures.
// Read "now" with useNow or useToday rather than Date, so tests can fix it. State that isn't data, such as which
// row is open, stays in useState; useStickyState keeps it across restarts on this device only.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { DependencyList, ReactNode } from 'react';
import type { Clock } from '../../core/clock';
import { today as todayOf } from '../../core/dates';
import type { Db, DbChange, Row, Sql } from '../../core/db';
import { perf } from '../../core/perf';
import { transact } from '../../core/records';
import type { Writer } from '../../core/records';
import type { AppSync } from '../../core/syncRunner';
import type { LocalDate } from '../../core/types';
import type { Updater } from '../../core/updates';
import type { Platform } from '../../platform/types';
import { useToast } from '../components/Toast';
import type { Layout } from './registry';

export interface App {
  platform: Platform;
  db: Db;
  clock: Clock;
  layout: Layout;
  /** Sign-in and sync; absent in tests that don't provide it. Read status with useQuery(syncStatus, []). */
  sync?: AppSync;
  /** Over-the-air updates; only in the apps, for an environment that publishes them. */
  updates?: Updater;
  /** When the running bundle was built: its commit's time in seconds. What's new dates an update by it. */
  build?: number;
}

const AppContext = createContext<App | null>(null);

export function useApp(): App {
  const app = useContext(AppContext);
  if (!app) throw new Error('useApp needs an AppProvider');
  return app;
}

const PHONE_QUERY = '(max-width: 640px)';

/** The phone layout on iPhone, and the desktop layout in Electron however narrow the window is. */
function useLayout(platform: Platform, forced?: Layout): Layout {
  const narrow = useSyncExternalStore(
    (notify) => {
      const media = window.matchMedia?.(PHONE_QUERY);
      media?.addEventListener('change', notify);
      return () => media?.removeEventListener('change', notify);
    },
    () => window.matchMedia?.(PHONE_QUERY).matches ?? false,
  );
  if (forced) return forced;
  if (platform.kind === 'ios') return 'phone';
  if (platform.kind === 'electron') return 'desktop';
  return narrow ? 'phone' : 'desktop';
}

export function AppProvider(props: { platform: Platform; clock: Clock; layout?: Layout; sync?: AppSync; updates?: Updater; build?: number; children: ReactNode }) {
  const { platform, clock, sync, updates, build, children } = props;
  const layout = useLayout(platform, props.layout);
  const app = useMemo(() => ({ platform, db: platform.db, clock, layout, sync, updates, build }), [platform, clock, layout, sync, updates, build]);
  return <AppContext.Provider value={app}>{children}</AppContext.Provider>;
}

interface QueryResult<T> {
  /** The latest rows. While deps change, this stays on the previous rows until the new ones arrive. */
  data: T | undefined;
  error: unknown;
}

/** A database row is a plain object, or one with no prototype, as some drivers return. */
const plain = (o: object) => [Object.prototype, null].includes(Object.getPrototypeOf(o));

/**
 * Whether two query results hold the same data: plain objects, arrays and primitives, compared all the way down.
 * Anything else, such as a Map, is the same only as the same object.
 */
export function sameData(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameData(a[i], b[i])) return false;
    return true;
  }
  if (!plain(a) || !plain(b)) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const key of keys) if (!Object.hasOwn(b, key) || !sameData((a as Row)[key], (b as Row)[key])) return false;
  return true;
}

function queryStore<T>(run: () => Promise<T>, db: Db, seed: T | undefined) {
  let snapshot: QueryResult<T> = { data: seed, error: undefined };
  let generation = 0;
  let subscribers = 0;
  let stale = true;
  let reading = false;
  let again = false;
  // Set by a sync's changes until a read shows them, which ends sync.pull (core/syncRunner.ts) if one is timing.
  let remote = false;
  const notifiers = new Set<() => void>();
  const publish = (next: QueryResult<T>) => {
    snapshot = next;
    for (const notify of notifiers) notify();
  };
  // A read that finds what the last one did keeps it, and draws nothing. Every change reads every query on every
  // screen still mounted, so publishing each would draw them all again for one change, which on a long history took
  // the slowed-down browser seconds for each (e2e/stack/history-journey.spec.ts).
  //
  // One read at a time, and changes made while it runs share the next one. A read is many statements, which on the web
  // app's database, in a worker (platform/web.ts), each wait their turn, so a read for every change in a burst would
  // queue behind the others and leave the screen seconds behind. A read a change landed in may mix before and after,
  // so only the next one is shown.
  const refresh = (change?: DbChange) => {
    if (change?.source === 'remote') remote = true;
    stale = false;
    if (reading) {
      again = true;
      return;
    }
    reading = true;
    again = false;
    const mine = generation;
    const current = () => mine === generation && !again;
    // A query that throws before its first await still ends its read, as a rejection.
    new Promise<T>((resolve) => resolve(run()))
      .then(
        (data) => {
          if (!current()) return;
          if (snapshot.error !== undefined || !sameData(snapshot.data, data)) publish({ data, error: undefined });
          if (remote) perf.stopAfterPaint('sync.pull');
          remote = false;
        },
        (error: unknown) => {
          console.error('Query failed', error);
          if (current()) publish({ data: snapshot.data, error });
        },
      )
      .finally(() => {
        reading = false;
        if (again) refresh();
      });
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(notify: () => void) {
      notifiers.add(notify);
      subscribers++;
      const unsubscribe = db.subscribe(refresh);
      if (stale) refresh();
      return () => {
        unsubscribe();
        notifiers.delete(notify);
        subscribers--;
        if (subscribers === 0) {
          stale = true;
          again = false;
          generation++;
        }
      };
    },
  };
}

export function useQuery<T>(query: (sql: Sql, clock: Clock) => Promise<T>, deps: DependencyList): QueryResult<T> {
  const { db, clock } = useApp();
  const latest = useRef(query);
  latest.current = query;
  const previous = useRef<T | undefined>(undefined);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const store = useMemo(() => queryStore(() => latest.current(db, clock), db, previous.current), [db, clock, ...deps]);
  const result = useSyncExternalStore(store.subscribe, store.getSnapshot);
  previous.current = result.data;
  return result;
}

interface Mutation<A extends unknown[], R> {
  /** Resolves to the result, or undefined after telling the user it failed. It never rejects. */
  run(...args: A): Promise<R | undefined>;
  pending: boolean;
}

/** One user action as one transaction. A failure shows a toast, so nothing is lost silently. */
export function useMutation<A extends unknown[], R>(action: (w: Writer, ...args: A) => Promise<R>): Mutation<A, R> {
  const { db, clock } = useApp();
  const toast = useToast();
  const latest = useRef(action);
  latest.current = action;
  const [pending, setPending] = useState(false);
  const run = useCallback(
    async (...args: A) => {
      setPending(true);
      try {
        const result = await transact(db, clock, (w) => latest.current(w, ...args));
        setPending(false);
        return result;
      } catch (error) {
        console.error('Save failed', error);
        setPending(false);
        toast.show("Couldn't save that. Try again.");
        return undefined;
      }
    },
    [db, clock, toast],
  );
  return { run, pending };
}

/** The clock's time in epoch ms, updating on an interval. */
export function useNow(intervalMs = 1000): number {
  const { clock } = useApp();
  const [now, setNow] = useState(() => clock.now());
  useEffect(() => {
    setNow(clock.now());
    const timer = setInterval(() => setNow(clock.now()), intervalMs);
    return () => clearInterval(timer);
  }, [clock, intervalMs]);
  return now;
}

/** Today's local date, changing when the day does. */
export function useToday(): LocalDate {
  const { clock } = useApp();
  useNow(30_000);
  return todayOf(clock);
}

// Every screen using a key hears a change at once: screens stay mounted, so two can show one value.
const stickyListeners = new Map<string, Set<(value: unknown) => void>>();

/** useState kept on this device across restarts, for things like the current planning step. Never synced. */
export function useStickyState<T>(key: string, initial: T): [T, (next: T) => void] {
  const storageKey = `multiscale.${key}`;
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = localStorage.getItem(storageKey);
      return stored === null ? initial : (JSON.parse(stored) as T);
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    const listeners = stickyListeners.get(storageKey) ?? new Set();
    stickyListeners.set(storageKey, listeners);
    const listener = (next: unknown) => setValue(next as T);
    listeners.add(listener);
    return () => void listeners.delete(listener);
  }, [storageKey]);
  const update = useCallback(
    (next: T) => {
      // Its own state first: a child's mount effect can set it before this screen's listener is registered.
      setValue(next);
      for (const listener of stickyListeners.get(storageKey) ?? []) listener(next);
      try {
        localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        // Storage can be blocked; the value still holds for this session.
      }
    },
    [storageKey],
  );
  return [value, update];
}

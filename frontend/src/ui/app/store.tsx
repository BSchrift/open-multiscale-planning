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
import type { Db, Sql } from '../../core/db';
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
}

const AppContext = createContext<App | null>(null);

export function useApp(): App {
  const app = useContext(AppContext);
  if (!app) throw new Error('useApp needs an AppProvider');
  return app;
}

const PHONE_QUERY = '(max-width: 640px)';

/** The phone layout on iPhone, and the desktop layout in Electron however narrow the window is. */
export function useLayout(platform: Platform, forced?: Layout): Layout {
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

export function AppProvider(props: { platform: Platform; clock: Clock; layout?: Layout; sync?: AppSync; updates?: Updater; children: ReactNode }) {
  const { platform, clock, sync, updates, children } = props;
  const layout = useLayout(platform, props.layout);
  const app = useMemo(() => ({ platform, db: platform.db, clock, layout, sync, updates }), [platform, clock, layout, sync, updates]);
  return <AppContext.Provider value={app}>{children}</AppContext.Provider>;
}

export interface QueryResult<T> {
  /** The latest rows. While deps change, this stays on the previous rows until the new ones arrive. */
  data: T | undefined;
  error: unknown;
  loading: boolean;
}

function queryStore<T>(run: () => Promise<T>, db: Db, seed: T | undefined) {
  let snapshot: QueryResult<T> = { data: seed, error: undefined, loading: true };
  let generation = 0;
  let subscribers = 0;
  let stale = true;
  const notifiers = new Set<() => void>();
  const publish = (next: QueryResult<T>) => {
    snapshot = next;
    for (const notify of notifiers) notify();
  };
  const refresh = () => {
    const mine = ++generation;
    stale = false;
    run().then(
      (data) => {
        if (mine === generation) publish({ data, error: undefined, loading: false });
      },
      (error: unknown) => {
        console.error('Query failed', error);
        if (mine === generation) publish({ data: snapshot.data, error, loading: false });
      },
    );
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

export interface Mutation<A extends unknown[], R> {
  /** Resolves to the result, or undefined after telling the user it failed. It never rejects. */
  run(...args: A): Promise<R | undefined>;
  pending: boolean;
  error: unknown;
}

/** One user action as one transaction. A failure shows a toast, so nothing is lost silently. */
export function useMutation<A extends unknown[], R>(action: (w: Writer, ...args: A) => Promise<R>): Mutation<A, R> {
  const { db, clock } = useApp();
  const toast = useToast();
  const latest = useRef(action);
  latest.current = action;
  const [state, setState] = useState<{ pending: boolean; error: unknown }>({ pending: false, error: undefined });
  const run = useCallback(
    async (...args: A) => {
      setState({ pending: true, error: undefined });
      try {
        const result = await transact(db, clock, (w) => latest.current(w, ...args));
        setState({ pending: false, error: undefined });
        return result;
      } catch (error) {
        console.error('Save failed', error);
        setState({ pending: false, error });
        toast.show("Couldn't save that. Try again.");
        return undefined;
      }
    },
    [db, clock, toast],
  );
  return { run, ...state };
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

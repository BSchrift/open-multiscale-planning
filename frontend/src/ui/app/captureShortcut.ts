// The desktop's capture shortcut, read once from the platform and shared, so the Capture button follows a change made
// in Settings.

import { useEffect, useSyncExternalStore } from 'react';
import type { CaptureShortcut } from '../../platform/types';
import { useApp } from './store';

type Shortcut = { accelerator: string; registered: boolean };

interface Store {
  value: Shortcut | null;
  listeners: Set<() => void>;
  loaded?: Promise<void>;
}

// Per platform, so each test's platform starts afresh.
const stores = new WeakMap<CaptureShortcut, Store>();
const NONE: Store = { value: null, listeners: new Set() };

function storeOf(native: CaptureShortcut | undefined): Store {
  if (!native) return NONE;
  let store = stores.get(native);
  if (!store) stores.set(native, (store = { value: null, listeners: new Set() }));
  return store;
}

const put = (store: Store, value: Shortcut) => {
  store.value = value;
  store.listeners.forEach((l) => l());
};

/** Null where there's no global shortcut, and until it's read. change resolves false when another app holds the keys. */
export function useCaptureShortcut() {
  const native = useApp().platform.captureShortcut;
  const store = storeOf(native);
  const shortcut = useSyncExternalStore(
    (l) => (store.listeners.add(l), () => void store.listeners.delete(l)),
    () => store.value,
  );
  useEffect(() => {
    if (native) store.loaded ??= native.get().then((v) => put(store, v));
  }, [native, store]);
  const change = async (accelerator: string) => {
    const ok = !!native && (await native.set(accelerator));
    if (ok) put(store, { accelerator, registered: true });
    return ok;
  };
  return { shortcut, change };
}

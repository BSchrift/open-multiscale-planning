// The iPhone app: Capacitor plugins behind the Platform interface.

import { KeychainAccess, SecureStorage } from '@aparajita/capacitor-secure-storage';
import { CapacitorSQLite, SQLiteConnection } from '@capacitor-community/sqlite';
import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { registerPlugin } from '@capacitor/core';
import type { PluginListenerHandle } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import type { ActionPerformed, ActionType } from '@capacitor/local-notifications';
import type { AppEnv } from '../core/appConfig';
import { openDb } from '../core/db';
import type { SqlDriver } from '../core/db';
import type { DiagnosticsSnapshot } from '../core/telemetry';
import type { Reminder, ReminderAction } from '../core/types';
import type { Appearance, Notifications, Platform, ReminderResponse, SecureTokens } from './types';

const CAPTURE_LINK = 'multiscale://capture';

/** Implemented in the app target. Reads the App Group folder the share extension writes to. */
const ShareQueue = registerPlugin<{
  status(): Promise<{ enabled: boolean }>;
  peek(): Promise<{ items: { id: string; text: string }[] }>;
  remove(options: { ids: string[] }): Promise<void>;
}>('MultiscaleShareQueue');

/** Implemented in the app target. Sets the window's light or dark, which the status bar and keyboard follow. */
const NativeAppearance = registerPlugin<{ set(options: { appearance: Appearance }): Promise<void> }>('MultiscaleAppearance');
const NativeDiagnostics = registerPlugin<{
  snapshot(): Promise<DiagnosticsSnapshot>;
  addListener(event: 'memoryWarning', listener: () => void): Promise<PluginListenerHandle>;
}>('MultiscaleDiagnostics');
/** Implemented in the app target. Checks and installs a downloaded web bundle, and picks when to switch to it. */
const NativeUpdates = registerPlugin<{
  install(options: { manifest: string; signature: string; files: Record<string, string> }): Promise<void>;
  staged(): Promise<{ build: number | null }>;
  apply(): Promise<void>;
  ready(): Promise<void>;
}>('MultiscaleUpdates');

/** The bridge carries JSON, so bytes cross it as base64. In slices, since one call can only take so many arguments. */
function base64(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

/** Events can arrive before React mounts, on a cold launch from a link or a notification. They wait for a listener. */
function channel<T>() {
  const listeners = new Set<(value: T) => void>();
  const waiting: T[] = [];
  return {
    emit(value: T) {
      if (listeners.size === 0) waiting.push(value);
      for (const listener of [...listeners]) listener(value);
    },
    on(listener: (value: T) => void) {
      listeners.add(listener);
      for (const value of waiting.splice(0)) listener(value);
      return () => void listeners.delete(listener);
    },
  };
}

export async function capacitorSqlDriver(name: string): Promise<SqlDriver> {
  const sqlite = new SQLiteConnection(CapacitorSQLite);
  // The native connection outlives the page, so a web view reload finds it still there.
  const live = (await sqlite.checkConnectionsConsistency()).result && (await sqlite.isConnection(name, false)).result;
  const connection = live
    ? await sqlite.retrieveConnection(name, false)
    : await sqlite.createConnection(name, false, 'no-encryption', 1, false);
  if (!(await connection.isDBOpen()).result) await connection.open();
  return {
    exec: async (sql) => void (await connection.execute(sql, false)),
    all: async (sql, values) => ((await connection.query(sql, values)).values ?? []) as Record<string, unknown>[],
    run: async (sql, values) => void (await connection.run(sql, values, false)),
    close: () => sqlite.closeConnection(name, false),
  };
}

/** The plugin wants a 32-bit integer id; ours are strings. FNV-1a, stable across launches so cancelling finds it. */
function nativeId(reminderId: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < reminderId.length; i++) hash = Math.imul(hash ^ reminderId.charCodeAt(i), 0x01000193);
  return hash & 0x7fffffff;
}

const actionTypeId = (actions: readonly ReminderAction[]) => `reminder-${nativeId(JSON.stringify(actions))}`;

function capacitorNotifications(): Notifications {
  const responses = channel<ReminderResponse>();
  void LocalNotifications.addListener('localNotificationActionPerformed', ({ actionId, notification }: ActionPerformed) => {
    const reminder = (notification.extra as { reminder?: Reminder } | null)?.reminder;
    if (!reminder || actionId === 'dismiss') return;
    responses.emit({ reminder_id: reminder.id, block_id: reminder.block_id, action_id: actionId === 'tap' ? null : actionId });
  });

  return {
    requestPermission: async () => (await LocalNotifications.requestPermissions()).display === 'granted',
    async replaceAll(reminders) {
      // Scheduling asks for permission by itself when undecided, and the first run decides when that happens.
      if ((await LocalNotifications.checkPermissions()).display !== 'granted') return;
      const { notifications: pending } = await LocalNotifications.getPending();
      if (pending.length > 0) await LocalNotifications.cancel({ notifications: pending.map(({ id }) => ({ id })) });

      const types = new Map<string, ActionType>();
      for (const { actions } of reminders) {
        types.set(actionTypeId(actions), {
          id: actionTypeId(actions),
          actions: actions.map(({ id, title, opens_app }) => ({ id, title, foreground: opens_app ?? false })),
        });
      }
      await LocalNotifications.registerActionTypes({ types: [...types.values()] });

      // One past date makes iOS reject the whole batch, and time passes between planning and getting here.
      const due = reminders.filter((r) => Date.parse(r.at) > Date.now());
      if (due.length === 0) return;
      await LocalNotifications.schedule({
        notifications: due.map((reminder) => ({
          id: nativeId(reminder.id),
          title: reminder.title,
          body: reminder.body ?? '',
          actionTypeId: actionTypeId(reminder.actions),
          schedule: { at: new Date(reminder.at) },
          extra: { reminder },
        })),
      });
    },
    async cancel(ids) {
      const native = ids.map(nativeId);
      await LocalNotifications.cancel({ notifications: native.map((id) => ({ id })) });
      await LocalNotifications.removeDeliveredNotificationsById({ ids: native });
    },
    scheduled: async () => (await LocalNotifications.getPending()).notifications.flatMap((n) => (n.extra as { reminder?: Reminder } | null)?.reminder ?? []),
    onResponse: responses.on,
  };
}

async function keychainTokens(): Promise<SecureTokens> {
  // After first unlock, so a notification action on a locked phone can still sync. This device only, so tokens
  // never travel in a backup.
  await SecureStorage.setDefaultKeychainAccess(KeychainAccess.afterFirstUnlockThisDeviceOnly);
  return {
    get: (key) => SecureStorage.getItem(key),
    set: (key, value) => SecureStorage.setItem(key, value),
    remove: (key) => SecureStorage.removeItem(key),
  };
}

/** env names the database: builds for each environment share one bundle id, so they must not share a file. */
export async function createCapacitorPlatform(env: AppEnv = 'prod'): Promise<Platform> {
  const links = channel<string>();
  const captures = channel<void>();
  void App.addListener('appUrlOpen', ({ url }) => {
    // The sign-in page sits in a browser sheet over the app, and has done its job once it links back.
    void Browser.close().catch(() => undefined);
    if (url === CAPTURE_LINK) captures.emit();
    else links.emit(url);
  });

  const foreground = channel<void>();
  const background = channel<void>();
  void App.addListener('resume', () => foreground.emit());
  void App.addListener('pause', () => background.emit());

  const { enabled: shareEnabled } = await ShareQueue.status();

  return {
    kind: 'ios',
    db: await openDb(await capacitorSqlDriver(env === 'prod' ? 'multiscale' : `multiscale-${env}`)),
    notifications: capacitorNotifications(),
    tokens: await keychainTokens(),
    lifecycle: { onForeground: foreground.on, onBackground: background.on },
    openExternal: (url) => Browser.open({ url }),
    signInRedirectUri: 'multiscale://auth/callback',
    onDeepLink: links.on,
    setAppearance: (appearance) => NativeAppearance.set({ appearance }),
    diagnostics: {
      snapshot: () => NativeDiagnostics.snapshot(),
      onMemoryWarning: (listener) => {
        const handle = NativeDiagnostics.addListener('memoryWarning', listener);
        return () => void handle.then((h) => h.remove());
      },
    },
    updates: {
      install: ({ manifest, signature, files }) =>
        NativeUpdates.install({ manifest, signature, files: Object.fromEntries(Object.entries(files).map(([path, bytes]) => [path, base64(bytes)])) }),
      staged: async () => (await NativeUpdates.staged()).build,
      apply: () => NativeUpdates.apply(),
      ready: () => void NativeUpdates.ready(),
    },
    // The Control Center widget is this phone's capture shortcut: it opens the capture link.
    hotkey: { onCapture: captures.on },
    ...(shareEnabled
      ? { shareImport: { peek: async () => (await ShareQueue.peek()).items, remove: (ids: string[]) => ShareQueue.remove({ ids }) } }
      : {}),
  };
}

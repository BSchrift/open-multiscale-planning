// What the preload script gives the main window. Everything is a narrow call rather than raw IPC, so a compromised
// page can't reach channels it wasn't given.

import type { Row, SqlValue } from '../src/core/db';
import type { Reminder } from '../src/core/types';
import type { NativeUpdates } from '../src/core/updates';
import type { Appearance, ReminderResponse } from '../src/platform/types';

export interface ElectronBridge {
  signInRedirectUri: string;
  db: {
    exec(sql: string): Promise<void>;
    all(sql: string, values: SqlValue[]): Promise<Row[]>;
    run(sql: string, values: SqlValue[]): Promise<void>;
  };
  notifications: {
    requestPermission(): Promise<boolean>;
    replaceAll(reminders: readonly Reminder[]): Promise<void>;
    cancel(ids: readonly string[]): Promise<void>;
    scheduled(): Promise<Reminder[]>;
    onResponse(listener: (response: ReminderResponse) => void): () => void;
  };
  tokens: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
    remove(key: string): Promise<void>;
  };
  openExternal(url: string): Promise<void>;
  onDeepLink(listener: (url: string) => void): () => void;
  /** The capture window asks for a saved title. Reports back with done, passing the error if it failed. */
  onCapture(listener: (id: string, title: string) => void): () => void;
  captureDone(id: string, error?: string): void;
  /** The page can now take captures and deep links. */
  ready(): void;
  setAppearance(appearance: Appearance): Promise<void>;
  updates: NativeUpdates;
}

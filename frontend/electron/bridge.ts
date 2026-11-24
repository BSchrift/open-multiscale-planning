// What the preload script gives the main window. Everything is a narrow call rather than raw IPC, so a compromised
// page can't reach channels it wasn't given.

import type { Row, SqlValue } from '../src/core/db';
import type { Energy } from '../src/core/telemetry';
import type { Reminder } from '../src/core/types';
import type { NativeUpdates } from '../src/core/updates';
import type { Appearance, CaptureShortcut, NativeMenuItem, ReminderResponse } from '../src/platform/types';

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
  /** The computer woke from sleep or its screen unlocked. Apps from before it lack it. */
  onWake?(listener: () => void): () => void;
  /** The capture window asks for a saved title. Reports back with done, passing the error if it failed. */
  onCapture(listener: (id: string, title: string) => void): () => void;
  captureDone(id: string, error?: string): void;
  /** The page can now take captures and deep links. */
  ready(): void;
  setAppearance(appearance: Appearance): Promise<void>;
  /** A menu macOS draws at the pointer: the chosen item's id, or null. Apps from before it lack it. */
  showMenu?(items: readonly NativeMenuItem[]): Promise<string | null>;
  updates: NativeUpdates;
  captureShortcut: CaptureShortcut;
  /** Each process's CPU and idle wakeups, and the power source, for telemetry. Apps from before it lack it. */
  energy?: Energy;
  /** Set by apps whose content policy lets the page reach attachments' storage. Older apps lack it. */
  attachments?: true;
}

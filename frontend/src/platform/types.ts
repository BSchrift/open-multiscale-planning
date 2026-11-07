// What the app needs from the device. UI code gets a Platform from useApp and never checks which one it's on.
// Each adapter (electron.ts, capacitor.ts, web.ts) implements this, and memory.ts holds the fakes used by the
// browser build and by tests. Core code never imports this: it gets data and a Clock as arguments.

import type { Db } from '../core/db';
import type { Diagnostics } from '../core/telemetry';
import type { Reminder } from '../core/types';
import type { NativeUpdates } from '../core/updates';

export type PlatformKind = 'electron' | 'ios' | 'web' | 'test';

/** Settings > Appearance on this device. System follows the OS. */
export type Appearance = 'system' | 'light' | 'dark';

export interface ReminderResponse {
  reminder_id: string;
  block_id: string;
  /** The action chosen, or null when the notification itself was tapped. */
  action_id: string | null;
}

export interface Notifications {
  /** Asks the OS for permission if needed, and returns whether notifications can show. */
  requestPermission(): Promise<boolean>;
  /** Replaces everything scheduled with this list. */
  replaceAll(reminders: readonly Reminder[]): Promise<void>;
  /** Removes these reminders, including any already showing. */
  cancel(ids: readonly string[]): Promise<void>;
  scheduled(): Promise<Reminder[]>;
  /** Called when the user responds to a notification. Returns an unsubscribe function. */
  onResponse(listener: (response: ReminderResponse) => void): () => void;
}

/** Sign-in tokens, in the OS keychain or its equivalent. Only ever store them here. */
export interface SecureTokens {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface Lifecycle {
  /** The app came back to the front. Returns an unsubscribe function. */
  onForeground(listener: () => void): () => void;
  onBackground(listener: () => void): () => void;
}

export interface CaptureShortcut {
  /** registered is false when another app held it at launch. */
  get(): Promise<{ accelerator: string; registered: boolean }>;
  /** False when another app holds it, and the old one stays. */
  set(accelerator: string): Promise<boolean>;
}

export interface Platform {
  readonly kind: PlatformKind;
  /** The open, migrated database. */
  readonly db: Db;
  readonly notifications: Notifications;
  readonly tokens: SecureTokens;
  readonly lifecycle: Lifecycle;
  /** Opens a URL in the system browser. Sign-in starts here and returns through onDeepLink. */
  openExternal(url: string): Promise<void>;
  /** The URL the identity provider sends the browser back to. */
  readonly signInRedirectUri: string;
  /** A deep link opened the app, such as the sign-in callback. Returns an unsubscribe function. */
  onDeepLink(listener: (url: string) => void): () => void;
  /** Only where a global shortcut exists. */
  readonly hotkey?: {
    /** Calls listener on the global capture shortcut. Returns an unsubscribe function. */
    onCapture(listener: () => void): () => void;
  };
  /** Only where native parts draw around the page: the window and menus on desktop, the status bar on iPhone. */
  setAppearance?(appearance: Appearance): Promise<void>;
  /** Only where native code can measure the app: memory, and memory warnings. */
  readonly diagnostics?: Diagnostics;
  /** Only in the apps, whose native code checks and installs a downloaded web bundle. */
  readonly updates?: NativeUpdates;
  /** Only on desktop: the global shortcut that opens capture, as an Electron accelerator. */
  readonly captureShortcut?: CaptureShortcut;
  /** Only where a share sheet exists. */
  readonly shareImport?: {
    /** Text shared while the app was closed, oldest first. It stays queued until removed. */
    peek(): Promise<{ id: string; text: string }[]>;
    /** Takes items off the queue, once they're saved. */
    remove(ids: string[]): Promise<void>;
  };
}

// What the app needs from the device. UI code gets a Platform from useApp and never checks which one it's on.
// Each adapter (electron.ts, capacitor.ts, web.ts) implements this, and memory.ts holds the fakes used by the
// browser build and by tests. Core code never imports this: it gets data and a Clock as arguments.

import type { AppLink } from '../core/appLinks';
import type { Db } from '../core/db';
import type { Diagnostics, Energy } from '../core/telemetry';
import type { Reminder } from '../core/types';
import type { NativeUpdates } from '../core/updates';

export type PlatformKind = 'electron' | 'ios' | 'web' | 'test';

/** Settings > Appearance on this device. System follows the OS. */
export type Appearance = 'system' | 'light' | 'dark';

/** A choice in a menu the platform draws, or a line between groups of them. A choice holds one level of submenu at most. */
export type NativeMenuItem = { id: string; label: string; submenu?: readonly NativeMenuItem[] } | { type: 'separator' };

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
  /** The page has begun to unload, as when it reloads. Only the browser build tells. */
  onLeave?(listener: () => void): () => void;
}

export interface CaptureShortcut {
  /** registered is false when another app held it at launch. */
  get(): Promise<{ accelerator: string; registered: boolean }>;
  /** False when another app holds it, and the old one stays. */
  set(accelerator: string): Promise<boolean>;
}

/** The iPhone's widgets, through the App Group they share with the app (frontend/ios/App/MultiscaleWidgets). */
export interface Widgets {
  /** Saves the snapshot the widgets draw from, then asks iOS to redraw them. */
  write(json: string): Promise<void>;
  /** The snapshot and any queued actions go, as at an erase. */
  clear(): Promise<void>;
  /** What the widget's buttons queued, oldest first, as files: each stays until removed. */
  actions(): Promise<{ id: string; text: string }[]>;
  remove(ids: string[]): Promise<void>;
  /**
   * iOS woke the app in the background to bring the widgets up to date. The listener syncs and writes the snapshot, and
   * iOS is told it finished when the promise settles. Returns an unsubscribe function.
   */
  onRefresh(listener: () => Promise<void>): () => void;
}

/** Attachments' bytes kept on this device, by attachment id. */
export interface FileStore {
  get(id: string): Promise<Blob | null>;
  put(id: string, file: Blob): Promise<void>;
  remove(id: string): Promise<void>;
  /** Everything, as when another account signs in here. */
  clear(): Promise<void>;
}

export interface Platform {
  readonly kind: PlatformKind;
  /** The open, migrated database. */
  readonly db: Db;
  readonly notifications: Notifications;
  readonly tokens: SecureTokens;
  readonly lifecycle: Lifecycle;
  /** Attachments' bytes kept on this device. */
  readonly files: FileStore;
  /** Set where this app may not reach attachments' storage: a Mac app whose content policy is from before them. */
  readonly filesBlocked?: true;
  /** Opens a URL in the system browser. Sign-in starts here and returns through onDeepLink. */
  openExternal(url: string): Promise<void>;
  /**
   * Only where the page can't download a file itself: the Mac app, whose default browser downloads it, and the iPhone,
   * whose Safari saves it to Files. Elsewhere screens download it (openDownload.ts).
   */
  openDownload?(url: string): Promise<void>;
  /** The URL the identity provider sends the browser back to. */
  readonly signInRedirectUri: string;
  /** A deep link opened the app, such as the sign-in callback. Returns an unsubscribe function. */
  onDeepLink(listener: (url: string) => void): () => void;
  /**
   * Only where widgets link into the app: one of its own links opened it, such as Today at a block. Waits for a listener,
   * so a link that launched the app isn't lost. Returns an unsubscribe function.
   */
  onAppLink?(listener: (link: AppLink) => void): () => void;
  /** Only on desktop: the computer woke from sleep or its screen unlocked. Returns an unsubscribe function. */
  onWake?(listener: () => void): () => void;
  /** Only where a global shortcut exists. */
  readonly hotkey?: {
    /** Calls listener on the global capture shortcut. Returns an unsubscribe function. */
    onCapture(listener: () => void): () => void;
  };
  /** Only where native parts draw around the page: the window and menus on desktop, the status bar on iPhone. */
  setAppearance?(appearance: Appearance): Promise<void>;
  /**
   * One light tap, as a held block lifts: the iPhone's Taptic Engine, or the browser's vibrate where a phone's browser
   * has one. Absent on the Mac, which can't. Never fails.
   */
  haptic?(): Promise<void>;
  /**
   * Only in the Mac app: a menu macOS draws at the pointer, as for a right-click. Resolves to the chosen item's id, or
   * null when it closes without a choice. Missing in a Mac app from before it, where the page draws its own.
   */
  showMenu?(items: readonly NativeMenuItem[]): Promise<string | null>;
  /** Only where native code can measure the app: memory, and memory warnings. */
  readonly diagnostics?: Diagnostics;
  /** Only where native code can read the battery, and on the Mac each process's CPU (docs/performance.md, Battery). */
  readonly energy?: Energy;
  /** Only in the apps, whose native code checks and installs a downloaded web bundle. */
  readonly updates?: NativeUpdates;
  /** Only on desktop: the global shortcut that opens capture, as an Electron accelerator. */
  readonly captureShortcut?: CaptureShortcut;
  /** Only on an iPhone whose build has the App Group the widgets read. */
  readonly widgets?: Widgets;
  /** Only where a share sheet exists. */
  readonly shareImport?: {
    /** Text shared while the app was closed, oldest first. It stays queued until removed. */
    peek(): Promise<{ id: string; text: string }[]>;
    /** Takes items off the queue, once they're saved. */
    remove(ids: string[]): Promise<void>;
  };
}

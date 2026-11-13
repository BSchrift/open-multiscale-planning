// The desktop app's device services. The main process owns SQLite, timers and the keychain, and this page reaches
// them through the preload bridge.

import type { ElectronBridge } from '../../electron/bridge';
import { systemClock } from '../core/clock';
import { openDb } from '../core/db';
import { transact } from '../core/records';
import { indexedDbFiles } from './attachment-files';
import { deepLinks, memoryLifecycle } from './memory';
import type { Platform } from './types';

export async function createElectronPlatform(): Promise<Platform> {
  const bridge = window.multiscaleElectron as ElectronBridge;
  // The connection belongs to the main process and outlives this page.
  const db = await openDb({ ...bridge.db, close: async () => undefined });

  // Every write goes through this page's Db, whose queue keeps the capture window's save from landing inside another
  // transaction on the one connection, and whose change events update the screens.
  bridge.onCapture((id, title) => {
    transact(db, systemClock, (w) => w.create('task', { kind: 'inbox', title })).then(
      () => bridge.captureDone(id),
      (err: unknown) => bridge.captureDone(id, String(err)),
    );
  });

  const links = deepLinks();
  let heldLinks: string[] | null = [];
  bridge.onDeepLink((url) => (heldLinks ? heldLinks.push(url) : links.open(url)));

  const lifecycle = memoryLifecycle();
  window.addEventListener('focus', lifecycle.foreground);
  window.addEventListener('blur', lifecycle.background);

  bridge.ready();

  return {
    kind: 'electron',
    db,
    notifications: bridge.notifications,
    tokens: bridge.tokens,
    lifecycle,
    files: indexedDbFiles,
    // A Mac app from before attachments keeps a content policy that doesn't reach their storage.
    ...(bridge.attachments ? {} : { filesBlocked: true as const }),
    openExternal: bridge.openExternal,
    signInRedirectUri: bridge.signInRedirectUri,
    setAppearance: bridge.setAppearance,
    updates: bridge.updates,
    captureShortcut: bridge.captureShortcut,
    onDeepLink: (listener) => {
      const stop = links.onDeepLink(listener);
      // A link can start the app, and arrive before the first listener does.
      const held = heldLinks ?? [];
      heldLinks = null;
      held.forEach(links.open);
      return stop;
    },
  };
}

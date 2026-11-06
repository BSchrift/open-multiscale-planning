import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ElectronBridge } from '../../electron/bridge';
import { nodeSqliteDriver } from './node-sqlite';
import { createElectronPlatform } from './electron';
import type { Platform } from './types';

interface Fake {
  bridge: ElectronBridge;
  capture(id: string, title: string): void;
  deepLink(url: string): void;
  done: [string, string | undefined][];
  ready: ReturnType<typeof vi.fn>;
}

function fakeBridge(): Fake {
  const driver = nodeSqliteDriver();
  const done: [string, string | undefined][] = [];
  const ready = vi.fn();
  let capture: (id: string, title: string) => void = () => undefined;
  let deepLink: (url: string) => void = () => undefined;
  const notifications = { requestPermission: async () => true, replaceAll: vi.fn(), cancel: vi.fn(), scheduled: async () => [], onResponse: () => () => undefined };
  const bridge: ElectronBridge = {
    signInRedirectUri: 'multiscale-local://auth/callback',
    db: { exec: driver.exec, all: driver.all, run: driver.run },
    notifications,
    tokens: { get: async () => 'stored', set: vi.fn(), remove: vi.fn() },
    openExternal: vi.fn(),
    onDeepLink: (listener) => {
      deepLink = listener;
      return () => undefined;
    },
    onCapture: (listener) => {
      capture = listener;
      return () => undefined;
    },
    captureDone: (id, error) => void done.push([id, error]),
    ready,
    setAppearance: vi.fn(async () => undefined),
    updates: { install: vi.fn(async () => undefined), staged: vi.fn(async () => null), apply: vi.fn(async () => undefined), ready: vi.fn(), rolledBack: vi.fn(async () => null) },
  };
  return { bridge, capture: (id, title) => capture(id, title), deepLink: (url) => deepLink(url), done, ready };
}

describe('the Electron platform', () => {
  let fake: Fake;
  let windowEvents: Record<string, () => void>;
  let platform: Platform;

  beforeEach(async () => {
    fake = fakeBridge();
    windowEvents = {};
    vi.stubGlobal('window', {
      multiscaleElectron: fake.bridge,
      addEventListener: (name: string, listener: () => void) => void (windowEvents[name] = listener),
    });
    platform = await createElectronPlatform();
  });
  afterEach(() => void vi.unstubAllGlobals());

  it('opens the database over the bridge, then says it is ready', async () => {
    expect(platform.kind).toBe('electron');
    expect(platform.signInRedirectUri).toBe('multiscale-local://auth/callback');
    expect(await platform.db.get("SELECT 1 AS ok FROM sqlite_master WHERE name = 'task'")).toEqual({ ok: 1 });
    expect(fake.ready).toHaveBeenCalledOnce();
  });

  it('saves a capture to the Inbox, queued to sync, tells subscribers, and then acknowledges', async () => {
    const changes: string[] = [];
    platform.db.subscribe((c) => changes.push(...c.types));
    fake.capture('c1', 'Paint the fence');
    await vi.waitFor(() => expect(fake.done).toEqual([['c1', undefined]]));
    expect(await platform.db.all("SELECT title FROM task WHERE kind = 'inbox'")).toEqual([{ title: 'Paint the fence' }]);
    expect(await platform.db.all("SELECT field FROM outbox WHERE field = 'title'")).toEqual([{ field: 'title' }]);
    expect(changes).toEqual(['task']);
  });

  it('reports a failed capture instead of acknowledging it', async () => {
    await platform.db.run('DROP VIEW task');
    await platform.db.run('DROP TABLE outbox');
    fake.capture('c2', 'Paint the fence');
    await vi.waitFor(() => expect(fake.done[0]?.[1]).toBeTruthy());
    expect(fake.done[0]![0]).toBe('c2');
  });

  it('holds a deep link until something listens, as on a launch that a sign-in return started', () => {
    fake.deepLink('multiscale-local://auth/callback?code=early');
    const links: string[] = [];
    const stop = platform.onDeepLink((url) => links.push(url));
    expect(links).toEqual(['multiscale-local://auth/callback?code=early']);
    fake.deepLink('multiscale-local://auth/callback?code=later');
    expect(links).toHaveLength(2);
    stop();
    fake.deepLink('multiscale-local://auth/callback?code=gone');
    expect(links).toHaveLength(2);
  });

  it('reports window focus as the app coming to the front', () => {
    const seen: string[] = [];
    platform.lifecycle.onForeground(() => seen.push('fg'));
    platform.lifecycle.onBackground(() => seen.push('bg'));
    windowEvents.focus!();
    windowEvents.blur!();
    expect(seen).toEqual(['fg', 'bg']);
  });

  it('passes the chosen appearance to the main process, for the window and its menus', async () => {
    await platform.setAppearance!('light');
    expect(fake.bridge.setAppearance).toHaveBeenCalledWith('light');
  });

  it('leaves the global shortcut to the capture window, not the page', () => {
    expect(platform.hotkey).toBeUndefined();
  });
});

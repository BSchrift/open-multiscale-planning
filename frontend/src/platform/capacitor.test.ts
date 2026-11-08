import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Reminder } from '../core/types';

// Stands in for the native side. Each test acts as iOS through `fire`.
const native = vi.hoisted(() => {
  const handlers = new Map<string, (data: never) => void>();
  return {
    handlers,
    fire: (event: string, data?: unknown) => handlers.get(event)?.(data as never),
    pending: [] as unknown[],
    sql: [] as { method: string; sql: string; values?: unknown[]; transaction?: boolean }[],
    keychain: new Map<string, string>(),
    connectionExists: false,
    shareEnabled: false,
    shared: [] as { id: string; text: string }[],
    databases: [] as string[],
    appearances: [] as unknown[],
  };
});

vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn(async (event: string, handler: (data: never) => void) => {
      native.handlers.set(event, handler);
      return { remove: vi.fn() };
    }),
  },
}));
vi.mock('@capacitor/browser', () => ({ Browser: { open: vi.fn(async () => undefined), close: vi.fn(async () => undefined) } }));
vi.mock('@capacitor/local-notifications', () => ({
  LocalNotifications: {
    addListener: vi.fn(async (event: string, handler: (data: never) => void) => {
      native.handlers.set(event, handler);
      return { remove: vi.fn() };
    }),
    requestPermissions: vi.fn(async () => ({ display: 'granted' })),
    checkPermissions: vi.fn(async () => ({ display: 'granted' })),
    registerActionTypes: vi.fn(async () => undefined),
    schedule: vi.fn(async () => ({ notifications: [] })),
    cancel: vi.fn(async () => undefined),
    removeDeliveredNotificationsById: vi.fn(async () => undefined),
    getPending: vi.fn(async () => ({ notifications: native.pending })),
  },
}));
vi.mock('@aparajita/capacitor-secure-storage', () => ({
  KeychainAccess: { afterFirstUnlockThisDeviceOnly: 3 },
  SecureStorage: {
    setDefaultKeychainAccess: vi.fn(async () => undefined),
    getItem: vi.fn(async (key: string) => native.keychain.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => void native.keychain.set(key, value)),
    removeItem: vi.fn(async (key: string) => void native.keychain.delete(key)),
  },
}));
vi.mock('@capacitor/core', () => ({
  registerPlugin: (name: string) =>
    name === 'MultiscaleAppearance'
      ? { set: async (options: unknown) => void native.appearances.push(options) }
      : {
          status: async () => ({ enabled: native.shareEnabled }),
          peek: async () => ({ items: [...native.shared] }),
          remove: async ({ ids }: { ids: string[] }) => void (native.shared = native.shared.filter((item) => !ids.includes(item.id))),
        },
}));
vi.mock('@capacitor-community/sqlite', () => {
  const connection = {
    open: vi.fn(async () => undefined),
    isDBOpen: vi.fn(async () => ({ result: false })),
    execute: vi.fn(async (sql: string, transaction: boolean) => {
      native.sql.push({ method: 'execute', sql, transaction });
      // As SQLite answers when no transaction is open.
      if (sql === 'ROLLBACK') throw new Error('cannot rollback - no transaction is active');
      return {};
    }),
    run: vi.fn(async (sql: string, values: unknown[], transaction: boolean) => {
      native.sql.push({ method: 'run', sql, values, transaction });
      return {};
    }),
    query: vi.fn(async (sql: string, values: unknown[]) => {
      native.sql.push({ method: 'query', sql, values });
      return /sqlite_master/.test(sql) ? { values: [] } : { values: [{ value: 'stored' }] };
    }),
  };
  return {
    CapacitorSQLite: {},
    SQLiteConnection: class {
      checkConnectionsConsistency = async () => ({ result: native.connectionExists });
      isConnection = async () => ({ result: native.connectionExists });
      retrieveConnection = vi.fn(async () => connection);
      createConnection = vi.fn(async (name: string) => {
        native.databases.push(name);
        return connection;
      });
      closeConnection = vi.fn(async () => undefined);
    },
  };
});

const { App } = await import('@capacitor/app');
const { Browser } = await import('@capacitor/browser');
const { LocalNotifications } = await import('@capacitor/local-notifications');
const { capacitorSqlDriver, createCapacitorPlatform } = await import('./capacitor');

const reminder = (overrides: Partial<Reminder> = {}): Reminder => ({
  id: 'b1:end',
  kind: 'block_end',
  block_id: 'b1',
  at: '2030-01-01T10:00:00Z',
  title: 'Write the report',
  body: 'How did it go?',
  actions: [
    { id: 'done', title: 'Done' },
    { id: 'partly', title: 'Partly', opens_app: true },
  ],
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  native.handlers.clear();
  native.pending = [];
  native.sql = [];
  native.keychain.clear();
  native.connectionExists = false;
  native.shareEnabled = false;
  native.shared = [];
  native.databases = [];
  native.appearances = [];
});

describe('database driver', () => {
  it('opens the plugin unencrypted and leaves transactions to the Db layer', async () => {
    const driver = await capacitorSqlDriver('check');
    await driver.exec('BEGIN IMMEDIATE');
    await driver.run('INSERT INTO meta VALUES (?, ?)', ['a', null]);
    expect(await driver.all('SELECT value FROM meta', [])).toEqual([{ value: 'stored' }]);
    expect(native.sql).toEqual([
      { method: 'execute', sql: 'BEGIN IMMEDIATE', transaction: false },
      { method: 'run', sql: 'INSERT INTO meta VALUES (?, ?)', values: ['a', null], transaction: false },
      { method: 'query', sql: 'SELECT value FROM meta', values: [] },
    ]);
  });

  it('runs migrations when the platform opens', async () => {
    await createCapacitorPlatform();
    expect(native.sql.some((s) => /CREATE TABLE records/.test(s.sql))).toBe(true);
  });

  it('gives each environment its own database, so a staging and a prod build on one phone never share data', async () => {
    await createCapacitorPlatform('prod');
    await createCapacitorPlatform('staging');
    await createCapacitorPlatform('local');
    expect(native.databases).toEqual(['multiscale', 'multiscale-staging', 'multiscale-local']);
  });

  it('reuses the native connection after the web view reloads, ending any transaction the old page left open', async () => {
    native.connectionExists = true;
    const driver = await capacitorSqlDriver('check');
    expect(await driver.all('SELECT value FROM meta', [])).toEqual([{ value: 'stored' }]);
    expect(native.sql[0]).toEqual({ method: 'execute', sql: 'ROLLBACK', transaction: false });
  });
});

describe('notifications', () => {
  it('schedules each reminder with its time, its actions and a way back to the reminder', async () => {
    const { notifications } = await createCapacitorPlatform();
    await notifications.replaceAll([reminder()]);

    const types = vi.mocked(LocalNotifications.registerActionTypes).mock.calls[0]![0].types;
    expect(types).toHaveLength(1);
    expect(types[0]!.actions).toEqual([
      { id: 'done', title: 'Done', foreground: false },
      { id: 'partly', title: 'Partly', foreground: true },
    ]);
    const scheduled = vi.mocked(LocalNotifications.schedule).mock.calls[0]![0].notifications[0]!;
    expect(scheduled).toMatchObject({ title: 'Write the report', body: 'How did it go?', actionTypeId: types[0]!.id });
    expect(scheduled.schedule?.at).toEqual(new Date('2030-01-01T10:00:00Z'));
    expect(Number.isInteger(scheduled.id)).toBe(true);
    expect(Math.abs(scheduled.id)).toBeLessThan(2 ** 31);
    expect(scheduled.extra).toEqual({ reminder: reminder() });
  });

  it('gives a reminder the same native id every time, and different reminders different ones', async () => {
    const { notifications } = await createCapacitorPlatform();
    await notifications.replaceAll([reminder(), reminder({ id: 'b1:start' })]);
    await notifications.replaceAll([reminder()]);
    const calls = vi.mocked(LocalNotifications.schedule).mock.calls;
    const [first, second] = calls[0]![0].notifications;
    expect(first!.id).not.toBe(second!.id);
    expect(calls[1]![0].notifications[0]!.id).toBe(first!.id);
  });

  it('shares one action type between reminders with the same buttons', async () => {
    const { notifications } = await createCapacitorPlatform();
    await notifications.replaceAll([reminder(), reminder({ id: 'b2:end', block_id: 'b2' })]);
    expect(vi.mocked(LocalNotifications.registerActionTypes).mock.calls[0]![0].types).toHaveLength(1);
  });

  it('replaces what was pending', async () => {
    native.pending = [{ id: 7 }, { id: 8 }];
    const { notifications } = await createCapacitorPlatform();
    await notifications.replaceAll([reminder()]);
    expect(LocalNotifications.cancel).toHaveBeenCalledWith({ notifications: [{ id: 7 }, { id: 8 }] });
  });

  it('skips a reminder already due, because iOS rejects the whole batch for one past date', async () => {
    const { notifications } = await createCapacitorPlatform();
    await notifications.replaceAll([reminder({ at: '2001-01-01T00:00:00Z' }), reminder({ id: 'b1:start' })]);
    expect(vi.mocked(LocalNotifications.schedule).mock.calls[0]![0].notifications).toHaveLength(1);
  });

  it('does not call schedule with an empty list', async () => {
    const { notifications } = await createCapacitorPlatform();
    await notifications.replaceAll([]);
    expect(LocalNotifications.schedule).not.toHaveBeenCalled();
  });

  it('schedules nothing until permission is granted, so it never prompts on its own', async () => {
    vi.mocked(LocalNotifications.checkPermissions).mockResolvedValueOnce({ display: 'prompt' });
    const { notifications } = await createCapacitorPlatform();
    await notifications.replaceAll([reminder()]);
    expect(LocalNotifications.schedule).not.toHaveBeenCalled();
  });

  it('cancels pending and delivered copies by the same id', async () => {
    const { notifications } = await createCapacitorPlatform();
    await notifications.replaceAll([reminder()]);
    const id = vi.mocked(LocalNotifications.schedule).mock.calls[0]![0].notifications[0]!.id;
    await notifications.cancel(['b1:end']);
    expect(LocalNotifications.cancel).toHaveBeenCalledWith({ notifications: [{ id }] });
    expect(LocalNotifications.removeDeliveredNotificationsById).toHaveBeenCalledWith({ ids: [id] });
  });

  it('reads back what is pending', async () => {
    native.pending = [{ id: 1, extra: { reminder: reminder() } }];
    const { notifications } = await createCapacitorPlatform();
    expect(await notifications.scheduled()).toEqual([reminder()]);
  });

  it('reports the permission result', async () => {
    const { notifications } = await createCapacitorPlatform();
    expect(await notifications.requestPermission()).toBe(true);
    vi.mocked(LocalNotifications.requestPermissions).mockResolvedValueOnce({ display: 'denied' });
    expect(await notifications.requestPermission()).toBe(false);
  });

  it('turns an action or a tap into a response, and ignores a dismissal', async () => {
    const { notifications } = await createCapacitorPlatform();
    const seen: unknown[] = [];
    notifications.onResponse((r) => seen.push(r));
    const notification = { extra: { reminder: reminder() } };
    native.fire('localNotificationActionPerformed', { actionId: 'done', notification });
    native.fire('localNotificationActionPerformed', { actionId: 'tap', notification });
    native.fire('localNotificationActionPerformed', { actionId: 'dismiss', notification });
    expect(seen).toEqual([
      { reminder_id: 'b1:end', block_id: 'b1', action_id: 'done' },
      { reminder_id: 'b1:end', block_id: 'b1', action_id: null },
    ]);
  });

  it('holds a response from a cold launch until the app subscribes', async () => {
    const { notifications } = await createCapacitorPlatform();
    native.fire('localNotificationActionPerformed', { actionId: 'done', notification: { extra: { reminder: reminder() } } });
    const seen: unknown[] = [];
    notifications.onResponse((r) => seen.push(r));
    expect(seen).toHaveLength(1);
  });

  it('ignores a notification it did not schedule', async () => {
    const { notifications } = await createCapacitorPlatform();
    const seen: unknown[] = [];
    notifications.onResponse((r) => seen.push(r));
    native.fire('localNotificationActionPerformed', { actionId: 'tap', notification: { extra: null } });
    expect(seen).toEqual([]);
  });
});

describe('tokens', () => {
  it('stores in the keychain, readable after first unlock and never leaving this device', async () => {
    const { SecureStorage } = await import('@aparajita/capacitor-secure-storage');
    const { tokens } = await createCapacitorPlatform();
    expect(SecureStorage.setDefaultKeychainAccess).toHaveBeenCalledWith(3);
    expect(await tokens.get('session')).toBeNull();
    await tokens.set('session', 'value');
    expect(await tokens.get('session')).toBe('value');
    await tokens.remove('session');
    expect(await tokens.get('session')).toBeNull();
  });
});

describe('sign-in and deep links', () => {
  it('returns through the custom URL scheme', async () => {
    const platform = await createCapacitorPlatform();
    expect(platform.kind).toBe('ios');
    expect(platform.signInRedirectUri).toBe('multiscale://auth/callback');
    await platform.openExternal('https://auth.example.com/oauth2/authorize');
    expect(Browser.open).toHaveBeenCalledWith({ url: 'https://auth.example.com/oauth2/authorize' });
  });

  it('closes the browser and passes on the link when one arrives', async () => {
    const platform = await createCapacitorPlatform();
    const links: string[] = [];
    platform.onDeepLink((url) => links.push(url));
    native.fire('appUrlOpen', { url: 'multiscale://auth/callback?code=x&state=y' });
    expect(links).toEqual(['multiscale://auth/callback?code=x&state=y']);
    expect(Browser.close).toHaveBeenCalled();
  });

  it('holds a link from a cold launch until the app subscribes', async () => {
    const platform = await createCapacitorPlatform();
    native.fire('appUrlOpen', { url: 'multiscale://auth/callback?code=x' });
    const links: string[] = [];
    platform.onDeepLink((url) => links.push(url));
    expect(links).toHaveLength(1);
  });

  it('stops delivering after unsubscribe', async () => {
    const platform = await createCapacitorPlatform();
    const links: string[] = [];
    platform.onDeepLink((url) => links.push(url))();
    native.fire('appUrlOpen', { url: 'multiscale://auth/callback' });
    expect(links).toEqual([]);
  });

  it('opens Capture from the capture link, without treating it as a sign-in link', async () => {
    const platform = await createCapacitorPlatform();
    const links: string[] = [];
    let captures = 0;
    platform.onDeepLink((url) => links.push(url));
    native.fire('appUrlOpen', { url: 'multiscale://capture' });
    platform.hotkey!.onCapture(() => captures++);
    expect(captures).toBe(1);
    expect(links).toEqual([]);
  });
});

describe('lifecycle', () => {
  it('reports foreground and background', async () => {
    const { lifecycle } = await createCapacitorPlatform();
    const seen: string[] = [];
    lifecycle.onForeground(() => seen.push('foreground'));
    lifecycle.onBackground(() => seen.push('background'));
    native.fire('resume');
    native.fire('pause');
    expect(seen).toEqual(['foreground', 'background']);
    expect(App.addListener).toHaveBeenCalledWith('resume', expect.any(Function));
  });
});

describe('share import', () => {
  it('is absent until the extensions are turned on', async () => {
    expect((await createCapacitorPlatform()).shareImport).toBeUndefined();
  });

  it('reads what the share extension queued, which stays until removed', async () => {
    native.shareEnabled = true;
    native.shared = [{ id: '1-a.txt', text: 'Paint the fence' }, { id: '2-b.txt', text: 'Write the report' }];
    const { shareImport } = await createCapacitorPlatform();
    expect(await shareImport!.peek()).toEqual(native.shared);
    await shareImport!.remove(['1-a.txt']);
    expect(await shareImport!.peek()).toEqual([{ id: '2-b.txt', text: 'Write the report' }]);
  });
});

describe('appearance', () => {
  it('passes the chosen appearance to the app, for the status bar and keyboard', async () => {
    const platform = await createCapacitorPlatform();
    await platform.setAppearance!('dark');
    await platform.setAppearance!('system');
    expect(native.appearances).toEqual([{ appearance: 'dark' }, { appearance: 'system' }]);
  });
});

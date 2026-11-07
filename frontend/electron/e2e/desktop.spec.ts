// Drives the real app: real main process, real preload, real SQLite file. A launch with an empty folder is a first
// run, and a second launch on the same folder is a restart.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import type { ElectronBridge } from '../bridge';

declare global {
  var firedNotifications: Electron.Notification[];
  var browserUrls: string[];
}

// Always the unpackaged app: the packaged one has its inspector fuse off, so Playwright can't attach to it.
const ROOT = join(import.meta.dirname, '../..');
const KEYCHAIN = process.platform === 'linux' ? ['-r', join(import.meta.dirname, 'linux-keychain.cjs')] : [];

let dataDir: string;
let app: ElectronApplication | undefined;

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  app = await electron.launch({
    // The mock keychain keeps an unattended run from stopping at a keychain prompt. Linux has none, see linux-keychain.cjs.
    args: [...KEYCHAIN, ROOT, `--user-data-dir=${dataDir}`, '--use-mock-keychain'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
  });
  const page = await app.firstWindow();
  await page.waitForFunction(() => document.getElementById('root')?.childElementCount);
  return { app, page };
}

const inbox = (page: Page) =>
  page.evaluate(() =>
    (window.multiscaleElectron as ElectronBridge).db.all("SELECT title FROM task WHERE kind = 'inbox'", []),
  );

/** The capture window, which the app makes hidden once its page is up. */
async function captureWindow(electronApp: ElectronApplication): Promise<Page> {
  await expect.poll(() => electronApp.windows().some((w) => w.url().endsWith('capture.html'))).toBe(true);
  await electronApp.evaluate(({ app: a }) => void a.emit('capture-shortcut'));
  return electronApp.windows().find((w) => w.url().endsWith('capture.html'))!;
}

test.beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'multiscale-e2e-'));
  // A packaged app registers itself as a login item on first run, which a test shouldn't do to this Mac.
  writeFileSync(join(dataDir, 'login-item-set'), '');
});

test.afterEach(async () => {
  await app?.close();
  app = undefined;
  rmSync(dataDir, { recursive: true, force: true });
});

test('launches to first-run setup with the page isolated from Node', async () => {
  const errors: string[] = [];
  const { page } = await launch();
  page.on('pageerror', (e) => errors.push(e.message));
  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();
  expect(await page.evaluate(() => typeof (globalThis as { require?: unknown }).require)).toBe('undefined');
  expect(await page.evaluate(() => typeof (globalThis as { process?: unknown }).process)).toBe('undefined');
  expect(await page.evaluate(() => Object.keys(window.multiscaleElectron as object).includes('ipcRenderer'))).toBe(false);
  expect(new URL(page.url()).protocol).toBe('multiscale-app:');
  const csp = await page.evaluate(() => fetch(location.href).then((r) => r.headers.get('content-security-policy')));
  expect(csp).toContain("script-src 'self'");
  expect(errors).toEqual([]);
});

test('data survives a restart', async () => {
  let { app: first, page } = await launch();
  // Through first-run setup without answering anything.
  await page.getByRole('button', { name: 'Skip' }).click();
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByRole('heading', { name: 'Start with one thing' })).toBeVisible();
  await page.getByRole('button', { name: 'Skip' }).click();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  await page.evaluate(() =>
    (window.multiscaleElectron as ElectronBridge).db.run("INSERT INTO meta (key, value) VALUES ('e2e', 'kept')", []),
  );
  await first.close();

  ({ page } = await launch());
  const rows = await page.evaluate(() =>
    (window.multiscaleElectron as ElectronBridge).db.all("SELECT value FROM meta WHERE key = 'e2e'", []),
  );
  expect(rows).toEqual([{ value: 'kept' }]);
  // Past setup, because that answer is in the database too.
  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeHidden();
});

test('the shortcut opens a one-field window that saves to the Inbox, and it survives a restart', async () => {
  const { app: running, page } = await launch();
  // shortcut: registration is checked here; the OS key press itself isn't reachable from Playwright, so the test sends
  // the event the shortcut's callback sends. A real press is on the manual checklist.
  expect(await running.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('Shift+Command+Space'))).toBe(true);
  // Loaded and hidden before the first press, which then only has to show it.
  await expect.poll(() => running.windows().length).toBe(2);
  expect(await running.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.isVisible()).length)).toBe(1);

  const capture = await captureWindow(running);
  const field = capture.getByRole('textbox', { name: 'Capture' });
  await expect(field).toBeFocused();
  // This window gets no database of its own.
  expect(await capture.evaluate(() => Object.keys((window as unknown as { multiscaleCapture: object }).multiscaleCapture))).toEqual(['save', 'dismiss']);
  expect(await capture.evaluate(() => 'multiscaleElectron' in window)).toBe(false);

  await field.fill('   ');
  await field.press('Enter');
  await expect(capture.getByRole('alert')).toBeHidden();
  expect(await inbox(page)).toEqual([]);

  await field.fill('Paint the fence');
  await field.press('Enter');
  await expect.poll(() => inbox(page)).toEqual([{ title: 'Paint the fence' }]);
  await expect.poll(() => running.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.isVisible()).length)).toBe(1);

  // Opens again with an empty field.
  await running.evaluate(({ app: a }) => void a.emit('capture-shortcut'));
  await expect(field).toHaveValue('');
  await field.press('Escape');
  await expect.poll(() => running.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.isVisible()).length)).toBe(1);

  const outbox = await page.evaluate(() =>
    (window.multiscaleElectron as ElectronBridge).db.all("SELECT field FROM outbox WHERE field = 'title'", []),
  );
  expect(outbox).toEqual([{ field: 'title' }]);

  await running.close();
  const again = await launch();
  expect(await inbox(again.page)).toEqual([{ title: 'Paint the fence' }]);
});

test('a save that fails keeps the text and says so', async () => {
  const { app: running, page } = await launch();
  await page.evaluate(() => (window.multiscaleElectron as ElectronBridge).db.run('DROP TABLE outbox', []));
  const capture = await captureWindow(running);
  const field = capture.getByRole('textbox', { name: 'Capture' });
  await field.fill('Paint the fence');
  await field.press('Enter');
  await expect(capture.getByRole('alert')).toBeVisible();
  await expect(field).toHaveValue('Paint the fence');
});

/**
 * Begins a transaction on the page's connection. The page's startup may hold one of its own for a moment, and these
 * calls skip the queue the page's own work waits in, so this waits for the moment it ends.
 */
const begin = (page: Page) =>
  expect
    .poll(
      () =>
        page.evaluate(async () => {
          try {
            await (window.multiscaleElectron as ElectronBridge).db.exec('BEGIN IMMEDIATE');
            return true;
          } catch {
            return false;
          }
        }),
      { timeout: 5000 },
    )
    .toBe(true);

test('a page reloading mid-transaction leaves no open transaction behind', async () => {
  const { page } = await launch();
  await begin(page);
  await page.evaluate(() => (window.multiscaleElectron as ElectronBridge).db.run("INSERT INTO meta (key, value) VALUES ('half', 'done')", []));
  await page.reload();
  await page.waitForFunction(() => document.getElementById('root')?.childElementCount);
  // One the old page left open would never end.
  await begin(page);
  await page.evaluate(() => (window.multiscaleElectron as ElectronBridge).db.exec('COMMIT'));
  const rows = await page.evaluate(() => (window.multiscaleElectron as ElectronBridge).db.all("SELECT value FROM meta WHERE key = 'half'", []));
  expect(rows).toEqual([]);
});

test('tokens are stored encrypted and survive a restart', async () => {
  const { app: running, page } = await launch();
  await page.evaluate(() => (window.multiscaleElectron as ElectronBridge).tokens.set('auth.session', 'e2e-secret-value'));
  await running.close();
  expect(readFileSync(join(dataDir, 'tokens.json'), 'utf8')).not.toContain('e2e-secret-value');
  const again = await launch();
  expect(await again.page.evaluate(() => (window.multiscaleElectron as ElectronBridge).tokens.get('auth.session'))).toBe('e2e-secret-value');
});

test('a reminder fires from the main process, and its action reaches the page', async () => {
  const { app: running, page } = await launch();
  await running.evaluate(({ Notification }) => {
    globalThis.firedNotifications = [];
    // Shared by every notification, so the main process's own instances are recorded too.
    const shared = (new Notification({ title: '' }) as unknown as { __proto__: Electron.Notification }).__proto__;
    const show = shared.show;
    shared.show = function (this: Electron.Notification) {
      globalThis.firedNotifications.push(this);
      show.call(this);
    };
  });
  const at = new Date(Date.now() + 500).toISOString();
  await page.evaluate(
    (reminderAt) => {
      const api = window.multiscaleElectron as ElectronBridge;
      (window as unknown as { responses: unknown[] }).responses = [];
      api.notifications.onResponse((r) => (window as unknown as { responses: unknown[] }).responses.push(r));
      return api.notifications.replaceAll([
        { id: 'r1', kind: 'block_start', block_id: 'b1', at: reminderAt, title: 'Paint the fence', actions: [{ id: 'start', title: 'Start' }] },
      ]);
    },
    at,
  );
  await expect
    .poll(() => running.evaluate(() => globalThis.firedNotifications.map((n) => n.title)))
    .toEqual(['Paint the fence']);
  expect(await page.evaluate(() => (window.multiscaleElectron as ElectronBridge).notifications.scheduled())).toEqual([]);

  await running.evaluate(() => void globalThis.firedNotifications[0]!.emit('action', {}, 0));
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { responses: unknown[] }).responses))
    .toEqual([{ reminder_id: 'r1', block_id: 'b1', action_id: 'start' }]);
});

test('a sign-in return reaches the page, a foreign link does not, and links open only in the browser', async () => {
  const { app: running, page } = await launch();
  const scheme = (await page.evaluate(() => (window.multiscaleElectron as ElectronBridge).signInRedirectUri)).split('://')[0];
  await page.evaluate(() => {
    (window as unknown as { links: string[] }).links = [];
    (window.multiscaleElectron as ElectronBridge).onDeepLink((u) => (window as unknown as { links: string[] }).links.push(u));
  });
  for (const url of ['https://example.com/', `${scheme}://auth/callback?code=c`]) {
    await running.evaluate(({ app: a }, u) => void a.emit('open-url', { preventDefault: () => undefined }, u), url);
  }
  await expect.poll(() => page.evaluate(() => (window as unknown as { links: string[] }).links)).toEqual([`${scheme}://auth/callback?code=c`]);

  // The system browser is stood in for. A real one can outlive the app, as on Linux, where it keeps the app's output
  // open and so its close waiting.
  await running.evaluate(({ shell }) => {
    globalThis.browserUrls = [];
    shell.openExternal = async (url: string) => void globalThis.browserUrls.push(url);
  });
  await expect(page.evaluate(() => (window.multiscaleElectron as ElectronBridge).openExternal('file:///etc/passwd'))).rejects.toThrow();
  // A window.open goes to the browser, and a navigation goes nowhere.
  await page.evaluate(() => void window.open('https://example.com/'));
  await page.evaluate(() => void (location.href = 'https://example.com/'));
  await page.waitForTimeout(300);
  expect(new URL(page.url()).protocol).toBe('multiscale-app:');
  expect(await running.evaluate(() => globalThis.browserUrls)).toEqual(['https://example.com/']);
  // The app's window and its hidden capture window, and nothing else.
  expect(running.windows().map((w) => new URL(w.url()).pathname.split('/').pop()).sort()).toEqual(['', 'capture.html']);
});

test('closing the window keeps the app running in the tray, and it comes back', async () => {
  const { app: running, page } = await launch();
  // The app's window is the first one made; the capture window comes after it.
  await running.evaluate(({ BrowserWindow }) => BrowserWindow.fromId(1)!.close());
  await expect.poll(() => running.evaluate(({ BrowserWindow }) => BrowserWindow.fromId(1)!.isVisible())).toBe(false);
  await running.evaluate(({ app: a }) => void a.emit('activate'));
  await expect.poll(() => running.evaluate(({ BrowserWindow }) => BrowserWindow.fromId(1)!.isVisible())).toBe(true);
  expect(await page.evaluate(() => 1 + 1)).toBe(2);
});


test('Appearance in Settings sets the native theme and the window background, and the next launch keeps it', async () => {
  let { app: running, page } = await launch();
  const native = (electronApp: ElectronApplication) =>
    electronApp.evaluate(({ BrowserWindow, nativeTheme }) => ({
      source: nativeTheme.themeSource,
      background: BrowserWindow.fromId(1)!.getBackgroundColor().toLowerCase(),
    }));
  await page.getByRole('button', { name: 'Skip' }).click();
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('button', { name: 'Skip' }).click();
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Settings' }).click();
  const appearance = page.getByRole('group', { name: 'Appearance' });
  expect((await native(running)).source).toBe('system');

  await appearance.getByRole('button', { name: 'Dark' }).click();
  await expect.poll(() => native(running)).toEqual({ source: 'dark', background: '#141517' });
  await appearance.getByRole('button', { name: 'Light' }).click();
  await expect.poll(() => native(running)).toEqual({ source: 'light', background: '#fafaf8' });
  await appearance.getByRole('button', { name: 'Dark' }).click();
  await expect.poll(() => native(running)).toEqual({ source: 'dark', background: '#141517' });
  await running.close();

  ({ app: running, page } = await launch());
  await expect.poll(() => native(running)).toEqual({ source: 'dark', background: '#141517' });
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
});

// The main process: owns the SQLite connection, reminder timers and keychain, and everything that outlives a window.

import { randomUUID } from 'node:crypto';
import { accessSync, existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, autoUpdater as squirrel, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, nativeTheme, net, Notification, powerMonitor, protocol, safeStorage, shell, Tray } from 'electron';
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import Database from 'better-sqlite3';
import type { Reminder } from '../src/core/types';
import type { DownloadedRelease, SignedRelease } from '../src/core/updates';
import type { ReminderResponse } from '../src/platform/types';
import { afterMove, appUpdates, MOVED_FILE, readOnlyPlace, setsLoginItem } from './appUpdates';
import type { Updater } from './appUpdates';
import { captureHotkey } from './hotkey';
import { createReminderTimers } from './reminder-timers';
import { appFilePath, cleanCapture, contentSecurityPolicy, isDeepLink, isExternalUrl, isOwnDbSql, isSqlValues, isWebUrl } from './security';
import { betterSqliteDriver } from './sqlite-driver';
import { fileTokens } from './tokens';
import { webBundles } from './updates';

declare const __BUILD__: { name: string; scheme: string; backendOrigins: string[]; downloadsOrigin: string | null; devUrl: string | null };
/** Only an e2e build, which runs unpackaged, stands in for where the app is and for electron-updater (e2e/desktop.spec.ts). */
declare const __E2E__: boolean;

/** A custom event, so that the tray and tests take the same path as the key press. */
const CAPTURE_EVENT = 'capture-shortcut';
const APP_SCHEME = 'multiscale-app';
const SAVE_TIMEOUT_MS = 15_000;
const WEB_ROOT = join(__dirname, '../dist');
/** How long a newly downloaded web bundle has to start and draw the app before it's rolled back. */
const TRIAL_MS = 20_000;

// Before anything reads the data folder, which is named after the app, so each environment gets its own.
app.setName(__BUILD__.name);

let mainWindow: BrowserWindow;
let captureWindow: BrowserWindow | undefined;
let captureDrawn: Promise<void>;
let tray: Tray; // Module scope: a collected tray disappears from the menu bar.
let hotkey: ReturnType<typeof captureHotkey>;
let quitting = false;

// The web bundle the scheme serves: the one inside the app, or a newer one downloaded over the air.
let bundles: ReturnType<typeof webBundles> | undefined;
let web = { root: WEB_ROOT, build: 0 };
let trial: NodeJS.Timeout | undefined;
// Kept until the page loaded after the rollback asks, so telemetry can report it.
let rolledBack: number | null = null;
// The app replacing itself: appUpdates.ts. Only a packaged app that knows its downloads host has it.
let appUpdater: ReturnType<typeof appUpdates> | undefined;
let movedHere = false;

/** The app bundle this runs from, such as /Applications/Multiscale.app. */
const appPath = () => (__E2E__ && process.env.MULTISCALE_E2E_APP_PATH) || resolve(app.getPath('exe'), '../../..');
/** Whether this can be a packaged app that moves and updates itself. */
const selfUpdating = () => app.isPackaged || __E2E__;
/** macOS's own dialog, or in an e2e build the answer the test gives, with what it would have said printed for the test. */
async function ask(options: Electron.MessageBoxOptions): Promise<number> {
  if (__E2E__ && process.env.MULTISCALE_E2E_ANSWER) {
    const said = `${options.message} ${options.detail ?? ''}`;
    console.log(`dialog: ${said}`);
    ((globalThis as unknown as { multiscaleE2eDialogs?: string[] }).multiscaleE2eDialogs ??= []).push(said);
    return Number(process.env.MULTISCALE_E2E_ANSWER);
  }
  return (await dialog.showMessageBox(options)).response;
}

// The page must be up before it can take a capture or a deep link: it loads hidden at login, and reloads after a crash.
let pageReady = false;
let waitingForPage: (() => void)[] = [];
const heldLinks: string[] = [];

function showMain() {
  mainWindow.show();
  mainWindow.focus();
}

function deliverDeepLink(url: string) {
  if (!isDeepLink(url, __BUILD__.scheme)) return;
  if (pageReady) mainWindow.webContents.send('deep-link', url);
  else heldLinks.push(url);
  if (mainWindow) showMain();
}

/** Handles a request only from the one window it's meant for, so nothing else that loads can reach it. */
function handleFrom<A extends unknown[], R>(
  window: () => BrowserWindow | undefined,
  channel: string,
  handler: (...args: A) => R,
) {
  ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
    if (event.sender !== window()?.webContents) throw new Error(`${channel} is not allowed from this window`);
    return handler(...(args as A));
  });
}

function checkedSql(sql: unknown, values: unknown = []): asserts sql is string {
  if (!isOwnDbSql(sql) || !isSqlValues(values)) throw new Error('Bad SQL call');
}

function registerAppScheme() {
  const csp = contentSecurityPolicy(__BUILD__.backendOrigins);
  protocol.handle(APP_SCHEME, async (request) => {
    const path = appFilePath(web.root, new URL(request.url).pathname);
    if (!path) return new Response('Not found', { status: 404 });
    const file = await net.fetch(pathToFileURL(path).href);
    const headers = new Headers(file.headers);
    headers.set('Content-Security-Policy', csp);
    return new Response(file.body, { status: file.status, headers });
  });
}

/** Loads the newest web bundle this app can run. A downloaded one on trial goes back unless it reports ready in time. */
function loadPage() {
  clearTimeout(trial);
  trial = undefined;
  if (bundles) {
    web = bundles.newest();
    if (web.root !== WEB_ROOT && web.build > bundles.confirmed()) trial = setTimeout(rollBack, TRIAL_MS);
  }
  void mainWindow.loadURL(__BUILD__.devUrl ?? `${APP_SCHEME}://app/`);
}

function rollBack() {
  console.error(`Web bundle ${web.build} didn't start, so it's rolled back`);
  rolledBack = web.build;
  bundles?.reject(web.build);
  loadPage();
}

/** No navigating away and no new windows: web and mail links go to the browser and mail app, and nothing else goes anywhere. */
function lockDown(window: BrowserWindow) {
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event) => event.preventDefault());
}

/** --page in each theme, so a resize or a reload never shows white around a dark page. */
const pageBackground = () => (nativeTheme.shouldUseDarkColors ? '#141517' : '#fafaf8');

function createMainWindow(rollbackOpenTransaction: () => void, startHidden: boolean) {
  mainWindow = new BrowserWindow({
    title: __BUILD__.name,
    backgroundColor: pageBackground(),
    width: 1360,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // It's often hidden while it still has to sync and take captures.
      backgroundThrottling: false,
    },
  });
  lockDown(mainWindow);
  mainWindow.once('ready-to-show', () => {
    if (!startHidden) mainWindow.show();
  });
  // The window stays alive when closed, so reminders, sync and capture keep working from the tray.
  mainWindow.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    mainWindow.hide();
  });
  // Out of sight is the moment to switch to a downloaded update.
  mainWindow.on('hide', () => {
    if (bundles && bundles.newest().build > web.build) loadPage();
  });
  mainWindow.webContents.on('did-start-navigation', (details) => {
    if (!details.isMainFrame || details.isSameDocument) return;
    pageReady = false;
    rollbackOpenTransaction();
  });
  mainWindow.webContents.on('render-process-gone', () => {
    pageReady = false;
    rollbackOpenTransaction();
    if (quitting) return;
    if (trial) rollBack();
    else mainWindow.reload();
  });
  loadPage();
}

/**
 * Made hidden once the page is up, so the shortcut only has to show it: making it on the first press took about 80ms
 * before anything appeared.
 */
function createCaptureWindow() {
  captureWindow = new BrowserWindow({
    width: 520,
    height: 64,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    // A panel takes the keyboard without activating the app, so focus returns to where the user was, and it shows
    // over full-screen apps.
    type: 'panel',
    show: false,
    webPreferences: { preload: join(__dirname, 'capture-preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  lockDown(captureWindow);
  // A press while it's still loading shows it once it has drawn, rather than blank.
  captureDrawn = new Promise((resolve) => captureWindow!.once('ready-to-show', resolve));
  // Stays loaded with its text, so clicking elsewhere doesn't lose what was typed.
  captureWindow.on('blur', () => captureWindow?.hide());
  captureWindow.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    captureWindow?.hide();
  });
  void captureWindow.loadFile(join(__dirname, 'capture.html'));
}

function openCapture() {
  if (!captureWindow) createCaptureWindow();
  void captureDrawn.then(() => {
    captureWindow?.show();
    captureWindow?.focus();
  });
}

function savesThroughPage() {
  const saves = new Map<string, { resolve(): void; reject(err: Error): void }>();
  ipcMain.on('capture:done', (event: IpcMainEvent, id: unknown, error: unknown) => {
    if (event.sender !== mainWindow.webContents || typeof id !== 'string') return;
    const save = saves.get(id);
    saves.delete(id);
    if (error) save?.reject(new Error(String(error)));
    else save?.resolve();
  });
  return (title: string) =>
    new Promise<void>((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        saves.delete(id);
        reject(new Error('The app did not save in time'));
      }, SAVE_TIMEOUT_MS);
      const settle = <T>(fn: (value: T) => void) => (value: T) => {
        clearTimeout(timer);
        fn(value);
      };
      saves.set(id, { resolve: settle(resolve) as () => void, reject: settle(reject) });
      const send = () => mainWindow.webContents.send('capture:save', id, title);
      if (pageReady) send();
      else waitingForPage.push(send);
    });
}

function createTray(hotkey: string) {
  tray = new Tray(join(__dirname, 'assets/trayTemplate.png'));
  tray.setToolTip(__BUILD__.name);
  trayMenu(hotkey);
}

/** Again whenever the capture shortcut changes, so the menu shows the one that works. */
function trayMenu(hotkey: string) {
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Open ${__BUILD__.name}`, click: showMain },
      { label: 'Capture', accelerator: hotkey, click: () => app.emit(CAPTURE_EVENT) },
      { type: 'separator' },
      // A ready app update, in its own group above Quit. Quit always quits: an update installs then, and doesn't reopen.
      ...(appUpdater?.ready() ? [{ label: 'Restart to update', click: () => appUpdater?.restart() }, { type: 'separator' as const }] : []),
      { label: 'Quit', role: 'quit' },
    ]),
  );
}

/**
 * Once, so that someone who later turns it off in System Settings stays off. Never from a disk image or a temporary
 * copy, so a login item never points there; a move to Applications sets it again from there if it was set.
 */
function startAtLoginOnFirstRun() {
  const marker = join(app.getPath('userData'), 'login-item-set');
  const moved = afterMove(app.getPath('userData'));
  if (moved?.openAtLogin) app.setLoginItemSettings({ openAtLogin: true });
  if (!setsLoginItem({ packaged: app.isPackaged, firstRunDone: existsSync(marker), place: readOnlyPlace(appPath(), accessSync) })) return;
  app.setLoginItemSettings({ openAtLogin: true });
  writeFileSync(marker, '');
}

/** Moves the app to Applications, which replaces an older copy there and opens the moved one. Says so if it can't. */
async function moveToApplications(): Promise<boolean> {
  writeFileSync(join(app.getPath('userData'), MOVED_FILE), JSON.stringify({ openAtLogin: app.getLoginItemSettings().openAtLogin }));
  try {
    // An e2e build runs the bare Electron binary, which must never move.
    if (__E2E__) return false;
    if (app.moveToApplicationsFolder()) return true;
  } catch (error) {
    console.error('Move to Applications failed', error);
  }
  await ask({ type: 'warning', message: `Couldn't move ${__BUILD__.name}`, detail: `Drag ${__BUILD__.name} to Applications in Finder, then open it from there.`, buttons: ['OK'] });
  return false;
}

/** On first run from a disk image or a temporary copy, macOS's own dialog offers to move the app, before the window. */
async function offerMove(): Promise<boolean> {
  const where = selfUpdating() ? readOnlyPlace(appPath(), accessSync) : null;
  if (!where) return false;
  const from = where.kind === 'translocated' ? 'macOS is running it from a temporary copy' : "It's running from the disk image";
  const response = await ask({
    type: 'question',
    message: `Move ${__BUILD__.name} to Applications?`,
    detail: `${from}, so it can't keep itself up to date or open when you log in. Moving it takes a moment, then it opens again.`,
    buttons: ['Move to Applications', 'Not now'],
    defaultId: 0,
    cancelId: 1,
  });
  return response === 0 && (await moveToApplications());
}

function showReminder(reminder: Reminder) {
  const notification = new Notification({
    title: reminder.title,
    body: reminder.body ?? '',
    actions: reminder.actions.map((action) => ({ type: 'button' as const, text: action.title })),
  });
  const respond = (action_id: string | null) => {
    const response: ReminderResponse = { reminder_id: reminder.id, block_id: reminder.block_id, action_id };
    mainWindow.webContents.send('notification:response', response);
    const action = reminder.actions.find((a) => a.id === action_id);
    if (!action_id || action?.opens_app) showMain();
  };
  notification.on('click', () => respond(null));
  notification.on('action', (_event, index) => respond(reminder.actions[index]?.id ?? null));
  notification.show();
  return notification;
}

function start() {
  const sqlite = new Database(join(app.getPath('userData'), 'multiscale.sqlite'));
  const driver = betterSqliteDriver(sqlite);
  const main = () => mainWindow;
  const capture = () => captureWindow;

  handleFrom(main, 'db:exec', (sql: unknown) => {
    checkedSql(sql);
    return driver.exec(sql);
  });
  handleFrom(main, 'db:all', (sql: unknown, values: unknown) => {
    checkedSql(sql, values);
    return driver.all(sql, values as never);
  });
  handleFrom(main, 'db:run', (sql: unknown, values: unknown) => {
    checkedSql(sql, values);
    return driver.run(sql, values as never);
  });

  const tokens = fileTokens(join(app.getPath('userData'), 'tokens.json'), safeStorage);
  const isKey = (key: unknown): key is string => typeof key === 'string' && key.length > 0;
  handleFrom(main, 'tokens:get', (key: unknown) => (isKey(key) ? tokens.get(key) : null));
  handleFrom(main, 'tokens:set', async (key: unknown, value: unknown) => {
    if (!isKey(key) || typeof value !== 'string') throw new Error('Bad token');
    await tokens.set(key, value);
  });
  handleFrom(main, 'tokens:remove', async (key: unknown) => {
    if (isKey(key)) await tokens.remove(key);
  });

  const timers = createReminderTimers(showReminder);
  powerMonitor.on('resume', timers.rearm);
  // So the page syncs then rather than at the next focus or its 5-minute timer. Unlocking too: the network can still be
  // coming back at the moment of waking, and a sync then fails as offline.
  const wake = () => {
    if (pageReady) mainWindow.webContents.send('power:wake');
  };
  powerMonitor.on('resume', wake);
  powerMonitor.on('unlock-screen', wake);
  handleFrom(main, 'notifications:permission', () => Notification.isSupported());
  handleFrom(main, 'notifications:replace', (reminders: Reminder[]) => timers.replaceAll(reminders));
  handleFrom(main, 'notifications:cancel', (ids: string[]) => timers.cancel(ids));
  handleFrom(main, 'notifications:scheduled', () => timers.scheduled());

  // The page's Settings > Appearance. The theme source also sets the menus, the capture window and the page's
  // prefers-color-scheme; 'updated' fires on that and on the system changing.
  handleFrom(main, 'appearance:set', (appearance: unknown) => {
    if (appearance !== 'system' && appearance !== 'light' && appearance !== 'dark') throw new Error('Bad appearance');
    nativeTheme.themeSource = appearance;
  });
  nativeTheme.on('updated', () => mainWindow.setBackgroundColor(pageBackground()));

  handleFrom(main, 'open-external', async (url: unknown) => {
    if (!isWebUrl(url)) throw new Error('Only web links can open in the browser');
    await shell.openExternal(url);
  });

  // Over-the-air updates: the page downloads a release, and this checks and installs it. See updates.ts.
  if (!__BUILD__.devUrl && existsSync(join(WEB_ROOT, 'version.json'))) bundles = webBundles(join(app.getPath('userData'), 'web'), WEB_ROOT);
  handleFrom(main, 'updates:install', (release: unknown) => {
    if (!bundles) throw new Error('This build takes no updates');
    bundles.install(release as DownloadedRelease, web.root);
  });
  handleFrom(main, 'updates:staged', () => {
    const next = bundles?.newest();
    return next && next.build > web.build ? next.build : null;
  });
  handleFrom(main, 'updates:rolledBack', () => {
    const build = rolledBack;
    rolledBack = null;
    return build;
  });
  handleFrom(main, 'updates:apply', () => {
    if (bundles && bundles.newest().build > web.build) loadPage();
  });

  // The app replacing itself, checked against the release key and the app record before anything downloads.
  if (bundles && selfUpdating() && __BUILD__.downloadsOrigin) {
    appUpdater = appUpdates({
      // Loaded only here: electron-updater makes its Squirrel.Mac updater as it loads.
      updater: (__E2E__ ? (globalThis as unknown as { multiscaleE2eUpdater: Updater }).multiscaleE2eUpdater : (require('electron-updater') as { autoUpdater: Updater }).autoUpdater),
      squirrel,
      info: bundles.embedded,
      downloadsOrigin: __BUILD__.downloadsOrigin,
      appPath: appPath(),
      dataDir: app.getPath('userData'),
      access: accessSync,
      beforeQuit: () => {
        quitting = true;
      },
    });
  }
  ipcMain.on('app-updates:available', (event) => {
    event.returnValue = !!appUpdater;
  });
  const appUpdates_ = () => {
    if (!appUpdater) throw new Error('This app does not update itself');
    return appUpdater;
  };
  handleFrom(main, 'app-updates:place', () => appUpdates_().place());
  handleFrom(main, 'app-updates:staged', () => appUpdates_().staged());
  handleFrom(main, 'app-updates:download', async (release: unknown) => {
    await appUpdates_().download(release as SignedRelease, (percent) => mainWindow.webContents.send('app-updates:progress', percent));
    trayMenu(hotkey.get().accelerator);
  });
  handleFrom(main, 'app-updates:install', (release: unknown) => appUpdates_().install(release as SignedRelease));
  handleFrom(main, 'app-updates:restart', () => appUpdates_().restart());
  handleFrom(main, 'app-updates:move', async () => void (await moveToApplications()));
  handleFrom(main, 'app-updates:updated', () => appUpdates_().updated());
  handleFrom(main, 'app-updates:moved', () => {
    const answer = movedHere;
    movedHere = false;
    return answer;
  });
  handleFrom(main, 'app-updates:built', () => appUpdates_().built());
  ipcMain.on('updates:ready', (event) => {
    if (event.sender !== mainWindow.webContents) return;
    clearTimeout(trial);
    trial = undefined;
    if (bundles && web.root !== WEB_ROOT) bundles.confirm(web.build);
  });

  ipcMain.on('app:signin-uri', (event) => {
    event.returnValue = `${__BUILD__.scheme}://auth/callback`;
  });
  ipcMain.on('app:ready', (event) => {
    if (event.sender !== mainWindow.webContents) return;
    pageReady = true;
    for (const send of waitingForPage) send();
    waitingForPage = [];
    for (const url of heldLinks.splice(0)) mainWindow.webContents.send('deep-link', url);
    // After the page, so it doesn't slow the app's own start.
    if (!captureWindow) createCaptureWindow();
  });

  const saveThroughPage = savesThroughPage();
  handleFrom(capture, 'capture:save', async (text: unknown) => {
    const title = cleanCapture(text);
    if (!title) throw new Error('Nothing to save');
    await saveThroughPage(title);
    captureWindow?.hide();
  });
  handleFrom(capture, 'capture:dismiss', () => captureWindow?.hide());

  registerAppScheme();
  const { wasOpenedAtLogin } = app.getLoginItemSettings();
  createMainWindow(() => {
    // A page that died mid-transaction must not leave it open for the next one.
    if (sqlite.inTransaction) sqlite.exec('ROLLBACK');
  }, wasOpenedAtLogin);
  (app as NodeJS.EventEmitter).on(CAPTURE_EVENT, openCapture);
  hotkey = captureHotkey(join(app.getPath('userData'), 'capture-shortcut.json'), globalShortcut, () => app.emit(CAPTURE_EVENT));
  handleFrom(main, 'shortcut:get', () => hotkey.get());
  handleFrom(main, 'shortcut:set', (accelerator: unknown) => {
    const ok = hotkey.set(accelerator);
    if (ok) trayMenu(hotkey.get().accelerator);
    return ok;
  });
  createTray(hotkey.get().accelerator);
  movedHere = existsSync(join(app.getPath('userData'), MOVED_FILE));
  startAtLoginOnFirstRun();

  app.on('activate', showMain);
  app.on('second-instance', showMain);
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    sqlite.close();
  });
}

protocol.registerSchemesAsPrivileged([{ scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

// open-url can arrive before ready when a link is what started the app.
app.on('open-url', (event, url) => {
  event.preventDefault();
  deliverDeepLink(url);
});
app.on('before-quit', () => {
  quitting = true;
});
app.on('window-all-closed', () => undefined);

if (!app.requestSingleInstanceLock()) {
  // A copy opened from a disk image while another runs only brings that one forward, so it says how to move it.
  if (selfUpdating() && readOnlyPlace(appPath(), accessSync)) {
    void app.whenReady().then(async () => {
      await ask({ type: 'info', message: `${__BUILD__.name} is already open`, detail: 'Quit it from its icon in the menu bar, then open this copy again to move it to Applications.', buttons: ['OK'] });
      app.quit();
    });
  } else app.quit();
} else {
  // An unpackaged run would register the bare Electron binary, which can't open this app.
  if (app.isPackaged) app.setAsDefaultProtocolClient(__BUILD__.scheme);
  void app.whenReady().then(async () => {
    try {
      // Holding the lock, no older copy runs, so a move can replace it.
      if (await offerMove()) return;
      start();
    } catch (err) {
      dialog.showErrorBox(`${__BUILD__.name} couldn't start`, String(err));
      app.exit(1);
    }
  });
}

// Loaded into the main process before the app, on Linux only. Playwright starts Electron on a stand-in keychain: the
// mock keychain on the Mac, and on Linux the basic store, which encrypts only once it's told to use its fixed key.
require('electron').safeStorage.setUsePlainTextEncryption(true);

// Runs sandboxed before the page. The page gets these calls and nothing else from Electron.

import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import type { ElectronBridge } from './bridge';

function subscribe<A extends unknown[]>(channel: string, listener: (...args: A) => void) {
  const handler = (_event: IpcRendererEvent, ...args: unknown[]) => listener(...(args as A));
  ipcRenderer.on(channel, handler);
  return () => void ipcRenderer.off(channel, handler);
}

const bridge: ElectronBridge = {
  signInRedirectUri: ipcRenderer.sendSync('app:signin-uri') as string,
  db: {
    exec: (sql) => ipcRenderer.invoke('db:exec', sql),
    all: (sql, values) => ipcRenderer.invoke('db:all', sql, values),
    run: (sql, values) => ipcRenderer.invoke('db:run', sql, values),
  },
  notifications: {
    requestPermission: () => ipcRenderer.invoke('notifications:permission'),
    replaceAll: (reminders) => ipcRenderer.invoke('notifications:replace', reminders),
    cancel: (ids) => ipcRenderer.invoke('notifications:cancel', ids),
    scheduled: () => ipcRenderer.invoke('notifications:scheduled'),
    onResponse: (listener) => subscribe('notification:response', listener),
  },
  tokens: {
    get: (key) => ipcRenderer.invoke('tokens:get', key),
    set: (key, value) => ipcRenderer.invoke('tokens:set', key, value),
    remove: (key) => ipcRenderer.invoke('tokens:remove', key),
  },
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  onDeepLink: (listener) => subscribe('deep-link', listener),
  onCapture: (listener) => subscribe('capture:save', listener),
  captureDone: (id, error) => ipcRenderer.send('capture:done', id, error),
  ready: () => ipcRenderer.send('app:ready'),
  setAppearance: (appearance) => ipcRenderer.invoke('appearance:set', appearance),
  updates: {
    install: (release) => ipcRenderer.invoke('updates:install', release),
    staged: () => ipcRenderer.invoke('updates:staged'),
    apply: () => ipcRenderer.invoke('updates:apply'),
    ready: () => ipcRenderer.send('updates:ready'),
    rolledBack: () => ipcRenderer.invoke('updates:rolledBack'),
  },
};

contextBridge.exposeInMainWorld('multiscaleElectron', bridge);

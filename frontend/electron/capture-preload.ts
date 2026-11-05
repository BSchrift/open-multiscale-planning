// The capture window can ask to save one line and to be dismissed. It has no database and no other access.

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('multiscaleCapture', {
  save: (text: string): Promise<void> => ipcRenderer.invoke('capture:save', text),
  dismiss: (): Promise<void> => ipcRenderer.invoke('capture:dismiss'),
});

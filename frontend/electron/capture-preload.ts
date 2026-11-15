// The capture window can ask to save one line and to be dismissed. It has no database and no other access.

import { contextBridge, ipcRenderer } from 'electron';

// capture.global (docs/performance.md): from the shortcut reaching the main process to the panel shown with
// its field focused, at the next frame. Here rather than in the page, which gets nothing it could be handed.
let pressed: number | undefined;
function measureOnceShown() {
  if (pressed === undefined || !document.hasFocus()) return;
  const start = pressed;
  pressed = undefined;
  requestAnimationFrame(() => setTimeout(() => performance.measure('capture.global', { start, end: performance.now() })));
}
ipcRenderer.on('capture:pressed', (_event, at: number) => {
  // Onto this page's clock, by how long ago the press was.
  pressed = performance.now() - (Date.now() - at);
  measureOnceShown();
});
window.addEventListener('focus', measureOnceShown);

contextBridge.exposeInMainWorld('multiscaleCapture', {
  save: (text: string): Promise<void> => ipcRenderer.invoke('capture:save', text),
  dismiss: (): Promise<void> => ipcRenderer.invoke('capture:dismiss'),
});

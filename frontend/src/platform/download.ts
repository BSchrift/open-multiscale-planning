// Saves a file the page made by downloading it. A browser puts it in Downloads or asks where, and the Mac app asks
// where with a save dialog, which Electron shows for any download the app doesn't place itself.

/** How long the file's URL lasts: the download may start after the click returns. */
const KEEP_URL_MS = 60_000;

export async function downloadFile(name: string, text: string): Promise<void> {
  const url = URL.createObjectURL(new Blob([text], { type: name.endsWith('.json') ? 'application/json' : 'text/plain' }));
  Object.assign(document.createElement('a'), { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), KEEP_URL_MS);
}

// The one rule for a title that capture makes, from the capture field, setup, the Mac's tray capture or the iPhone
// share sheet. The Mac's main process is built with it too, so a change here means reinstalling the Mac app.

/** The longest title, so a paste or a share can't make a record too large to sync. */
export const MAX_TITLE = 2000;

/** The text as one line with single spaces, cut on a whole word if it's too long, or null if there's nothing in it. */
export function captureTitle(text: string): string | null {
  const title = text.replace(/\s+/g, ' ').trim();
  if (title.length <= MAX_TITLE) return title || null;
  // From the character just past the limit, so a space there still ends the last word that fits.
  const space = title.lastIndexOf(' ', MAX_TITLE);
  return space > 0 ? title.slice(0, space) : title.slice(0, MAX_TITLE);
}

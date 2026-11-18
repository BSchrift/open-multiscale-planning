// What text shared from another app becomes, from the iPhone share sheet. Apart from captureTitle.ts, which the Mac's
// main process is built with, so this can change without a new Mac app.

import { MAX_LINK } from './attachments';
import { captureTitle } from './captureTitle';
import { linkHref, MAX_NOTES } from './notes';

/** Text shared from another app, as an Inbox item. */
export interface Share {
  title: string;
  notes: string | null;
  /** Whether the description was cut to MAX_NOTES. */
  cut: boolean;
  /** A link shared on its own, for a link attachment. */
  link: string | null;
}

/** The text cut on a whole word if it's longer than max, or at max when no word ends before it, as captureTitle cuts. */
function cutOnWord(text: string, max: number): string {
  if (text.length <= max) return text;
  // From the character just past the limit, so a space or line break there still ends the last word that fits.
  const space = text.slice(0, max + 1).search(/\s\S*$/);
  return (space > 0 ? text.slice(0, space) : text.slice(0, max)).trimEnd();
}

/**
 * The first line is the title, and the rest the description, line breaks and all, cut on a whole word to MAX_NOTES so
 * the record syncs. A first line too long for a title stays whole in the description too, so the cut title loses
 * nothing. A web address of up to MAX_LINK shared on its own is a link as well; a longer one stays in the description.
 * Null if there's nothing in it.
 */
export function captureShare(text: string): Share | null {
  const lines = text.trim().split(/\r?\n/);
  const line = lines[0]!.replace(/\s+/g, ' ').trim();
  const title = captureTitle(line);
  if (!title) return null;
  const body = lines.slice(title === line ? 1 : 0).join('\n').trim();
  const notes = cutOnWord(body, MAX_NOTES);
  const alone = lines.length === 1 && line.length <= MAX_LINK && /^https?:\/\/\S+$/i.test(line) && linkHref(line);
  return { title, notes: notes || null, cut: notes.length < body.length, link: alone ? line : null };
}

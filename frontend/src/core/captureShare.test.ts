import { describe, expect, it } from 'vitest';
import { MAX_LINK } from './attachments';
import { captureShare } from './captureShare';
import { MAX_TITLE } from './captureTitle';
import { MAX_NOTES } from './notes';

describe('captureShare', () => {
  it('makes the first line the title and the rest the description, keeping its line breaks', () => {
    expect(captureShare('  Lentil soup\r\n\r\n- 200g lentils\n- 1 onion\n\nSimmer for *20 minutes*.\n ')).toEqual({
      title: 'Lentil soup',
      notes: '- 200g lentils\n- 1 onion\n\nSimmer for *20 minutes*.',
      cut: false,
      link: null,
    });
    expect(captureShare('Call  the\tbank')).toEqual({ title: 'Call the bank', notes: null, cut: false, link: null });
  });

  it('refuses a share with nothing in it', () => {
    for (const blank of ['', '   ', '\n\t ']) expect(captureShare(blank)).toBeNull();
  });

  it('cuts the description of a 21,000-character share on a word boundary at 20,000 characters, and says so', () => {
    const text = `Notes from the talk\n${'word '.repeat(4196)}`;
    expect(text).toHaveLength(21_000);
    // The 4,001st "word" would run past 20,000 characters.
    expect(captureShare(text)).toEqual({ title: 'Notes from the talk', notes: 'word '.repeat(4000).trim(), cut: true, link: null });
    // At the limit it's whole; past it with no word to end on, it's cut at the limit.
    expect(captureShare(`Notes\n${'x'.repeat(MAX_NOTES)}`)).toMatchObject({ notes: 'x'.repeat(MAX_NOTES), cut: false });
    expect(captureShare(`Notes\n${'x'.repeat(MAX_NOTES + 1)}`)).toMatchObject({ notes: 'x'.repeat(MAX_NOTES), cut: true });
  });

  it('keeps a first line too long for a title whole in the description, so the cut title loses nothing', () => {
    const line = 'fences '.repeat(400).trim();
    expect(captureShare(`${line}\nPaint them green`)).toEqual({ title: 'fences '.repeat(285).trim(), notes: `${line}\nPaint them green`, cut: false, link: null });
  });

  it('makes a link of up to 2,000 characters shared on its own a link attachment', () => {
    const url = 'https://example.com/recipes/lentil-soup';
    expect(captureShare(` ${url}\n`)).toEqual({ title: url, notes: null, cut: false, link: url });
    const longest = `https://example.com/${'a'.repeat(MAX_LINK - 20)}`;
    expect(longest).toHaveLength(MAX_LINK);
    expect(captureShare(longest)).toEqual({ title: longest, notes: null, cut: false, link: longest });
    // Not a link on its own: words with it, another kind of address, or no address at all.
    for (const text of [`Soup ${url}`, `${url}\nTry this one`, 'mailto:someone@example.com', 'ftp://example.com/file', 'https://']) {
      expect(captureShare(text)?.link).toBeNull();
    }
  });

  it('keeps a longer link in the description, where a 60 KB one is cut like any text', () => {
    const over = `https://example.com/${'a'.repeat(MAX_LINK - 19)}`;
    expect(captureShare(over)).toEqual({ title: over.slice(0, MAX_TITLE), notes: over, cut: false, link: null });
    const huge = `https://example.com/?q=${'a'.repeat(60 * 1024)}`;
    expect(captureShare(huge)).toEqual({ title: huge.slice(0, MAX_TITLE), notes: huge.slice(0, MAX_NOTES), cut: true, link: null });
  });
});

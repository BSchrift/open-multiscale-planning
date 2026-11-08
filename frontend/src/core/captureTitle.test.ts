import { describe, expect, it } from 'vitest';
import { captureTitle, MAX_TITLE } from './captureTitle';

describe('captureTitle', () => {
  it('makes one line of text, with single spaces', () => {
    expect(captureTitle('  Paint the fence \n')).toBe('Paint the fence');
    expect(captureTitle('Paint\nthe\t\tfence')).toBe('Paint the fence');
    expect(captureTitle('Call  the\r\n  bank')).toBe('Call the bank');
  });

  it('refuses text with nothing in it', () => {
    for (const blank of ['', '   ', '\n\t ']) expect(captureTitle(blank)).toBeNull();
  });

  it('keeps a title of exactly the limit whole', () => {
    expect(captureTitle('x'.repeat(MAX_TITLE))).toBe('x'.repeat(MAX_TITLE));
    const words = `${'word '.repeat(399)}words`;
    expect(words).toHaveLength(MAX_TITLE);
    expect(captureTitle(words)).toBe(words);
  });

  it('cuts longer text at the last whole word that fits', () => {
    expect(captureTitle('word '.repeat(600))).toBe('word '.repeat(400).trim());
    // A space right after the limit still keeps the word before it.
    expect(captureTitle(`${'x'.repeat(MAX_TITLE)} more`)).toBe('x'.repeat(MAX_TITLE));
  });

  it('cuts at the limit when no word ends before it', () => {
    expect(captureTitle('x'.repeat(2500))).toBe('x'.repeat(MAX_TITLE));
  });
});

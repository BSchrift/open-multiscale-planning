import { describe, expect, it } from 'vitest';
import { formatBytes, linkName, storageFull, tooLarge, usageLine } from './attachments';

describe('attachment words', () => {
  it('sizes files the way people read them', () => {
    expect(formatBytes(0)).toBe('0 KB');
    expect(formatBytes(1)).toBe('1 KB');
    expect(formatBytes(240 * 1024)).toBe('240 KB');
    expect(formatBytes(1024 * 1024)).toBe('1 MB');
    expect(formatBytes(1.24 * 1024 * 1024)).toBe('1.2 MB');
    expect(formatBytes(14.4 * 1024 * 1024)).toBe('14 MB');
    expect(formatBytes(240 * 1024 * 1024)).toBe('240 MB');
    expect(formatBytes(1024 ** 3)).toBe('1 GB');
    // Just under a unit reads as it, not as 1,024 of the one below.
    expect(formatBytes(1024 ** 3 - 2)).toBe('1 GB');
    expect(formatBytes(1023 * 1024)).toBe('1 MB');
    expect(formatBytes(5.5 * 1024 ** 3)).toBe('5.5 GB');
  });

  it('says how much storage is used, and what to do when it is full', () => {
    expect(usageLine(240 * 1024 * 1024, 1024 ** 3)).toBe('240 MB of 1 GB used');
    expect(storageFull(1024 ** 3, 1024 ** 3)).toBe('Storage full: 1 GB of 1 GB used. Remove attachments to make room.');
  });

  it('says a file is too large, with both sizes', () => {
    expect(tooLarge(14 * 1024 * 1024, 10 * 1024 * 1024)).toBe('This file is 14 MB. Files can be up to 10 MB.');
  });

  it("names a link by its site when it's given no name", () => {
    expect(linkName('https://docs.example.com/q3/numbers')).toBe('docs.example.com');
    expect(linkName('https://www.example.com/')).toBe('example.com');
    expect(linkName('not a link')).toBe('not a link');
  });
});

import { describe, expect, it } from 'vitest';
import { WHATS_NEW } from '../whatsNew';
import { newestId, readSeen, unseenEntries, WHATS_NEW_KEY, WHATS_NEW_SHOWN, writeSeen } from './whatsNew';
import type { WhatsNewEntry } from './whatsNew';

/** Lines 1 to n, newest first, as whatsNew.ts keeps them. */
const lines = (n: number): WhatsNewEntry[] => Array.from({ length: n }, (_, i) => ({ id: n - i, text: `Line ${n - i}.` }));
const ids = (entries: readonly WhatsNewEntry[]) => entries.map((e) => e.id);

function memoryStore(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value), values };
}

describe("what's new", () => {
  it('shows only the lines newer than the newest this device has seen, newest first', () => {
    expect(ids(unseenEntries(lines(5), 3))).toEqual([5, 4]);
  });

  it('shows nothing once the device has seen the newest, or a newer one from a bundle since rolled back', () => {
    expect(unseenEntries(lines(5), 5)).toEqual([]);
    expect(unseenEntries(lines(5), 7)).toEqual([]);
  });

  it('shows the lines of several missed updates together', () => {
    // Seen up to 2 in one update; 3 and 4 came in a second, 5 in a third, all while the phone was away.
    expect(ids(unseenEntries(lines(5), 2))).toEqual([5, 4, 3]);
  });

  it(`keeps to the newest ${WHATS_NEW_SHOWN}, dropping older ones quietly`, () => {
    expect(ids(unseenEntries(lines(10), 1))).toEqual([10, 9, 8, 7, 6, 5]);
  });

  it('shows the newest lines to a device that ran the app before it recorded any, as one updating to this release does', () => {
    expect(ids(unseenEntries(lines(3), null))).toEqual([3, 2, 1]);
    expect(unseenEntries(lines(9), null)).toHaveLength(WHATS_NEW_SHOWN);
  });

  it('takes the newest id, which a new install records as seen', () => {
    expect(newestId(lines(4))).toBe(4);
    expect(newestId([])).toBe(0);
  });

  it('remembers the newest seen on the device, and reads nothing from a value it never wrote', () => {
    const store = memoryStore();
    expect(readSeen(store)).toBeNull();
    writeSeen(4, store);
    expect(store.values.get(WHATS_NEW_KEY)).toBe('4');
    expect(readSeen(store)).toBe(4);
    expect(readSeen(memoryStore({ [WHATS_NEW_KEY]: 'soon' }))).toBeNull();
  });

  it('carries on when storage is blocked', () => {
    const blocked = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(readSeen(blocked)).toBeNull();
    expect(() => writeSeen(1, blocked)).not.toThrow();
  });
});

describe("whatsNew.ts's lines", () => {
  it('each have their own whole-number id, newest first, so a device can tell which it has seen', () => {
    for (const entry of WHATS_NEW) expect(Number.isInteger(entry.id) && entry.id > 0, `${entry.id}`).toBe(true);
    for (let i = 1; i < WHATS_NEW.length; i++) expect(WHATS_NEW[i]!.id, WHATS_NEW[i]!.text).toBeLessThan(WHATS_NEW[i - 1]!.id);
  });

  it('are each one short plain sentence, with no pull request or version in it', () => {
    for (const { text } of WHATS_NEW) {
      expect(text, 'starts with a capital and ends with a full stop').toMatch(/^[A-Z].*\.$/);
      expect(text.slice(0, -1), 'one sentence').not.toMatch(/[.!?] /);
      expect(text, 'no pull request number').not.toMatch(/#\d/);
      expect(text, 'no version or commit').not.toMatch(/\b\d+\.\d+\.\d+\b|\b[0-9a-f]{7,}\b/);
      expect(text.length, text).toBeLessThanOrEqual(100);
    }
  });
});

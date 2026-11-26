// What's new: a line for each change someone can use, shown once on each iPhone the first time a bundle with new lines
// runs there (ui/app/WhatsNew.tsx). The lines themselves are in src/whatsNew.ts.

export interface WhatsNewEntry {
  /** Never reused or changed: a device remembers the newest it has seen. Each new line takes the next number. */
  readonly id: number;
  /** One plain sentence saying what someone can now do. */
  readonly text: string;
}

/** Where this device keeps the newest id it has seen. Never synced: each device shows the lines once. */
export const WHATS_NEW_KEY = 'multiscale.whatsNew.seen';

/** The most lines shown at once. Older unseen ones are dropped, so a phone back after months gets a short list. */
export const WHATS_NEW_SHOWN = 6;

export const newestId = (entries: readonly WhatsNewEntry[]): number => entries.reduce((most, e) => Math.max(most, e.id), 0);

/**
 * The lines to show, from entries kept newest first: those newer than the newest seen, at most WHATS_NEW_SHOWN. A device
 * that never recorded one (null) ran the app before What's new existed, so it gets the newest; a new install records
 * the newest as seen during setup instead.
 */
export function unseenEntries(entries: readonly WhatsNewEntry[], seen: number | null): WhatsNewEntry[] {
  return entries.filter((e) => seen === null || e.id > seen).slice(0, WHATS_NEW_SHOWN);
}

type Store = Pick<Storage, 'getItem' | 'setItem'>;

/** The newest id this device has seen, or null if it never recorded one. */
export function readSeen(store: Store = localStorage): number | null {
  try {
    const seen = Number(store.getItem(WHATS_NEW_KEY) ?? NaN);
    return Number.isInteger(seen) ? seen : null;
  } catch {
    return null;
  }
}

export function writeSeen(id: number, store: Store = localStorage): void {
  try {
    store.setItem(WHATS_NEW_KEY, String(id));
  } catch {
    // Storage can be blocked; then the lines show again at the next launch.
  }
}

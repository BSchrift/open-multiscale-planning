// What attachments say about themselves: sizes, the storage used, and the reasons a file can't go up.

const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;

/** One decimal under 10, whole numbers above, in the unit that fits from 1,000 of the one below: 240 KB, 1.2 MB, 1 GB. */
export function formatBytes(bytes: number): string {
  const [size, unit] = bytes >= 1000 * MB ? [bytes / GB, 'GB'] : bytes >= 1000 * KB ? [bytes / MB, 'MB'] : [Math.ceil(bytes / KB), 'KB'];
  const shown = size < 10 && unit !== 'KB' ? Math.round(size * 10) / 10 : Math.round(size);
  return `${shown} ${unit}`;
}

export const usageLine = (used: number, quota: number) => `${formatBytes(used)} of ${formatBytes(quota)} used`;

export const storageFull = (used: number, quota: number) => `Storage full: ${usageLine(used, quota)}. Remove attachments to make room.`;

export const tooLarge = (size: number, max: number) => `This file is ${formatBytes(size)}. Files can be up to ${formatBytes(max)}.`;

/** A link with no name of its own goes by its site. */
export function linkName(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '') || url;
  } catch {
    return url;
  }
}

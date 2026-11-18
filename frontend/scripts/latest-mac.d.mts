// Types for latest-mac.mjs, which stays plain JavaScript so the release pipeline runs it with nothing installed.
import type { AppRecord } from '../src/core/updates';

export function latestMacYml(record: Pick<AppRecord, 'version' | 'file' | 'sha512' | 'size'>, releaseDate?: Date): string;

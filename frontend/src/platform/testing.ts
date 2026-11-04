// A complete Platform for tests: real SQLite in memory, and services a test can drive.

import type { Db } from '../core/db';
import { deepLinks, memoryLifecycle, memoryNotifications, memoryTokens } from './memory';
import type { MemoryLifecycle, MemoryNotifications } from './memory';
import { openTestDb } from './node-sqlite';
import type { Appearance, Platform } from './types';

export interface TestPlatform extends Platform {
  readonly notifications: MemoryNotifications;
  readonly lifecycle: MemoryLifecycle;
  /** Acts as the OS opening a deep link. */
  openDeepLink(url: string): void;
  /** Every URL passed to openExternal. */
  readonly opened: string[];
  /** Every appearance passed to setAppearance. */
  readonly appearances: Appearance[];
}

export async function createTestPlatform(db?: Db): Promise<TestPlatform> {
  const links = deepLinks();
  const opened: string[] = [];
  const appearances: Appearance[] = [];
  return {
    kind: 'test',
    db: db ?? (await openTestDb()),
    notifications: memoryNotifications(),
    tokens: memoryTokens(),
    lifecycle: memoryLifecycle(),
    openExternal: async (url) => void opened.push(url),
    signInRedirectUri: 'multiscale://auth/callback',
    onDeepLink: links.onDeepLink,
    openDeepLink: links.open,
    opened,
    setAppearance: async (appearance) => void appearances.push(appearance),
    appearances,
  };
}

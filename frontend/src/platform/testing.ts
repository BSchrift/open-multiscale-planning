// A complete Platform for tests: real SQLite in memory, and services a test can drive.

import type { Db } from '../core/db';
import { appLinks, deepLinks, memoryFiles, memoryLifecycle, memoryNotifications, memoryTokens } from './memory';
import type { MemoryLifecycle, MemoryNotifications } from './memory';
import { openTestDb } from './node-sqlite';
import type { AppLink } from '../core/appLinks';
import type { Appearance, Platform } from './types';

export interface TestPlatform extends Platform {
  readonly notifications: MemoryNotifications;
  readonly lifecycle: MemoryLifecycle;
  readonly files: ReturnType<typeof memoryFiles>;
  /** Acts as the OS opening a deep link. */
  openDeepLink(url: string): void;
  /** Acts as a widget opening one of the app's links. */
  openAppLink(link: AppLink): void;
  /** Every URL passed to openExternal. */
  readonly opened: string[];
  /** Every appearance passed to setAppearance. */
  readonly appearances: Appearance[];
  /** Every haptic tap the screens asked for, by its strength, which is always light. */
  readonly haptics: 'light'[];
}

export async function createTestPlatform(db?: Db): Promise<TestPlatform> {
  const links = deepLinks();
  const ownLinks = appLinks();
  const opened: string[] = [];
  const appearances: Appearance[] = [];
  const haptics: 'light'[] = [];
  return {
    kind: 'test',
    db: db ?? (await openTestDb()),
    notifications: memoryNotifications(),
    tokens: memoryTokens(),
    lifecycle: memoryLifecycle(),
    files: memoryFiles(),
    openExternal: async (url) => void opened.push(url),
    signInRedirectUri: 'multiscale://auth/callback',
    onDeepLink: links.onDeepLink,
    openDeepLink: links.open,
    onAppLink: ownLinks.onAppLink,
    openAppLink: ownLinks.open,
    opened,
    setAppearance: async (appearance) => void appearances.push(appearance),
    appearances,
    haptic: async () => void haptics.push('light'),
    haptics,
  };
}

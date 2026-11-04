// Picks the adapter at startup. Each loads on demand, so no build carries another platform's native code.

import { Capacitor } from '@capacitor/core';
import type { AppEnv } from '../core/appConfig';
import type { Platform } from './types';

declare global {
  interface Window {
    /** Set by the Electron preload script. */
    multiscaleElectron?: unknown;
  }
}

/** env keeps each environment's data apart where the install doesn't already: Electron's data folder is per environment. */
export async function createPlatform(env: AppEnv): Promise<Platform> {
  if (window.multiscaleElectron) return (await import('./electron')).createElectronPlatform();
  if (Capacitor.isNativePlatform()) return (await import('./capacitor')).createCapacitorPlatform(env);
  return (await import('./web')).createWebPlatform();
}

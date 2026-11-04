// What makes each environment's install its own app: separate name, data folder and sign-in return address.

import type { AppEnv } from '../src/core/appConfig';

const DEFAULT_BUNDLE_ID = 'io.github.bschrift.multiscale';

export interface AppIdentity {
  name: string;
  appId: string;
  scheme: string;
}

export function appIdentity(env: AppEnv, bundleId = DEFAULT_BUNDLE_ID): AppIdentity {
  if (env === 'prod') return { name: 'Multiscale', appId: bundleId, scheme: 'multiscale' };
  const label = env === 'staging' ? 'Staging' : 'Local';
  return { name: `Multiscale ${label}`, appId: `${bundleId}.${env}`, scheme: `multiscale-${env}` };
}

/** electron-builder's settings for one environment. */
export function builderConfig(env: AppEnv, identity: AppIdentity) {
  return {
    appId: identity.appId,
    productName: identity.name,
    directories: { output: `release/${env}`, buildResources: 'electron/assets' },
    files: [
      'dist/**',
      'dist-electron/**',
      'package.json',
      '!**/*.map',
      // Vite and esbuild bundled everything else: only better-sqlite3 loads from node_modules at runtime.
      '!node_modules/**',
      'node_modules/better-sqlite3/{lib/**,package.json,prebuilds/darwin-*.node}',
    ],
    // better-sqlite3 ships a prebuilt Node-API binary that Electron can load, so nothing needs compiling.
    npmRebuild: false,
    protocols: [{ name: identity.name, schemes: [identity.scheme] }],
    mac: {
      target: ['dmg'],
      icon: 'electron/assets/icon.png',
      category: 'public.app-category.productivity',
      // shortcut: ad-hoc signed, which Apple Silicon requires to launch at all; use a Developer ID once there is one.
      identity: '-',
      // Blocks injected libraries and debuggers, which could otherwise decrypt the stored sign-in as this app.
      hardenedRuntime: true,
      extendInfo: { NSUserNotificationAlertStyle: 'alert' },
    },
    // Same reason: no running the app's binary as plain Node, no inspector, no swapped app code.
    electronFuses: {
      runAsNode: false,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      enableEmbeddedAsarIntegrityValidation: true,
      onlyLoadAppFromAsar: true,
    },
    publish: null,
  };
}

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { AppConfig } from './core/appConfig';
import { systemClock } from './core/clock';
import { diagnosticLog, watchErrors } from './core/diagnosticLog';
import { applyRemote, getRecord, transact } from './core/records';
import { configureRetention } from './core/retention';
import type { Fields, RecordChange, RecordType } from './core/types';
import { startAppSync } from './core/syncRunner';
import { createUpdater } from './core/updates';
import { createPlatform } from './platform';
import { Shell } from './ui/app/Shell';
import { AppProvider } from './ui/app/store';
import './ui/styles/index.css';

declare const __APP_CONFIG__: AppConfig;

// First, so startup's own errors are kept for Settings > Export diagnostic log.
watchErrors(diagnosticLog, window, console);
diagnosticLog.add('info', 'app', `Started version ${__APP_CONFIG__.version ?? 'unknown'}`);

const root = createRoot(document.getElementById('root')!);
// Before anything writes: every write works out the record's expiry from it.
configureRetention(__APP_CONFIG__.retention ?? null);

createPlatform(__APP_CONFIG__.env).then(
  (platform) => {
    // An app doesn't zoom: WebKit would zoom in on a focused field, and a pinch could leave the screen zoomed in.
    // The iPhone app's text follows the phone's text-size setting (tokens.css).
    if (platform.kind === 'ios') document.documentElement.dataset.platform = 'ios';
    if (platform.kind === 'ios') document.querySelector('meta[name=viewport]')?.setAttribute('content', 'width=device-width, initial-scale=1, viewport-fit=cover, maximum-scale=1, user-scalable=no');
    // Lets Playwright seed and read records in dev builds and in the performance runner's build (vite build --mode perf).
    // Production bundles drop this branch.
    if (import.meta.env.DEV || import.meta.env.MODE === 'perf') {
      Object.assign(window, {
        multiscaleSeed: (records: readonly { type: RecordType; id?: string; fields: Fields<RecordType> }[]) =>
          transact(platform.db, systemClock, async (w) => {
            for (const r of records) await w.create(r.type, r.fields, r.id);
          }),
        multiscaleRecord: (type: RecordType, id: string) => getRecord(platform.db, type, id),
        // A history straight into the database, as a sync would apply it, clocks and all (core/history-testing.ts).
        multiscaleApply: async (changes: readonly RecordChange[]) => {
          await applyRemote(platform.db, changes);
          platform.db.notifyChanged({ source: 'remote' });
        },
      });
    }
    // Over-the-air updates, in the apps of an environment that publishes them. The disk image is for the Mac only.
    const { releaseUrl, downloadsUrl, version, build, shell } = __APP_CONFIG__;
    const kind = platform.kind === 'electron' || platform.kind === 'ios' ? platform.kind : null;
    const updates =
      platform.updates && kind && releaseUrl && version && build && shell
        ? createUpdater({
            url: releaseUrl,
            version,
            build,
            shell: shell[kind],
            platform: kind,
            native: platform.updates,
            onForeground: platform.lifecycle.onForeground,
            ...(kind === 'electron' && downloadsUrl ? { download: `${downloadsUrl}/Multiscale.dmg` } : {}),
          })
        : undefined;
    // What the exported diagnostic log says about this build and device.
    diagnosticLog.describe({
      app: { version, build, env: __APP_CONFIG__.env },
      platform: platform.kind,
      database: platform.database,
      features: {
        overTheAirUpdates: !!updates,
        attachments: !platform.filesBlocked,
        shareImport: !!platform.shareImport,
        retention: Object.fromEntries(Object.entries(__APP_CONFIG__.retention ?? {}).map(([name, period]) => [name, period.iso])),
      },
    });
    root.render(
      <StrictMode>
        <AppProvider platform={platform} clock={systemClock} sync={startAppSync(platform, systemClock, __APP_CONFIG__, updates ? { updates } : {})} updates={updates}>
          <Shell />
        </AppProvider>
      </StrictMode>,
    );
  },
  (error: unknown) => {
    console.error('Startup failed', error);
    const elsewhere = error instanceof Error && error.name === 'InAnotherTab';
    root.render(<div className="boot">{elsewhere ? error.message : "Couldn't open your data. Restart the app to try again."}</div>);
  },
);

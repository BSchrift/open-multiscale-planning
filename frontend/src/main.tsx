import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { AppConfig } from './core/appConfig';
import { systemClock } from './core/clock';
import { transact } from './core/records';
import type { Fields, RecordType } from './core/types';
import { startAppSync } from './core/syncRunner';
import { createPlatform } from './platform';
import { Shell } from './ui/app/Shell';
import { AppProvider } from './ui/app/store';
import './ui/styles/index.css';

declare const __APP_CONFIG__: AppConfig;

const root = createRoot(document.getElementById('root')!);

createPlatform(__APP_CONFIG__.env).then(
  (platform) => {
    // Lets Playwright seed records in dev builds; production bundles drop this branch.
    if (import.meta.env.DEV) {
      Object.assign(window, {
        multiscaleSeed: (records: readonly { type: RecordType; id?: string; fields: Fields<RecordType> }[]) =>
          transact(platform.db, systemClock, async (w) => {
            for (const r of records) await w.create(r.type, r.fields, r.id);
          }),
      });
    }
    root.render(
      <StrictMode>
        <AppProvider platform={platform} clock={systemClock} sync={startAppSync(platform, systemClock, __APP_CONFIG__)}>
          <Shell />
        </AppProvider>
      </StrictMode>,
    );
  },
  (error: unknown) => {
    console.error('Startup failed', error);
    root.render(<div className="boot">Couldn't open your data. Restart the app to try again.</div>);
  },
);

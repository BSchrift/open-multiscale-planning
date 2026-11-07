// Renders a screen or the whole app in a test, against real SQLite in memory.
//
//   const t = await renderScreen('inbox', { layout: 'phone', seed: async (w) => { await w.create(...) } });
//   expect(await screen.findByText('Paint the fence')).toBeVisible();
//   await t.write((w) => ...);    // anything rendered picks it up, as with a sync
//
// Tests import this file; the app never does.

import { render } from '@testing-library/react';
import type { RenderResult } from '@testing-library/react';
import type { ReactElement } from 'react';
import { Suspense } from 'react';
import { fixedClock } from '../../core/clock';
import { transact, updateSettings } from '../../core/records';
import type { Writer } from '../../core/records';
import { createTestPlatform } from '../../platform/testing';
import type { TestPlatform } from '../../platform/testing';
import type { CaptureShortcut, PlatformKind } from '../../platform/types';
import { ToastProvider } from '../components/Toast';
import { NavProvider, useNav, useOverlay } from './nav';
import type { Nav, Overlay, Route } from './nav';
import { AREAS } from './registry';
import type { AreaId, Layout, Presentation, RouteParams } from './registry';
import { Shell } from './Shell';
import { AppProvider } from './store';
import type { AppSync } from '../../core/syncRunner';
import type { NativeUpdates, Updater } from '../../core/updates';

export interface HarnessOptions {
  layout?: Layout;
  /** Defaults to a Monday afternoon in Chicago, fixed so tests don't depend on today. */
  now?: string;
  zone?: string;
  /** Writes through the normal path before anything renders. */
  seed?(w: Writer): Promise<unknown>;
  /** Leaves first-run setup unfinished. */
  firstRun?: boolean;
  /** Sign-in and sync, usually a stub with vi.fn() methods. Absent by default, as on a device with no backend. */
  sync?: AppSync;
  /** Over-the-air updates as the page sees them. Absent by default, as in a browser. */
  updates?: Updater;
  /** The native side of updates, on the platform. */
  nativeUpdates?: NativeUpdates;
  /** The platform the screens think they're on. */
  kind?: PlatformKind;
  /** The desktop's global capture shortcut. Absent by default, as in a browser. */
  captureShortcut?: CaptureShortcut;
}

export interface Harness extends RenderResult {
  platform: TestPlatform;
  db: TestPlatform['db'];
  clock: ReturnType<typeof fixedClock>;
  write<R>(fn: (w: Writer) => Promise<R>): Promise<R>;
  /** The navigation the rendered tree is using, with the overlay that's open. */
  nav(): Nav & { overlay: Overlay | null };
}

async function prepare(options: HarnessOptions) {
  const clock = fixedClock(options.now ?? '2026-11-02T20:00:00Z', options.zone ?? 'America/Chicago');
  const platform: TestPlatform = Object.assign(
    await createTestPlatform(),
    options.nativeUpdates ? { updates: options.nativeUpdates } : {},
    options.kind ? { kind: options.kind } : {},
    options.captureShortcut ? { captureShortcut: options.captureShortcut } : {},
  );
  const write = <R,>(fn: (w: Writer) => Promise<R>) => transact(platform.db, clock, fn);
  if (!options.firstRun) await write((w) => updateSettings(w, { setup_done_at: '2026-11-01T00:00:00Z' }));
  if (options.seed) await write(options.seed);
  return { clock, platform, write };
}

function harness(
  ui: ReactElement,
  options: HarnessOptions,
  prepared: Awaited<ReturnType<typeof prepare>>,
  getNav: Harness['nav'],
): Harness {
  const { platform, clock, write } = prepared;
  const result = render(
    <AppProvider platform={platform} clock={clock} layout={options.layout ?? 'desktop'} {...(options.sync ? { sync: options.sync } : {})} {...(options.updates ? { updates: options.updates } : {})}>
      {ui}
    </AppProvider>,
  );
  return { ...result, platform, db: platform.db, clock, write, nav: getNav };
}

/** Renders one area on its own, with the same data, toast and navigation context it has in the app. */
export async function renderScreen(
  area: AreaId,
  options: HarnessOptions & { params?: RouteParams; presentation?: Presentation; close?(): void } = {},
): Promise<Harness> {
  const prepared = await prepare(options);
  const layout = options.layout ?? 'desktop';
  const { Screen } = AREAS[area];
  let nav: (Nav & { overlay: Overlay | null }) | undefined;
  const Grab = () => {
    nav = { ...useNav(), overlay: useOverlay() };
    return null;
  };
  return harness(
    <div data-layout={layout}>
      <ToastProvider>
        <NavProvider layout={layout}>
          <Grab />
          <Suspense fallback={null}>
            <Screen
              params={options.params ?? {}}
              layout={layout}
              presentation={options.presentation ?? 'page'}
              close={options.close ?? (() => undefined)}
            />
          </Suspense>
        </NavProvider>
      </ToastProvider>
    </div>,
    options,
    prepared,
    () => nav!,
  );
}

/** Renders the whole app, with navigation. */
export async function renderApp(options: HarnessOptions & { initial?: Route } = {}): Promise<Harness> {
  const prepared = await prepare(options);
  return harness(<Shell {...(options.initial ? { initial: options.initial } : {})} />, options, prepared, () => {
    throw new Error('Use the rendered navigation in renderApp tests');
  });
}

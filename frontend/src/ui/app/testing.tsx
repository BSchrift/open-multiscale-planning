// Renders a screen or the whole app in a test, against real SQLite in memory.
//
//   const t = await renderScreen('inbox', { layout: 'phone', seed: async (w) => { await w.create(...) } });
//   expect(await screen.findByText('Paint the fence')).toBeVisible();
//   await t.write((w) => ...);    // anything rendered picks it up, as with a sync
//
// A task's popup, opened from the screen, renders over it as in the app.
//
// Tests import this file; the app never does.

import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RenderResult } from '@testing-library/react';
import type { ReactElement } from 'react';
import { Suspense } from 'react';
import { vi } from 'vitest';
import { fixedClock } from '../../core/clock';
import { transact, updateSettings } from '../../core/records';
import type { Writer } from '../../core/records';
import { createTestPlatform } from '../../platform/testing';
import type { TestPlatform } from '../../platform/testing';
import type { CaptureShortcut, Platform, PlatformKind, Widgets } from '../../platform/types';
import { HOLD_MS } from '../components/weekgrid';
import { ToastProvider } from '../components/Toast';
import { NavProvider, useNav, useOverlay } from './nav';
import type { Nav, Overlay, Route } from './nav';
import { AREAS } from './registry';
import type { AreaId, Layout, Presentation, RouteParams } from './registry';
import { Shell } from './Shell';
import { AppProvider } from './store';
import type { AppSync } from '../../core/syncRunner';
import type { AppPlace, NativeUpdates, UpdateStatus, Updater } from '../../core/updates';

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
  /** As on a Mac app whose content policy is from before attachments. */
  filesBlocked?: true;
  /** As in the Mac app, where macOS draws a block's menu. */
  showMenu?: Platform['showMenu'];
  /** As on an iPhone with the App Group the widgets read: usually memoryWidgets(). */
  widgets?: Widgets;
  /** When the running bundle was built, in seconds, as main.tsx passes it. */
  build?: number;
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
    options.filesBlocked ? { filesBlocked: true as const } : {},
    options.showMenu ? { showMenu: options.showMenu } : {},
    options.widgets ? { widgets: options.widgets } : {},
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
    <AppProvider platform={platform} clock={clock} layout={options.layout ?? 'desktop'} {...(options.sync ? { sync: options.sync } : {})} {...(options.updates ? { updates: options.updates } : {})} {...(options.build ? { build: options.build } : {})}>
      {ui}
    </AppProvider>,
  );
  return { ...result, platform, db: platform.db, clock, write, nav: getNav };
}

// The page's own clock, read before any test moves it on.
const realNow = performance.now.bind(performance);
let heldFor = 0;
/** Picks from a search of choices, as Belongs to is: its field opens the list, on phone in a sheet, then a click picks. */
export async function pickFrom(field: HTMLElement, option: string) {
  await userEvent.click(field);
  await userEvent.click(await screen.findByRole('option', { name: option }));
}

/**
 * A press held past the hold that lifts a block or card to drag (HOLD_MS), as a person holds before dragging: the
 * page's clock moves on, so the next move lifts it and drags. Time only goes forward, so nothing else minds.
 */
export function holdDown(el: Element, init: PointerEventInit = {}) {
  fireEvent.pointerDown(el, { button: 0, ...init });
  heldFor += HOLD_MS;
  vi.spyOn(performance, 'now').mockImplementation(() => realNow() + heldFor);
}

/**
 * Fake timers for tests that hold a press, so a hold's timer runs when `pass` moves time on rather than whenever a busy
 * machine gets to it. They still move with the real clock, so findBy, waitFor and userEvent work as before.
 */
export const holdTimers = () => void vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });

/**
 * Moves holdTimers' clock on by ms, as a press held that long, and draws whatever the timers set off before it returns.
 * A real wait raced the page: on a busy machine the hold's timer and the wait's ran back to back, and the test looked
 * before the page had drawn the draft.
 */
export const pass = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

/** Renders one area on its own, with the same data, toast and navigation context it has in the app. */
export function renderScreen(
  area: AreaId,
  options: HarnessOptions & { params?: RouteParams; presentation?: Presentation; close?(): void } = {},
): Promise<Harness> {
  const layout = options.layout ?? 'desktop';
  const { Screen } = AREAS[area];
  return renderInApp(
    <Screen params={options.params ?? {}} layout={layout} presentation={options.presentation ?? 'page'} close={options.close ?? (() => undefined)} />,
    options,
    area !== 'task',
  );
}

/**
 * Renders part of a screen, such as a component a calendar opens, with the data, toast and navigation context an area
 * has in the app.
 */
export async function renderInApp(ui: ReactElement, options: HarnessOptions = {}, taskPopups = true): Promise<Harness> {
  const prepared = await prepare(options);
  const layout = options.layout ?? 'desktop';
  let nav: (Nav & { overlay: Overlay | null }) | undefined;
  const Grab = () => {
    nav = { ...useNav(), overlay: useOverlay() };
    return null;
  };
  // A task's popup opens over whatever showed the task, so it renders here as the shell renders it. Other overlays,
  // such as Process, are screens of their own, tested on their own.
  const TaskPopup = () => {
    const overlay = useOverlay();
    const { closeOverlay } = useNav();
    if (overlay?.area !== 'task') return null;
    const { Screen: Popup } = AREAS.task;
    return <Popup params={overlay.params} layout={layout} presentation="overlay" close={closeOverlay} />;
  };
  return harness(
    <div data-layout={layout}>
      <ToastProvider>
        <NavProvider layout={layout}>
          <Grab />
          <Suspense fallback={null}>
            {ui}
            {taskPopups && <TaskPopup />}
          </Suspense>
        </NavProvider>
      </ToastProvider>
    </div>,
    options,
    prepared,
    () => nav!,
  );
}

/** Over-the-air updates in a given state, as the page sees them. Checking finds it up to date. */
export function fakeUpdater(
  initial: UpdateStatus,
  more: { download?: string; app?: { place?: AppPlace | null; built?: number; updated?: { from: number; to: number; settings?: boolean } | null; moved?: boolean } } = {},
) {
  let status = initial;
  const listeners = new Set<() => void>();
  const set = (next: UpdateStatus) => {
    status = next;
    listeners.forEach((l) => l());
    return status;
  };
  const app = more.app && {
    place: () => more.app!.place ?? null,
    built: () => more.app!.built ?? 1762160000,
    restart: vi.fn(async () => undefined),
    install: vi.fn(async () => undefined),
    move: vi.fn(async () => undefined),
    updated: vi.fn(async () => more.app!.updated ?? null),
    moved: vi.fn(async () => more.app!.moved ?? false),
  };
  return {
    version: '0.1.0-aaaaaaa',
    ...(more.download ? { download: more.download } : {}),
    ...(app ? { app } : {}),
    status: () => status,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    check: vi.fn(async () => set({ state: 'current' })),
    apply: vi.fn(async () => undefined),
    rolledBack: vi.fn(async () => null),
    stop: vi.fn(),
    /** Moves it to another state, as a check would. */
    set,
  } satisfies Updater & { set(next: UpdateStatus): UpdateStatus };
}

/** Renders the whole app, with navigation. */
export async function renderApp(options: HarnessOptions & { initial?: Route } = {}): Promise<Harness> {
  const prepared = await prepare(options);
  return harness(<Shell {...(options.initial ? { initial: options.initial } : {})} />, options, prepared, () => {
    throw new Error('Use the rendered navigation in renderApp tests');
  });
}

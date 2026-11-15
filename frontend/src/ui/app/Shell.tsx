// The frame around every screen: navigation for each layout, panes that keep their state, flows and overlays.

import { Component, Suspense, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { inputTime, perf } from '../../core/perf';
import type { Updater } from '../../core/updates';
import { inboxCount } from '../../core/queries';
import { getSettings } from '../../core/records';
import { HowToUpdate } from '../components/HowToUpdate';
import { PlusIcon, TabIcon } from '../components/icons';
import { ToastProvider, useToast } from '../components/Toast';
import { useNativeAppearance } from './appearance';
import { MorePage } from './MorePage';
import { NavProvider, PaneShown, useNav, useOverlay } from './nav';
import type { Route } from './nav';
import { AREAS, FLOW_TABS, tabLabel } from './registry';
import { useKeyboardInset } from './keyboard';
import { useReminders } from './reminders';
import { useShareImport } from './shareImport';
import { SwitchAccount } from './SwitchAccount';
import type { AreaId, Presentation, RouteParams, TabId } from './registry';
import { useApp, useQuery } from './store';
import { useCaptureShortcut } from './captureShortcut';
import { DEFAULT_SHORTCUT, shortcutLabel } from '../../platform/shortcut';

class ScreenBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch(error: unknown) {
    console.error('Screen failed', error);
  }
  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alert" className="stack8">
        <h1>Something went wrong</h1>
        <p className="quiet">Your data is safe. Restart the app to try again.</p>
      </div>
    );
  }
}

function AreaScreen(props: { area: AreaId; params: RouteParams; presentation: Presentation; close(): void }) {
  const { layout } = useApp();
  const { Screen } = AREAS[props.area];
  return (
    <ScreenBoundary>
      <Suspense fallback={null}>
        <Screen params={props.params} layout={layout} presentation={props.presentation} close={props.close} />
      </Suspense>
    </ScreenBoundary>
  );
}

function Pane(props: { route: Route; visible: boolean; isTop: boolean }) {
  const nav = useNav();
  const { route, visible, isTop } = props;
  const ref = useRef<HTMLDivElement>(null);
  const label = tabLabel(route.area);

  // Move focus with the page, so keyboards and screen readers land on what just changed.
  const wasVisible = useRef(visible);
  useEffect(() => {
    if (visible && !wasVisible.current) ref.current?.focus({ preventScroll: true });
    wasVisible.current = visible;
  }, [visible]);

  const signal = useRef(nav.topSignal);
  useEffect(() => {
    if (signal.current !== nav.topSignal && isTop && visible) ref.current?.scrollTo?.({ top: 0 });
    signal.current = nav.topSignal;
  }, [nav.topSignal, isTop, visible]);

  return (
    <div
      ref={ref}
      className="pane"
      role="region"
      tabIndex={-1}
      aria-label={label}
      aria-hidden={!visible}
      // Hidden by visibility rather than display, so a pane's scroll position survives.
      style={visible ? undefined : { visibility: 'hidden' }}
    >
      {nav.backLabel && visible && isTop && (
        <button className="backbtn" type="button" aria-label={`Back to ${nav.backLabel}`} onClick={nav.back}>
          <span aria-hidden="true">‹</span> {nav.backLabel}
        </button>
      )}
      <PaneShown.Provider value={visible}>
        {route.area === 'more' ? (
          <MorePage />
        ) : (
          <AreaScreen area={route.area} params={route.params} presentation="page" close={nav.back} />
        )}
      </PaneShown.Provider>
    </div>
  );
}

function Panes() {
  const nav = useNav();
  const visibleTab = nav.flow ? null : nav.tab;
  const tabs = Object.keys(nav.stacks) as TabId[];
  return (
    <>
      {tabs.map((tab) => {
        const stack = nav.stacks[tab]!;
        return stack.map((route, i) => (
          <Pane
            key={`${tab}:${i}:${route.area}:${JSON.stringify(route.params)}`}
            route={route}
            isTop={i === stack.length - 1}
            visible={tab === visibleTab && i === stack.length - 1}
          />
        ));
      })}
      {nav.flow && (
        <div className="flowpane" role="region" tabIndex={-1} aria-label={AREAS[nav.flow.area].label}>
          <AreaScreen area={nav.flow.area} params={nav.flow.params} presentation="flow" close={nav.closeFlow} />
        </div>
      )}
    </>
  );
}

function useInboxCount(): number {
  return useQuery((sql) => inboxCount(sql), []).data ?? 0;
}

type Input ={ type: string; timeStamp: number; detail?: number };

/** Starts the screen's nav KPI from the tap or click, as docs/performance.md defines it, then goes there. */
function selectTab(nav: ReturnType<typeof useNav>, tab: TabId, event: Input) {
  perf.start(`nav.${tab}`, inputTime(event));
  nav.selectTab(tab);
}

function openCapture(nav: ReturnType<typeof useNav>, event: Input) {
  perf.start('capture.open', inputTime(event));
  nav.openOverlay('capture');
}

const NEW_APP_TITLE = 'Install the new Mac app';
const NEW_APP_LINE = 'One last install by hand. After this, Multiscale updates itself.';
const READY_TITLE = 'Update ready';
const READY_LINE = 'Installs when Multiscale quits or your Mac restarts.';

/**
 * An update that needs the Mac app replaced, at the foot of the sidebar, since a login-item app is rarely quit and
 * Settings alone would hide it for weeks: on today's apps, the new app to install by hand; on an app that replaces
 * itself, a ready update to restart into. Later hides it until the app next opens. Its text goes into a status region
 * that's always there, once, as it appears.
 */
function UpdateNotice(props: { updates: Updater }) {
  const { updates } = props;
  const status = useSyncExternalStore(updates.subscribe, updates.status);
  const [later, setLater] = useState(false);
  const [howTo, setHowTo] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [said, setSaid] = useState('');
  const kind = later ? null : status.state === 'app-ready' && updates.app ? 'ready' : status.state === 'needs-app' && updates.download ? 'new-app' : null;
  const [title, line] = kind === 'ready' ? [READY_TITLE, READY_LINE] : [NEW_APP_TITLE, NEW_APP_LINE];
  useEffect(() => {
    if (kind) setSaid(`${title}. ${line}`);
  }, [kind, title, line]);
  const download = status.state === 'needs-app' ? status.dmg ?? updates.download : undefined;
  return (
    <>
      <div className="sr" role="status">
        {said}
      </div>
      {kind && (
        <div className="updnote">
          <span className="strong">{title}</span>
          <span className="small">{line}</span>
          <div className="row">
            {kind === 'ready' ? (
              <button className="btn sm pri" type="button" disabled={restarting} onClick={() => {
                setRestarting(true);
                void updates.app?.restart();
              }}>
                {restarting ? 'Restarting…' : 'Restart to update'}
              </button>
            ) : (
              <button className="btn sm pri" type="button" onClick={() => setHowTo(true)}>
                How to update
              </button>
            )}
            <button
              className="btn sm"
              type="button"
              aria-label="Later, hide the update notice until Multiscale next opens"
              onClick={(event) => {
                // The button goes with the notice, so focus goes to the page someone was on.
                event.currentTarget.closest('nav')?.querySelector<HTMLElement>('[aria-current="page"]')?.focus();
                setLater(true);
                setSaid('Hidden until Multiscale next opens.');
              }}
            >
              Later
            </button>
          </div>
        </div>
      )}
      {howTo && download && <HowToUpdate download={download} onClose={() => setHowTo(false)} />}
    </>
  );
}

/** "Multiscale updated." the first time the window shows after the app replaced itself: it may open hidden at login. */
function useUpdatedToast() {
  const { updates } = useApp();
  const toast = useToast();
  useEffect(() => {
    const app = updates?.app;
    if (!app) return;
    let shown = false;
    let stop = false;
    const show = () => {
      if (stop || shown || document.visibilityState !== 'visible') return;
      shown = true;
      toast.show('Multiscale updated.');
    };
    void app.updated().then((updated) => {
      if (!updated) return;
      show();
      document.addEventListener('visibilitychange', show);
    });
    return () => {
      stop = true;
      document.removeEventListener('visibilitychange', show);
    };
  }, [updates, toast]);
}

function DesktopNav() {
  const nav = useNav();
  const { updates } = useApp();
  const count = useInboxCount();
  const { shortcut } = useCaptureShortcut();
  const lit = nav.flow ? FLOW_TABS[nav.flow.area] : nav.tab;
  return (
    <nav className="side" aria-label="Main">
      <button className="brand" type="button" onClick={() => nav.selectTab('today')}>
        Multiscale
      </button>
      <div>
        <button className="capture" type="button" aria-keyshortcuts="Shift+Meta+Space" onClick={(e) => openCapture(nav, e)}>
          <PlusIcon />
          <span>Capture</span>
          <span className="key">{shortcutLabel(shortcut?.accelerator ?? DEFAULT_SHORTCUT)}</span>
        </button>
      </div>
      <div className="nav">
        {nav.tabs.map((tab) => {
          const on = tab === lit;
          return (
            <button key={tab} type="button" className={on ? 'on' : ''} aria-current={on ? 'page' : undefined} onClick={(e) => selectTab(nav, tab, e)}>
              <span>{tabLabel(tab)}</span>
              {tab === 'inbox' && count > 0 && <span className="navcount">{count}</span>}
            </button>
          );
        })}
      </div>
      {/* Only the Mac app offers a download or replaces itself. */}
      {(updates?.download || updates?.app) && <UpdateNotice updates={updates} />}
    </nav>
  );
}

function PhoneNav() {
  const nav = useNav();
  const count = useInboxCount();
  if (nav.flow) return null;
  return (
    <>
      <nav className="tabs" aria-label="Main">
        {nav.tabs.map((tab) => {
          const on = nav.tab === tab;
          return (
            <button
              key={tab}
              type="button"
              className={on ? 'on' : ''}
              aria-current={on ? 'page' : undefined}
              aria-label={tab === 'inbox' && count > 0 ? `Inbox, ${count} to sort` : undefined}
              onClick={(e) => selectTab(nav, tab, e)}
            >
              <span className="ticon" aria-hidden="true">
                <TabIcon tab={tab} />
                {tab === 'inbox' && count > 0 && <span className="tbadge">{count}</span>}
              </span>
              <span>{tabLabel(tab)}</span>
            </button>
          );
        })}
      </nav>
      <button className="fab" type="button" aria-label="Capture a task" onClick={(e) => openCapture(nav, e)}>
        <PlusIcon />
      </button>
    </>
  );
}

function Frame() {
  const { layout, platform } = useApp();
  const nav = useNav();
  useReminders();
  useShareImport();
  useKeyboardInset();
  useUpdatedToast();

  useEffect(() => platform.hotkey?.onCapture(() => nav.openOverlay('capture')), [platform, nav.openOverlay]);

  // Back to the app while it's still running: the first frame after, once whatever the return set off has run.
  useEffect(
    () =>
      platform.lifecycle.onForeground(() => {
        perf.start('start.resume');
        perf.stopAfterPaint('start.resume');
      }),
    [platform],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.code === 'Space' && event.shiftKey && event.metaKey) {
        event.preventDefault();
        perf.start('capture.open', event.timeStamp);
        nav.openOverlay('capture');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [nav.openOverlay]);

  return (
    <>
      {layout === 'desktop' && <DesktopNav />}
      <main className="mainarea">
        <Panes />
      </main>
      {layout === 'phone' && <PhoneNav />}
      <OverlayScreen />
    </>
  );
}

/** Its own component, so only it renders when an overlay opens or closes. */
function OverlayScreen() {
  const overlay = useOverlay();
  const nav = useNav();
  // Telemetry reports the screen on show, which is the only place it learns it. Here, as the overlay is only read here.
  const screen = overlay?.area ?? nav.flow?.area ?? nav.route.area;
  useEffect(() => {
    document.documentElement.dataset.screen = screen;
  }, [screen]);
  if (!overlay) return null;
  return <AreaScreen area={overlay.area} params={overlay.params} presentation="overlay" close={nav.closeOverlay} />;
}

/** Setup until first run has finished, then the app. The settings record carries this between devices. */
export function Shell(props: { initial?: Route }) {
  const { layout, platform } = useApp();
  const settings = useQuery((sql) => getSettings(sql), []);
  useNativeAppearance();
  // The data opened and the app drew, so a newly downloaded bundle is kept rather than rolled back.
  const started = settings.data !== undefined;
  useEffect(() => {
    if (started) platform.updates?.ready();
  }, [started, platform]);
  if (!settings.data) {
    return settings.error ? <div className="boot">Couldn't open your data. Restart the app to try again.</div> : null;
  }
  // Toasts sit inside the layout, which is what styles them.
  return (
    <div data-layout={layout}>
      <ToastProvider>
        {settings.data.setup_done_at ? (
          <NavProvider layout={layout} {...(props.initial ? { initial: props.initial } : {})}>
            <Frame />
          </NavProvider>
        ) : (
          <main className="mainarea">
            <div className="pane">
              <AreaScreen area="setup" params={{}} presentation="flow" close={() => undefined} />
            </div>
          </main>
        )}
        <SwitchAccount />
      </ToastProvider>
    </div>
  );
}

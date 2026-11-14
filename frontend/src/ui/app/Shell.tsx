// The frame around every screen: navigation for each layout, panes that keep their state, flows and overlays.

import { Suspense, useEffect, useRef } from 'react';
import { inboxCount } from '../../core/queries';
import { getSettings } from '../../core/records';
import { PlusIcon, TabIcon } from '../components/icons';
import { ToastProvider } from '../components/Toast';
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
import { preloadScreens, ScreenBoundary } from './screenLoad';
import { useApp, useQuery } from './store';
import { useCaptureShortcut } from './captureShortcut';
import { DEFAULT_SHORTCUT, shortcutLabel } from '../../platform/shortcut';

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

function DesktopNav() {
  const nav = useNav();
  const count = useInboxCount();
  const { shortcut } = useCaptureShortcut();
  const lit = nav.flow ? FLOW_TABS[nav.flow.area] : nav.tab;
  return (
    <nav className="side" aria-label="Main">
      <button className="brand" type="button" onClick={() => nav.selectTab('today')}>
        Multiscale
      </button>
      <div>
        <button className="capture" type="button" aria-keyshortcuts="Shift+Meta+Space" onClick={() => nav.openOverlay('capture')}>
          <PlusIcon />
          <span>Capture</span>
          <span className="key">{shortcutLabel(shortcut?.accelerator ?? DEFAULT_SHORTCUT)}</span>
        </button>
      </div>
      <div className="nav">
        {nav.tabs.map((tab) => {
          const on = tab === lit;
          return (
            <button key={tab} type="button" className={on ? 'on' : ''} aria-current={on ? 'page' : undefined} onClick={() => nav.selectTab(tab)}>
              <span>{tabLabel(tab)}</span>
              {tab === 'inbox' && count > 0 && <span className="navcount">{count}</span>}
            </button>
          );
        })}
      </div>
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
              onClick={() => nav.selectTab(tab)}
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
      <button className="fab" type="button" aria-label="Capture a task" onClick={() => nav.openOverlay('capture')}>
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

  useEffect(() => platform.hotkey?.onCapture(() => nav.openOverlay('capture')), [platform, nav.openOverlay]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.code === 'Space' && event.shiftKey && event.metaKey) {
        event.preventDefault();
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
  // The browser fetches each screen's code from the server, so fetch it all once the app has drawn: a screen first
  // opened offline then still opens. The apps carry their code.
  useEffect(() => (started && platform.kind === 'web' ? preloadScreens(Object.values(AREAS).map((a) => a.Screen)) : undefined), [started, platform]);
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

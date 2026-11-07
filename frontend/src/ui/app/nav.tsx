// Navigation, as plain state.
//
//   const nav = useNav();
//   nav.go('goals');                       // that area's root
//   nav.go('goals', { project: id });      // a sub-page: back returns here, even across tabs
//   nav.openFlow('planning');              // full screen on phone; exit returns to where you were
//   nav.openOverlay('capture');            // above everything
//
// Each tab keeps its page and scroll: panes stay mounted but hidden. Tapping the tab you're on goes to its root.

import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { DESKTOP_TABS, PHONE_TABS, tabForArea, tabLabel } from './registry';
import type { AreaId, Layout, RouteParams, TabId } from './registry';

export interface Route {
  area: TabId;
  params: RouteParams;
  /** Set when this route was reached from another tab, which back returns to. */
  returnTab?: TabId;
}

export interface Overlay {
  area: AreaId;
  params: RouteParams;
}

interface NavState {
  tab: TabId;
  stacks: Partial<Record<TabId, Route[]>>;
  flow: Overlay | null;
  /** Bumps when a tab is re-tapped, telling its pane to scroll to the top. */
  topSignal: number;
}

export interface Nav {
  tabs: readonly TabId[];
  tab: TabId;
  route: Route;
  stacks: Partial<Record<TabId, Route[]>>;
  flow: Overlay | null;
  topSignal: number;
  go(area: AreaId, params?: RouteParams): void;
  selectTab(tab: TabId): void;
  back(): void;
  /** Label for the back button, such as More, or null at a tab's root. */
  backLabel: string | null;
  openFlow(area: AreaId, params?: RouteParams): void;
  closeFlow(): void;
  openOverlay(area: AreaId, params?: RouteParams): void;
  closeOverlay(): void;
}

const NavContext = createContext<Nav | null>(null);
// Kept out of Nav, so opening or closing Capture or Process doesn't render every pane and screen again, none of which
// shows it. That took most of the time Capture took to open.
const OverlayContext = createContext<Overlay | null>(null);

export function useNav(): Nav {
  const nav = useContext(NavContext);
  if (!nav) throw new Error('useNav needs a NavProvider');
  return nav;
}

/** The overlay that's open, such as Capture or Process. */
export function useOverlay(): Overlay | null {
  return useContext(OverlayContext);
}

const root = (tab: TabId): Route => ({ area: tab, params: {} });
const stackOf = (state: NavState, tab: TabId): Route[] => state.stacks[tab] ?? [root(tab)];

export function NavProvider(props: { layout: Layout; initial?: Route; children: ReactNode }) {
  const { layout, initial, children } = props;
  const [state, setState] = useState<NavState>(() => {
    const tab = initial ? tabForArea(initial.area, layout) : 'today';
    return {
      tab,
      stacks: { [tab]: initial && initial.area !== tab ? [root(tab), initial] : [initial ?? root(tab)] },
      flow: null,
      topSignal: 0,
    };
  });
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const openOverlay = useCallback((area: AreaId, params: RouteParams = {}) => setOverlay({ area, params }), []);
  const closeOverlay = useCallback(() => setOverlay(null), []);

  const go = useCallback(
    (area: AreaId, params: RouteParams = {}) => {
      setState((s) => {
        const tab = tabForArea(area, layout);
        const isRoot = area === tab && Object.keys(params).length === 0;
        const returnTab = tab === s.tab ? undefined : s.tab;
        const base = stackOf(s, tab);
        const entry: Route = { area, params, ...(returnTab ? { returnTab } : {}) };
        const top = base[base.length - 1]!;
        if (!isRoot && top.area === area && JSON.stringify(top.params) === JSON.stringify(params)) {
          return { ...s, tab, flow: null };
        }
        // A plain visit to a tab shows that tab as it was, unless it needs a specific page.
        const stack = isRoot ? (tab === s.tab ? [root(tab)] : base) : [...base, entry];
        return { ...s, tab, flow: null, stacks: { ...s.stacks, [tab]: stack } };
      });
    },
    [layout],
  );

  const selectTab = useCallback((tab: TabId) => {
    setState((s) =>
      s.tab === tab && !s.flow
        ? { ...s, stacks: { ...s.stacks, [tab]: [root(tab)] }, topSignal: s.topSignal + 1 }
        : { ...s, tab, flow: null, stacks: { ...s.stacks, [tab]: stackOf(s, tab) } },
    );
  }, []);

  const back = useCallback(() => {
    setState((s) => {
      const stack = stackOf(s, s.tab);
      const top = stack[stack.length - 1]!;
      if (stack.length < 2) return s;
      const stacks = { ...s.stacks, [s.tab]: stack.slice(0, -1) };
      return { ...s, stacks, tab: top.returnTab ?? s.tab };
    });
  }, []);

  const value = useMemo<Nav>(() => {
    const stack = stackOf(state, state.tab);
    const route = stack[stack.length - 1]!;
    const previous = stack[stack.length - 2];
    const backLabel = !previous ? null : tabLabel(route.returnTab ?? previous.area);
    return {
      tabs: layout === 'phone' ? PHONE_TABS : DESKTOP_TABS,
      tab: state.tab,
      route,
      stacks: state.stacks,
      flow: state.flow,
      topSignal: state.topSignal,
      go,
      selectTab,
      back,
      backLabel,
      openFlow: (area, params = {}) => setState((s) => ({ ...s, flow: { area, params } })),
      closeFlow: () => setState((s) => ({ ...s, flow: null })),
      openOverlay,
      closeOverlay,
    };
  }, [state, layout, go, selectTab, back, openOverlay, closeOverlay]);

  return (
    <NavContext.Provider value={value}>
      <OverlayContext.Provider value={overlay}>{children}</OverlayContext.Provider>
    </NavContext.Provider>
  );
}

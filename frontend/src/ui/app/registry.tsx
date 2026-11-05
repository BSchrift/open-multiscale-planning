// Every area of the app, each rendered from src/ui/screens/<area>/index.tsx with a default export taking
// ScreenProps. An area's folder belongs to it alone: navigate with useNav and share only through components/.

import { lazy } from 'react';
import type { ComponentType } from 'react';
import CaptureScreen from '../screens/capture';

export type Layout = 'desktop' | 'phone';

export type AreaId =
  | 'today'
  | 'week'
  | 'inbox'
  | 'process'
  | 'capture'
  | 'planning'
  | 'plan'
  | 'goals'
  | 'oneoffs'
  | 'analytics'
  | 'settings'
  | 'setup';

export type RouteParams = Readonly<Record<string, string>>;

/**
 * - page: inside the navigation, on a tab.
 * - flow: full screen with no tab bar on phone, or the main area on desktop.
 * - overlay: above everything, such as Capture and Process.
 */
export type Presentation = 'page' | 'flow' | 'overlay';

export interface ScreenProps {
  params: RouteParams;
  layout: Layout;
  presentation: Presentation;
  /** Leaves a flow or overlay. On a page, goes back if there's somewhere to go. */
  close(): void;
}

export const AREAS: Record<AreaId, { label: string; Screen: ComponentType<ScreenProps> }> = {
  today: { label: 'Today', Screen: lazy(() => import('../screens/today')) },
  week: { label: 'Week', Screen: lazy(() => import('../screens/week')) },
  inbox: { label: 'Inbox', Screen: lazy(() => import('../screens/inbox')) },
  process: { label: 'Process', Screen: lazy(() => import('../screens/process')) },
  // Loaded with the app, unlike the rest: a screen that suspends shows its fallback, and React then holds the screen
  // back for 300ms, so the first capture after launch would open that much late.
  capture: { label: 'Capture', Screen: CaptureScreen },
  planning: { label: 'Plan your week', Screen: lazy(() => import('../screens/planning')) },
  plan: { label: 'Plan', Screen: lazy(() => import('../screens/plan')) },
  goals: { label: 'Goals', Screen: lazy(() => import('../screens/goals')) },
  oneoffs: { label: 'One offs', Screen: lazy(() => import('../screens/oneoffs')) },
  analytics: { label: 'Analytics', Screen: lazy(() => import('../screens/analytics')) },
  settings: { label: 'Settings', Screen: lazy(() => import('../screens/settings')) },
  setup: { label: 'Welcome', Screen: lazy(() => import('../screens/setup')) },
};

export type TabId = AreaId | 'more';

/** Side navigation on desktop, in order. */
export const DESKTOP_TABS: readonly TabId[] = ['today', 'inbox', 'week', 'plan', 'goals', 'oneoffs', 'analytics', 'settings'];

/** The fixed tab bar on phone. Anything else is a row under More. */
export const PHONE_TABS: readonly TabId[] = ['today', 'week', 'inbox', 'goals', 'more'];

export const MORE_ROWS: readonly AreaId[] = ['plan', 'oneoffs', 'analytics', 'settings'];

/** On desktop a flow covers the main area and lights the tab it belongs to. */
export const FLOW_TABS: Partial<Record<AreaId, TabId>> = { planning: 'week', plan: 'plan' };

export function tabLabel(tab: TabId): string {
  return tab === 'more' ? 'More' : AREAS[tab].label;
}

/** The tab an area lives under, which stays lit while it's open. */
export function tabForArea(area: TabId, layout: Layout): TabId {
  if (layout === 'phone' && !PHONE_TABS.includes(area)) return 'more';
  return area;
}

// Every area of the app, each rendered from src/ui/screens/<area>/index.tsx with a default export taking
// ScreenProps. Areas navigate to each other with useNav, and what several of them show lives in components/. A few
// files are another area's own, reused as they are: Today's To schedule is Week's lane, Setup asks for hours and
// Google Calendar as Settings does, and the Schedule step drags blocks on Week's phone day.

import type { ComponentType } from 'react';
import { lazyScreen } from './screenLoad';
// Capture's and a task popup's styles, which stay in the app's first load, in the order they always had there, though
// their code doesn't: arriving with it, after the app's own styles, they'd win where both set the same thing.
import '../components/daychips.css';
import '../components/attachments/attachments.css';
import '../components/notes/notes.css';
import '../components/searchlist.css';
import '../screens/capture/capture.css';
import '../components/oneoff/oneoff.css';
import '../components/menu.css';
import '../components/task/task.css';
import '../components/blocks/missed.css';
import '../screens/task/task.css';

export type Layout = 'desktop' | 'phone';

export type AreaId =
  | 'today'
  | 'week'
  | 'inbox'
  | 'process'
  | 'capture'
  | 'task'
  | 'practice'
  | 'planning'
  | 'plan'
  | 'goals'
  | 'oneoffs'
  | 'notes'
  | 'analytics'
  | 'done'
  | 'settings'
  | 'setup';

export type RouteParams = Readonly<Record<string, string>>;

/**
 * - page: inside the navigation, on a tab.
 * - flow: full screen with no tab bar on phone, or the main area on desktop.
 * - overlay: above everything, such as Capture, Process and a task's popup.
 */
export type Presentation = 'page' | 'flow' | 'overlay';

export interface ScreenProps {
  params: RouteParams;
  layout: Layout;
  presentation: Presentation;
  /** Leaves a flow or overlay. On a page, goes back if there's somewhere to go. */
  close(): void;
}

export const AREAS: Record<AreaId, { label: string; Screen: ComponentType<ScreenProps> & { preload?(): Promise<boolean> } }> = {
  today: { label: 'Today', Screen: lazyScreen(() => import('../screens/today')) },
  week: { label: 'Week', Screen: lazyScreen(() => import('../screens/week')) },
  inbox: { label: 'Inbox', Screen: lazyScreen(() => import('../screens/inbox')) },
  process: { label: 'Process', Screen: lazyScreen(() => import('../screens/process')) },
  // Capture, and a task's popup over whatever showed the task, open at once on a tap: the shell loads them first, in
  // every app, as soon as the app has drawn.
  capture: { label: 'Capture', Screen: lazyScreen(() => import('../screens/capture')) },
  task: { label: 'Task', Screen: lazyScreen(() => import('../screens/task')) },
  // A practice's session or a planning block, opened over whatever named it, such as the Now card. Its code isn't in
  // the app's first load: the calendars that draw it load it with them.
  practice: { label: 'Practice', Screen: lazyScreen(() => import('../screens/practice')) },
  planning: { label: 'Plan your week', Screen: lazyScreen(() => import('../screens/planning')) },
  plan: { label: 'Plan', Screen: lazyScreen(() => import('../screens/plan')) },
  goals: { label: 'Goals', Screen: lazyScreen(() => import('../screens/goals')) },
  oneoffs: { label: 'One offs', Screen: lazyScreen(() => import('../screens/oneoffs')) },
  notes: { label: 'Notes', Screen: lazyScreen(() => import('../screens/notes')) },
  analytics: { label: 'Analytics', Screen: lazyScreen(() => import('../screens/analytics')) },
  done: { label: 'Done', Screen: lazyScreen(() => import('../screens/done')) },
  settings: { label: 'Settings', Screen: lazyScreen(() => import('../screens/settings')) },
  setup: { label: 'Welcome', Screen: lazyScreen(() => import('../screens/setup')) },
};

export type TabId = AreaId | 'more';

/** Side navigation on desktop, in order. */
export const DESKTOP_TABS: readonly TabId[] = ['today', 'inbox', 'week', 'plan', 'goals', 'oneoffs', 'notes', 'analytics', 'done', 'settings'];

/**
 * The fixed tab bar on phone. Anything else is a row under More. Week has no tab of its own: the phone's Today draws the
 * week over its day, and Plan has the week's cards.
 */
export const PHONE_TABS: readonly TabId[] = ['today', 'plan', 'inbox', 'goals', 'more'];

export const MORE_ROWS: readonly AreaId[] = ['oneoffs', 'notes', 'analytics', 'done', 'settings'];

/** On desktop a flow covers the main area and lights the tab it belongs to. */
export const FLOW_TABS: Partial<Record<AreaId, TabId>> = { planning: 'week', plan: 'plan' };

export function tabLabel(tab: TabId): string {
  return tab === 'more' ? 'More' : AREAS[tab].label;
}

/**
 * Where an area opens. On phone, Week is Today's: a link to Week, from the app, a widget, a notification or `#/week`,
 * opens Today on that week, with the same params, such as a task to place or editing this week.
 */
export function areaOn<A extends TabId>(area: A, layout: Layout): A | 'today' {
  return layout === 'phone' && area === 'week' ? 'today' : area;
}

/** The tab an area lives under, which stays lit while it's open. */
export function tabForArea(area: TabId, layout: Layout): TabId {
  if (layout === 'phone' && !PHONE_TABS.includes(area)) return 'more';
  return area;
}

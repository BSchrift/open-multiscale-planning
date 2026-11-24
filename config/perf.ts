// The performance KPIs and their targets, as approved on 14 November 2026 (docs/performance.md): the one list the
// performance runner reports against, the PR check compares with, and the CloudWatch dashboard draws its target lines
// from. Every target is a starting point, report-only until the KPI has two weeks of baseline, then moved to what the
// app does plus some headroom. It imports nothing, so the frontend and the infrastructure can each load it.

export type Platform = 'web-desktop' | 'web-phone' | 'mac' | 'iphone';
export const PLATFORMS: readonly Platform[] = ['web-desktop', 'web-phone', 'mac', 'iphone'];

export type Unit = 'ms' | 'MB' | 'KB' | 'count';

/** One row of a KPI's targets: the platforms and the scenario it holds for. Without a scenario, the default one. */
export interface Target {
  platforms: readonly Platform[];
  scenario?: string;
  p50?: number;
  p95?: number;
  p99?: number;
}

export interface Kpi {
  /** Also its performance.measure name. */
  name: string;
  label: string;
  section: Section;
  unit: Unit;
  /**
   * repeatable: many samples in one session, 100 on a PR and 500 on main and nightly. launch: one per launch, 30 a run.
   * run: one per run, its percentiles from the last 14 nightly runs. build: one exact number a build.
   */
  kind: 'repeatable' | 'launch' | 'run' | 'build';
  /** How much slower its p95 has to be, besides 10%, before the PR check calls it slower. */
  floorMs?: number;
  /** Kept for trends and never compared or gated: sync.push, whose 2-second wait hides a slower push. */
  trendOnly?: true;
  /** Measured nowhere yet, so a run that leaves it out is expected. */
  notYetMarked?: true;
  targets: readonly Target[];
}

/** The dashboard's sections, in docs/performance.md's order. */
export const SECTIONS = [
  { id: 'capture', title: 'Capture' },
  { id: 'start', title: 'Start' },
  { id: 'screens', title: 'Screens: Today, Week, Done and Analytics' },
  { id: 'popup', title: 'Task popup and Process' },
  { id: 'drag', title: 'Calendar drag and drop, and Plan the week' },
  { id: 'sync', title: 'Sync' },
  { id: 'other', title: 'Notifications, memory, web bytes and the server' },
] as const;
export type Section = (typeof SECTIONS)[number]['id'];

/** The data scenarios, and the default a target without one means. */
export const DEFAULT_SCENARIO = 'one-year';

const DESKTOP: readonly Platform[] = ['web-desktop', 'mac'];
const t = (platforms: readonly Platform[], p50: number, p95: number, p99: number, scenario?: string): Target => ({ platforms, p50, p95, p99, ...(scenario ? { scenario } : {}) });

/** Today, Week and Done share their targets; Analytics has its own. One year and five. */
const screen = (name: string, label: string, year: [number, number, number][], five: [number, number, number][]): Kpi => ({
  name,
  label,
  section: 'screens',
  unit: 'ms',
  kind: 'repeatable',
  floorMs: 25,
  targets: [DESKTOP, ['web-phone'] as const, ['iphone'] as const].flatMap((platforms, i) => [
    t(platforms, ...year[i]!),
    t(platforms, ...five[i]!, 'five-year'),
  ]),
});
const QUERY_YEAR: [number, number, number][] = [[80, 120, 200], [150, 250, 400], [120, 200, 300]];
const QUERY_FIVE: [number, number, number][] = [[120, 180, 300], [200, 350, 500], [160, 250, 400]];

/** Quick actions share one shape: desktop and the Mac, the phone browser, the iPhone. */
const quick = (name: string, label: string, section: Section, rows: [number, number, number][], extra: Partial<Kpi> = {}): Kpi => ({
  name,
  label,
  section,
  unit: 'ms',
  kind: 'repeatable',
  floorMs: 5,
  targets: [t(DESKTOP, ...rows[0]!), t(['web-phone'], ...rows[1]!), t(['iphone'], ...rows[2]!)],
  ...extra,
});
const ACTION: [number, number, number][] = [[50, 100, 150], [100, 200, 300], [80, 150, 250]];

export const KPIS: readonly Kpi[] = [
  // Capture
  {
    name: 'capture.open', label: 'Open capture', section: 'capture', unit: 'ms', kind: 'repeatable', floorMs: 5,
    targets: [t(DESKTOP, 16, 33, 50), t(['web-phone'], 33, 66, 100), t(['iphone'], 50, 100, 150)],
  },
  { name: 'capture.global', label: 'Capture from another app', section: 'capture', unit: 'ms', kind: 'repeatable', floorMs: 5, targets: [t(['mac'], 100, 200, 300)] },
  {
    name: 'capture.control', label: 'Capture from Control Center', section: 'capture', unit: 'ms', kind: 'launch', floorMs: 100, notYetMarked: true,
    targets: [t(['iphone'], 400, 700, 1000, 'background'), t(['iphone'], 1200, 2000, 2500, 'not-running')],
  },
  { name: 'capture.share', label: 'Share to the Inbox', section: 'capture', unit: 'ms', kind: 'launch', floorMs: 5, notYetMarked: true, targets: [t(['iphone'], 150, 300, 500)] },
  {
    name: 'capture.key', label: 'Type in capture', section: 'capture', unit: 'ms', kind: 'repeatable', floorMs: 2,
    targets: [t(DESKTOP, 8, 16, 33), t(['web-phone', 'iphone'], 16, 33, 50)],
  },
  {
    name: 'capture.save', label: 'Save a capture', section: 'capture', unit: 'ms', kind: 'repeatable', floorMs: 5,
    targets: [t(DESKTOP, 30, 60, 100), t(['web-phone', 'iphone'], 60, 120, 200)],
  },
  // Start: five years may take 250 ms more at p95.
  {
    name: 'start.cold', label: 'Cold start', section: 'start', unit: 'ms', kind: 'launch', floorMs: 100,
    targets: [
      t(['web-desktop'], 1000, 1500, 2000), t(['web-phone'], 2500, 3500, 5000), t(['mac'], 1200, 1800, 2500), t(['iphone'], 1500, 2500, 3500),
      ...([['web-desktop', 1750], ['web-phone', 3750], ['mac', 2050], ['iphone', 2750]] as const).map(([p, p95]) => ({ platforms: [p], scenario: 'five-year', p95 })),
    ],
  },
  {
    name: 'start.warm', label: 'Warm start', section: 'start', unit: 'ms', kind: 'launch', floorMs: 100,
    targets: [
      t(['web-desktop'], 500, 800, 1200), t(['web-phone'], 1000, 1500, 2000), t(['mac'], 600, 900, 1300), t(['iphone'], 800, 1200, 1800),
      ...([['web-desktop', 1050], ['web-phone', 1750], ['mac', 1150], ['iphone', 1450]] as const).map(([p, p95]) => ({ platforms: [p], scenario: 'five-year', p95 })),
    ],
  },
  { name: 'start.resume', label: 'Back to the app', section: 'start', unit: 'ms', kind: 'launch', floorMs: 100, targets: [t(['mac'], 50, 100, 200), t(['iphone'], 100, 200, 400)] },
  // Screens
  screen('nav.today', 'Today', QUERY_YEAR, QUERY_FIVE),
  screen('nav.week', 'Week', QUERY_YEAR, QUERY_FIVE),
  screen('nav.done', 'Done', QUERY_YEAR, QUERY_FIVE),
  screen('nav.analytics', 'Analytics', [[150, 250, 400], [300, 500, 800], [250, 400, 600]], [[250, 400, 600], [500, 800, 1200], [400, 600, 900]]),
  // Task popup and Process
  quick('popup.open', 'Open a task', 'popup', ACTION, { notYetMarked: true }),
  quick('popup.save', 'Save a task', 'popup', ACTION, { notYetMarked: true }),
  quick('process.step', 'A Process step', 'popup', ACTION, { notYetMarked: true }),
  // Calendar drag and drop, and Plan the week
  {
    name: 'drag.frame', label: 'Drag frame', section: 'drag', unit: 'ms', kind: 'repeatable', floorMs: 2, notYetMarked: true,
    targets: [t(DESKTOP, 16, 33, 50), t(['web-phone'], 16, 33, 66), t(['iphone'], 16, 33, 50)],
  },
  quick('drag.drop', 'Drop to saved', 'drag', ACTION, { notYetMarked: true }),
  quick('plan.step', 'A Plan the week step', 'drag', [[80, 150, 250], [150, 300, 450], [120, 200, 350]], { notYetMarked: true }),
  // Sync, by network
  {
    name: 'sync.send', label: 'Push to the server', section: 'sync', unit: 'ms', kind: 'repeatable', floorMs: 25,
    targets: [t(['web-desktop'], 150, 400, 800, 'good'), t(['web-desktop'], 2200, 3500, 5000, 'slow-3g'), t(['web-desktop'], 300, 2500, 8000, 'flaky')],
  },
  {
    name: 'sync.push', label: 'Local change to the server', section: 'sync', unit: 'ms', kind: 'repeatable', trendOnly: true,
    targets: [t(['web-desktop'], 2150, 2400, 2800, 'good'), t(['web-desktop'], 4200, 5500, 7000, 'slow-3g'), t(['web-desktop'], 2300, 4500, 10000, 'flaky')],
  },
  {
    name: 'sync.pull', label: 'Remote change to the screen', section: 'sync', unit: 'ms', kind: 'repeatable', floorMs: 25,
    targets: [t(DESKTOP, 300, 600, 1000, 'good'), t(['iphone'], 500, 1000, 1500, 'good')],
  },
  {
    name: 'sync.first', label: 'First sync of a big account', section: 'sync', unit: 'ms', kind: 'run', floorMs: 500,
    targets: [{ platforms: DESKTOP, scenario: 'five-year', p50: 10_000 }, { platforms: ['iphone'], scenario: 'five-year', p50: 20_000 }],
  },
  // Notifications, memory, web bytes
  {
    name: 'notify.action', label: 'Notification action to recorded', section: 'other', unit: 'ms', kind: 'launch', floorMs: 25, notYetMarked: true,
    targets: [t(['iphone'], 300, 600, 1000, 'background'), t(['iphone'], 1500, 2500, 3500, 'not-running'), t(['mac'], 100, 200, 300)],
  },
  { name: 'mem.app', label: 'App peak memory', section: 'other', unit: 'MB', kind: 'run', targets: [{ platforms: ['iphone'], p50: 150 }, { platforms: ['iphone'], scenario: 'five-year', p50: 250 }] },
  { name: 'mem.webview', label: 'Web view peak memory', section: 'other', unit: 'MB', kind: 'run', targets: [{ platforms: ['iphone'], p50: 300 }, { platforms: ['iphone'], scenario: 'five-year', p50: 500 }] },
  { name: 'mem.events', label: 'Memory warnings and reloads', section: 'other', unit: 'count', kind: 'run', targets: [{ platforms: ['iphone'], p50: 0 }, { platforms: ['iphone'], scenario: 'five-year', p50: 0 }] },
  { name: 'mem.heap', label: 'Web heap', section: 'other', unit: 'MB', kind: 'run', targets: [{ platforms: DESKTOP, p50: 60 }, { platforms: DESKTOP, scenario: 'five-year', p50: 120 }] },
  { name: 'web.initial', label: 'Page scripts and styles', section: 'other', unit: 'KB', kind: 'build', targets: [{ platforms: ['web-desktop'], p50: 200 }] },
  { name: 'web.firstload', label: 'First-load bytes', section: 'other', unit: 'KB', kind: 'build', targets: [{ platforms: ['web-desktop'], p50: 800 }] },
];

/** API Gateway's responseLatency per route, from staging's access logs under the nightly request mix. Milliseconds. */
export const API_ROUTES: readonly { routes: readonly string[]; request: string; p50: number; p95: number; p99: number }[] = [
  // The access log can't tell a push from a pull, so the /sync graph carries both rows.
  { routes: ['POST /sync'], request: 'A push of up to 99 records', p50: 100, p95: 250, p99: 600 },
  { routes: ['POST /sync'], request: 'A pull of a full page, 500 records', p50: 250, p95: 600, p99: 1200 },
  { routes: ['POST /files/upload', 'POST /files/download'], request: 'One file', p50: 100, p95: 300, p99: 700 },
  { routes: ['GET /files/usage'], request: 'One call', p50: 80, p95: 200, p99: 500 },
  { routes: ['POST /v1/logs'], request: 'A telemetry batch', p50: 50, p95: 150, p99: 400 },
  { routes: ['POST /calendar/refresh'], request: 'Calls Google', p50: 800, p95: 2000, p99: 5000 },
];
/** Lambda init duration, from the functions' own REPORT lines. */
export const LAMBDA_INIT = { p50: 200, p95: 400, p99: 600 };

export const kpi = (name: string): Kpi | undefined => KPIS.find((k) => k.name === name);

/** The target a result is held to: its platform's row for its scenario, else the default scenario's. */
export function targetFor(name: string, platform: Platform, scenario = DEFAULT_SCENARIO): Target | undefined {
  const rows = kpi(name)?.targets.filter((row) => row.platforms.includes(platform)) ?? [];
  return rows.find((row) => (row.scenario ?? DEFAULT_SCENARIO) === scenario) ?? rows.find((row) => !row.scenario);
}

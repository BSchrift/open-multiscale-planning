// The performance KPIs' dashboard (docs/performance.md), in the spec's sections and order: each client KPI's p50, p95
// and p99 per platform and scenario, with its targets from config/perf.ts drawn across, and the server's per-route API
// latency and Lambda init durations from the logs. Only staging has it (config/env's stack.performanceDashboard): its
// nightly publishes CI's results to Multiscale/Perf there, from the perf-data branch (scripts/perf-publish.sh), and
// its request mix is what the per-route targets are for.

import { Duration } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { Color, Dashboard, GraphWidget, LogQueryVisualizationType, LogQueryWidget, Metric, TextWidget } from 'aws-cdk-lib/aws-cloudwatch';
import type { IWidget } from 'aws-cdk-lib/aws-cloudwatch';
import type { ILogGroup } from 'aws-cdk-lib/aws-logs';
import { API_ROUTES, DEFAULT_SCENARIO, KPIS, LAMBDA_INIT, SECTIONS } from '../../config/perf.ts';
import type { Kpi, Section, Target } from '../../config/perf.ts';

/** Where CI's results go, one metric per statistic with the dimensions KPI, Platform and Scenario. */
export const PERF_NAMESPACE = 'Multiscale/Perf';
const STATS = ['p50', 'p95', 'p99'] as const;
const COLORS = { p50: Color.GREEN, p95: Color.ORANGE, p99: Color.RED };
const WIDE = 24;
const GRAPH = 8;

const NOTES: Record<Section, string> = {
  capture:
    "Each KPI's p50, p95 and p99 from CI: main and nightly runs on Linux, the iPhone nightly and the Mac app weekly, which staging's nightly publishes from the perf-data branch. A day's point is the average of that day's runs. The lines across are the targets in config/perf.ts, starting points until they're calibrated on two weeks of baseline. docs/performance.md defines each KPI.",
  start: 'From the launch to Today drawn with its data and taking input. Five years may take 250 ms more at p95 than one.',
  screens: "From the tab's tap or click to the screen drawn with its data. The history-scale test times the queries alone.",
  popup: 'From the tap to the popup or the next card drawn; from Save to the change committed and its toast drawn.',
  drag: "Each frame of a drag on Today's timeline or Week, and from the drop to the block drawn, committed and its toast drawn.",
  sync: 'sync.send is the push alone and the one to watch; sync.push includes the 2-second wait before a push, so it is for trends only.',
  other: 'Notification actions, memory and web bytes from CI, then the server, from staging’s own logs.',
};

const LATER =
  'Real phones and Macs: later. The same measures from real use, timings only, through the app’s telemetry (perf-telemetry in docs/performance.md), will go here beside CI’s.';

/** A KPI's graph for one target row: each platform's p50, p95 and p99, and the row's targets as lines across. */
function graph(kpi: Kpi, target: Target): GraphWidget {
  const scenario = target.scenario ?? DEFAULT_SCENARIO;
  return new GraphWidget({
    title: `${kpi.name}: ${kpi.label}, ${target.platforms.join(', ')}, ${scenario}`,
    width: GRAPH,
    height: 6,
    left: target.platforms.flatMap((platform) =>
      STATS.map(
        (stat) =>
          new Metric({
            namespace: PERF_NAMESPACE,
            metricName: stat,
            dimensionsMap: { KPI: kpi.name, Platform: platform, Scenario: scenario },
            statistic: 'Average',
            period: Duration.days(1),
            label: target.platforms.length > 1 ? `${platform} ${stat}` : stat,
            color: target.platforms.length > 1 ? undefined : COLORS[stat],
          }),
      ),
    ),
    leftYAxis: { label: kpi.unit, showUnits: false, min: 0 },
    leftAnnotations: STATS.filter((stat) => target[stat] !== undefined).map((stat) => ({ value: target[stat]!, label: `${stat} target`, color: COLORS[stat] })),
  });
}

/** Widgets in rows of a full width. */
function rows(widgets: IWidget[]): IWidget[][] {
  const out: IWidget[][] = [];
  let row: IWidget[] = [];
  for (const w of widgets) {
    if (row.reduce((sum, x) => sum + x.width, 0) + w.width > WIDE) {
      out.push(row);
      row = [];
    }
    row.push(w);
  }
  if (row.length) out.push(row);
  return out;
}

/** Per-route API latency from the access logs, and Lambda init from the functions' REPORT lines: both dashboards show them. */
export function serverWidgets(accessLogs: ILogGroup, functionLogs: ILogGroup[]): LogQueryWidget[] {
  return [
    new LogQueryWidget({
      title: 'API latency by route (ms)',
      width: 12,
      height: 6,
      view: LogQueryVisualizationType.TABLE,
      logGroupNames: [accessLogs.logGroupName],
      queryLines: [
        'filter ispresent(latencyMs)',
        'stats count(*) as requests, pct(latencyMs, 50) as p50, pct(latencyMs, 95) as p95, pct(latencyMs, 99) as p99 by route',
        'sort route',
      ],
    }),
    new LogQueryWidget({
      title: 'Lambda cold starts: init duration (ms)',
      width: 12,
      height: 6,
      view: LogQueryVisualizationType.TABLE,
      logGroupNames: functionLogs.map((g) => g.logGroupName),
      queryLines: [
        'filter @type = "REPORT" and ispresent(@initDuration)',
        'stats count(*) as cold_starts, pct(@initDuration, 50) as p50, pct(@initDuration, 95) as p95, pct(@initDuration, 99) as p99 by @log',
      ],
    }),
  ];
}

export function perfDashboard(scope: Construct, name: string, accessLogs: ILogGroup, functionLogs: ILogGroup[]): Dashboard {
  const dashboard = new Dashboard(scope, 'PerformanceDashboard', { dashboardName: name, start: '-P4W' });
  for (const section of SECTIONS) {
    dashboard.addWidgets(new TextWidget({ markdown: `## ${section.title}\n${NOTES[section.id]}`, width: WIDE, height: section.id === 'capture' ? 3 : 2 }));
    const graphs = KPIS.filter((k) => k.section === section.id).flatMap((k) => k.targets.map((target) => graph(k, target)));
    for (const row of rows(graphs)) dashboard.addWidgets(...row);
    if (section.id === 'other') {
      const targets = [
        '### The server',
        "API Gateway's responseLatency by route, from the access logs, under staging's nightly request mix, and Lambda init durations from the functions' logs. Logs Insights draws no target lines, so the targets are here, in ms:",
        '',
        '| Route | Request | p50 | p95 | p99 |',
        '| --- | --- | --- | --- | --- |',
        ...API_ROUTES.map((r) => `| ${r.routes.join(', ')} | ${r.request} | ${r.p50} | ${r.p95} | ${r.p99} |`),
        `| Lambda init | Any route | ${LAMBDA_INIT.p50} | ${LAMBDA_INIT.p95} | ${LAMBDA_INIT.p99} |`,
      ];
      dashboard.addWidgets(new TextWidget({ markdown: targets.join('\n'), width: WIDE, height: 6 }));
      dashboard.addWidgets(...serverWidgets(accessLogs, functionLogs));
      dashboard.addWidgets(
        new LogQueryWidget({
          title: 'POST /sync latency, daily (ms)',
          width: WIDE,
          height: 6,
          view: LogQueryVisualizationType.LINE,
          logGroupNames: [accessLogs.logGroupName],
          queryLines: ['filter route = "POST /sync" and ispresent(latencyMs)', 'stats pct(latencyMs, 50) as p50, pct(latencyMs, 95) as p95, pct(latencyMs, 99) as p99 by bin(1d)'],
        }),
      );
    }
    dashboard.addWidgets(new TextWidget({ markdown: LATER, width: WIDE, height: 1 }));
  }
  return dashboard;
}

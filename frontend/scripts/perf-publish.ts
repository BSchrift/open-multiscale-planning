// CI's performance results, as CloudWatch metric data for the performance dashboard (infrastructure/lib/perf-dashboard.ts):
// each run's p50, p95 and p99 per KPI, platform and scenario in Multiscale/Perf, timed at the run. scripts/perf-publish.sh
// sends the last 13 days of the perf-data branch each night: CloudWatch takes points up to two weeks old, and a point
// sent again changes no average, so a missed night loses nothing.
//   node scripts/perf-publish.ts <perf-data folder> <out folder>   writes one file of up to 1,000 points per request
//   node scripts/perf-publish.ts --summary <summary.json> <out folder>   the same for a run measured on staging just now

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { kpi } from '../../config/perf.ts';
import type { Unit } from '../../config/perf.ts';
import { readRuns } from './perf-data.ts';
import type { Run } from './perf-data.ts';

export interface MetricDatum {
  MetricName: 'p50' | 'p95' | 'p99';
  Dimensions: { Name: 'KPI' | 'Platform' | 'Scenario'; Value: string }[];
  Timestamp: string;
  Value: number;
  Unit: string;
}

const UNITS: Record<Unit, string> = { ms: 'Milliseconds', MB: 'Megabytes', KB: 'Kilobytes', count: 'Count' };
/** PutMetricData's limit per request. */
const PER_REQUEST = 1000;
const WINDOW_DAYS = 13;

/** The runs' points. A/A runs time one build twice, for false alarms, so they're not the app's numbers. */
export function metricData(runs: readonly Run[]): MetricDatum[] {
  return runs
    .filter((run) => run.kind !== 'aa')
    .flatMap((run) =>
      run.rows.flatMap((row) => {
        const k = kpi(row.kpi);
        if (!k) return [];
        const Dimensions: MetricDatum['Dimensions'] = [{ Name: 'KPI', Value: row.kpi }, { Name: 'Platform', Value: row.platform }, { Name: 'Scenario', Value: row.scenario }];
        return (['p50', 'p95', 'p99'] as const).map((MetricName) => ({ MetricName, Dimensions, Timestamp: run.at, Value: row[MetricName], Unit: UNITS[k.unit] }));
      }),
    );
}

/** A summary the nightly measured itself, against staging, which never goes through perf-data. */
export function summaryRun(rows: Run['rows'], at = new Date().toISOString()): Run {
  return { kind: 'staging', commit: process.env.COMMIT ?? 'unknown', runner: 'codebuild', at, rows };
}

export function batches<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += PER_REQUEST) out.push(items.slice(i, i + PER_REQUEST));
  return out;
}

function main(argv: string[]) {
  const summary = argv[0] === '--summary' ? argv[1] : undefined;
  const [dir, out] = summary ? [undefined, argv[2]] : argv;
  if ((!dir && !summary) || !out) throw new Error('Usage: node scripts/perf-publish.ts <perf-data folder> <out folder>, or --summary <summary.json> <out folder>');
  const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString();
  const data = metricData(summary ? [summaryRun(JSON.parse(readFileSync(summary, 'utf8')) as Run['rows'])] : readRuns(dir!, since));
  mkdirSync(out, { recursive: true });
  batches(data).forEach((batch, i) => writeFileSync(join(out, `${String(i).padStart(4, '0')}.json`), JSON.stringify(batch)));
  console.log(`${data.length} points from ${summary ? summary : `the runs since ${since.slice(0, 10)}`}, in ${Math.ceil(data.length / PER_REQUEST)} requests.`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]!).href) process.exit(main(process.argv.slice(2)));

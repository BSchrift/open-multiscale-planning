// The perf-data branch (docs/performance.md): one file per main, nightly, iPhone, Mac or staging run, with each KPI's
// percentiles, and baseline.json, each KPI's median over main's last 10 runs, which trends and the nightly comparisons
// read. Only the main and nightly workflows write it. The CloudWatch dashboard's numbers come from these files too.
//   node scripts/perf-data.ts add <perf-data folder> <summary.json>... --kind main --commit <sha> --runner <runner>
//     [--flagged <file of the A/A's flagged KPIs>]
//   node scripts/perf-data.ts regressions <perf-data folder> <summary.json>...
//   node scripts/perf-data.ts track <baseline.json> <summary.json>

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { kpi } from '../../config/perf.ts';
import type { Row } from './perf-report.ts';

export type Kind = 'main' | 'nightly' | 'ios' | 'mac' | 'staging' | 'aa';

export interface Run {
  kind: Kind;
  commit: string;
  runner: string;
  /** When it ran, as an ISO instant. */
  at: string;
  rows: Row[];
  /** An A/A run's KPIs that its comparison called slower or faster, as "kpi platform scenario": false alarms. */
  flagged?: string[];
}

/** How many of main's runs a baseline is the median of. */
export const BASELINE_RUNS = 10;

const RUNS = 'runs';

/** Adds a run as runs/<day>/<time>-<kind>-<commit>.json, then works out the baseline again. Returns the file's path. */
export function addRun(dir: string, run: Run): string {
  const day = run.at.slice(0, 10);
  const name = `${run.at.slice(11, 19).replaceAll(':', '')}-${run.kind}-${run.commit.slice(0, 7)}.json`;
  mkdirSync(join(dir, RUNS, day), { recursive: true });
  writeFileSync(join(dir, RUNS, day, name), `${JSON.stringify(run, null, 1)}\n`);
  writeFileSync(join(dir, 'baseline.json'), `${JSON.stringify(baseline(readRuns(dir)), null, 1)}\n`);
  return join(RUNS, day, name);
}

/** Every run, oldest first, optionally only those since an instant. */
export function readRuns(dir: string, since?: string): Run[] {
  let days: string[];
  try {
    days = readdirSync(join(dir, RUNS));
  } catch {
    return [];
  }
  return days
    .filter((day) => !since || day >= since.slice(0, 10))
    .flatMap((day) => readdirSync(join(dir, RUNS, day)).map((f) => JSON.parse(readFileSync(join(dir, RUNS, day, f), 'utf8')) as Run))
    .filter((run) => !since || run.at >= since)
    .sort((a, b) => a.at.localeCompare(b.at));
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

/** Each KPI, platform and scenario's median p50, p95 and p99 over main's last BASELINE_RUNS runs that measured it. */
export function baseline(runs: readonly Run[]): (Row & { runs: number })[] {
  const by = new Map<string, Row[]>();
  for (const run of runs.filter((r) => r.kind === 'main')) {
    for (const row of run.rows) {
      const key = `${row.kpi}|${row.platform}|${row.scenario}`;
      by.set(key, [...(by.get(key) ?? []), row].slice(-BASELINE_RUNS));
    }
  }
  return [...by.values()].map((rows) => ({
    kpi: rows[0]!.kpi,
    platform: rows[0]!.platform,
    scenario: rows[0]!.scenario,
    n: rows.reduce((sum, r) => sum + r.n, 0),
    p50: median(rows.map((r) => r.p50)),
    p95: median(rows.map((r) => r.p95)),
    p99: median(rows.map((r) => r.p99)),
    runs: rows.length,
  }));
}

/**
 * The nightly's KPIs whose p95 is more than 10% and the KPI's floor over main's baseline. Without the samples there's no
 * test that they differ, so this is noisier than the PR check's rule; it only emails.
 */
export function regressions(base: readonly Row[], rows: readonly Row[]): string[] {
  return rows.flatMap((r) => {
    const k = kpi(r.kpi);
    const b = base.find((x) => x.kpi === r.kpi && x.platform === r.platform && x.scenario === r.scenario);
    if (!k || k.trendOnly || !b || !(r.p95 > b.p95 * 1.1 && r.p95 - b.p95 > (k.floorMs ?? 0))) return [];
    return [`${r.kpi} on ${r.platform}, ${r.scenario}: p95 ${r.p95} ${k.unit} against a baseline of ${b.p95} ${k.unit} (+${Math.round((r.p95 / b.p95 - 1) * 100)}%)`];
  });
}

/** The weekly macOS run beside Linux's baseline for the Mac app, as a table: whether xvfb's numbers still track a Mac's. */
export function track(linux: readonly Row[], mac: readonly Row[]): string[] {
  return [
    '| KPI | Scenario | macOS p50 | macOS p95 | Linux p50 | Linux p95 | macOS ÷ Linux, p95 |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...mac.map((r) => {
      const l = linux.find((x) => x.kpi === r.kpi && x.platform === r.platform && x.scenario === r.scenario);
      return `| ${r.kpi} | ${r.scenario} | ${r.p50} | ${r.p95} | ${l ? `${l.p50} | ${l.p95} | ${Math.round((r.p95 / l.p95) * 100) / 100}` : '| |'} |`;
    }),
  ];
}

function main(argv: string[]) {
  const [command, dir, ...rest] = argv;
  if (command === 'track' && dir && rest[0]) {
    // node scripts/perf-data.ts track <baseline.json> <the Mac's summary.json>
    console.log(track(JSON.parse(readFileSync(dir, 'utf8')) as Row[], JSON.parse(readFileSync(rest[0], 'utf8')) as Row[]).join('\n'));
    return 0;
  }
  if (command === 'regressions' && dir) {
    // node scripts/perf-data.ts regressions <perf-data folder> <summary.json>...: exits 1 if there are any.
    const base = JSON.parse(readFileSync(join(dir, 'baseline.json'), 'utf8')) as Row[];
    const found = regressions(base, rest.flatMap((file) => JSON.parse(readFileSync(file, 'utf8')) as Row[]));
    console.log(found.length ? `Slower than main's baseline:\n${found.join('\n')}` : "Nothing slower than main's baseline.");
    return found.length ? 1 : 0;
  }
  const option = (name: string) => (rest.includes(name) ? rest[rest.indexOf(name) + 1] : undefined);
  const summaries = rest.filter((arg, i) => !arg.startsWith('--') && !rest[i - 1]?.startsWith('--'));
  if (command !== 'add' || !dir || summaries.length === 0 || !option('--kind') || !option('--commit')) {
    throw new Error('Usage: node scripts/perf-data.ts add <perf-data folder> <summary.json>... --kind <kind> --commit <sha> [--runner <runner>]');
  }
  // One run, from the summaries of the jobs it was split into.
  const rows = summaries.flatMap((file) => JSON.parse(readFileSync(file, 'utf8')) as Row[]);
  const flaggedFile = option('--flagged');
  const flagged = flaggedFile ? readFileSync(flaggedFile, 'utf8').split('\n').filter(Boolean) : undefined;
  const path = addRun(dir, { kind: option('--kind') as Kind, commit: option('--commit')!, runner: option('--runner') ?? 'unknown', at: new Date().toISOString(), rows, ...(flagged ? { flagged } : {}) });
  console.log(`Added ${path}, ${rows.length} rows.`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]!).href) process.exit(main(process.argv.slice(2)));

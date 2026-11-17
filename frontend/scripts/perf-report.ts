// The performance runner's report (docs/performance.md): each KPI's percentiles per build, platform and scenario
// against its target in config/perf.ts, and with two builds, whether the second made each one slower. Report-only: it
// never fails a run on a timing. Reads the raw samples e2e/perf writes, and writes one summary per build, which the main
// and nightly runs keep on the perf-data branch.
//   node scripts/perf-report.ts <raw folder> [--summary <folder>]
//     [--base <build> --head <build> [--again <second round's raw folder>] [--notes <file>] [--markdown <file>]
//      [--flagged <file>]]

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_SCENARIO, kpi, KPIS, targetFor } from '../../config/perf.ts';
import type { Platform } from '../../config/perf.ts';
import { compare, summarize } from './perf-stats.ts';
import type { Summary, Verdict } from './perf-stats.ts';

export interface Raw {
  target: string;
  platform: Platform;
  scenario: string;
  samples: Record<string, number[]>;
}

export interface Row extends Summary {
  kpi: string;
  platform: Platform;
  scenario: string;
}

const order = (a: Row, b: Row) =>
  KPIS.findIndex((k) => k.name === a.kpi) - KPIS.findIndex((k) => k.name === b.kpi) || a.platform.localeCompare(b.platform) || a.scenario.localeCompare(b.scenario);

/** Each KPI's percentiles in one build's raw files. */
export function summaries(raws: readonly Raw[]): Row[] {
  return raws
    .flatMap((raw) => Object.entries(raw.samples).filter(([name, values]) => kpi(name) && values.length > 0).map(([name, values]) => ({ kpi: name, platform: raw.platform, scenario: raw.scenario, ...summarize(values) })))
    .sort(order);
}

const unit = (name: string) => kpi(name)?.unit ?? 'ms';
const show = (name: string, value: number | undefined) => (value === undefined ? '' : `${value} ${unit(name)}`);

/** The table a run prints: each row against its target's p95, over it or not. */
export function table(rows: readonly Row[]): string[] {
  const lines = [['KPI', 'Platform', 'Scenario', 'n', 'p50', 'p95', 'p99', 'Target p95', '']];
  for (const r of rows) {
    const target = targetFor(r.kpi, r.platform, r.scenario);
    const limit = target?.p95 ?? target?.p50;
    const value = target?.p95 === undefined ? r.p50 : r.p95;
    lines.push([r.kpi, r.platform, r.scenario, String(r.n), show(r.kpi, r.p50), show(r.kpi, r.p95), show(r.kpi, r.p99), show(r.kpi, limit), limit === undefined ? '' : value > limit ? 'over, report only' : 'ok']);
  }
  const widths = lines[0]!.map((_, i) => Math.max(...lines.map((l) => l[i]!.length)));
  return lines.map((l) => l.map((cell, i) => cell.padEnd(widths[i]!)).join('  ').trimEnd());
}

export interface Change {
  kpi: string;
  platform: Platform;
  scenario: string;
  base: Summary;
  head: Summary;
  verdict: Verdict;
  change: number;
}

/**
 * Each KPI both builds measured many times, compared by perf-stats' rule. sync.push is for trends, so it's never
 * compared, and one-a-run numbers such as the heap need the nightly's 14 runs.
 */
export function changes(base: readonly Raw[], head: readonly Raw[]): Change[] {
  const out: Change[] = [];
  for (const h of head) {
    const b = base.find((r) => r.platform === h.platform && r.scenario === h.scenario);
    if (!b) continue;
    for (const [name, values] of Object.entries(h.samples)) {
      const k = kpi(name);
      const before = b.samples[name];
      if (!k || k.trendOnly || k.kind === 'run' || k.kind === 'build' || !before?.length || !values.length) continue;
      const { verdict, change } = compare(before, values, k.floorMs ?? 0);
      out.push({ kpi: name, platform: h.platform, scenario: h.scenario, base: summarize(before), head: summarize(values), verdict, change });
    }
  }
  return out.sort((a, b) => order({ ...a, ...a.head }, { ...b, ...b.head }));
}

/** The second round's say: a KPI stays slower or faster only if fresh samples find the same. */
export function confirm(first: readonly Change[], again: readonly Change[]): Change[] {
  return first.map((c) => {
    if (c.verdict === 'unchanged') return c;
    const second = again.find((a) => a.kpi === c.kpi && a.platform === c.platform && a.scenario === c.scenario);
    return second && second.verdict === c.verdict ? c : { ...c, verdict: 'unchanged' };
  });
}

const percent = (x: number) => `${x > 0 ? '+' : '−'}${Math.round(Math.abs(x) * 100)}%`;

/** The PR comment's table: slower and faster first, the rest folded away. */
export function markdown(found: readonly Change[], intro: string, options: { noBase?: boolean; notes?: readonly string[] } = {}): string {
  const footer = [...(options.notes ?? []), 'Report only. To accept a slowdown on purpose, add the `perf-accepted` label and say why under "Performance" in the PR description.'];
  if (options.noBase) return [`**Performance: no comparison.** The base is from before the performance runner, so only this PR was timed. ${intro}`, '', ...footer].join('\n');
  const slower = found.filter((c) => c.verdict === 'slower');
  const faster = found.filter((c) => c.verdict === 'faster');
  const same = found.filter((c) => c.verdict === 'unchanged');
  const row = (c: Change) =>
    `| ${c.kpi} | ${c.platform}${c.scenario === DEFAULT_SCENARIO ? '' : `, ${c.scenario}`} | ${c.base.p50} | ${c.head.p50} | ${c.base.p95} | ${c.head.p95} | ${c.head.p99} | ${c.verdict === 'unchanged' ? 'no change' : `${percent(c.change)} ${c.verdict}`} |`;
  const head = '| KPI | Platform | main p50 | PR p50 | main p95 | PR p95 | PR p99 | |\n| --- | --- | --- | --- | --- | --- | --- | --- |';
  return [
    `**Performance: ${slower.length} slower, ${faster.length} faster, ${same.length} unchanged.** ${intro}`,
    '',
    ...(slower.length + faster.length > 0 ? [head, ...[...slower, ...faster].map(row), ''] : []),
    ...(same.length > 0 ? ['<details><summary>Unchanged</summary>', '', head, ...same.map(row), '', '</details>', ''] : []),
    ...footer,
  ].join('\n');
}

export function readRaw(folder: string): Raw[] {
  return readdirSync(folder)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(folder, f), 'utf8')) as Raw);
}

function main(argv: string[]) {
  const [folder, ...rest] = argv;
  if (!folder) throw new Error('Usage: node scripts/perf-report.ts <raw folder> [--base <build> --head <build>] [--markdown <file>] [--summary <folder>]');
  const option = (name: string) => (rest.includes(name) ? rest[rest.indexOf(name) + 1] : undefined);
  const raws = readRaw(folder);
  const builds = [...new Set(raws.map((r) => r.target))];
  for (const build of builds) {
    const rows = summaries(raws.filter((r) => r.target === build));
    console.log(`\n${build}\n${table(rows).join('\n')}`);
    const out = option('--summary');
    if (out) {
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, `${build}.json`), JSON.stringify(rows, null, 1));
    }
  }
  const [base, head, again] = [option('--base'), option('--head'), option('--again')];
  if (base && head) {
    const compared = (from: readonly Raw[]) => changes(from.filter((r) => r.target === base), from.filter((r) => r.target === head));
    let found = compared(raws);
    if (again && existsSync(again)) found = confirm(found, compared(readRaw(again)));
    const notes = option('--notes') && existsSync(option('--notes')!) ? readFileSync(option('--notes')!, 'utf8').split('\n').filter(Boolean) : [];
    const text = markdown(found, process.env.PERF_INTRO ?? '', { noBase: !raws.some((r) => r.target === base), notes });
    console.log(`\n${text}`);
    const file = option('--markdown');
    if (file) writeFileSync(file, `${text}\n`);
    // An A/A run's false alarms, for the nightly to keep: each KPI called slower or faster, as "kpi platform scenario".
    const flagged = option('--flagged');
    if (flagged) writeFileSync(flagged, found.filter((c) => c.verdict !== 'unchanged').map((c) => `${c.kpi} ${c.platform} ${c.scenario}\n`).join(''));
  }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]!).href) process.exit(main(process.argv.slice(2)));

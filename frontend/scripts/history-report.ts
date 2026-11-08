// The history-scale test's verdict: each number its specs measured against its budget, as a table. Exits 1 when a
// budget is missed, or 0 with HISTORY_REPORT_ONLY=1, and 1 either way when a surface measured nothing. Run by
// scripts/test-history.sh, the numbers in one <surface>.json each in the folder given.
//   node scripts/history-report.ts <folder> [--skip iphone]

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

type Surface = 'web' | 'mac' | 'iphone';
type Measure = 'first_sync_ms' | 'edit_save_ms' | 'today_query_ms' | 'week_query_ms';
type Results = Partial<Record<Surface, Partial<Record<Measure, number>>>>;

const LABELS: Record<Measure, string> = {
  first_sync_ms: 'First sync to a usable app',
  edit_save_ms: 'Edit saved',
  today_query_ms: 'Today query',
  week_query_ms: 'Week query',
};

/** The plan's budgets. docs/performance.md lists them with the baseline. */
export const BUDGETS: { measure: Measure; surface: Surface; budget: number }[] = [
  { measure: 'first_sync_ms', surface: 'web', budget: 10_000 },
  { measure: 'first_sync_ms', surface: 'mac', budget: 10_000 },
  { measure: 'first_sync_ms', surface: 'iphone', budget: 20_000 },
  { measure: 'edit_save_ms', surface: 'web', budget: 50 },
  ...(['today_query_ms', 'week_query_ms'] as const).flatMap((measure) => (['web', 'mac', 'iphone'] as const).map((surface) => ({ measure, surface, budget: 100 }))),
];

/** Seconds for a first sync, milliseconds for the rest. */
const format = (measure: Measure, ms: number) => (measure === 'first_sync_ms' ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);
const formatBudget = (measure: Measure, ms: number) => (measure === 'first_sync_ms' ? `${ms / 1000} s` : `${ms} ms`);

export function report(results: Results, skip: readonly string[]) {
  const rows = [['Budget', 'Surface', 'Measured', 'Budget', '']];
  let missed = 0;
  let missing = 0;
  for (const { measure, surface, budget } of BUDGETS) {
    if (skip.includes(surface)) continue;
    const value = results[surface]?.[measure];
    if (typeof value !== 'number') {
      missing++;
      rows.push([LABELS[measure], surface, 'not measured', formatBudget(measure, budget), '']);
      continue;
    }
    const over = value > budget;
    if (over) missed++;
    rows.push([LABELS[measure], surface, format(measure, value), formatBudget(measure, budget), over ? 'MISSED' : 'ok']);
  }
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((row) => row[i]!.length)));
  const lines = rows.map((row) => row.map((cell, i) => cell.padEnd(widths[i]!)).join('  ').trimEnd());
  return { lines, missed, missing };
}

function main(argv: string[]) {
  const [folder, ...rest] = argv;
  if (!folder) throw new Error('Usage: node scripts/history-report.ts <folder> [--skip iphone]');
  const skipAt = rest.indexOf('--skip');
  const skip = skipAt >= 0 ? (rest[skipAt + 1] ?? '').split(',') : [];
  const results: Results = {};
  for (const surface of ['web', 'mac', 'iphone'] as const) {
    const file = join(folder, `${surface}.json`);
    if (existsSync(file)) results[surface] = JSON.parse(readFileSync(file, 'utf8')) as Results[Surface];
  }
  const { lines, missed, missing } = report(results, skip);
  console.log(lines.join('\n'));
  const reportOnly = process.env.HISTORY_REPORT_ONLY === '1';
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  if (missing > 0) {
    console.error(`${plural(missing, 'number was', 'numbers were')} not measured: see the failing spec above.`);
    return 1;
  }
  if (missed === 0) {
    console.log('Every budget met.');
    return 0;
  }
  if (reportOnly) {
    console.log(`Report only: ${plural(missed, 'budget', 'budgets')} missed.`);
    return 0;
  }
  console.error(`${plural(missed, 'budget', 'budgets')} missed. HISTORY_REPORT_ONLY=1 reports without failing.`);
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]!).href) process.exit(main(process.argv.slice(2)));

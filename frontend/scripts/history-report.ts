// The history-scale test's verdict: each number its specs measured against its budget, as a table. Exits 1 when a
// budget is missed or a surface measured nothing, which HISTORY_REPORT_ONLY=1 only reports, since they're about speed.
// A device that holds fewer records than were seeded, or a history that wasn't seeded, fails either way: that's whether
// the data arrived. Run by scripts/test-history.sh, the numbers in one <surface>.json each in the folder given, and
// what was seeded in facts.json.
//   node scripts/history-report.ts <folder> [--skip iphone]

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

type Surface = 'web' | 'mac' | 'iphone';
type Measure = 'first_sync_ms' | 'edit_save_ms' | 'today_query_ms' | 'week_query_ms' | 'done_query_ms';
type Results = Partial<Record<Surface, Partial<Record<Measure | 'records', number>>>>;

const LABELS: Record<Measure, string> = {
  first_sync_ms: 'First sync to a usable app',
  edit_save_ms: 'Edit saved',
  today_query_ms: 'Today query',
  week_query_ms: 'Week query',
  done_query_ms: 'Done query',
};

const SURFACES = ['web', 'mac', 'iphone'] as const;

/**
 * The plan's budgets. docs/performance.md lists them with the baseline. A report-only one is shown against its budget
 * but never fails a run, missed or not measured.
 */
export const BUDGETS: { measure: Measure; surface: Surface; budget: number; reportOnly?: true }[] = [
  { measure: 'first_sync_ms', surface: 'web', budget: 10_000 },
  { measure: 'first_sync_ms', surface: 'mac', budget: 10_000 },
  { measure: 'first_sync_ms', surface: 'iphone', budget: 20_000 },
  { measure: 'edit_save_ms', surface: 'web', budget: 50 },
  ...(['today_query_ms', 'week_query_ms'] as const).flatMap((measure) => SURFACES.map((surface) => ({ measure, surface, budget: 100 }))),
  ...SURFACES.map((surface) => ({ measure: 'done_query_ms' as const, surface, budget: 100, reportOnly: true as const })),
];

/** Seconds for a first sync, milliseconds for the rest. */
const format = (measure: Measure, ms: number) => (measure === 'first_sync_ms' ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);
const formatBudget = (measure: Measure, ms: number) => (measure === 'first_sync_ms' ? `${ms / 1000} s` : `${ms} ms`);

export function report(results: Results, skip: readonly string[]) {
  const rows = [['Budget', 'Surface', 'Measured', 'Budget', '']];
  let missed = 0;
  let missing = 0;
  for (const { measure, surface, budget, reportOnly } of BUDGETS) {
    if (skip.includes(surface)) continue;
    const value = results[surface]?.[measure];
    if (typeof value !== 'number') {
      if (!reportOnly) missing++;
      rows.push([LABELS[measure], surface, 'not measured', formatBudget(measure, budget), reportOnly ? 'report only' : '']);
      continue;
    }
    const over = value > budget;
    if (over && !reportOnly) missed++;
    const verdict = reportOnly ? (over ? 'missed, report only' : 'ok, report only') : over ? 'MISSED' : 'ok';
    rows.push([LABELS[measure], surface, format(measure, value), formatBudget(measure, budget), verdict]);
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
  const read = (name: string) => {
    const file = join(folder, `${name}.json`);
    return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, number>) : undefined;
  };
  const results: Results = {};
  for (const surface of SURFACES) results[surface] = read(surface);
  const { lines, missed, missing } = report(results, skip);
  console.log(lines.join('\n'));
  const reportOnly = process.env.HISTORY_REPORT_ONLY === '1';
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

  const seeded = read('facts')?.records;
  if (seeded === undefined) {
    console.error("The history wasn't seeded, so no device's records could be checked: see the seed above.");
    return 1;
  }
  // At least, since a server keeps deleted records until its retention purges them, and the seed sends none.
  const short = (['web', 'mac', 'iphone'] as const).filter((surface) => (results[surface]?.records ?? seeded) < seeded);
  for (const surface of short) console.error(`${surface} holds ${results[surface]!.records} of the ${seeded} records seeded.`);
  const slow: string[] = [];
  if (missing > 0) slow.push(`${plural(missing, 'number was', 'numbers were')} not measured: see the failing spec above.`);
  if (missed > 0) slow.push(`${plural(missed, 'budget', 'budgets')} missed.`);
  if (reportOnly && slow.length > 0) console.log(`Report only: ${slow.join(' ')}`);
  else if (slow.length > 0) console.error(`${slow.join(' ')} HISTORY_REPORT_ONLY=1 reports these without failing.`);
  else console.log('Every budget met.');
  return short.length > 0 || (slow.length > 0 && !reportOnly) ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]!).href) process.exit(main(process.argv.slice(2)));

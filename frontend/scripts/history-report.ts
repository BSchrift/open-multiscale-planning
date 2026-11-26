// The history-scale test's verdict: each number its specs measured against its budget, as a table. Exits 1 when a
// budget is missed or a surface measured nothing, which HISTORY_REPORT_ONLY=1 only reports, since they're about speed.
// A device that holds fewer live records than were seeded, or a history that wasn't seeded, fails either way: that's
// whether the data arrived. Live, since a first sync leaves out what was deleted before it began. Run by scripts/test-history.sh, the numbers in one <surface>.json each in the folder given, and
// what was seeded in facts.json.
//   node scripts/history-report.ts <folder> [--skip iphone]

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

type Surface = 'web' | 'mac' | 'iphone';
type Measure = 'first_sync_ms' | 'edit_save_ms' | 'today_query_ms' | 'week_query_ms' | 'week_figures_ms' | 'estimate_drag_ms' | 'done_query_ms' | 'notes_list_ms' | 'notes_search_ms';
/** What a first sync brought down, from the sync API's answers on the web and the Mac, and what each device then held. */
type Count = 'sync_requests' | 'sync_records' | 'sync_deleted' | 'sync_bytes' | 'deleted_records';
type Results = Partial<Record<Surface, Partial<Record<Measure | Count | 'records', number>>>>;

const LABELS: Record<Measure, string> = {
  first_sync_ms: 'First sync to a usable app',
  edit_save_ms: 'Edit saved',
  today_query_ms: 'Today query',
  week_query_ms: 'Week query',
  week_figures_ms: 'Week figures',
  estimate_drag_ms: 'Pick estimate drag, slowest step',
  done_query_ms: 'Done query',
  notes_list_ms: 'Notes list',
  notes_search_ms: 'Notes search',
};

const SURFACES = ['web', 'mac', 'iphone'] as const;

/**
 * The plan's budgets. docs/performance.md lists them with the baseline. A report-only one is shown but never fails a
 * run, missed or not measured, until it has a baseline of its own.
 */
export const BUDGETS: { measure: Measure; surface: Surface; budget: number; reportOnly?: true }[] = [
  { measure: 'first_sync_ms', surface: 'web', budget: 10_000 },
  { measure: 'first_sync_ms', surface: 'mac', budget: 10_000 },
  { measure: 'first_sync_ms', surface: 'iphone', budget: 20_000 },
  { measure: 'edit_save_ms', surface: 'web', budget: 50 },
  ...(['today_query_ms', 'week_query_ms'] as const).flatMap((measure) => SURFACES.map((surface) => ({ measure, surface, budget: 100 }))),
  // What Week works out from its query before it draws, which it does again on every change.
  ...SURFACES.map((surface) => ({ measure: 'week_figures_ms' as const, surface, budget: 100, reportOnly: true as const })),
  // A step of a drag drawn within three frames.
  ...(['web', 'mac'] as const).map((surface) => ({ measure: 'estimate_drag_ms' as const, surface, budget: 50, reportOnly: true as const })),
  ...(['done_query_ms', 'notes_list_ms', 'notes_search_ms'] as const).flatMap((measure) => SURFACES.map((surface) => ({ measure, surface, budget: 100, reportOnly: true as const }))),
];

/** Seconds for a first sync, milliseconds for the rest. */
const format = (measure: Measure, ms: number) => (measure === 'first_sync_ms' ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);
const formatBudget = (measure: Measure, ms: number) => (measure === 'first_sync_ms' ? `${ms / 1000} s` : `${ms} ms`);

const table = (rows: string[][]) => {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((row) => row[i]!.length)));
  return rows.map((row) => row.map((cell, i) => cell.padEnd(widths[i]!)).join('  ').trimEnd());
};

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
    rows.push([LABELS[measure], surface, format(measure, value), formatBudget(measure, budget), over ? (reportOnly ? 'over, report only' : 'MISSED') : 'ok']);
  }
  return { lines: table(rows), missed, missing };
}

/**
 * What each first sync brought down, beside its time: requests, records, deleted records and the bytes on the wire,
 * gzipped or not, then the deleted records the device held after. So a first sync that brings deleted records it needn't,
 * or bytes gzip should have shrunk, shows up.
 */
export function traffic(results: Results, skip: readonly string[]) {
  const rows = [['Surface', 'Requests', 'Records', 'Deleted', 'On the wire', 'Deleted held']];
  const cell = (value: number | undefined, shown: (n: number) => string = String) => (typeof value === 'number' ? shown(value) : 'not measured');
  for (const surface of SURFACES) {
    if (skip.includes(surface)) continue;
    const r = results[surface] ?? {};
    rows.push([
      surface,
      cell(r.sync_requests),
      cell(r.sync_records),
      cell(r.sync_deleted),
      cell(r.sync_bytes, (bytes) => `${(bytes / 1_000_000).toFixed(1)} MB`),
      cell(r.deleted_records),
    ]);
  }
  return table(rows);
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
  console.log(`\n${traffic(results, skip).join('\n')}`);
  const reportOnly = process.env.HISTORY_REPORT_ONLY === '1';
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

  const facts = read('facts');
  if (facts?.records === undefined) {
    console.error("The history wasn't seeded, so no device's records could be checked: see the seed above.");
    return 1;
  }
  const seeded = facts.records - (facts.deleted ?? 0);
  // At least, since a record the seed sent as live may have been made live again elsewhere, never the other way.
  const short = (['web', 'mac', 'iphone'] as const).filter((surface) => (results[surface]?.records ?? seeded) < seeded);
  for (const surface of short) console.error(`${surface} holds ${results[surface]!.records} of the ${seeded} live records seeded.`);
  const slow: string[] = [];
  if (missing > 0) slow.push(`${plural(missing, 'number was', 'numbers were')} not measured: see the failing spec above.`);
  if (missed > 0) slow.push(`${plural(missed, 'budget', 'budgets')} missed.`);
  if (reportOnly && slow.length > 0) console.log(`Report only: ${slow.join(' ')}`);
  else if (slow.length > 0) console.error(`${slow.join(' ')} HISTORY_REPORT_ONLY=1 reports these without failing.`);
  else console.log('Every budget met.');
  return short.length > 0 || (slow.length > 0 && !reportOnly) ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]!).href) process.exit(main(process.argv.slice(2)));

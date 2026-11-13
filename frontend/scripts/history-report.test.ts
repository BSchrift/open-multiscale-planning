import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUDGETS, report } from './history-report';

const script = join(import.meta.dirname, 'history-report.ts');
const within = {
  web: { first_sync_ms: 4000, edit_save_ms: 20, today_query_ms: 30, week_query_ms: 60, done_query_ms: 10 },
  mac: { first_sync_ms: 8000, today_query_ms: 40, week_query_ms: 90, done_query_ms: 12 },
  iphone: { first_sync_ms: 15000, today_query_ms: 80, week_query_ms: 99, done_query_ms: 30 },
};

const facts = { records: 38836 };

/** With what was seeded, unless results gives facts of its own, or none as undefined. */
function run(results: Record<string, object | undefined>, env: Record<string, string> = {}, args: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'history-report-'));
  for (const [name, numbers] of Object.entries({ facts, ...results })) if (numbers) writeFileSync(join(dir, `${name}.json`), JSON.stringify(numbers));
  return spawnSync(process.execPath, [script, dir, ...args], { env: { ...process.env, HISTORY_REPORT_ONLY: '', ...env }, encoding: 'utf8' });
}

describe('history-report', () => {
  it('has the budgets the plan sets', () => {
    expect(BUDGETS.map((b) => `${b.measure} ${b.surface} ${b.budget}${b.reportOnly ? ' report-only' : ''}`)).toEqual([
      'first_sync_ms web 10000',
      'first_sync_ms mac 10000',
      'first_sync_ms iphone 20000',
      'edit_save_ms web 50',
      'today_query_ms web 100',
      'today_query_ms mac 100',
      'today_query_ms iphone 100',
      'week_query_ms web 100',
      'week_query_ms mac 100',
      'week_query_ms iphone 100',
      'estimate_drag_ms web 50 report-only',
      'estimate_drag_ms mac 50 report-only',
      'done_query_ms web 100 report-only',
      'done_query_ms mac 100 report-only',
      'done_query_ms iphone 100 report-only',
    ]);
  });

  it('shows a report-only budget, over it or not measured, without failing', () => {
    const over = run({ ...within, web: { ...within.web, estimate_drag_ms: 240 } });
    expect(over.status).toBe(0);
    expect(over.stdout).toMatch(/Pick estimate drag, slowest step\s+web\s+240 ms\s+50 ms\s+over, report only/);
    expect(over.stdout).toMatch(/Pick estimate drag, slowest step\s+mac\s+not measured\s+50 ms\s+report only/);
    expect(over.stdout).toContain('Every budget met.');
    const within_ = run({ ...within, web: { ...within.web, estimate_drag_ms: 12 } });
    expect(within_.stdout).toMatch(/Pick estimate drag, slowest step\s+web\s+12 ms\s+50 ms\s+ok/);
  });

  it('reports the Done query against its report-only budget, missed or not measured, without failing on it', () => {
    const slow = { ...within, web: { ...within.web, done_query_ms: 140 }, mac: { ...within.mac, done_query_ms: undefined } };
    const result = run(slow);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Done query\s+web\s+140 ms\s+100 ms\s+over, report only/);
    expect(result.stdout).toMatch(/Done query\s+mac\s+not measured\s+100 ms\s+report only/);
    expect(result.stdout).toContain('Every budget met.');
  });

  it('reports each number against its budget and passes when all are within', () => {
    const result = run(within);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('First sync to a usable app');
    expect(result.stdout).toMatch(/web\s+4\.0 s\s+10 s\s+ok/);
    expect(result.stdout).toMatch(/Edit saved\s+web\s+20 ms\s+50 ms\s+ok/);
    expect(result.stdout).toContain('Every budget met.');
  });

  it('fails when a budget is missed, naming it, unless only reporting', () => {
    const slow = { ...within, mac: { ...within.mac, first_sync_ms: 42_500 } };
    const failed = run(slow);
    expect(failed.status).toBe(1);
    expect(failed.stdout).toMatch(/mac\s+42\.5 s\s+10 s\s+MISSED/);
    expect(failed.stderr).toContain('1 budget missed');
    const reported = run(slow, { HISTORY_REPORT_ONLY: '1' });
    expect(reported.status).toBe(0);
    expect(reported.stdout).toMatch(/mac\s+42\.5 s\s+10 s\s+MISSED/);
    expect(reported.stdout).toContain('Report only: 1 budget missed');
  });

  it('fails on a surface that measured nothing, such as an iPhone not usable in time, unless only reporting', () => {
    const { iphone: _, ...rest } = within;
    const failed = run(rest);
    expect(failed.status).toBe(1);
    expect(failed.stdout).toMatch(/iphone\s+not measured/);
    expect(failed.stderr).toContain('3 numbers were not measured');
    const reported = run(rest, { HISTORY_REPORT_ONLY: '1' });
    expect(reported.status).toBe(0);
    expect(reported.stdout).toMatch(/iphone\s+not measured/);
    expect(reported.stdout).toContain('Report only: 3 numbers were not measured');
  });

  it('fails on a device holding fewer records than were seeded, even when only reporting', () => {
    const short = { ...within, web: { ...within.web, records: 37000 }, mac: { ...within.mac, records: 38836 }, iphone: { ...within.iphone, records: 40000 } };
    const result = run(short, { HISTORY_REPORT_ONLY: '1' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('web holds 37000 of the 38836 records seeded.');
    expect(result.stderr).not.toContain('mac holds');
    expect(result.stderr).not.toContain('iphone holds');
  });

  it("fails when the history wasn't seeded, even when only reporting", () => {
    const result = run({ ...within, facts: undefined }, { HISTORY_REPORT_ONLY: '1' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("The history wasn't seeded");
  });

  it('leaves out the surfaces it is told were skipped', () => {
    const { iphone: _, ...rest } = within;
    const result = run(rest, {}, ['--skip', 'iphone']);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('iphone');
  });

  it('formats seconds and milliseconds', () => {
    const lines = report(within, []).lines.join('\n');
    expect(lines).toMatch(/iphone\s+15\.0 s\s+20 s/);
    expect(lines).toMatch(/Week query\s+iphone\s+99 ms\s+100 ms\s+ok/);
  });
});

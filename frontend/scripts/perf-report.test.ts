import { describe, expect, it } from 'vitest';
import { changes, markdown, summaries, table } from './perf-report';
import type { Raw } from './perf-report';

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const raw = (target: string, samples: Record<string, number[]>): Raw => ({ target, platform: 'web-phone', scenario: 'one-year', samples });

describe('the report', () => {
  it("summarizes each KPI in the catalog's order, leaving out names it doesn't know", () => {
    const rows = summaries([raw('pr', { 'nav.week': range(1, 100), 'capture.open': range(1, 100), 'something.else': [1] })]);
    expect(rows.map((r) => r.kpi)).toEqual(['capture.open', 'nav.week']);
    expect(rows[0]).toMatchObject({ n: 100, p50: 50, p95: 95, p99: 99, platform: 'web-phone' });
  });

  it("holds each row to its platform's p95 target, report-only", () => {
    const lines = table(summaries([raw('pr', { 'capture.open': range(1, 100), 'nav.week': range(1, 100) })]));
    expect(lines[0]).toMatch(/^KPI +Platform +Scenario/);
    // capture.open on a phone: 66 ms at p95.
    expect(lines[1]).toMatch(/capture\.open .* 66 ms +over, report only$/);
    // Week on a phone, one year: 250 ms.
    expect(lines[2]).toMatch(/nav\.week .* 250 ms +ok$/);
  });

  it('compares two builds, never sync.push, and writes the PR comment with slower and faster first', () => {
    const base = raw('main', { 'capture.save': range(40, 139), 'nav.week': range(60, 159), 'capture.open': range(20, 119), 'sync.push': range(1, 100) });
    const head = raw('pr', { 'capture.save': range(40, 139).map((x) => x * 1.5), 'nav.week': range(60, 159).map((x) => x * 0.7), 'capture.open': range(20, 119), 'sync.push': range(1, 100).map((x) => x * 3) });
    const found = changes([base], [head]);
    expect(found.map((c) => [c.kpi, c.verdict])).toEqual([['capture.open', 'unchanged'], ['capture.save', 'slower'], ['nav.week', 'faster']]);
    const text = markdown(found, 'On the same runner.');
    expect(text).toMatch(/^\*\*Performance: 1 slower, 1 faster, 1 unchanged\.\*\* On the same runner\./);
    expect(text).toContain('| capture.save | web-phone | 89 | 133.5 | 134 | 201 | 207 | +50% slower |');
    expect(text.indexOf('capture.save')).toBeLessThan(text.indexOf('<details>'));
    expect(text).toContain('`perf-accepted`');
  });
});

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cssViolations, tsxViolations, tally } from './designRules';
import type { Violation } from './designRules';

const rules = (found: Violation[]) => found.map((v) => `${v.rule}: ${v.text}`);

describe('the stylesheet rules', () => {
  it('pass values taken from the tokens', () => {
    const css = `.a { color: var(--ink); background: var(--wash); padding: var(--space-2) var(--space-4); margin: 0 auto;
      gap: calc(var(--space-2) + env(safe-area-inset-bottom)); font-size: var(--fs-body); font-weight: var(--fw-strong);
      border-radius: var(--radius-control); box-shadow: var(--shadow-2); z-index: var(--z-sticky);
      transition: opacity var(--dur-fast) var(--ease); border: 1px solid var(--line); margin-top: -1px; width: 120px; }`;
    expect(rules(cssViolations('a.css', css))).toEqual([]);
  });

  it('pass a ring drawn as a shadow in a token colour, and none at all', () => {
    expect(rules(cssViolations('a.css', '.a { box-shadow: inset 0 0 0 2px var(--focus); } .b { box-shadow: none; }'))).toEqual([]);
  });

  it('report each raw colour, size, space, radius, shadow, layer and duration', () => {
    const css = `.a { color: #fff; background: rgba(0, 0, 0, 0.3); border-color: white; font-size: 13px; font-weight: 600;
      padding: 6px var(--space-2); gap: 10px; border-radius: 10px; box-shadow: 0 2px 8px var(--scrim); z-index: 12;
      transition: transform 0.3s ease; animation: pop 200ms both; }`;
    expect(rules(cssViolations('a.css', css))).toEqual([
      'colour: color: #fff',
      'colour: background: rgba(0, 0, 0, 0.3)',
      'colour: border-color: white',
      'type: font-size: 13px',
      'type: font-weight: 600',
      'spacing: padding: 6px var(--space-2)',
      'spacing: gap: 10px',
      'radius: border-radius: 10px',
      'shadow: box-shadow: 0 2px 8px var(--scrim)',
      'layer: z-index: 12',
      'motion: transition: transform 0.3s ease',
      'motion: animation: pop 200ms both',
    ]);
  });

  it('say where each one is', () => {
    expect(cssViolations('screens/x.css', '.a {\n  color: var(--ink);\n  gap: 6px;\n}')).toEqual([
      { file: 'screens/x.css', line: 3, rule: 'spacing', text: 'gap: 6px' },
    ]);
  });

  it('leave the tokens file and comments alone', () => {
    expect(cssViolations('styles/tokens.css', ':root { --ink: #1e2126; }')).toEqual([]);
    expect(cssViolations('a.css', '/* gap: 6px; color: #fff */ .a { color: var(--ink); }')).toEqual([]);
  });
});

describe('the component rules', () => {
  it('report a text glyph used as an icon', () => {
    const tsx = `export const A = () => <div><span>Done today ›</span>{open ? '▾' : '▸'}<b title="× is fine here">x</b></div>;`;
    expect(rules(tsxViolations('screens/a.tsx', tsx))).toEqual(['glyph: ›', 'glyph: ▾', 'glyph: ▸']);
  });

  it('report a button hand-built with the btn class, outside the design-system components', () => {
    const tsx = `export const A = () => <><button className="btn pri" type="button">Save</button><button className={\`btn \${x}\`}>B</button><button className="icbtn">C</button></>;`;
    expect(rules(tsxViolations('screens/a.tsx', tsx))).toEqual(['button: <button className="btn pri"', 'button: <button className={`btn ${x}`}']);
    expect(tsxViolations('components/ds/Button.tsx', tsx)).toEqual([]);
  });

  it('pass text and buttons that use the shared components', () => {
    const tsx = `export const A = () => <Button variant="primary">Save <Icon name="chevron-right" /></Button>;`;
    expect(tsxViolations('screens/a.tsx', tsx)).toEqual([]);
  });
});

describe('tally', () => {
  it('counts violations by rule and file', () => {
    const v = (rule: string, file: string): Violation => ({ rule, file, line: 1, text: '' });
    expect(tally([v('colour', 'a.css'), v('colour', 'a.css'), v('spacing', 'b.css')])).toEqual({ colour: { 'a.css': 2 }, spacing: { 'b.css': 1 } });
  });
});

// Report-only until the baseline is zero: each run lists what breaks the rules today and what's new since the
// baseline, and fails nothing. DESIGN_BASELINE=write records today's counts as the new baseline.
describe('the app', () => {
  const ui = join(import.meta.dirname, '..');
  const files = readdirSync(ui, { recursive: true, encoding: 'utf8' }).filter((file) => !/\.test\.tsx?$/.test(file));
  const found = files.flatMap((file) => {
    if (file.endsWith('.css')) return cssViolations(file, readFileSync(join(ui, file), 'utf8'));
    if (file.endsWith('.tsx')) return tsxViolations(file, readFileSync(join(ui, file), 'utf8'));
    return [];
  });
  const baselineFile = join(import.meta.dirname, 'design-baseline.json');

  it('report what still breaks the design rules, against the baseline', () => {
    const now = tally(found);
    if (process.env.DESIGN_BASELINE === 'write') writeFileSync(baselineFile, `${JSON.stringify(now, null, 2)}\n`);
    const baseline = JSON.parse(readFileSync(baselineFile, 'utf8')) as Record<string, Record<string, number>>;
    const lines = Object.entries(now).map(([rule, byFile]) => {
      const total = Object.values(byFile).reduce((a, b) => a + b, 0);
      const was = Object.values(baseline[rule] ?? {}).reduce((a, b) => a + b, 0);
      const grew = Object.entries(byFile).filter(([file, n]) => n > (baseline[rule]?.[file] ?? 0));
      return `${rule}: ${total} (baseline ${was})${grew.length ? `; new in ${grew.map(([file]) => file).join(', ')}` : ''}`;
    });
    process.stdout.write(`Design rules, report-only:\n  ${lines.join('\n  ') || 'nothing breaks them'}\n`);
    // DESIGN_LIST=spacing,radius lists each one of those rules, where it is.
    const list = process.env.DESIGN_LIST?.split(',') ?? [];
    if (list.length) process.stdout.write(`${found.filter((v) => list.includes(v.rule)).map((v) => `${v.file}:${v.line} ${v.text}`).join('\n')}\n`);
    expect(found.every((v) => v.file && v.rule)).toBe(true);
  });
});

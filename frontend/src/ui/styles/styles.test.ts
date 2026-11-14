import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ui = join(import.meta.dirname, '..');
const sheets = readdirSync(ui, { recursive: true, encoding: 'utf8' }).filter((file) => file.endsWith('.css'));

describe('the stylesheets', () => {
  // On an iPhone it makes a scrolling area a stacking context, so a sheet opened inside a page sits under the tab bar
  // and the + button, and its buttons can't be tapped. Scrolling has had momentum without it since iOS 13.
  it('never use -webkit-overflow-scrolling', () => {
    expect(sheets.length).toBeGreaterThan(0);
    expect(sheets.filter((file) => readFileSync(join(ui, file), 'utf8').includes('-webkit-overflow-scrolling'))).toEqual([]);
  });

  // iOS has dvh only from 15.4, and ignores a declaration it can't read, so without a vh one before it there's no limit.
  it('give every dvh a vh fallback just before it', () => {
    const missing = sheets.flatMap((file) => {
      const css = readFileSync(join(ui, file), 'utf8').replace(/\s/g, '');
      return [...css.matchAll(/([\w-]+):([^;{}]*dvh[^;{}]*);/g)]
        .filter((m) => !css.slice(0, m.index).endsWith(`${m[1]}:${m[2]!.replaceAll('dvh', 'vh')};`))
        .map((m) => `${file}: ${m[0]}`);
    });
    expect(missing).toEqual([]);
  });

  // A block gone by is struck through only when it was done, on every calendar: Partly, Not done and no answer never are.
  it('strike through only what was done', () => {
    const struck = sheets.flatMap((file) =>
      readFileSync(join(ui, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('}')
        .filter((rule) => rule.includes('line-through'))
        .flatMap((rule) => rule.split('{')[0]!.split(','))
        .filter((selector) => !/\.done\b/.test(selector))
        .map((selector) => `${file}: ${selector.trim()}`),
    );
    expect(struck).toEqual([]);
  });

  // The current-time line passes behind blocks, so it never strikes through the block under way, and only its dot is
  // drawn in front. Each calendar draws the line before its blocks, so the line takes no z-index of its own (which would
  // lift it, dot and all, over them); the dot takes one. Phone Week's rows hold a block in the flow, under anything
  // positioned, so there the line is left out of a row that holds one, and only the dot shows. Neither takes a pointer.
  it('draw the current-time line behind blocks, with only its dot in front, and let pointers through', () => {
    const rules = sheets.flatMap((file) =>
      readFileSync(join(ui, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('}')
        .filter((rule) => rule.includes('.nowline'))
        .map((rule) => rule.split('{').map((part) => part.trim()) as [string, string]),
    );
    const style = (selector: string) => rules.find(([sel]) => sel === selector)?.[1] ?? '';
    expect(style('.nowline')).toMatch(/pointer-events:none/);
    expect(rules.filter(([, body]) => /z-index/.test(body)).map(([sel]) => sel)).toEqual(['.nowline i']);
    expect(rules.some(([sel, body]) => /\.tlrow:has\(\.tlblock\)\s*>\s*\.nowline$/.test(sel) && /background:\s*none/.test(body))).toBe(true);
  });

  // Dark mode reaches only colours that come from tokens.css. Black shadows suit both themes, and the select's
  // mid-grey chevron, inside an image, is 3:1 on both themes' fields.
  it('take every colour from the tokens', () => {
    const raw = /#[0-9a-f]{3,8}\b|rgba?\((?!var\(|0, ?0, ?0|0 0 0)|%23(?!777')|(stroke|fill)='white'/i;
    const found = sheets
      .filter((file) => !file.endsWith('tokens.css'))
      .flatMap((file) => readFileSync(join(ui, file), 'utf8').split('\n').flatMap((line, i) => (raw.test(line) ? [`${file}:${i + 1}`] : [])));
    expect(found).toEqual([]);
  });
});

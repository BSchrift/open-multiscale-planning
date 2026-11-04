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

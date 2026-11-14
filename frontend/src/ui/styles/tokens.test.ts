import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(import.meta.dirname, 'tokens.css'), 'utf8');

function block(selector: string): Map<string, string> {
  const at = css.indexOf(`${selector} {`);
  if (at < 0) throw new Error(`tokens.css has no ${selector} block`);
  const body = css.slice(at, css.indexOf('}', at)).replace(/\/\*[\s\S]*?\*\//g, '');
  return new Map([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
}

const light = block(':root');
const themes = {
  light,
  // The system's dark, unless Light was chosen; and Dark chosen on a light system. They must say the same thing.
  dark: block(":root:not([data-theme='light'])"),
  chosenDark: block(":root[data-theme='dark']"),
};

// WCAG 2 relative luminance and contrast ratio.
function luminance(hex: string): number {
  const full = hex.length === 4 ? `#${[...hex.slice(1)].map((c) => c + c).join('')}` : hex;
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(full.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

const BODY = 4.5;
const PART = 3;
// [text or part, the background it sits on, the least contrast it needs], from the rules that pair them.
const PAIRS: [string, string, number][] = [
  ...['page', 'white', 'panel', 'closed', 'hover', 'fill', 'blue-pale', 'blue-tint'].map((bg): [string, string, number] => ['ink', bg, BODY]),
  ...['page', 'white', 'panel', 'hover'].map((bg): [string, string, number] => ['ink-2', bg, BODY]),
  ...['page', 'white', 'panel', 'closed', 'track', 'hover'].map((bg): [string, string, number] => ['quiet', bg, BODY]),
  // Screens sit on --ground in place of the page, so it carries the page's pairs.
  ...['ink', 'ink-2', 'quiet', 'blue', 'blue-hover', 'red', 'amber-ink'].map((fg): [string, string, number] => [fg, 'ground', BODY]),
  // A project opened inside its goal's card sits on --track.
  ...['ink', 'ink-2', 'blue', 'red'].map((fg): [string, string, number] => [fg, 'track', BODY]),
  ['blue', 'page', BODY],
  ['blue', 'white', BODY],
  ['blue', 'panel', BODY],
  ['blue-hover', 'page', BODY],
  ['white', 'blue', BODY],
  ['white', 'purple', BODY],
  ['white', 'ink', BODY],
  ['blue-on-dark', 'ink', BODY],
  ['blue-on-solid', 'blue', BODY],
  ['blue-ink', 'white', BODY],
  ['blue-ink', 'blue-pale', BODY],
  ['blue-ink', 'blue-soft', BODY],
  ['blue-ink', 'blue-tint', BODY],
  ['purple', 'white', BODY],
  ['white', 'orange', BODY],
  ['purple-ink', 'purple-soft', BODY],
  ['purple-ink', 'purple-pale', BODY],
  ['teal-ink', 'teal-soft', BODY],
  ['red', 'red-tint', BODY],
  ['red', 'page', BODY],
  ['red', 'white', BODY],
  ['red-dark', 'red-tint', BODY],
  // A danger button: red on the raised surface, or the reverse when it's the confirming one.
  ['white', 'red', BODY],
  ['white', 'red-dark', BODY],
  ['amber-ink', 'amber-soft', BODY],
  ['amber-ink', 'page', BODY],
  ['amber-ink', 'white', BODY],
  ['amber-ink-2', 'amber-pale', BODY],
  ['amber-ink-2', 'ground', BODY], // Week's note on a moved block, under the list while editing.
  ['green', 'green-soft', BODY],
  ['neutral-ink', 'neutral', BODY],
  // Focus rings, checkbox rings, bars and meters. The block being placed on the grid, and in the chosen day's strip.
  ['orange', 'white', PART],
  ['orange', 'blue-tint', PART],
  ['blue', 'blue-tint', PART],
  ['grey', 'white', PART],
  ['grey', 'track', PART], // A met milestone's diamond in an open project's inset panel.
  ...['blue', 'teal', 'purple', 'amber', 'green'].map((part): [string, string, number] => [part, 'fill', PART]),
  // The Projects step's meter sits on the ground with a white track.
  ['amber', 'white', PART],
  ['red', 'red-soft', PART],
];

describe('the colour tokens', () => {
  it('give dark the same names as light, the same whichever way dark was reached', () => {
    const colours = [...light.keys()].filter((name) => !/^--(font|text-|space-|radius|tap)/.test(name));
    expect([...themes.dark.keys()].sort()).toEqual(colours.sort());
    expect(themes.chosenDark).toEqual(themes.dark);
  });

  it('give cards their line and shadow', () => {
    expect([...light.keys()]).toEqual(expect.arrayContaining(['--card-line', '--card-shadow']));
  });

  it('set the matching color-scheme, so scrollbars and form controls follow', () => {
    expect(css).toMatch(/:root \{\s*color-scheme: light;/);
    expect(css).toMatch(/:root:not\(\[data-theme='light'\]\) \{\s*color-scheme: dark;/);
    expect(css).toMatch(/:root\[data-theme='dark'\] \{\s*color-scheme: dark;/);
  });

  describe.each(['light', 'dark'] as const)('in %s', (theme) => {
    const value = (name: string) => themes[theme].get(`--${name}`) ?? '';
    it.each(PAIRS)('%s on %s meets %s:1', (fg, bg, least) => {
      expect(value(fg)).toMatch(/^#[0-9a-f]{3,6}$/);
      expect(contrast(value(fg), value(bg))).toBeGreaterThanOrEqual(least);
    });

    // The focus ring around a toast's button sits on the toast, which is ink, so the usual blue ring won't do.
    it.each(['.toastact', '.pktoast button'])('ring a focused %s at 3:1 on its toast', (button) => {
      const rules = readFileSync(join(import.meta.dirname, 'shell.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').split('}');
      const rule = rules.find((r) => r.split('{')[0]!.split(',').some((s) => s.trim() === `${button}:focus-visible`));
      const ring = /outline-color: var\(--([\w-]+)\)/.exec(rule ?? '')?.[1] ?? 'blue';
      expect(contrast(value(ring), value('ink'))).toBeGreaterThanOrEqual(PART);
    });

    // The hour sliders' handles drop the usual ring for one drawn round the handle, so that ring has to show on the card.
    it('ring a focused hour handle at 3:1 on its card', () => {
      const css = readFileSync(join(import.meta.dirname, '../screens/settings/settings.css'), 'utf8');
      const rings = [...css.matchAll(/:focus-visible::-(?:webkit-slider|moz-range)-thumb\s*\{[^}]*radial-gradient\(([^;]*)\);/g)].map(
        (m) => [...m[1]!.matchAll(/var\(--([\w-]+)\)/g)].at(-1)![1]!,
      );
      expect(rings).toHaveLength(2);
      for (const ring of rings) expect(contrast(value(ring), value('white'))).toBeGreaterThanOrEqual(PART);
    });

    // An icon button with no fill, such as a planning row's Delete, is only its icon, so the icon is what has to show.
    it('draw every icon button at 3:1 on its card', () => {
      const ui = join(import.meta.dirname, '..');
      const sheets = readdirSync(ui, { recursive: true, encoding: 'utf8' }).filter((file) => file.endsWith('.css'));
      const colours = sheets.flatMap((file) =>
        readFileSync(join(ui, file), 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .split('}')
          .filter((rule) => /\.icbtn(?![\w-])(?![^{]*:(disabled|hover))[^{]*\{/.test(rule))
          .flatMap((rule) => [...rule.matchAll(/(?:^|[;{\s])color:\s*var\(--([\w-]+)\)/g)].map((m) => `${file}: ${m[1]}`)),
      );
      expect(colours.length).toBeGreaterThan(0);
      expect(colours.filter((c) => contrast(value(c.split(': ')[1]!), value('white')) < PART)).toEqual([]);
    });
  });
});

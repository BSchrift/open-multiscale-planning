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

// The 27 colour roles, as docs/design.md lists them. A new one means a new role in the design, not a new shade.
const ROLES = [
  'ground', 'card', 'raised',
  'ink', 'ink-2', 'ink-3',
  'line',
  'accent', 'on-accent', 'accent-text', 'accent-tint', 'focus',
  'project', 'project-tint', 'project-ink', 'practice', 'practice-tint', 'practice-ink', 'oneoff', 'oneoff-tint', 'oneoff-ink', 'on-kind', 'placing',
  'danger', 'warn', 'ok', 'ink-action',
];
// Colours made from the roles: [name, the colour, its strength, or for an opaque mix the colour mixed into the second].
const DERIVED: [string, string, number, string?][] = [
  ['hairline', 'ink', 0.11],
  ['wash', 'ink', 0.07],
  ['pressed', 'ink', 0.13],
  ['accent-hover', 'ink', 0.18, 'accent'],
  ['danger-tint', 'danger', 0.14],
  ['warn-tint', 'warn', 0.14],
  ['ok-tint', 'ok', 0.14],
  ['placing-tint', 'placing', 0.16],
];
const EFFECTS = ['shadow-1', 'shadow-2', 'shadow-3', 'scrim', 'check'];
const colourNames = [...ROLES, ...DERIVED.map(([name]) => name), ...EFFECTS].map((name) => `--${name}`);

type Rgba = [number, number, number, number];
function parse(colour: string): Rgba {
  const hex = colour.slice(1);
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
  return [r!, g!, b!, full.length === 8 ? parseInt(full.slice(6), 16) / 255 : 1];
}
/** A colour laid over an opaque one, as the screen shows it. */
function over([r, g, b, a]: Rgba, [R, G, B]: Rgba): Rgba {
  return [r * a + R * (1 - a), g * a + G * (1 - a), b * a + B * (1 - a), 1];
}
// WCAG 2 relative luminance and contrast ratio.
function luminance([r, g, b]: Rgba): number {
  const [R, G, B] = [r, g, b].map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * R! + 0.7152 * G! + 0.0722 * B!;
}
const contrast = (a: Rgba, b: Rgba) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};
// CIE76 colour difference, through Lab: under about 3 two colours can't be told apart by eye.
function lab([r, g, b]: Rgba): [number, number, number] {
  const lin = [r, g, b].map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  const xyz = [
    (0.4124 * lin[0] + 0.3576 * lin[1] + 0.1805 * lin[2]) / 0.95047,
    0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2],
    (0.0193 * lin[0] + 0.1192 * lin[1] + 0.9505 * lin[2]) / 1.08883,
  ].map((t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116)) as [number, number, number];
  return [116 * xyz[1] - 16, 500 * (xyz[0] - xyz[1]), 200 * (xyz[1] - xyz[2])];
}
const deltaE = (a: Rgba, b: Rgba) => Math.hypot(...lab(a).map((v, i) => v - lab(b)[i]!));

const BODY = 4.5;
const PART = 3;
// [text or part, the surface it sits on, the least contrast it needs]. A derived colour is laid over the card.
const PAIRS: [string, string, number][] = [
  ...['ground', 'card', 'raised', 'wash', 'pressed', 'accent-tint'].map((bg): [string, string, number] => ['ink', bg, BODY]),
  ...['ground', 'card', 'raised', 'wash'].map((bg): [string, string, number] => ['ink-2', bg, BODY]),
  ...['ground', 'card', 'raised', 'wash'].map((bg): [string, string, number] => ['ink-3', bg, BODY]),
  ...['ground', 'card', 'raised', 'accent-tint'].map((bg): [string, string, number] => ['accent-text', bg, BODY]),
  ['on-accent', 'accent', BODY],
  ['on-accent', 'accent-hover', BODY],
  ['project-ink', 'project-tint', BODY],
  ['project-ink', 'accent-tint', BODY],
  ['project-ink', 'card', BODY],
  ['practice-ink', 'practice-tint', BODY],
  ['oneoff-ink', 'oneoff-tint', BODY],
  ...['project', 'practice', 'oneoff', 'placing'].map((bg): [string, string, number] => ['on-kind', bg, BODY]),
  ['ink', 'placing-tint', BODY],
  ...['card', 'ground', 'danger-tint'].map((bg): [string, string, number] => ['danger', bg, BODY]),
  ...['card', 'ground', 'wash', 'warn-tint'].map((bg): [string, string, number] => ['warn', bg, BODY]),
  ...['card', 'ok-tint'].map((bg): [string, string, number] => ['ok', bg, BODY]),
  // A confirming Delete is filled; the toast is the reverse of the page, with Undo in its own colour.
  ['card', 'danger', BODY],
  ['card', 'ink', BODY],
  ['ground', 'ink', BODY],
  ['ink-action', 'ink', BODY],
  // Control boundaries, focus rings, kind edges, bars and meters: 3:1 against what's beside them.
  ...['card', 'ground', 'raised'].map((bg): [string, string, number] => ['line', bg, PART]),
  ...['card', 'ground', 'raised'].map((bg): [string, string, number] => ['focus', bg, PART]),
  ['accent', 'card', PART],
  ...['project', 'practice', 'oneoff'].flatMap((kind): [string, string, number][] => [
    [kind, 'card', PART],
    [kind, `${kind}-tint`, PART],
    [kind, 'wash', PART],
  ]),
  ['placing', 'card', PART],
  ['placing', 'accent-tint', PART],
  ...['warn', 'ok', 'danger'].map((part): [string, string, number] => [part, 'wash', PART]),
];

describe('the colour tokens', () => {
  it('are the 27 roles, the colours derived from them and the shadows, in dark under the same names', () => {
    const colours = [...light.keys()].filter((name) => !/^--(font|fw-|fs-|lh-|space-|radius-|border-|edge|tap|icon-|z-|dur-|ease|pt)/.test(name));
    expect(colours.sort()).toEqual([...colourNames].sort());
    expect([...themes.dark.keys()].sort()).toEqual(colours.sort());
    expect(themes.chosenDark).toEqual(themes.dark);
  });

  // An unknown name draws nothing, silently: a branch from before the roles, using an old name, has to fail here.
  it('are the only custom properties used, beside the ones the app sets itself', () => {
    const src = join(import.meta.dirname, '../..');
    const files = readdirSync(src, { recursive: true, encoding: 'utf8' }).filter((file) => /\.(css|tsx?)$/.test(file) && !/\.test\.tsx?$/.test(file));
    const text = files.map((file) => readFileSync(join(src, file), 'utf8')).join('\n');
    const defined = new Set([...text.matchAll(/(--[\w-]+)\s*:|['"`](--[\w-]+)['"`]/g)].map((m) => m[1] ?? m[2]));
    const unknown = [...new Set([...text.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]!))].filter((name) => !defined.has(name));
    expect(unknown).toEqual([]);
  });

  it('set the matching color-scheme, so scrollbars and form controls follow', () => {
    expect(css).toMatch(/:root \{\s*color-scheme: light;/);
    expect(css).toMatch(/:root:not\(\[data-theme='light'\]\) \{\s*color-scheme: dark;/);
    expect(css).toMatch(/:root\[data-theme='dark'\] \{\s*color-scheme: dark;/);
  });

  describe.each(['light', 'dark'] as const)('in %s', (theme) => {
    const raw = (name: string) => themes[theme].get(`--${name}`) ?? '';
    const card = () => parse(raw('card'));
    const colour = (name: string) => over(parse(raw(name)), card());

    it.each(ROLES)('give the role %s one opaque colour', (role) => {
      expect(raw(role)).toMatch(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
    });

    it.each(DERIVED)('derive %s from %s at %s', (name, from, strength, into) => {
      const base = parse(raw(from));
      if (into) {
        const want = over([base[0], base[1], base[2], strength], parse(raw(into)));
        expect(deltaE(parse(raw(name)), want)).toBeLessThan(1);
      } else {
        expect(raw(name)).toMatch(/^#[0-9a-f]{8}$/);
        const [r, g, b, a] = parse(raw(name));
        expect([r, g, b]).toEqual(base.slice(0, 3));
        expect(a).toBeCloseTo(strength, 2);
      }
    });

    // Two roles closer than that can't be told apart, so one of them is a shade nobody can choose between.
    it('keep roles apart by ΔE 5, unless one is the other', () => {
      const close = ROLES.flatMap((a, i) =>
        ROLES.slice(i + 1).flatMap((b) => {
          const d = deltaE(parse(raw(a)), parse(raw(b)));
          return d > 0.5 && d < 5 ? [`${a} ~ ${b} (${d.toFixed(1)})`] : [];
        }),
      );
      expect(close).toEqual([]);
    });

    // Dark has real steps between the ground, cards and raised sheets, so each reads as above the last.
    if (theme === 'dark') {
      it('step up from the ground to cards to raised surfaces', () => {
        expect(luminance(parse(raw('card')))).toBeGreaterThan(luminance(parse(raw('ground'))));
        expect(luminance(parse(raw('raised')))).toBeGreaterThan(luminance(parse(raw('card'))));
        expect(contrast(parse(raw('card')), parse(raw('ground')))).toBeGreaterThanOrEqual(1.15);
        expect(contrast(parse(raw('raised')), parse(raw('card')))).toBeGreaterThanOrEqual(1.15);
      });
    }

    it.each(PAIRS)('%s on %s meets %s:1', (fg, bg, least) => {
      const surface = colour(bg);
      expect(contrast(over(parse(raw(fg)), surface), surface)).toBeGreaterThanOrEqual(least);
    });

    it('draw the checkbox tick in the colour on the accent', () => {
      const stroke = /stroke='([^']+)'/.exec(raw('check'))?.[1]?.replace('%23', '#');
      expect(contrast(parse(stroke === 'white' ? '#fff' : stroke!), parse(raw('accent')))).toBeGreaterThanOrEqual(BODY);
    });

    // The focus ring around a toast's button sits on the toast, which is ink, so the usual ring won't do.
    it.each(['.toastact', '.pktoast button'])('ring a focused %s at 3:1 on its toast', (button) => {
      const rules = readFileSync(join(import.meta.dirname, 'shell.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').split('}');
      const rule = rules.find((r) => r.split('{')[0]!.split(',').some((s) => s.trim() === `${button}:focus-visible`));
      const ring = /outline-color: var\(--([\w-]+)\)/.exec(rule ?? '')?.[1] ?? 'focus';
      expect(contrast(parse(raw(ring)), parse(raw('ink')))).toBeGreaterThanOrEqual(PART);
    });

    // The hour sliders' handles drop the usual ring for one drawn round the handle, so that ring has to show on the card.
    it('ring a focused hour handle at 3:1 on its card', () => {
      const sheet = readFileSync(join(import.meta.dirname, '../screens/settings/settings.css'), 'utf8');
      const rings = [...sheet.matchAll(/:focus-visible::-(?:webkit-slider|moz-range)-thumb\s*\{[^}]*radial-gradient\(([^;]*)\);/g)].map(
        (m) => [...m[1]!.matchAll(/var\(--([\w-]+)\)/g)].at(-1)![1]!,
      );
      expect(rings).toHaveLength(2);
      for (const ring of rings) expect(contrast(colour(ring), card())).toBeGreaterThanOrEqual(PART);
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
      expect(colours.filter((c) => contrast(colour(c.split(': ')[1]!), card()) < PART)).toEqual([]);
    });
  });
});

// The design's budget (docs/design.md): a new size, space or layer means changing the design, not adding a token.
describe('the scales', () => {
  const names = (prefix: string) => [...light.keys()].filter((name) => name.startsWith(prefix));
  const px = (name: string) => Number(/^(\d+)px$/.exec(light.get(name) ?? '')?.[1]);

  it('hold seven text styles, each a size and a line height, at two weights', () => {
    const styles = ['display', 'title', 'heading', 'body', 'label', 'meta', 'caption'];
    expect(names('--fs-')).toEqual(styles.map((s) => `--fs-${s}`));
    expect(names('--lh-')).toEqual(styles.map((s) => `--lh-${s}`));
    expect(names('--fw-').map((name) => light.get(name))).toEqual(['400', '600']);
    // Nothing under 12px, on any layout.
    expect(Math.min(...names('--fs-').map(px))).toBe(12);
  });

  it('space in eight steps on the 4px grid, each named by its multiple of 4', () => {
    const steps = names('--space-');
    expect(steps).toHaveLength(8);
    for (const step of steps) expect(px(step)).toBe(Number(step.slice('--space-'.length)) * 4);
  });

  it('round by role: four radii, the pill and the circle', () => {
    expect(names('--radius-')).toEqual(['--radius-block', '--radius-control', '--radius-card', '--radius-sheet', '--radius-pill', '--radius-circle']);
  });

  it('lift with three shadows, stack in six named layers, and move in three durations', () => {
    expect(names('--shadow-')).toHaveLength(3);
    const layers = names('--z-').map((name) => Number(light.get(name)));
    expect(layers).toHaveLength(6);
    expect([...layers].sort((a, b) => a - b)).toEqual(layers);
    const durations = names('--dur-').map((name) => Number(/^(\d+)ms$/.exec(light.get(name)!)?.[1]));
    expect(durations).toHaveLength(3);
    // Transitions take 250ms or less.
    expect(Math.max(...durations)).toBeLessThanOrEqual(250);
  });

  it('give phone text its larger sizes, following the iPhone text-size setting in the app', () => {
    const phone = css.slice(css.indexOf("[data-layout='phone'] {"));
    expect(phone).toMatch(/--fs-body: calc\(17 \* var\(--pt\)\)/);
    expect(css).toMatch(/:root\[data-platform='ios'\] \{\s*font: -apple-system-body;\s*--pt: calc\(1rem \/ 17\);/);
    expect(light.get('--pt')).toBe('1px');
  });
});

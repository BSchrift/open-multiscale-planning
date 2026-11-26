// The iPhone widgets draw with the app's tokens and font, copied into their Swift package since a widget can't read
// CSS. These keep the copies the same as the originals, so the widgets never drift from the app.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const widgets = join(import.meta.dirname, '../../../ios/App/MultiscaleWidgets/Sources/WidgetUI');
const css = readFileSync(join(import.meta.dirname, 'tokens.css'), 'utf8');
const swift = readFileSync(join(widgets, 'Tokens.swift'), 'utf8');

/** A theme's custom properties: the first rule after `start`, up to its closing brace. */
function theme(start: string): Map<string, string> {
  const from = css.indexOf(start);
  const body = css.slice(css.indexOf('{', from + start.length - 1) + 1, css.indexOf('}', from));
  return new Map([...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
}

/** #fff, #1e2126 or #1e21261c as the Swift file writes it, 0xRRGGBBAA. */
function rgba(hex: string): string {
  const h = hex.slice(1);
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
  return `0x${(full.length === 6 ? `${full}ff` : full).toUpperCase()}`;
}

/** The Swift dictionary literal after `name:`. */
function swiftTheme(name: 'light' | 'dark'): Map<string, string> {
  const from = swift.indexOf('= [', swift.indexOf(`static let ${name}:`));
  const body = swift.slice(from, swift.indexOf(']', from));
  return new Map([...body.matchAll(/"([\w-]+)": (0x[0-9A-F]{8})/g)].map((m) => [m[1]!, m[2]!]));
}

describe('the widgets’ copy of the design tokens', () => {
  const light = theme(':root {');
  const dark = theme(":root:not([data-theme='light']) {");

  it('has each role the widgets draw with, in both themes, with tokens.css’s values', () => {
    for (const [name, values] of [
      ['light', light],
      ['dark', dark],
    ] as const) {
      const copy = swiftTheme(name);
      expect(copy.size, name).toBeGreaterThan(15);
      for (const [role, value] of copy) {
        const original = values.get(role) ?? light.get(role);
        expect(original, `${name} --${role} isn't in tokens.css`).toBeDefined();
        expect(value, `${name} --${role}`).toBe(rgba(original!));
      }
    }
  });
});

describe('the widgets’ font', () => {
  it('is the file the web app loads, with its licence beside it', () => {
    const fontsource = join(import.meta.dirname, '../../../node_modules/@fontsource-variable/instrument-sans');
    for (const file of ['instrument-sans-latin-wght-normal.woff2', 'instrument-sans-latin-ext-wght-normal.woff2']) {
      expect(readFileSync(join(widgets, 'Fonts', file)).equals(readFileSync(join(fontsource, 'files', file))), file).toBe(true);
    }
    expect(readFileSync(join(widgets, 'Fonts', 'OFL.txt'), 'utf8')).toContain('SIL Open Font License');
  });
});

// The design system's rules, as checks over the source: stylesheets take every raw value from tokens.css, and
// components draw icons with the SVG set and buttons with the shared Button. docs/design.md explains the rules;
// designRules.test.ts runs them over the app. Test-only: nothing in the app imports this.

import { parseAst } from 'vite';

export interface Violation {
  file: string;
  line: number;
  rule: string;
  text: string;
}

const COLOUR = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(|\b(?:white|black|red|blue|green|gray|grey|orange|purple|yellow|pink|silver)\b/i;
const PX = /(?<![\w.-])-?\d*\.?\d+px\b/g;
const SPACING = /^(?:padding|margin|gap|row-gap|column-gap)(?:-(?:top|right|bottom|left|inline|block)(?:-(?:start|end))?)?$/;
// A shadow with no blur is a solid shape, not elevation: a ring, an edge, a cover or a hover's overlay. Its colour is a
// token; its lengths draw a line, not a space.
const LEN = String.raw`(?:0|-?[\d.]+px|var\(--[\w-]+\)|calc\(-1 \* var\(--[\w-]+\)\))`;
const RING = new RegExp(String.raw`^(?:inset\s+)?${LEN}\s+${LEN}\s+0(?:\s+${LEN})?\s+var\(--[\w-]+\)$`);
const DURATION = /(?<![\w.-])\d*\.?\d+m?s\b/g;

/** The rule a declaration breaks, if any. */
function ruleFor(prop: string, value: string): string | null {
  const v = value.replace(/!important/, '').trim();
  // A url() holds an image, such as the select's chevron, whose colours aren't the page's.
  if (!/^--/.test(prop) && COLOUR.test(v.replace(/url\([^)]*\)/g, ''))) return 'colour';
  // A size between two styles that follows the window, such as the clock's, is still made of the styles.
  if (prop === 'font-size') return /^(var\(--fs-[\w-]+\)|inherit|1em|100%)$/.test(v) || /^clamp\(var\(--fs-[\w-]+\), [\d.]+vw, var\(--fs-[\w-]+\)\)$/.test(v) ? null : 'type';
  if (prop === 'font-weight') return /^(var\(--fw-[\w-]+\)|inherit)$/.test(v) ? null : 'type';
  // A hairline (1px) nudges a box over its neighbour's border; anything bigger is a step on the spacing scale.
  if (SPACING.test(prop)) return [...v.matchAll(PX)].some((m) => !/^-?(0|1)px$/.test(m[0])) ? 'spacing' : null;
  if (/^border(-(top|bottom)-(left|right))?-radius$/.test(prop)) return /^((var\(--radius-[\w-]+\)|0)\s*)+$|^inherit$/.test(v) ? null : 'radius';
  if (prop === 'box-shadow') {
    const parts = v.split(/,(?![^(]*\))/).map((p) => p.trim());
    return v === 'none' || parts.every((p) => /^var\(--shadow-\d\)$/.test(p) || RING.test(p)) ? null : 'shadow';
  }
  // calc(var(--z-raised) + 1) lifts one thing over its neighbour within a layer.
  if (prop === 'z-index') return /^(var\(--z-[\w-]+\)|calc\(var\(--z-[\w-]+\) [+-] \d{1,2}\)|0|auto)$/.test(v) ? null : 'layer';
  if (/^(transition|animation)(-duration|-delay)?$/.test(prop)) {
    // A loop, such as the spinner, has a period rather than a duration. Reduced motion turns movement off with an
    // all-but-zero duration.
    if (/\binfinite\b/.test(v)) return null;
    return [...v.matchAll(DURATION)].some((m) => !/^(0m?s|0?\.01ms)$/.test(m[0])) ? 'motion' : null;
  }
  return null;
}

/** Each declaration outside tokens.css that takes a raw value instead of a token. */
export function cssViolations(file: string, css: string): Violation[] {
  if (file.endsWith('tokens.css')) return [];
  // Blank out comments, keeping their newlines, so line numbers stay true.
  const text = css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
  const found: Violation[] = [];
  for (const m of text.matchAll(/([\w-]+)\s*:\s*([^;{}]+)(?=[;}])/g)) {
    // A selector such as a:hover isn't a declaration: declarations follow { or ; on their own.
    const before = text.slice(0, m.index).replace(/\s+$/, '').at(-1);
    if (before !== '{' && before !== ';') continue;
    const rule = ruleFor(m[1]!.toLowerCase(), m[2]!);
    if (rule) found.push({ file, line: text.slice(0, m.index).split('\n').length, rule, text: `${m[1]}: ${m[2]!.trim()}` });
  }
  return found;
}

const GLYPHS = /[›‹▾▸✓×✕]/g;
type Node = { type: string; start: number; [key: string]: unknown };
const isNode = (x: unknown): x is Node => typeof x === 'object' && x !== null && typeof (x as Node).type === 'string';

/** Strings an expression can render, without going into JSX inside it, which is checked on its own. */
function strings(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) node.forEach((n) => strings(n, out));
  else if (isNode(node)) {
    if (node.type === 'JSXElement' || node.type === 'JSXFragment') return out;
    if (node.type === 'Literal' && typeof node.value === 'string') out.push(node.value);
    else if (node.type === 'TemplateElement') out.push(String((node.value as { cooked?: string }).cooked ?? ''));
    else for (const [key, value] of Object.entries(node)) if (key !== 'type') strings(value, out);
  }
  return out;
}

/** Text glyphs used as icons, and buttons built by hand with the btn class outside components/ds. */
export function tsxViolations(file: string, source: string): Violation[] {
  const found: (Violation & { start: number })[] = [];
  const at = (start: number) => source.slice(0, start).split('\n').length;
  const buttonsAllowed = /(^|\/)components\/ds\//.test(file);
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!isNode(node)) return;
    if (node.type === 'JSXElement' || node.type === 'JSXFragment') {
      for (const child of node.children as Node[]) {
        const texts = child.type === 'JSXText' ? [String(child.value)] : child.type === 'JSXExpressionContainer' ? strings(child.expression) : [];
        for (const glyph of texts.join('').match(GLYPHS) ?? []) found.push({ file, line: at(child.start), rule: 'glyph', text: glyph, start: child.start });
      }
    }
    if (node.type === 'JSXOpeningElement' && !buttonsAllowed && (node.name as Node & { name?: string }).name === 'button') {
      const cls = (node.attributes as Node[]).find((a) => a.type === 'JSXAttribute' && (a.name as { name?: string }).name === 'className');
      if (cls && strings(cls.value).some((s) => /(^|\s)btn(\s|$)/.test(s))) {
        const end = (cls as { end?: number }).end ?? cls.start;
        found.push({ file, line: at(node.start), rule: 'button', text: `<button ${source.slice(cls.start, end)}`, start: node.start });
      }
    }
    for (const [key, value] of Object.entries(node)) if (key !== 'type') visit(value);
  };
  visit(parseAst(source, { lang: 'tsx' } as never));
  return found.sort((a, b) => a.start - b.start).map(({ start: _, ...v }) => v);
}

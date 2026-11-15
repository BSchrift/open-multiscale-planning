// The web.initial KPI (docs/performance.md): the gzipped bytes of the scripts and styles the web app's page links, which
// a browser fetches before it can draw anything. Exact, so it blocks a merge from day one: the frontend CI job runs this
// on its build and fails over the target in config/perf.ts. Given the base's build too, it notes a build that adds more
// than 5 KB.
//   node scripts/bundle-budget.ts <dist> [--base <base dist>]

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { targetFor } from '../../config/perf.ts';

const NOTE_BYTES = 5 * 1024;

/** The page's own scripts, module preloads and stylesheets, as gzipped bytes. */
export function linkedBytes(dist: string): { files: string[]; bytes: number } {
  const page = readFileSync(join(dist, 'index.html'), 'utf8');
  const files = [...page.matchAll(/<script\b[^>]*\bsrc="([^"]+)"|<link\b[^>]*\brel="(?:modulepreload|stylesheet)"[^>]*\bhref="([^"]+)"/g)]
    .map((m) => (m[1] ?? m[2])!)
    .filter((src) => src.startsWith('/'));
  const bytes = files.reduce((sum, file) => sum + gzipSync(readFileSync(join(dist, file))).length, 0);
  return { files, bytes };
}

const kb = (bytes: number) => (bytes / 1024).toFixed(1);

export function check(dist: string, options: { budgetKb: number; base?: string }): { ok: boolean; lines: string[] } {
  const { files, bytes } = linkedBytes(dist);
  const ok = bytes <= options.budgetKb * 1024;
  const lines = [`web.initial: ${kb(bytes)} KB gzipped in the ${files.length} scripts and styles the page links, against ${options.budgetKb} KB.`];
  if (!ok) lines.push(`That's over the budget in config/perf.ts. Make the first load smaller, or change the budget there and in docs/performance.md with the reason.`);
  if (options.base) {
    const grew = bytes - linkedBytes(options.base).bytes;
    if (grew > NOTE_BYTES) lines.push(`This build adds ${kb(grew)} KB to the page's scripts and styles, more than 5 KB.`);
  }
  return { ok, lines };
}

function main(argv: string[]) {
  const [dist, ...rest] = argv;
  if (!dist) throw new Error('Usage: node scripts/bundle-budget.ts <dist> [--base <base dist>]');
  const base = rest.includes('--base') ? rest[rest.indexOf('--base') + 1] : undefined;
  const { ok, lines } = check(dist, { budgetKb: targetFor('web.initial', 'web-desktop')!.p50!, ...(base ? { base } : {}) });
  (ok ? console.log : console.error)(lines.join('\n'));
  return ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]!).href) process.exit(main(process.argv.slice(2)));

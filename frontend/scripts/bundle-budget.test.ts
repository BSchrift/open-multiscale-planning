import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { check, linkedBytes } from './bundle-budget';

/** A build whose page links a script, a preload and a style, and holds a file it doesn't link. */
function build(script: string) {
  const dist = mkdtempSync(join(tmpdir(), 'multiscale-budget-'));
  mkdirSync(join(dist, 'assets'));
  writeFileSync(join(dist, 'index.html'), '<link rel="icon" href="/favicon.png"><script type="module" src="/assets/index.js"></script><link rel="modulepreload" href="/assets/db.js"><link rel="stylesheet" href="/assets/index.css">');
  writeFileSync(join(dist, 'assets/index.js'), script);
  writeFileSync(join(dist, 'assets/db.js'), 'export const db = 1;');
  writeFileSync(join(dist, 'assets/index.css'), 'body { margin: 0 }');
  writeFileSync(join(dist, 'assets/later.js'), 'x'.repeat(100_000));
  writeFileSync(join(dist, 'favicon.png'), 'png');
  return dist;
}

describe('the bundle budget', () => {
  it("counts the gzipped scripts and styles the page links, not what it loads later or its icon", () => {
    const { files, bytes } = linkedBytes(build('console.log(1);'));
    expect(files).toEqual(['/assets/index.js', '/assets/db.js', '/assets/index.css']);
    expect(bytes).toBeGreaterThan(50);
    expect(bytes).toBeLessThan(200);
  });

  it('fails over the budget, and notes a build that adds more than 5 KB over its base', () => {
    // Random text, which gzip can't shrink much.
    const random = (n: number) => randomBytes(n).toString('base64');
    expect(check(build('a'), { budgetKb: 1 }).ok).toBe(true);
    expect(check(build(random(4000)), { budgetKb: 1 }).ok).toBe(false);
    const grown = check(build(random(8000)), { budgetKb: 100, base: build('a') });
    expect(grown.ok).toBe(true);
    expect(grown.lines.join('\n')).toMatch(/adds [\d.]+ KB to the page's scripts and styles, more than 5 KB/);
  });
});

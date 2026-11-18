// The iPhone's performance numbers (docs/performance.md): the PERF iphone line PerfUITests prints, as the runner's raw
// samples, so scripts/perf-report.ts reports them with the rest. The first launch is cold, the Simulator having just
// installed the app, and the rest warm.
//   node scripts/perf-ios.ts <test log> <raw folder> <scenario> [<web view's peak MB>]

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Raw } from './perf-report.ts';

interface Line {
  launched: number[];
  measures: Record<string, number[]>;
  peakMb: number | null;
  warnings: number | null;
}

export function iphoneRaw(log: string, scenario: string, webviewMb?: number): Raw {
  const json = /^.*PERF iphone (\{.*\})\s*$/m.exec(log)?.[1];
  if (!json) throw new Error('The iPhone test printed no PERF iphone line: see its log.');
  const line = JSON.parse(json) as Line;
  const interactive = [...(line.measures['today:interactive@'] ?? [])].sort((a, b) => a - b);
  // Each launch to the first time Today was interactive after it.
  const starts = line.launched.flatMap((at) => {
    const next = interactive.find((t) => t >= at);
    return next === undefined ? [] : [Math.round((next - at) * 10) / 10];
  });
  const samples: Record<string, number[]> = Object.fromEntries(Object.entries(line.measures).filter(([name]) => !name.endsWith('@')));
  if (starts.length) samples['start.cold'] = starts.slice(0, 1);
  if (starts.length > 1) samples['start.warm'] = starts.slice(1);
  if (line.peakMb !== null) samples['mem.app'] = [line.peakMb];
  if (line.warnings !== null) samples['mem.events'] = [line.warnings];
  if (webviewMb !== undefined) samples['mem.webview'] = [webviewMb];
  return { target: 'this', platform: 'iphone', scenario, samples };
}

function main(argv: string[]) {
  const [log, out, scenario, webview] = argv;
  if (!log || !out || !scenario) throw new Error("Usage: node scripts/perf-ios.ts <test log> <raw folder> <scenario> [<web view's peak MB>]");
  const raw = iphoneRaw(readFileSync(log, 'utf8'), scenario, webview ? Number(webview) : undefined);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, `this--iphone--${scenario}.json`), JSON.stringify(raw));
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]!).href) process.exit(main(process.argv.slice(2)));

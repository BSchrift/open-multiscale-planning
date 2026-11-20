// Whether node_modules holds what package-lock.json asks for, checked as the test runners load their config. A
// node_modules behind its lockfile fails tests in ways that look like the app's own: one without @capacitor/haptics
// failed the phone Schedule test 3 times in 3 on a Mac while CI passed it. So the runners stop first and say why.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

interface Locked {
  version?: string;
  /** Left out on platforms it doesn't run on, such as fsevents off macOS. */
  optional?: boolean;
  devOptional?: boolean;
  /** A folder of this repo, such as @multiscale/config, rather than a download. */
  link?: boolean;
}

/** Each package the lockfile asks for that node_modules lacks or holds at another version, with what it wants. */
export function notInstalled(dir: string): string[] {
  const lock = JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf8')) as { packages: Record<string, Locked> };
  const wrong: string[] = [];
  for (const [path, locked] of Object.entries(lock.packages)) {
    if (!path.startsWith('node_modules/') || locked.optional || locked.devOptional || locked.link) continue;
    const file = join(dir, path, 'package.json');
    const version = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { version?: string }).version : undefined;
    if (version === locked.version) continue;
    const name = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
    wrong.push(`${name} (${version ?? 'missing'}, wants ${locked.version})`);
  }
  return wrong;
}

/** Throws, naming what's wrong and what to do, unless node_modules matches the lockfile. */
export function assertInstalled(dir: string): void {
  const wrong = notInstalled(dir);
  if (wrong.length === 0) return;
  const named = wrong.length > 5 ? `${wrong.slice(0, 5).join(', ')} and ${wrong.length - 5} more` : wrong.join(', ');
  throw new Error(`frontend/node_modules doesn't match package-lock.json: ${named}. Run npm ci in frontend, in a node_modules of this checkout's own.`);
}

// A stand-in for `aws s3` in the pipeline script's tests: each bucket is a folder under $PARAMS/s3, so a test sets up
// what a bucket holds and reads what a step left there. It takes the commands and flags scripts/pipeline.sh uses: cp
// (with - for stdin or stdout), sync, ls and rm, with --recursive and --exclude. Headers aren't kept; the tests read
// them from the log.

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';

const root = join(process.env.PARAMS!, 's3');
const [command, ...args] = process.argv.slice(3);
const flags = new Set(['--recursive', '--size-only', '--quiet', '--no-progress', '--only-show-errors']);
const paths: string[] = [];
const excludes: RegExp[] = [];
for (let i = 0; i < args.length; i++) {
  const arg = args[i]!;
  if (arg === '--exclude') excludes.push(new RegExp(`^${args[++i]!.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*')}$`));
  else if (flags.has(arg)) continue;
  else if (arg.startsWith('--')) i++;
  else paths.push(arg);
}
const recursive = args.includes('--recursive') || command === 'sync';
const local = (path: string) => (path.startsWith('s3://') ? join(root, path.slice('s3://'.length)) : path);
const walk = (dir: string): string[] =>
  existsSync(dir) && statSync(dir).isDirectory() ? readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)])) : [];
const put = (from: string | Buffer, to: string) => {
  mkdirSync(dirname(to), { recursive: true });
  if (typeof from === 'string') copyFileSync(from, to);
  else writeFileSync(to, from);
};
const missing = (path: string) => {
  console.error(`fatal error: An error occurred (404) when calling the HeadObject operation: Key "${path}" does not exist`);
  process.exit(1);
};
// What S3 prints for each object: its time, size and key.
const line = (file: string) => {
  const { mtime, size } = statSync(file);
  return `${mtime.toISOString().slice(0, 19).replace('T', ' ')} ${String(size).padStart(10)} ${relative(root, file).split('/').slice(1).join('/')}`;
};

const [from, to] = paths as [string, string];
switch (command) {
  case 'cp':
  case 'sync': {
    if (recursive) {
      for (const file of walk(local(from))) {
        const name = relative(local(from), file);
        if (!excludes.some((e) => e.test(name))) put(file, join(local(to), name));
      }
    } else if (to === '-') {
      if (!existsSync(local(from)) || statSync(local(from)).isDirectory()) missing(from);
      process.stdout.write(readFileSync(local(from)));
    } else if (from === '-') {
      put(readFileSync(0), local(to));
    } else {
      if (!existsSync(local(from))) missing(from);
      put(local(from), to.endsWith('/') ? join(local(to), basename(from)) : local(to));
    }
    break;
  }
  case 'ls': {
    const dir = local(from);
    if (recursive) {
      const files = walk(dir.endsWith('/') ? dir : dirname(dir)).filter((f) => f.startsWith(dir));
      if (files.length === 0) process.exit(1);
      for (const file of files.sort()) console.log(line(file));
    } else {
      if (!existsSync(dir)) process.exit(1);
      for (const e of readdirSync(dir, { withFileTypes: true })) console.log(e.isDirectory() ? `${''.padStart(30)}PRE ${e.name}/` : line(join(dir, e.name)));
    }
    break;
  }
  case 'rm':
    rmSync(local(from), { recursive, force: true });
    break;
  default:
    console.error(`fake s3: ${command} isn't faked`);
    process.exit(2);
}

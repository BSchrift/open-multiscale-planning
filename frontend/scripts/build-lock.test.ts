import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const frontend = join(import.meta.dirname, '..');

/** A copy in a folder of its own, so it locks that folder and never waits on a real run in this checkout. */
function lockCopy() {
  const dir = mkdtempSync(join(tmpdir(), 'build-lock-'));
  mkdirSync(join(dir, 'scripts'));
  copyFileSync(join(frontend, 'scripts/build-lock.sh'), join(dir, 'scripts/build-lock.sh'));
  return { dir, lock: join(dir, 'scripts/build-lock.sh'), log: join(dir, 'log') };
}

const exited = (child: ReturnType<typeof spawn>) => new Promise((resolve) => child.on('exit', resolve));

it('makes a second run wait until the first is done with the shared build output', async () => {
  const { lock, log } = lockCopy();
  const env = { ...process.env, MULTISCALE_BUILD_LOCK: '' };
  const first = spawn(lock, ['sh', '-c', `echo first-start >> ${log}; sleep 1; echo first-end >> ${log}`], { env });
  while (!existsSync(log)) await new Promise((resolve) => setTimeout(resolve, 20));
  const second = spawn(lock, ['sh', '-c', `echo second >> ${log}`], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let waiting = '';
  second.stderr!.on('data', (chunk) => (waiting += chunk));
  await Promise.all([exited(first), exited(second)]);
  expect(readFileSync(log, 'utf8').split('\n').filter(Boolean)).toEqual(['first-start', 'first-end', 'second']);
  expect(waiting).toMatch(/Waiting/);
});

it('lets a run that holds the lock call steps that take it again', () => {
  const { lock } = lockCopy();
  const run = spawnSync(lock, [lock, 'echo', 'inner'], { env: { ...process.env, MULTISCALE_BUILD_LOCK: '' }, encoding: 'utf8', timeout: 10_000 });
  expect(run.stdout.trim()).toBe('inner');
});

it('frees the lock when a holder is killed', async () => {
  const { lock, log } = lockCopy();
  const env = { ...process.env, MULTISCALE_BUILD_LOCK: '' };
  const killed = spawn(lock, ['sh', '-c', `echo held >> ${log}; sleep 30`], { env, detached: true });
  while (!existsSync(log)) await new Promise((resolve) => setTimeout(resolve, 20));
  killed.kill('SIGKILL');
  await exited(killed);
  const run = spawnSync(lock, ['echo', 'after'], { env, encoding: 'utf8', timeout: 10_000 });
  process.kill(-killed.pid!, 'SIGKILL');
  expect(run.stdout.trim()).toBe('after');
});

it('frees the lock when the command is done, even if it leaves something running', () => {
  const { lock } = lockCopy();
  const env = { ...process.env, MULTISCALE_BUILD_LOCK: '' };
  const leaver = spawnSync(lock, ['sh', '-c', 'sleep 30 >/dev/null 2>&1 & echo $!'], { env, encoding: 'utf8', timeout: 10_000 });
  const run = spawnSync(lock, ['echo', 'after'], { env, encoding: 'utf8', timeout: 10_000 });
  process.kill(Number(leaver.stdout.trim()), 'SIGKILL');
  expect(run.stdout.trim()).toBe('after');
});

it('runs everything that writes or reads the shared build output under the lock', () => {
  const { scripts } = JSON.parse(readFileSync(join(frontend, 'package.json'), 'utf8'));
  for (const name of ['build', 'e2e:electron', 'electron:build', 'ios:sync']) expect(scripts[name], name).toMatch(/^scripts\/build-lock\.sh /);
  expect(readFileSync(join(frontend, '../scripts/test-ios.sh'), 'utf8')).toContain('frontend/scripts/build-lock.sh');
});

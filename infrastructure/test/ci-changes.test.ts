import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { parse } from 'yaml';

const repo = join(import.meta.dirname, '../..');
const script = join(repo, 'scripts/ci-changes.sh');

/** Runs the script for an event with these changed paths, and what it wrote to the step's output and summary. */
function changes(event: string, paths: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-changes-'));
  const output = join(dir, 'output');
  const summary = join(dir, 'summary');
  writeFileSync(output, '');
  writeFileSync(summary, '');
  const r = spawnSync('bash', [script, event], {
    input: paths.map((p) => `${p}\n`).join(''),
    encoding: 'utf8',
    env: { PATH: process.env.PATH, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary },
  });
  assert.equal(r.status, 0, r.stderr);
  return { ios: readFileSync(output, 'utf8'), summary: readFileSync(summary, 'utf8'), stdout: r.stdout };
}
const runsIos = (event: string, paths: string[]) => changes(event, paths).ios === 'ios=true\n';

describe('scripts/ci-changes.sh', () => {
  it('runs the iPhone job for a pull request that changes what the app is built from', () => {
    for (const path of [
      'frontend/src/ui/screens/today/Today.tsx',
      'frontend/src/platform/capacitor-checks.ts',
      'frontend/src/styles/phone.css',
      'frontend/ios/App/App/AppDelegate.swift',
      'frontend/ios/App/UITests/MultiscaleUITests.swift',
      'frontend/ios/harness/index.html',
      'frontend/ios/App/App.xcodeproj/project.pbxproj',
      'frontend/capacitor.config.json',
      'frontend/package.json',
      'frontend/package-lock.json',
      'frontend/index.html',
      'frontend/public/icon.svg',
      'frontend/vite.config.ts',
      'frontend/tsconfig.json',
      'frontend/scripts/ios-sync.mjs',
      'frontend/scripts/build-lock.sh',
      'frontend/scripts/test-target.mjs',
      'frontend/scripts/shell-hash.ts',
      'frontend/scripts/sign-release.mjs',
      'config/app.gen.ts',
      'config/protocol.yaml',
      'config/env/local.yaml',
      'config/retention.yaml',
      'config/retention.ts',
      'scripts/test-ios.sh',
      'scripts/local-stack.sh',
      'Makefile',
      '.github/workflows/ci.yml',
    ]) {
      assert.ok(runsIos('pull_request', [path]), path);
    }
  });

  it("skips it for a pull request that changes only what the iPhone app neither builds nor runs", () => {
    for (const path of [
      'README.md',
      'AGENTS.md',
      'docs/releasing.md',
      'frontend/ios/README.md',
      'backend/internal/sync/handler.go',
      'infrastructure/lib/pipeline-stack.ts',
      'infrastructure/test/ci-changes.test.ts',
      'frontend/e2e/today.spec.ts',
      'frontend/electron/main.ts',
      'frontend/electron/identity.ts',
      'frontend/src/core/sync.test.ts',
      'frontend/src/ui/screens/today/Today.test.tsx',
      'frontend/scripts/electron-build.mjs',
      'frontend/scripts/shell-hash.test.ts',
      'frontend/playwright.config.ts',
      'frontend/vitest.config.ts',
      'config/config.go',
      'config/retention_test.go',
      'config/go.mod',
      'config/go.sum',
      'config/cmd/gen/main.go',
      'config/prod.example.yaml',
      'scripts/pipeline.sh',
      'scripts/e2e.sh',
      'site/index.html',
      '.github/workflows/mac-release.yml',
      'compose.yaml',
    ]) {
      assert.ok(!runsIos('pull_request', [path]), path);
    }
  });

  it('runs it when any one changed path is an input, and says which', () => {
    const r = changes('pull_request', ['docs/releasing.md', 'backend/main.go', 'frontend/src/App.tsx', 'frontend/ios/App/App/Info.plist']);
    assert.equal(r.ios, 'ios=true\n');
    assert.match(r.summary, /iPhone tests run.*frontend\/src\/App\.tsx/);
    assert.equal(r.stdout, r.summary);
  });

  it('says in the summary why it skipped, with what changed', () => {
    const r = changes('pull_request', ['docs/releasing.md', 'backend/main.go']);
    assert.equal(r.ios, 'ios=false\n');
    assert.match(r.summary, /iPhone tests are skipped/);
    assert.match(r.summary, /2 changed files/);
  });

  it('skips it for a pull request that changes nothing', () => {
    assert.ok(!runsIos('pull_request', []));
  });

  it('decides a merge group by its diff too', () => {
    assert.ok(runsIos('merge_group', ['frontend/src/App.tsx']));
    assert.ok(!runsIos('merge_group', ['backend/main.go']));
  });

  it('always runs it on a push to main, a scheduled run and a run started by hand, whatever changed', () => {
    for (const event of ['push', 'schedule', 'workflow_dispatch']) {
      const r = changes(event, ['docs/releasing.md']);
      assert.equal(r.ios, 'ios=true\n', event);
      assert.match(r.summary, /iPhone tests run/, event);
    }
  });

  // The lists above are samples. These hold the script to what the iPhone build actually reads, so a new input can't
  // slip past it.
  it('counts every file the web build imports from the repo, except the Mac-only identity', () => {
    const vite = readFileSync(join(repo, 'frontend/vite.config.ts'), 'utf8');
    const imported = [...vite.matchAll(/from '(\.{1,2}\/[^']+)'/g)].map((m) => join('frontend', m[1]!).replace(/\\/g, '/'));
    assert.ok(imported.length > 3, imported.join(' '));
    const files = imported.map((path) => (/\.\w+$/.test(path) ? path : `${path}.ts`));
    // Only the Mac app's half of the shell hash reads it, and the frontend job builds the bundle that imports it.
    assert.deepEqual(files.filter((path) => !runsIos('pull_request', [path])), ['frontend/electron/identity.ts']);
    assert.ok(runsIos('pull_request', ['config/app.gen.ts']), "the alias for @multiscale/config");
  });

  it('counts every tracked file the iPhone project and its shell hash are made of', () => {
    const tracked = execFileSync('git', ['ls-files', 'frontend/ios', 'frontend/capacitor.config.json'], { cwd: repo, encoding: 'utf8' })
      .split('\n')
      .filter((path) => path && !path.endsWith('.md'));
    assert.ok(tracked.length > 10);
    assert.deepEqual(tracked.filter((path) => !runsIos('pull_request', [path])), []);
  });

  it('counts every script and file make test-ios runs from the repo', () => {
    const testIos = readFileSync(join(repo, 'scripts/test-ios.sh'), 'utf8');
    const named = [...testIos.matchAll(/\$root\/((?:scripts|frontend)\/[\w./-]+)/g)].map((m) => m[1]!);
    const inFrontend = [...testIos.matchAll(/(?:node|npx esbuild) ((?:scripts|src)\/[\w./-]+)/g)].map((m) => `frontend/${m[1]!}`);
    assert.ok(named.length > 1 && inFrontend.length > 1, [...named, ...inFrontend].join(' '));
    assert.deepEqual([...named, ...inFrontend].filter((path) => !runsIos('pull_request', [path])), []);
  });
});

describe('the iPhone job in .github/workflows/ci.yml', () => {
  const ci = parse(readFileSync(join(repo, '.github/workflows/ci.yml'), 'utf8')) as {
    on: Record<string, unknown>;
    jobs: Record<
      string,
      {
        'runs-on': string;
        needs?: string[];
        if?: string;
        outputs?: Record<string, string>;
        strategy?: { 'fail-fast'?: boolean; matrix?: Record<string, unknown> };
        steps: { run?: string; uses?: string; env?: Record<string, string>; with?: Record<string, unknown> }[];
      }
    >;
  };

  it('waits for the changes job on Linux and runs only when it says so', () => {
    const { 'ios-simulator': simulator, changes: job } = ci.jobs;
    assert.ok(job, 'a changes job');
    assert.equal(job['runs-on'], 'ubuntu-latest');
    assert.ok(job.steps.some((step) => step.run?.includes('scripts/ci-changes.sh "$GITHUB_EVENT_NAME"')));
    assert.match(job.outputs?.ios ?? '', /steps\.\w+\.outputs\.ios/);
    assert.ok(simulator?.needs?.includes('changes'));
    assert.equal(simulator?.if, "needs.changes.outputs.ios == 'true'");
  });

  // The two builds' tests, one after the other, outlast a job's hour on GitHub's Macs, so each has a Mac of its own.
  it('runs each build, extensions off and on, on a Mac of its own, and keeps both results', () => {
    const simulator = ci.jobs['ios-simulator']!;
    assert.match(simulator['runs-on'], /^macos-/);
    assert.deepEqual(simulator.strategy?.matrix, { extensions: ['NO', 'YES'] });
    // One failing build doesn't stop the other, so a run shows every failure.
    assert.equal(simulator.strategy?.['fail-fast'], false);
    const test = simulator.steps.find((step) => step.run === 'make test-ios');
    assert.equal(test?.env?.MULTISCALE_RUNS, '${{ matrix.extensions }}');
    const upload = simulator.steps.find((step) => step.uses?.startsWith('actions/upload-artifact@'));
    assert.match(String(upload?.with?.name), /\$\{\{ matrix\.extensions \}\}/);
  });

  // Branch protection names one check, ios, rather than one per build.
  describe('its one result, ios', () => {
    const ios = ci.jobs.ios!;

    it('waits for both builds on Linux, unless the run was cancelled or the changes job skipped them', () => {
      assert.equal(ios['runs-on'], 'ubuntu-latest');
      assert.deepEqual(ios.needs, ['changes', 'ios-simulator']);
      assert.equal(ios.if, "${{ !cancelled() && needs.changes.outputs.ios == 'true' }}");
    });

    it('passes only when both builds passed', () => {
      const [step] = ios.steps;
      assert.equal(step?.env?.RESULT, '${{ needs.ios-simulator.result }}');
      for (const result of ['success', 'failure', 'cancelled', 'skipped']) {
        const r = spawnSync('bash', ['-e', '-c', step!.run!], { encoding: 'utf8', env: { PATH: process.env.PATH, RESULT: result } });
        assert.equal(r.status === 0, result === 'success', `${result}: ${r.stdout}${r.stderr}`);
      }
    });
  });

  // The changes step as written, in a shallow checkout like actions/checkout's, of a throwaway repo: main, then a branch
  // changing the web app and one changing only docs, each merged on top as a pull request's checkout or a merge group's
  // commits are.
  describe('its changes step', () => {
    const step = ci.jobs.changes!.steps.find((s) => s.run?.includes('scripts/ci-changes.sh'))!.run!;
    const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.net', ...args], { cwd, encoding: 'utf8' }).trim();
    function origin() {
      const dir = mkdtempSync(join(tmpdir(), 'ci-changes-'));
      const bare = join(dir, 'origin.git');
      const work = join(dir, 'work');
      execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
      // As GitHub serves a commit by its id.
      git(bare, 'config', 'uploadpack.allowReachableSHA1InWant', 'true');
      execFileSync('git', ['clone', '-q', bare, work]);
      const commit = (path: string, message: string) => {
        mkdirSync(join(work, dirname(path)), { recursive: true });
        writeFileSync(join(work, path), message);
        git(work, 'add', '.');
        git(work, 'commit', '-q', '-m', message);
        return git(work, 'rev-parse', 'HEAD');
      };
      mkdirSync(join(work, 'scripts'));
      cpSync(script, join(work, 'scripts/ci-changes.sh'));
      const main = commit('README.md', 'main');
      git(work, 'push', '-q', 'origin', 'main');
      git(work, 'checkout', '-q', '-b', 'app');
      commit('frontend/src/App.tsx', 'app');
      git(work, 'checkout', '-q', '-b', 'docs', main);
      commit('docs/releasing.md', 'docs');
      return { bare, work, main, git: (...args: string[]) => git(work, ...args) };
    }
    function runStep(o: ReturnType<typeof origin>, event: string, ref: string, env: Record<string, string> = {}) {
      o.git('push', '-q', 'origin', `HEAD:refs/heads/${ref}`);
      const checkout = join(dirname(o.work), 'checkout');
      execFileSync('git', ['clone', '-q', '--depth=2', '--branch', ref, `file://${o.bare}`, checkout]);
      const output = join(dirname(o.work), 'output');
      writeFileSync(output, '');
      const r = spawnSync('bash', ['-e', '-c', step], { cwd: checkout, encoding: 'utf8', env: { PATH: process.env.PATH, GITHUB_EVENT_NAME: event, GITHUB_OUTPUT: output, ...env } });
      assert.equal(r.status, 0, r.stderr);
      return readFileSync(output, 'utf8');
    }

    it("reads a pull request's changes from its merge into the base", () => {
      const o = origin();
      o.git('checkout', '-q', '-b', 'merge', o.main);
      o.git('merge', '-q', '--no-ff', '-m', 'merge app', 'app');
      assert.equal(runStep(o, 'pull_request', 'pull/1/merge'), 'ios=true\n');
    });

    it("reads a merge group's changes against the main it was made from, PRs ahead of it included", () => {
      const o = origin();
      // The group's commit for the docs PR sits on the one for the app PR ahead of it.
      o.git('checkout', '-q', '-b', 'group', o.main);
      o.git('merge', '-q', '--no-ff', '-m', 'merge app', 'app');
      o.git('merge', '-q', '--no-ff', '-m', 'merge docs', 'docs');
      assert.equal(runStep(o, 'merge_group', 'gh-readonly-queue/main/pr-2', { MERGE_GROUP_BASE: o.main }), 'ios=true\n');
    });

    it('runs on a push to main without reading a diff', () => {
      const o = origin();
      o.git('checkout', '-q', 'docs');
      assert.equal(runStep(o, 'push', 'main-copy'), 'ios=true\n');
    });
  });

  it('can be started by hand, which runs every job', () => {
    assert.ok('workflow_dispatch' in ci.on);
  });

  // The iPhone widgets' job holds a macOS runner too, and tests only what the iPhone app is built from, so it runs when
  // the iPhone job does.
  it('leaves every other job to run whatever changed', () => {
    const conditional = Object.entries(ci.jobs).filter(([, job]) => job.if).map(([name]) => name);
    assert.deepEqual(conditional, ['ios-simulator', 'ios', 'widgets']);
    assert.equal(ci.jobs.widgets!.if, ci.jobs['ios-simulator']!.if);
  });
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parse } from 'yaml';

type Step = { uses?: string; run?: string; env?: Record<string, string>; with?: Record<string, unknown> };
type Job = { if?: string; 'runs-on': string; environment?: string; permissions?: Record<string, string>; env?: Record<string, string>; steps: Step[] };
const file = join(import.meta.dirname, '../../.github/workflows/ios-staging.yml');

describe('the iPhone app against staging, .github/workflows/ios-staging.yml', () => {
  const text = readFileSync(file, 'utf8');
  const workflow = parse(text) as { on: { schedule?: { cron: string }[]; workflow_dispatch?: unknown }; permissions: unknown; jobs: Record<string, Job> };
  const jobs = Object.values(workflow.jobs);
  const job = jobs[0]!;
  const runs = job.steps.filter((step) => step.run?.includes('scripts/test-ios.sh'));

  it('runs every night and by hand, from main only and never in a fork', () => {
    assert.equal(workflow.on.schedule?.length, 1);
    assert.match(workflow.on.schedule![0]!.cron, /^\d+ \d+ \* \* \*$/);
    assert.ok('workflow_dispatch' in workflow.on);
    assert.deepEqual(Object.keys(workflow.on).sort(), ['schedule', 'workflow_dispatch']);
    assert.equal(jobs.length, 1);
    assert.equal(job.if, "${{ !github.event.repository.fork && github.ref == 'refs/heads/main' }}");
  });

  it("runs the iPhone tests' signed-in subset against staging, on a Mac, as make test-ios ENV=staging does", () => {
    assert.match(job['runs-on'], /^macos-/);
    assert.equal(runs.length, 1);
    const env = { ...job.env, ...runs[0]!.env };
    assert.equal(env.ENV, 'staging');
    assert.equal(env.MULTISCALE_TARGET, '${{ secrets.STAGING_TEST_TARGET }}');
    assert.equal(env.MULTISCALE_ONLY, undefined);
  });

  it('reads staging and its test user from the release environment, and may do nothing else', () => {
    assert.equal(job.environment, 'release');
    assert.deepEqual(workflow.permissions, {});
    assert.deepEqual(job.permissions, { contents: 'read' });
    assert.match(text, /secrets\.MAC_BUILD_CONFIG/);
  });

  // Against a deployment, the result bundle holds what XCTest typed, the test user's password included, and a public
  // repository's artifacts can be downloaded by anyone signed in to GitHub.
  it('keeps no result bundle and uploads nothing', () => {
    assert.ok(!text.includes('IOS_RESULTS'));
    assert.deepEqual(job.steps.filter((step) => step.uses?.startsWith('actions/upload-artifact')), []);
  });

  it('takes nothing another workflow wrote: no cache, and every action pinned to a commit', () => {
    for (const step of job.steps.filter((s) => s.uses)) {
      assert.match(step.uses!, /^[\w-]+\/[\w-]+@[0-9a-f]{40}$/, step.uses);
      assert.ok(!step.uses!.startsWith('actions/cache'), step.uses);
      assert.equal(step.with?.cache, undefined, step.uses);
    }
  });
});

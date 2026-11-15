import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parse } from 'yaml';

// GitHub's merge queue waits for every required check on each group's commit, so a required job that doesn't run there,
// or skips, leaves the queue waiting until the check times out. These hold the workflows to the ruleset docs/merge-queue.md
// gives, in .github/rulesets/main.json.

const repo = join(import.meta.dirname, '../..');
const GITHUB_ACTIONS = 15368;

interface Job {
  if?: string;
  needs?: string | string[];
  steps?: { if?: string; uses?: string; run?: string }[];
}
interface Workflow {
  on: Record<string, { paths?: string[]; 'paths-ignore'?: string[]; branches?: string[] } | null>;
  jobs: Record<string, Job>;
}
const dir = join(repo, '.github/workflows');
const workflows = Object.fromEntries(readdirSync(dir).map((file) => [file, parse(readFileSync(join(dir, file), 'utf8')) as Workflow]));

interface Rule {
  type: string;
  parameters?: Record<string, unknown>;
}
const ruleset = JSON.parse(readFileSync(join(repo, '.github/rulesets/main.json'), 'utf8')) as {
  target: string;
  enforcement: string;
  conditions: { ref_name: { include: string[] } };
  rules: Rule[];
};
const rule = (type: string) => ruleset.rules.find((r) => r.type === type)?.parameters ?? assert.fail(`no ${type} rule`);
const required = (rule('required_status_checks').required_status_checks as { context: string; integration_id: number }[]);

/** The workflow and job that report a check, by the job's name, which is its check's name. */
function reporter(check: string): [string, Workflow, Job] {
  const found = Object.entries(workflows).flatMap(([file, w]) => (w.jobs[check] ? [[file, w, w.jobs[check]] as [string, Workflow, Job]] : []));
  assert.equal(found.length, 1, `one job named ${check}`);
  return found[0]!;
}

describe("main's merge queue ruleset", () => {
  it('requires the checks main requires today, each from GitHub Actions', () => {
    assert.deepEqual(required.map((c) => c.context), [
      'secret-scan', 'cla', 'frontend', 'backend', 'infrastructure', 'local-suite', 'e2e-stack', 'e2e-browser', 'e2e-electron', 'e2e-compat',
    ]);
    for (const check of required) assert.equal(check.integration_id, GITHUB_ACTIONS, check.context);
  });

  it("queues main's merges as merge commits, never with a failing pull request, and needs no branch to be up to date", () => {
    assert.equal(ruleset.target, 'branch');
    assert.deepEqual(ruleset.conditions.ref_name.include, ['~DEFAULT_BRANCH']);
    const queue = rule('merge_queue');
    // Merge commits keep "Merge pull request #N from <branch>" as main's subjects, as today.
    assert.equal(queue.merge_method, 'MERGE');
    // Each pull request in a group passes on its own commit, so a failing one never merges behind a green one.
    assert.equal(queue.grouping_strategy, 'ALLGREEN');
    assert.equal(rule('required_status_checks').strict_required_status_checks_policy, false);
    // Longer than the slowest required job, e2e-browser, takes with a wait for a runner.
    assert.ok((queue.check_response_timeout_minutes as number) >= 45);
    for (const type of ['deletion', 'non_fast_forward']) assert.ok(ruleset.rules.some((r) => r.type === type), type);
  });
});

describe('the workflows behind main’s required checks', () => {
  it('each runs for a merge group', () => {
    for (const { context } of required) {
      const [file, workflow] = reporter(context);
      assert.ok('merge_group' in workflow.on, `${file}, for ${context}`);
    }
  });

  it('runs every required job there, with nothing that could skip it or anything it needs', () => {
    for (const { context } of required) {
      const [file, workflow, job] = reporter(context);
      const chain = [context];
      for (let i = 0; i < chain.length; i++) {
        const name = chain[i]!;
        assert.equal(workflow.jobs[name]!.if, undefined, `${file}: ${name}, which ${context} needs, has an if`);
        chain.push(...[workflow.jobs[name]!.needs ?? []].flat());
      }
      assert.ok(job.steps?.length, context);
    }
  });

  it('filters none of their pull requests or merge groups by path, which would leave a required check pending', () => {
    for (const { context } of required) {
      const [file, workflow] = reporter(context);
      for (const event of ['pull_request', 'pull_request_target', 'merge_group']) {
        const filter = workflow.on[event];
        assert.ok(!filter?.paths && !filter?.['paths-ignore'], `${file}: ${event}`);
      }
    }
  });

  it("reports the CLA check for a merge group without asking anyone to sign, since each PR passed it to be queued", () => {
    const [, , job] = reporter('cla');
    const sign = job.steps!.find((s) => s.uses?.startsWith('contributor-assistant/github-action'))!;
    assert.doesNotMatch(sign.if ?? '', /merge_group/);
    assert.ok(job.steps!.some((s) => s.if === "github.event_name == 'merge_group'" && s.run));
  });
});

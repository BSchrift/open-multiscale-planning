import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parse, stringify } from 'yaml';
import { configDir, loadConfig, loadControl } from '../lib/config.ts';

const repoConfig = join(import.meta.dirname, '../../config');
const good = {
  aws: { account: '210987654321', region: 'us-west-2', profile: 'multiscale-staging' },
  alarmEmail: 'me@example.net',
  auth: { cognitoDomainPrefix: 'multiscale-staging-abc', signInCallbackUrls: ['multiscale://auth/callback'] },
  dns: { zone: 'staging.example.net' },
  integration: { testUser: 'test@example.net', capabilities: ['googleClient'] },
};
const goodControl = { aws: { account: '210987654321', region: 'us-west-2', profile: 'multiscale-control' }, dns: { domain: 'example.net', hostedZoneId: 'Z0123456789ABCDEFGHIJ' } };

/** A config folder holding these files, each a YAML string or an object to write as YAML. */
function dirWith(files: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), 'config-'));
  for (const [name, value] of Object.entries(files)) {
    writeFileSync(join(dir, `${name}.yaml`), typeof value === 'string' ? value : stringify(value));
  }
  return dir;
}
const withStaging = (staging: unknown) => dirWith({ staging, control: goodControl });

/** A copy of `base` with one field, named by its dotted path, replaced. */
function withField<T>(base: T, path: string, value: unknown): T {
  const copy = structuredClone(base) as any;
  const keys = path.split('.');
  let at = copy;
  for (const key of keys.slice(0, -1)) at = at[key];
  at[keys.at(-1)!] = value;
  return copy;
}

const throwsNaming = (fn: () => unknown, ...parts: string[]) =>
  assert.throws(fn, (e: Error) => parts.every((p) => e.message.includes(p)) || assert.fail(e.message));

describe('loadConfig', () => {
  it('reads the environment file and the control file it delegates from', () => {
    const { config, control } = loadConfig('staging', withStaging(good), true);
    assert.equal(config.aws.account, '210987654321');
    assert.equal(config.dns?.zone, 'staging.example.net');
    assert.equal(control?.dns?.domain, 'example.net');
  });

  it('keeps a quoted account as written, and rejects an unquoted one, which YAML reads as a number', () => {
    assert.equal(loadConfig('staging', withStaging(withField(good, 'aws.account', '012345678901')), true).config.aws.account, '012345678901');
    const unquoted = stringify(good).replace('"210987654321"', '210987654321');
    assert.match(unquoted, /account: 210987654321/);
    assert.throws(() => loadConfig('staging', withStaging(unquoted), false), /aws\.account/);
  });

  it('falls back to the examples for synth, so that a fresh clone synthesizes', () => {
    const { config, control } = loadConfig('staging', dirWith({}), false);
    assert.equal(config.aws.account, '111111111111');
    assert.equal(control?.dns?.domain, 'example.com');
  });

  it('pairs an example with the example control, so that synth works before every file is filled in', () => {
    const { config, control } = loadConfig('prod', dirWith({ control: goodControl, staging: good }), false);
    assert.equal(config.dns?.zone, 'app.example.com');
    assert.equal(control?.dns?.domain, 'example.com');
  });

  it('never falls back when deploying, and names the missing file and the example to copy', () => {
    const dir = dirWith({ control: goodControl });
    throwsNaming(() => loadConfig('staging', dir, true), join(dir, 'staging.yaml'), join(repoConfig, 'staging.example.yaml'));
  });

  it('refuses to deploy the example values', () => {
    for (const [path, value] of [
      ['aws.account', '111111111111'],
      ['aws.account', '222222222222'],
      ['aws.account', '333333333333'],
      ['auth.cognitoDomainPrefix', 'multiscale-staging-change-me'],
      ['alarmEmail', 'you@example.com'],
      ['alarmEmail', 'Alerts@Example.COM'],
    ] as const) {
      assert.throws(() => loadConfig('staging', withStaging(withField(good, path, value)), true), /example/, `${path} ${value}`);
    }
  });

  it('refuses to deploy into the example domain', () => {
    const dir = dirWith({ staging: withField(good, 'dns.zone', 'staging.example.com'), control: withField(goodControl, 'dns.domain', 'example.com') });
    assert.throws(() => loadConfig('staging', dir, true), /control\.yaml: still has example values/);
  });

  for (const [path, bad] of [
    ['aws.account', '123'],
    ['aws.region', 'west'],
    ['aws.profile', ''],
    ['aws.profile', undefined],
    ['alarmEmail', 'nobody'],
    ['auth.cognitoDomainPrefix', 'Has Spaces'],
    ['auth.cognitoDomainPrefix', 'my-cognito-app'],
    ['auth.signInCallbackUrls', []],
    ['auth.signInCallbackUrls', 'multiscale://auth/callback'],
    ['auth.signInCallbackUrls', ['http://example.com/callback']],
    ['dns.zone', 'staging.other.net'],
    ['dns.zone', 'stagingexample.net'],
    ['dns.zone', 'example.net'],
    ['dns.zone', 'Staging.example.net'],
  ] as const) {
    it(`rejects ${path} = ${JSON.stringify(bad)}`, () => {
      assert.throws(() => loadConfig('staging', withStaging(withField(good, path, bad)), false), new RegExp(path.replace('.', '\\.')));
    });
  }

  it('lists what is missing instead of crashing on a missing section or an empty file', () => {
    assert.throws(() => loadConfig('staging', withStaging({ ...good, auth: undefined }), false), /auth\.cognitoDomainPrefix/);
    assert.throws(() => loadConfig('staging', withStaging(''), false), /aws\.account/);
  });

  it('needs control.yaml when the environment sets dns.zone, and says which file to copy', () => {
    const dir = dirWith({ staging: good });
    throwsNaming(() => loadConfig('staging', dir, false), join(dir, 'control.yaml'), join(repoConfig, 'control.example.yaml'));
  });

  it("needs control.yaml's dns.domain for a zone", () => {
    const dir = dirWith({ staging: good, control: { aws: goodControl.aws } });
    assert.throws(() => loadConfig('staging', dir, false), /dns\.zone/);
  });

  it("rejects a zone the other environment already uses, since each would undelegate the other's", () => {
    const dir = dirWith({ control: goodControl, staging: good, prod: good });
    for (const envName of ['staging', 'prod'] as const) {
      throwsNaming(() => loadConfig(envName, dir, false), 'dns.zone', join(dir, envName === 'staging' ? 'prod.yaml' : 'staging.yaml'));
    }
  });

  it('needs no control.yaml without a zone', () => {
    const { config, control } = loadConfig('staging', dirWith({ staging: { ...good, dns: undefined } }), true);
    assert.equal(config.dns, undefined);
    assert.equal(control, undefined);
  });

  it('allows https and a custom scheme, and plain http only on localhost', () => {
    const urls = ['https://example.com/cb', 'multiscale://auth/callback', 'http://localhost:5173/auth/callback'];
    assert.deepEqual(loadConfig('staging', withStaging(withField(good, 'auth.signInCallbackUrls', urls)), false).config.auth.signInCallbackUrls, urls);
  });
});

describe('loadControl', () => {
  it('reads control.yaml, whose dns section is optional', () => {
    assert.equal(loadControl(dirWith({ control: goodControl }), true).dns?.domain, 'example.net');
    assert.equal(loadControl(dirWith({ control: { aws: goodControl.aws } }), true).dns, undefined);
  });

  it('falls back to the example for synth only', () => {
    const dir = dirWith({});
    assert.equal(loadControl(dir, false).aws.account, '333333333333');
    throwsNaming(() => loadControl(dir, true), join(dir, 'control.yaml'), join(repoConfig, 'control.example.yaml'));
  });

  it('refuses to deploy the example account or domain', () => {
    assert.throws(() => loadControl(dirWith({ control: withField(goodControl, 'aws.account', '333333333333') }), true), /example/);
    assert.throws(() => loadControl(dirWith({ control: withField(goodControl, 'dns.domain', 'example.com') }), true), /example/);
    assert.throws(() => loadControl(dirWith({ control: withField(goodControl, 'dns.domain', 'my.example.com') }), true), /example/);
  });

  for (const [path, bad] of [
    ['aws.account', 210987654321],
    ['aws.region', 'west'],
    ['aws.profile', 'two words'],
    ['dns.domain', 'Example.NET'],
    ['dns.domain', 'https://example.net'],
    ['dns.domain', 'net'],
    ['dns.hostedZoneId', undefined],
    ['dns.hostedZoneId', 'z0123456789'],
    ['dns.hostedZoneId', '/hostedzone/Z0123456789'],
    ['dns.txt', 'google-site-verification=abc'],
    ['dns.txt', ['']],
  ] as const) {
    it(`rejects ${path} = ${JSON.stringify(bad)}`, () => {
      assert.throws(() => loadControl(dirWith({ control: withField(goodControl, path, bad) }), false), new RegExp(path.replace('.', '\\.')));
    });
  }

  const withPipeline = { ...goodControl, pipeline: { repository: 'someone/open-multiscale-planning', branch: 'main', email: 'releases@example.net' } };

  it("reads the pipeline's window before prod, two hours unless it says, and none with PT0S", () => {
    assert.equal(loadControl(dirWith({ control: withPipeline }), true).pipeline?.promoteAfter, 'PT2H');
    assert.equal(loadControl(dirWith({ control: withField(withPipeline, 'pipeline.promoteAfter', 'PT0S') }), true).pipeline?.promoteAfter, 'PT0S');
    assert.equal(loadControl(dirWith({ control: withField(withPipeline, 'pipeline.promoteAfter', 'P1DT30M') }), true).pipeline?.promoteAfter, 'P1DT30M');
  });

  it('reads the optional pipeline section', () => {
    assert.equal(loadControl(dirWith({ control: withPipeline }), true).pipeline?.repository, 'someone/open-multiscale-planning');
    assert.equal(loadControl(dirWith({ control: goodControl }), true).pipeline, undefined);
  });

  it("refuses to deploy the example's pipeline email", () => {
    assert.throws(() => loadControl(dirWith({ control: withField(withPipeline, 'pipeline.email', 'you@example.com') }), true), /example/);
  });

  for (const [path, bad] of [
    ['pipeline.repository', 'open-multiscale-planning'],
    ['pipeline.repository', 'https://github.com/someone/open-multiscale-planning'],
    ['pipeline.branch', ''],
    ['pipeline.branch', 'two words'],
    ['pipeline.email', 'releases'],
    // Whole days, hours, minutes and seconds, up to 6 days: the pipeline waits on Step Functions for at most 7.
    ['pipeline.promoteAfter', '2h'],
    ['pipeline.promoteAfter', 'P1M'],
    ['pipeline.promoteAfter', 'PT'],
    ['pipeline.promoteAfter', 'P7D'],
    ['pipeline.promoteAfter', 7200],
  ] as const) {
    it(`rejects ${path} = ${JSON.stringify(bad)}`, () => {
      assert.throws(() => loadControl(dirWith({ control: withField(withPipeline, path, bad) }), false), new RegExp(path.replace('.', '\\.')));
    });
  }
});

describe('configDir', () => {
  it('is MULTISCALE_CONFIG_DIR when set, else the config folder at the top of the repo', () => {
    const saved = process.env.MULTISCALE_CONFIG_DIR;
    try {
      delete process.env.MULTISCALE_CONFIG_DIR;
      assert.equal(configDir(), repoConfig);
      process.env.MULTISCALE_CONFIG_DIR = '/somewhere/else';
      assert.equal(configDir(), '/somewhere/else');
    } finally {
      if (saved === undefined) delete process.env.MULTISCALE_CONFIG_DIR;
      else process.env.MULTISCALE_CONFIG_DIR = saved;
    }
  });
});

describe('example config', () => {
  const callbacks = (env: string) => parse(readFileSync(join(repoConfig, `${env}.example.yaml`), 'utf8')).auth.signInCallbackUrls;

  it('covers each app build that signs in to that environment', () => {
    // iPhone always returns to multiscale://. On the desktop, a staging install has its own scheme.
    assert.deepEqual(callbacks('staging'), ['multiscale-staging://auth/callback', 'multiscale://auth/callback']);
    assert.deepEqual(callbacks('prod'), ['multiscale://auth/callback']);
  });
});

describe('bin/app.ts', () => {
  const run = (configDir: string, ...context: string[]) => {
    const out = mkdtempSync(join(tmpdir(), 'cdkout-'));
    const r = spawnSync('node', ['bin/app.ts'], {
      cwd: join(import.meta.dirname, '..'),
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        CDK_OUTDIR: out,
        MULTISCALE_CONFIG_DIR: configDir,
        CDK_CONTEXT_JSON: JSON.stringify(Object.fromEntries(context.map((c) => c.split('=')))),
      },
    });
    return { ...r, out, template: (stack: string) => readFileSync(join(out, `${stack}.template.json`), 'utf8') };
  };
  const real = {
    control: goodControl,
    staging: good,
    prod: { ...withField(good, 'dns.zone', 'app.example.net'), aws: { ...good.aws, profile: 'multiscale-prod' } },
  };

  it('synthesizes all three stacks from the examples, with no credentials', () => {
    const r = run(dirWith({}));
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.template('Multiscale-staging').includes('Multiscale/staging'));
    assert.ok(r.template('Multiscale-prod').includes('Multiscale/prod'));
    assert.ok(r.template('Multiscale-control').includes('multiscale-dns-delegation'));
    assert.ok(r.template('Multiscale-site').includes('www.example.com'));
    assert.ok(r.template('Multiscale-pipeline').includes('your-github-user/open-multiscale-planning'));
    // Each environment's release role trusts the pipeline's account.
    assert.ok(r.template('Multiscale-staging').includes('multiscale-release'));
  });

  it('deploys the pipeline only when control.yaml sets it up', () => {
    const without = run(dirWith(real), 'deploy=pipeline');
    assert.notEqual(without.status, 0);
    assert.match(without.stderr, /no pipeline section/);
    const pipeline = { repository: 'someone/open-multiscale-planning', branch: 'main', email: 'releases@example.net' };
    const r = run(dirWith({ ...real, control: { ...goodControl, pipeline } }), 'deploy=pipeline');
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.template('Multiscale-pipeline').includes('someone/open-multiscale-planning'));
    assert.ok(!existsSync(join(r.out, 'Multiscale-prod.template.json')));
  });

  it('rejects an unknown deploy target', () => {
    const r = run(dirWith({}), 'deploy=dev');
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /control, staging, prod or pipeline/);
  });

  it('deploys only the stack asked for, from the real files', () => {
    const r = run(dirWith(real), 'deploy=control');
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.template('Multiscale-control').includes('staging.example.net'));
    assert.ok(!existsSync(join(r.out, 'Multiscale-staging.template.json')));
  });

  it('needs the real staging and prod files to deploy control, since its role trusts their accounts', () => {
    const dir = dirWith({ control: goodControl, staging: good });
    const r = run(dir, 'deploy=control');
    assert.notEqual(r.status, 0);
    assert.ok(r.stderr.includes(join(dir, 'prod.yaml')), r.stderr);
  });
});

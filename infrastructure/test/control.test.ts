import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { ControlStack } from '../lib/control-stack.ts';
import { MultiscaleStack } from '../lib/stack.ts';
import type { Config, ControlConfig } from '../lib/config.ts';

const CONTROL = '333333333333';
const STAGING = '111111111111';
const PROD = '222222222222';

const control = (account = CONTROL, domain: string | null = 'example.net'): ControlConfig => ({
  aws: { account, region: 'us-west-2', profile: 'control' },
  ...(domain ? { dns: { domain, hostedZoneId: 'Z0PARENTZONE' } } : {}),
});
const env = (account: string, zone?: string): Config => ({
  aws: { account, region: 'us-west-2', profile: 'env' },
  alarmEmail: 'alarms@example.net',
  auth: { cognitoDomainPrefix: 'multiscale-test', signInCallbackUrls: ['multiscale://auth/callback'] },
  ...(zone ? { dns: { zone } } : {}),
});

const synth = (c: ControlConfig, environments: Config[]) => Template.fromStack(new ControlStack(new App(), 'Multiscale-control', { control: c, environments }));
type Resource = { Type: string; Properties: Record<string, any>; DeletionPolicy?: string };
const ofType = (t: Template, type: string) => Object.values(t.toJSON().Resources ?? {} as Record<string, Resource>).filter((r: any) => r.Type === type) as Resource[];
const trusted = (t: Template) => {
  const [role] = ofType(t, 'AWS::IAM::Role').filter((r) => r.Properties.RoleName === 'multiscale-dns-delegation');
  assert.ok(role, 'no delegation role');
  const principals = role.Properties.AssumeRolePolicyDocument.Statement.flatMap((s: any) => [s.Principal.AWS].flat());
  return principals.map((p: any) => JSON.stringify(p).match(/iam::(\d{12}):root/)![1]).sort();
};

describe('control stack without a domain', () => {
  it('creates nothing, since everything in it is DNS', () => {
    assert.deepEqual(Object.keys(synth(control(CONTROL, null), []).toJSON().Resources ?? {}), []);
  });
});

describe('control stack with a domain', () => {
  const t = synth(control(), [env(STAGING, 'staging.example.net'), env(PROD, 'app.example.net')]);

  it('adopts the zone Route 53 made when the domain was registered, and creates no zone or name-server change', () => {
    t.resourceCountIs('AWS::Route53::HostedZone', 0);
    assert.deepEqual(ofType(t, 'Custom::AWS'), []);
    assert.deepEqual(ofType(t, 'AWS::Lambda::Function'), []);
  });

  it('can be deleted, since it holds only the delegation role', () => {
    assert.equal(new ControlStack(new App(), 'Multiscale-control', { control: control(), environments: [] }).terminationProtection, false);
  });

  it('has one delegation role with a fixed name, trusted by the staging and prod accounts', () => {
    assert.deepEqual(trusted(t), [STAGING, PROD].sort());
  });

  it('lets the role change only NS records, and only for the zones staging and prod set', () => {
    const [roleId] = Object.entries(t.toJSON().Resources).find(([, r]: [string, any]) => r.Properties?.RoleName === 'multiscale-dns-delegation')!;
    const statements = ofType(t, 'AWS::IAM::Policy')
      .filter((p) => p.Properties.Roles.some((r: any) => r.Ref === roleId))
      .flatMap((p) => p.Properties.PolicyDocument.Statement);
    const change = statements.find((s: any) => s.Action === 'route53:ChangeResourceRecordSets');
    assert.ok(change, 'no ChangeResourceRecordSets');
    assert.deepEqual(change.Condition['ForAllValues:StringEquals'], {
      'route53:ChangeResourceRecordSetsRecordTypes': ['NS'],
      'route53:ChangeResourceRecordSetsActions': ['UPSERT', 'DELETE'],
      'route53:ChangeResourceRecordSetsNormalizedRecordNames': ['staging.example.net', 'app.example.net'],
    });
    assert.deepEqual(change.Resource, { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':route53:::hostedzone/Z0PARENTZONE']] });
  });

  it('trusts only environments that set a zone, and creates no role when none does', () => {
    assert.deepEqual(trusted(synth(control(), [env(STAGING, 'staging.example.net'), env(PROD)])), [STAGING]);
    assert.equal(ofType(synth(control(), [env(STAGING), env(PROD)]), 'AWS::IAM::Role').filter((r) => r.Properties.RoleName).length, 0);
  });
});

describe('accounts', () => {
  for (const [name, accounts] of [
    ['one account', { control: CONTROL, staging: CONTROL, prod: CONTROL }],
    ['three accounts', { control: CONTROL, staging: STAGING, prod: PROD }],
    ['staging in the control account', { control: CONTROL, staging: CONTROL, prod: PROD }],
    ['prod in the control account', { control: CONTROL, staging: STAGING, prod: CONTROL }],
    ['staging and prod sharing an account', { control: CONTROL, staging: STAGING, prod: STAGING }],
  ] as const) {
    it(`synthesizes all three stacks with ${name}, trusting each account once`, () => {
      const app = new App();
      const c = control(accounts.control);
      const staging = env(accounts.staging, 'staging.example.net');
      const prod = env(accounts.prod, 'app.example.net');
      const controlStack = new ControlStack(app, 'Multiscale-control', { control: c, environments: [staging, prod] });
      const stacks = (['staging', 'prod'] as const).map((envName) =>
        new MultiscaleStack(app, `Multiscale-${envName}`, { envName, config: envName === 'staging' ? staging : prod, control: c, backendDist: '/nonexistent', requireBinaries: false }));
      app.synth();
      assert.deepEqual(trusted(Template.fromStack(controlStack)), [...new Set([accounts.staging, accounts.prod])].sort());
      for (const stack of stacks) {
        const role = JSON.stringify(Template.fromStack(stack).findResources('Custom::CrossAccountZoneDelegation'));
        assert.ok(role.includes(`:iam::${accounts.control}:role/multiscale-dns-delegation`), stack.stackName);
      }
    });
  }
});

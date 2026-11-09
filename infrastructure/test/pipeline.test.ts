import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { PipelineStack } from '../lib/pipeline-stack.ts';
import type { Config, ControlConfig, PipelineConfig } from '../lib/config.ts';

const env = (account: string, name: string): Config => ({
  aws: { account, region: 'us-east-2', profile: `ms-${name}` },
  alarmEmail: 'alarms@example.net',
  auth: { cognitoDomainPrefix: `multiscale-${name}`, signInCallbackUrls: ['multiscale://auth/callback'] },
});
const control: ControlConfig & { pipeline: PipelineConfig } = {
  aws: { account: '333333333333', region: 'us-east-2', profile: 'ms-control' },
  pipeline: { repository: 'someone/open-multiscale-planning', branch: 'main', email: 'releases@example.net' },
};
const environments = { staging: env('111111111111', 'staging'), prod: env('222222222222', 'prod') };

const t = Template.fromStack(new PipelineStack(new App(), 'Multiscale-pipeline', { control, environments }));
const all = t.toJSON().Resources as Record<string, { Type: string; Properties: any }>;
const ofType = (type: string) => Object.entries(all).filter(([, r]) => r.Type === type);
const [[, pipeline]] = ofType('AWS::CodePipeline::Pipeline');
const stages = pipeline.Properties.Stages as { Name: string; Actions: any[] }[];
const actions = (stage: string) => stages.find((s) => s.Name === stage)!.Actions.sort((a, b) => a.RunOrder - b.RunOrder);
const roleArn = (account: string, name: string) => ({ 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, `:iam::${account}:role/${name}`]] });
const bootstrapRole = (account: string, kind: string) => roleArn(account, `cdk-hnb659fds-${kind}-role-${account}-us-east-2`);
const step = (action: any) => JSON.parse(action.Configuration.EnvironmentVariables).find((v: any) => v.name === 'STEP').value;

describe('the release pipeline', () => {
  it('is a V2 pipeline named Multiscale, in the control account', () => {
    assert.equal(pipeline.Properties.PipelineType, 'V2');
    assert.equal(pipeline.Properties.Name, 'Multiscale');
    assert.deepEqual(stages.map((s) => s.Name), ['Source', 'Build', 'Staging', 'Approve', 'Prod']);
  });

  it("starts from the configured branch, through a GitHub connection, as a clone the builds can read git from", () => {
    const [source] = actions('Source');
    assert.equal(source.ActionTypeId.Provider, 'CodeStarSourceConnection');
    assert.equal(source.Configuration.FullRepositoryId, 'someone/open-multiscale-planning');
    assert.equal(source.Configuration.BranchName, 'main');
    assert.equal(source.Configuration.OutputArtifactFormat, 'CODEBUILD_CLONE_REF');
    t.hasResourceProperties('AWS::CodeStarConnections::Connection', { ProviderType: 'GitHub' });
  });

  it('builds once, then deploys and tests staging, waits for a person, and promotes the same build to prod', () => {
    assert.deepEqual(actions('Build').map(step), ['build']);
    assert.deepEqual(actions('Staging').map(step), ['deploy-staging', 'release-staging']);
    const [approve] = actions('Approve');
    assert.equal(approve.ActionTypeId.Category, 'Approval');
    assert.ok(approve.Configuration.NotificationArn);
    const prod = actions('Prod');
    assert.deepEqual(prod.map((a) => a.Name), ['PublishAssets', 'Prepare', 'Deploy', 'Test', 'Release']);
    assert.deepEqual([prod[0], prod[3], prod[4]].map(step), ['prod-assets', 'test-prod', 'release-prod']);
    // Every step after the build reads its assemblies.
    for (const action of [...actions('Staging'), prod[0], prod[3], prod[4]]) {
      assert.deepEqual(action.InputArtifacts.map((a: any) => a.Name), ['Source', 'Built']);
    }
  });

  it("deploys prod with CloudFormation in prod's account, which waits out the day's canary without a build running", () => {
    const [, prepare, deploy] = actions('Prod');
    assert.equal(prepare.Configuration.ActionMode, 'CHANGE_SET_REPLACE');
    assert.equal(prepare.Configuration.StackName, 'Multiscale-prod');
    assert.equal(prepare.Configuration.TemplatePath, 'Built::infrastructure/cdk.out/prod/Multiscale-prod.template.json');
    assert.deepEqual(prepare.RoleArn, bootstrapRole('222222222222', 'deploy'));
    assert.deepEqual(prepare.Configuration.RoleArn, bootstrapRole('222222222222', 'cfn-exec'));
    assert.equal(deploy.Configuration.ActionMode, 'CHANGE_SET_EXECUTE');
    assert.equal(deploy.Configuration.ChangeSetName, prepare.Configuration.ChangeSetName);
    assert.deepEqual(deploy.RoleArn, bootstrapRole('222222222222', 'deploy'));
    // The template and assets cross accounts, so the artifacts are encrypted with a key prod's deploy role may use.
    assert.equal(ofType('AWS::KMS::Key').length, 1);
  });

  it('lets a run started by hand skip the pause switch and prod\'s canary', () => {
    assert.deepEqual(pipeline.Properties.Variables.map((v: any) => [v.Name, v.DefaultValue]), [['CANARY', 'on'], ['RUN', 'auto']]);
    const vars = JSON.parse(actions('Build')[0].Configuration.EnvironmentVariables);
    assert.deepEqual(vars.find((v: any) => v.name === 'CANARY').value, '#{variables.CANARY}');
    assert.deepEqual(vars.find((v: any) => v.name === 'RUN').value, '#{variables.RUN}');
  });

  it('builds may assume only CDK\'s bootstrap roles and the release role in staging and prod', () => {
    const [[roleId]] = ofType('AWS::IAM::Role').filter(([, r]) => r.Properties.RoleName === 'multiscale-pipeline');
    const statements = ofType('AWS::IAM::Policy')
      .filter(([, p]) => p.Properties.Roles.some((r: any) => r.Ref === roleId))
      .flatMap(([, p]) => p.Properties.PolicyDocument.Statement as any[]);
    const assume = statements.filter((s) => s.Action === 'sts:AssumeRole').flatMap((s) => s.Resource);
    const expected = ['111111111111', '222222222222'].flatMap((account) => [
      ...['deploy', 'file-publishing', 'lookup'].map((kind) => bootstrapRole(account, kind)),
      roleArn(account, 'multiscale-release'),
    ]);
    assert.deepEqual(assume, expected);
    for (const s of statements) {
      assert.ok(![s.Action].flat().some((a: string) => a === '*' || a.endsWith(':*')), JSON.stringify(s.Action));
    }
    // Its own parameters only, and it writes only the two commits it records.
    const ssm = statements.filter((s) => [s.Action].flat().some((a: string) => a.startsWith('ssm:')));
    assert.ok(ssm.every((s) => JSON.stringify(s.Resource).includes(':parameter/multiscale/pipeline/')), JSON.stringify(ssm));
    const writes = ssm.filter((s) => s.Action === 'ssm:PutParameter').flatMap((s) => s.Resource).map((r: any) => JSON.stringify(r));
    assert.ok(writes.length === 2 && writes.every((r) => /pipeline\/(released|nightly)"/.test(r)), writes.join());
  });

  it('emails approval requests and failed runs to the configured address', () => {
    t.hasResourceProperties('AWS::SNS::Subscription', { Protocol: 'email', Endpoint: 'releases@example.net' });
    const rules = ofType('AWS::Events::Rule').map(([, r]) => r.Properties.EventPattern);
    assert.deepEqual(rules.map((p) => p.source).sort(), [['aws.codebuild'], ['aws.codepipeline']]);
    assert.ok(rules.some((p) => p.detail.state?.[0] === 'FAILED'));
  });

  it("runs staging's slow suites every night, never as part of a release", () => {
    const nightly = ofType('AWS::CodeBuild::Project').find(([, p]) => p.Properties.Source.Type === 'NO_SOURCE')!;
    t.hasResourceProperties('AWS::Scheduler::Schedule', {
      ScheduleExpression: 'cron(0 10 * * ? *)',
      Target: Match.objectLike({ Arn: { 'Fn::GetAtt': [nightly[0], 'Arn'] } }),
    });
    const vars = nightly[1].Properties.Environment.EnvironmentVariables;
    assert.deepEqual(vars.find((v: any) => v.Name === 'STEP').Value, 'nightly');
    assert.match(nightly[1].Properties.Source.BuildSpec, /scripts\/pipeline\.sh nightly/);
  });

  it('needs every environment in the control account\'s region', () => {
    const elsewhere = { ...environments, prod: { ...environments.prod, aws: { ...environments.prod.aws, region: 'eu-west-1' } } };
    assert.throws(() => new PipelineStack(new App(), 'P', { control, environments: elsewhere }), /prod in us-east-2/);
  });
});

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
const envOf = (action: any) => JSON.parse(action.Configuration.EnvironmentVariables) as { name: string; value: string; type: string }[];
const step = (action: any) => envOf(action).find((v) => v.name === 'STEP')?.value ?? action.Name;
const projectOf = (action: any) => all[action.Configuration.ProjectName.Ref]!;
const policiesOf = (roleId: string) => ofType('AWS::IAM::Policy')
  .filter(([, p]) => p.Properties.Roles.some((r: any) => r.Ref === roleId))
  .flatMap(([, p]) => p.Properties.PolicyDocument.Statement as any[]);
const roleNamed = (name: string) => ofType('AWS::IAM::Role').find(([, r]) => r.Properties.RoleName === name)![0];

describe('the release pipeline', () => {
  it('is a V2 pipeline named Multiscale, in the control account', () => {
    assert.equal(pipeline.Properties.PipelineType, 'V2');
    assert.equal(pipeline.Properties.Name, 'Multiscale');
    assert.deepEqual(stages.map((s) => s.Name), ['Source', 'Build', 'Staging', 'Promote', 'Prod']);
  });

  it("starts from the configured branch, through a GitHub connection, as a clone the builds can read git from", () => {
    const [source] = actions('Source');
    assert.equal(source.ActionTypeId.Provider, 'CodeStarSourceConnection');
    assert.equal(source.Configuration.FullRepositoryId, 'someone/open-multiscale-planning');
    assert.equal(source.Configuration.BranchName, 'main');
    assert.equal(source.Configuration.OutputArtifactFormat, 'CODEBUILD_CLONE_REF');
    t.hasResourceProperties('AWS::CodeStarConnections::Connection', { ProviderType: 'GitHub' });
  });

  it('names no variable namespace after an artifact, which CodePipeline refuses on create', () => {
    const all = stages.flatMap((s) => s.Actions);
    const artifacts = new Set(all.flatMap((a: any) => (a.OutputArtifacts ?? []).map((o: any) => o.Name)));
    const namespaces = all.map((a: any) => a.Namespace).filter(Boolean);
    assert.ok(namespaces.length > 0);
    for (const namespace of namespaces) assert.ok(!artifacts.has(namespace), `namespace ${namespace} is also an artifact`);
  });

  it('builds once, then deploys and tests staging, waits out the window, and promotes the same build to prod', () => {
    assert.deepEqual(actions('Build').map(step), ['build']);
    assert.deepEqual(actions('Staging').map(step), ['deploy-staging', 'Sign', 'release-staging']);
    // No person needs to approve: a state machine emails and waits, and the owner may stop the run in that time.
    assert.ok(!stages.some((s) => s.Actions.some((a) => a.ActionTypeId.Category === 'Approval')));
    const [wait] = actions('Promote');
    assert.equal(wait.ActionTypeId.Provider, 'StepFunctions');
    const prod = actions('Prod');
    assert.deepEqual(prod.map((a) => a.Name), ['PublishAssets', 'Prepare', 'Deploy', 'Test', 'Sign', 'Release']);
    assert.deepEqual([prod[0], prod[3], prod[5]].map(step), ['prod-assets', 'test-prod', 'release-prod']);
    // Every step after the build reads its output, and each release reads what its signing step signed.
    const [deployStaging, , releaseStaging] = actions('Staging');
    for (const action of [deployStaging, prod[0], prod[3]]) assert.deepEqual(action.InputArtifacts.map((a: any) => a.Name), ['Source', 'Built']);
    assert.deepEqual(releaseStaging.InputArtifacts.map((a: any) => a.Name), ['Source', 'Built', 'SignedStaging']);
    assert.deepEqual(prod[5].InputArtifacts.map((a: any) => a.Name), ['Source', 'Built', 'SignedProd']);
  });

  it("deploys prod with CloudFormation in prod's account, which waits out the day's canary without a build running", () => {
    const [, prepare, deploy] = actions('Prod');
    assert.equal(prepare.Configuration.ActionMode, 'CHANGE_SET_REPLACE');
    assert.equal(prepare.Configuration.StackName, 'Multiscale-prod');
    assert.equal(prepare.Configuration.TemplatePath, 'Built::infrastructure/cdk.out/prod/Multiscale-prod.template.json');
    // Prod's stack names its IAM roles (multiscale-release), which CloudFormation refuses to change without this.
    assert.equal(prepare.Configuration.Capabilities, 'CAPABILITY_NAMED_IAM');
    assert.deepEqual(prepare.RoleArn, bootstrapRole('222222222222', 'deploy'));
    assert.deepEqual(prepare.Configuration.RoleArn, bootstrapRole('222222222222', 'cfn-exec'));
    assert.equal(deploy.Configuration.ActionMode, 'CHANGE_SET_EXECUTE');
    assert.equal(deploy.Configuration.ChangeSetName, prepare.Configuration.ChangeSetName);
    assert.deepEqual(deploy.RoleArn, bootstrapRole('222222222222', 'deploy'));
    // The template and assets cross accounts, so the artifacts are encrypted with a key prod's deploy role may use.
    const artifactKey = ofType('AWS::KMS::Key').find(([id]) => id.startsWith('PipelineArtifacts'))!;
    assert.ok(JSON.stringify(artifactKey[1].Properties.KeyPolicy).includes('cdk-hnb659fds-deploy-role-222222222222'));
  });

  it('lets a run started by hand skip the pause switch and prod\'s canary', () => {
    assert.deepEqual(pipeline.Properties.Variables.map((v: any) => [v.Name, v.DefaultValue]), [['CANARY', 'on'], ['ALARMS', 'on'], ['RUN', 'auto']]);
    const vars = JSON.parse(actions('Build')[0].Configuration.EnvironmentVariables);
    assert.deepEqual(vars.find((v: any) => v.name === 'CANARY').value, '#{variables.CANARY}');
    assert.deepEqual(vars.find((v: any) => v.name === 'RUN').value, '#{variables.RUN}');
    assert.deepEqual(vars.find((v: any) => v.name === 'ALARMS').value, '#{variables.ALARMS}');
    // The email before prod says whether the run skips the canary or turns the release alarms off.
    const input = JSON.parse(actions('Promote')[0].Configuration.Input);
    assert.equal(input.canary, '#{variables.CANARY}');
    assert.equal(input.alarms, '#{variables.ALARMS}');
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
    // Its own parameters only, never the release keys under signing/, and it writes only the two commits it records.
    const ssm = statements.filter((s) => [s.Action].flat().some((a: string) => a.startsWith('ssm:')));
    assert.ok(ssm.every((s) => JSON.stringify(s.Resource).includes(':parameter/multiscale/pipeline/')), JSON.stringify(ssm));
    const read = ssm.filter((s) => s.Action === 'ssm:GetParameter').flatMap((s) => s.Resource).map((r: any) => JSON.stringify(r).match(/pipeline\/([\w/*.-]+)"/)![1]);
    assert.deepEqual(read, ['config/*', 'paused', 'released', 'nightly']);
    const writes = ssm.filter((s) => s.Action === 'ssm:PutParameter').flatMap((s) => s.Resource).map((r: any) => JSON.stringify(r));
    assert.ok(writes.length === 2 && writes.every((r) => /pipeline\/(released|nightly)"/.test(r)), writes.join());
  });

  it("signs each environment's feed in a step of its own, after prod's suites, from the Build output alone", () => {
    for (const [stage, env, output, after] of [['Staging', 'staging', 'SignedStaging', 'deploy-staging'], ['Prod', 'prod', 'SignedProd', 'test-prod']] as const) {
      const list = actions(stage);
      const at = list.findIndex((a) => a.Name === 'Sign');
      assert.equal(step(list[at - 1]), after);
      const signAction = list[at];
      // Not the checkout: only the tested build, which carries the web build and the script that signs it.
      assert.deepEqual(signAction.InputArtifacts.map((a: any) => a.Name), ['Built']);
      assert.deepEqual(signAction.OutputArtifacts.map((a: any) => a.Name), [output]);
      assert.deepEqual(envOf(signAction), [
        { name: 'ENV_NAME', type: 'PLAINTEXT', value: env },
        { name: 'RELEASE_KEY', type: 'PARAMETER_STORE', value: `/multiscale/pipeline/signing/${env}.release-key.pem` },
      ]);
      const project = projectOf(signAction);
      assert.deepEqual(project.Properties.ServiceRole, { 'Fn::GetAtt': [roleNamed('multiscale-pipeline-signer'), 'Arn'] });
      const spec = JSON.parse(project.Properties.Source.BuildSpec);
      // It installs nothing and runs nothing but the signing script, on the image's own Node.
      assert.deepEqual(Object.keys(spec.phases), ['build']);
      assert.deepEqual(spec.phases.build.commands, ['node web/sign-release.mjs "web/$ENV_NAME" signed']);
    }
  });

  it('lets no role but the signing step read a release key, nor decrypt with their KMS key', () => {
    const [[keyId, key]] = ofType('AWS::KMS::Key').filter(([, k]) => k.Properties.Description?.includes('release keys'));
    assert.equal(key.Properties.EnableKeyRotation, true);
    t.hasResourceProperties('AWS::KMS::Alias', { AliasName: 'alias/multiscale-release-signing' });
    const signer = roleNamed('multiscale-pipeline-signer');
    const reads = (statement: any) => {
      const acts = [statement.Action].flat() as string[];
      const resources = JSON.stringify(statement.Resource);
      const ssmRead = acts.some((a) => a === '*' || a === 'ssm:*' || /^ssm:Get/.test(a)) &&
        (resources === '"*"' || resources.includes('signing') || /pipeline\/\*"|multiscale\/\*"/.test(resources));
      const decrypt = acts.some((a) => a === '*' || a === 'kms:*' || a === 'kms:Decrypt') && (resources === '"*"' || resources.includes(keyId));
      return ssmRead || decrypt;
    };
    const readers = ofType('AWS::IAM::Role').filter(([id]) => policiesOf(id).some(reads)).map(([id]) => id);
    assert.deepEqual(readers, [signer]);
    // The key's own policy names no role at all: only the account, so that IAM decides, as above.
    for (const statement of key.Properties.KeyPolicy.Statement) {
      assert.deepEqual(statement.Principal, { AWS: { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':iam::333333333333:root']] } });
    }
    // And the signer may do nothing else.
    const signerActions = new Set(policiesOf(signer).flatMap((st) => [st.Action].flat() as string[]));
    for (const action of signerActions) assert.match(action, /^(ssm:GetParameters?|kms:\w+\*?|s3:\w+\*?|logs:\w+|codebuild:\w+)$/, action);
    assert.ok(![...signerActions].some((a) => a.startsWith('sts:') || a === 'ssm:PutParameter'));
  });

  const promotion = () => {
    const [[id, machine]] = ofType('AWS::StepFunctions::StateMachine');
    const body = machine.Properties.DefinitionString;
    // The definition is a Fn::Join of strings and references; the states are what matter here.
    const text = typeof body === 'string' ? body : body['Fn::Join'][1].map((part: unknown) => (typeof part === 'string' ? part : JSON.stringify(part))).join('');
    return { id, machine, text };
  };

  it('emails when staging passes, saying when the run goes to prod and how to stop it, then waits that long', () => {
    const [wait] = actions('Promote');
    const { id, text } = promotion();
    assert.ok(JSON.stringify(wait.Configuration.StateMachineArn).includes(id));
    // The commit, from the source, and the window, from control.yaml: two hours unless it says otherwise.
    const input = JSON.parse(wait.Configuration.Input);
    assert.equal(input.commit, '#{GitHub.CommitId}');
    assert.equal(input.seconds, 7200);
    assert.match(text, /"QueryLanguage":"JSONata"/);
    assert.match(text, /"Notify":\{"Next":"Window","Type":"Task"/);
    assert.ok(text.includes(`"Resource":"arn:{"Ref":"AWS::Partition"}:states:::sns:publish"`), text);
    const [[topicId]] = ofType('AWS::SNS::Topic');
    assert.ok(text.includes(`"TopicArn":"{"Ref":"${topicId}"}"`), text);
    assert.match(text, /passed staging/);
    assert.match(text, /make pipeline-stop/);
    // Both the email and the wait count from when the window starts, the state machine's start.
    const until = '$fromMillis($toMillis($states.context.Execution.StartTime) + $states.input.seconds * 1000)';
    assert.ok(text.includes(`"Type":"Wait","Timestamp":"{% ${until} %}"`), text);
    assert.ok(text.includes('$toMillis($states.context.Execution.StartTime) + $states.input.seconds * 1000'), text);
  });

  it('waits on Step Functions, so the window costs no build minutes, and only it may publish to the topic', () => {
    const { machine } = promotion();
    const roleId = machine.Properties.RoleArn['Fn::GetAtt'][0];
    const actionsOf = policiesOf(roleId).flatMap((st) => [st.Action].flat());
    assert.deepEqual([...new Set(actionsOf)].sort(), ['sns:Publish']);
    // Nothing of the manual approval is left: no action role that may publish.
    const publishers = ofType('AWS::IAM::Role').filter(([rid]) => policiesOf(rid).some((st) => [st.Action].flat().includes('sns:Publish'))).map(([rid]) => rid);
    assert.deepEqual(publishers, [roleId]);
  });

  it('takes the window from control.yaml, and none at all with PT0S', () => {
    const none = Template.fromStack(new PipelineStack(new App(), 'P', { control: { ...control, pipeline: { ...control.pipeline, promoteAfter: 'PT0S' } }, environments }));
    const [p] = Object.values(none.toJSON().Resources as Record<string, any>).filter((r) => r.Type === 'AWS::CodePipeline::Pipeline');
    const promote = p.Properties.Stages.find((st: any) => st.Name === 'Promote').Actions[0];
    assert.equal(JSON.parse(promote.Configuration.Input).seconds, 0);
  });

  it('emails the notice before prod and failed runs to the configured address', () => {
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

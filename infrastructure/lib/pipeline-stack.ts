// The release pipeline, in the control account: each main commit is built once, deployed to staging and tested there,
// and after a person approves it, promoted to prod by the backend's canary, tested, and published. docs/releasing.md
// describes it. The steps themselves are scripts/pipeline.sh, run by CodeBuild; deploy rights stay in AWS.

import { CfnCapabilities, Duration, Stack } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { BuildEnvironmentVariableType, BuildSpec, ComputeType, LinuxBuildImage, PipelineProject, Project } from 'aws-cdk-lib/aws-codebuild';
import { Artifact, GlobalVariables, Pipeline, PipelineType, Variable } from 'aws-cdk-lib/aws-codepipeline';
import {
  CloudFormationCreateReplaceChangeSetAction, CloudFormationExecuteChangeSetAction, CodeBuildAction, CodeStarConnectionsSourceAction, ManualApprovalAction,
} from 'aws-cdk-lib/aws-codepipeline-actions';
import { CfnConnection } from 'aws-cdk-lib/aws-codestarconnections';
import { Rule, RuleTargetInput, EventField } from 'aws-cdk-lib/aws-events';
import { SnsTopic } from 'aws-cdk-lib/aws-events-targets';
import { PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Key } from 'aws-cdk-lib/aws-kms';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Schedule, ScheduleExpression } from 'aws-cdk-lib/aws-scheduler';
import { CodeBuildStartBuild } from 'aws-cdk-lib/aws-scheduler-targets';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { EmailSubscription } from 'aws-cdk-lib/aws-sns-subscriptions';
import type { Config, ControlConfig, EnvName, PipelineConfig } from './config.ts';

/** The pipeline's CodeBuild role. Each environment's release role trusts it by this name. */
export const PIPELINE_ROLE_NAME = 'multiscale-pipeline';
/** The signing step's role: the only one that may read the release keys. */
export const SIGNER_ROLE_NAME = 'multiscale-pipeline-signer';
/** The KMS key the release keys' SecureStrings are encrypted with. scripts/pipeline.sh config uploads them with it. */
export const SIGNING_KEY_ALIAS = 'alias/multiscale-release-signing';
/** In each environment's account: what the pipeline's tests and publishing sign in as (MultiscaleStack). */
export const RELEASE_ROLE_NAME = 'multiscale-release';
export const PIPELINE_NAME = 'Multiscale';
/** SSM parameters in the control account, under this path, that scripts/pipeline.sh reads and writes. */
export const PIPELINE_PARAMETERS = '/multiscale/pipeline';

export interface PipelineStackProps {
  control: ControlConfig & { pipeline: PipelineConfig };
  environments: Record<EnvName, Config>;
}

export class PipelineStack extends Stack {
  constructor(scope: Construct, id: string, { control, environments }: PipelineStackProps) {
    super(scope, id, { env: { account: control.aws.account, region: control.aws.region } });
    const { repository, branch, email } = control.pipeline;
    const [owner, repo] = repository.split('/') as [string, string];
    for (const [name, env] of Object.entries(environments)) {
      // One region keeps the pipeline free of cross-region replication buckets.
      if (env.aws.region !== control.aws.region) throw new Error(`The pipeline needs ${name} in ${control.aws.region}, control.yaml's region`);
    }

    // Pending until someone authorises it once in the console: docs/releasing.md.
    const connection = new CfnConnection(this, 'GitHub', { connectionName: 'multiscale-github', providerType: 'GitHub' });

    // Approval requests, failed runs and failed nightly runs.
    const topic = new Topic(this, 'ReleaseTopic');
    topic.addSubscription(new EmailSubscription(email));

    // What each step signs in as. It deploys through CDK's bootstrap roles in staging and prod, which trust this account
    // once they are bootstrapped with --trust, and tests and publishes as each one's release role.
    const role = new Role(this, 'BuildRole', { roleName: PIPELINE_ROLE_NAME, assumedBy: new ServicePrincipal('codebuild.amazonaws.com') });
    role.addToPolicy(new PolicyStatement({
      actions: ['sts:AssumeRole'],
      resources: Object.values(environments).flatMap(({ aws }) => [
        ...['deploy', 'file-publishing', 'lookup'].map((kind) => `arn:${this.partition}:iam::${aws.account}:role/cdk-hnb659fds-${kind}-role-${aws.account}-${aws.region}`),
        `arn:${this.partition}:iam::${aws.account}:role/${RELEASE_ROLE_NAME}`,
      ]),
    }));
    const parameter = (name: string) => this.formatArn({ service: 'ssm', resource: 'parameter', resourceName: `${PIPELINE_PARAMETERS.slice(1)}/${name}` });
    // The config folder's files with the keys' public halves, the pause switch, and the commits the last release and
    // nightly run had. Never the keys themselves, under signing/.
    role.addToPolicy(new PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [parameter('config/*'), parameter('paused'), parameter('released'), parameter('nightly')],
    }));
    role.addToPolicy(new PolicyStatement({ actions: ['ssm:PutParameter'], resources: [parameter('released'), parameter('nightly')] }));
    // A run that the pause switch holds back stops itself.
    role.addToPolicy(new PolicyStatement({
      actions: ['codepipeline:StopPipelineExecution'],
      resources: [this.formatArn({ service: 'codepipeline', resource: PIPELINE_NAME })],
    }));

    const logGroup = new LogGroup(this, 'Logs', { retention: RetentionDays.ONE_MONTH });
    const source = new Artifact('Source');
    const built = new Artifact('Built');
    const signedStaging = new Artifact('SignedStaging');
    const signedProd = new Artifact('SignedProd');
    const environment = { buildImage: LinuxBuildImage.STANDARD_7_0, computeType: ComputeType.MEDIUM };
    const install = ['scripts/pipeline.sh install'];
    // Each step's work is scripts/pipeline.sh $STEP, so the steps are read and reviewed in one file.
    const project = (projectId: string, artifacts?: object) => new PipelineProject(this, projectId, {
      role,
      environment,
      timeout: Duration.hours(2),
      logging: { cloudWatch: { logGroup } },
      buildSpec: BuildSpec.fromObject({
        version: '0.2',
        env: { shell: 'bash', variables: { GOTOOLCHAIN: 'auto' } },
        phases: { install: { commands: install }, build: { commands: ['scripts/pipeline.sh "$STEP"'] } },
        ...(artifacts ? { artifacts } : {}),
      }),
    });
    // The assemblies hold copies of the Lambdas' binaries, so staging and prod deploy the same files. web/ holds each
    // environment's web build and the script that signs it.
    const builder = project('Build', { files: ['infrastructure/cdk.out/**/*', 'web/**/*'] });
    const releaser = project('Release');

    // Signing. Only this step reads a release key: its own project and role, which may read the keys and nothing else
    // but its artifacts. It installs nothing and runs nothing from the repo but the signing script, taken with the web
    // build from the tested Build output, on the image's own Node. CodeBuild hands it the key from SSM in RELEASE_KEY.
    // CloudTrail records each read.
    const signingKey = new Key(this, 'SigningKey', {
      alias: SIGNING_KEY_ALIAS,
      description: "Encrypts the release keys' SecureStrings, which only the pipeline's signing step may read",
      enableKeyRotation: true,
    });
    const signerRole = new Role(this, 'SignerRole', { roleName: SIGNER_ROLE_NAME, assumedBy: new ServicePrincipal('codebuild.amazonaws.com') });
    const keyParameter = (envName: EnvName) => `${PIPELINE_PARAMETERS}/signing/${envName}.release-key.pem`;
    signerRole.addToPolicy(new PolicyStatement({
      actions: ['ssm:GetParameter', 'ssm:GetParameters'],
      resources: (['staging', 'prod'] as const).map((envName) => parameter(`signing/${envName}.release-key.pem`)),
    }));
    signingKey.grantDecrypt(signerRole);
    const signer = new PipelineProject(this, 'Sign', {
      role: signerRole,
      environment: { buildImage: LinuxBuildImage.STANDARD_7_0, computeType: ComputeType.SMALL },
      timeout: Duration.minutes(15),
      logging: { cloudWatch: { logGroup } },
      buildSpec: BuildSpec.fromObject({
        version: '0.2',
        phases: { build: { commands: ['node web/sign-release.mjs "web/$ENV_NAME" signed'] } },
        artifacts: { 'base-directory': 'signed', files: ['**/*'] },
      }),
    });
    const sign = (envName: EnvName, signed: Artifact, runOrder: number) => new CodeBuildAction({
      actionName: 'Sign',
      project: signer,
      input: built,
      outputs: [signed],
      runOrder,
      environmentVariables: {
        ENV_NAME: { value: envName },
        RELEASE_KEY: { type: BuildEnvironmentVariableType.PARAMETER_STORE, value: keyParameter(envName) },
      },
    });

    // A run started by hand sets these: scripts/pipeline.sh run.
    const canary = new Variable({ variableName: 'CANARY', defaultValue: 'on', description: "skip sends prod's new backend all traffic at once" });
    const alarms = new Variable({ variableName: 'ALARMS', defaultValue: 'on', description: 'off ships a release while a release alarm fires, with the alarms off for it' });
    const run = new Variable({ variableName: 'RUN', defaultValue: 'auto', description: 'hand when started by hand, which the pause switch lets through' });

    const sourceAction = new CodeStarConnectionsSourceAction({
      actionName: 'GitHub',
      owner,
      repo,
      branch,
      connectionArn: connection.attrConnectionArn,
      output: source,
      // A clone rather than a zip: builds read the commit from git, and the cross-version suite builds an older one.
      codeBuildCloneOutput: true,
      // Not 'Source': CodePipeline refuses a namespace named like an artifact.
      variablesNamespace: 'GitHub',
    });
    const step = (actionName: string, name: string, runOrder = 1, outputs: Artifact[] = [], signed?: Artifact) => new CodeBuildAction({
      actionName,
      project: outputs.length > 0 ? builder : releaser,
      input: source,
      extraInputs: name === 'build' ? [] : [built, ...(signed ? [signed] : [])],
      outputs,
      runOrder,
      environmentVariables: {
        STEP: { value: name },
        CANARY: { value: canary.reference() },
        ALARMS: { value: alarms.reference() },
        RUN: { value: run.reference() },
        EXECUTION_ID: { value: GlobalVariables.executionId },
        COMMIT: { value: sourceAction.variables.commitId },
      },
    });

    const prod = environments.prod.aws;
    const prodRole = (kind: string) => Role.fromRoleArn(this, `Prod${kind}Role`, `arn:${this.partition}:iam::${prod.account}:role/cdk-hnb659fds-${kind}-role-${prod.account}-${prod.region}`, { mutable: false });
    const deployRole = prodRole('deploy');
    const changeSet = { stackName: 'Multiscale-prod', changeSetName: 'release' };

    new Pipeline(this, 'Pipeline', {
      pipelineName: PIPELINE_NAME,
      pipelineType: PipelineType.V2,
      // Prod's CloudFormation actions run in prod's account and read the template from here.
      crossAccountKeys: true,
      variables: [canary, alarms, run],
      stages: [
        { stageName: 'Source', actions: [sourceAction] },
        { stageName: 'Build', actions: [step('Build', 'build', 1, [built])] },
        {
          stageName: 'Staging',
          actions: [
            step('Deploy', 'deploy-staging', 1),
            sign('staging', signedStaging, 2),
            // Publishes staging's web app and its signed feed, then runs staging's suites against them.
            step('ReleaseAndTest', 'release-staging', 3, [], signedStaging),
          ],
        },
        {
          stageName: 'Approve',
          actions: [new ManualApprovalAction({
            actionName: 'Approve',
            notificationTopic: topic,
            // The approver sees whether this run skips the canary or turns the release alarms off.
            additionalInformation: `Staging passed for ${sourceAction.variables.commitId}: ${sourceAction.variables.commitMessage}. Approving promotes it to prod. Canary: ${canary.reference()}. Release alarms: ${alarms.reference()}.`,
            externalEntityLink: `https://github.com/${repository}/commit/${sourceAction.variables.commitId}`,
          })],
        },
        {
          stageName: 'Prod',
          actions: [
            step('PublishAssets', 'prod-assets', 1),
            new CloudFormationCreateReplaceChangeSetAction({
              actionName: 'Prepare',
              ...changeSet,
              templatePath: built.atPath('infrastructure/cdk.out/prod/Multiscale-prod.template.json'),
              adminPermissions: false,
              // Prod's stack names IAM roles, such as multiscale-release.
              cfnCapabilities: [CfnCapabilities.NAMED_IAM],
              role: deployRole,
              deploymentRole: prodRole('cfn-exec'),
              runOrder: 2,
            }),
            // CloudFormation waits out the canary here, a day on prod, which this action may take up to 3 days for.
            new CloudFormationExecuteChangeSetAction({ actionName: 'Deploy', ...changeSet, role: deployRole, runOrder: 3 }),
            step('Test', 'test-prod', 4),
            // Only once prod's suites pass.
            sign('prod', signedProd, 5),
            // Publishes the web app and its signed feed, then checks them.
            step('Release', 'release-prod', 6, [], signedProd),
          ],
        },
      ],
    });

    // Every night, staging's slow suites: the full deployed suite with retention and the history-scale test. They never
    // hold up a release. Skipped when main hasn't moved since the last one passed.
    const nightly = new Project(this, 'Nightly', {
      role,
      // Half the price of a release's builds: nothing waits on it.
      environment: { ...environment, computeType: ComputeType.SMALL },
      timeout: Duration.hours(3),
      logging: { cloudWatch: { logGroup } },
      environmentVariables: { STEP: { value: 'nightly' }, REPOSITORY: { value: repository }, BRANCH: { value: branch } },
      buildSpec: BuildSpec.fromObject({
        version: '0.2',
        env: { shell: 'bash', variables: { GOTOOLCHAIN: 'auto' } },
        phases: {
          // The repo is public, so it clones without a credential.
          install: { commands: ['git clone --branch "$BRANCH" "https://github.com/$REPOSITORY.git" repo', 'cd repo && scripts/pipeline.sh install'] },
          build: { commands: ['cd repo && scripts/pipeline.sh nightly'] },
        },
      }),
    });
    new Schedule(this, 'NightlySchedule', {
      schedule: ScheduleExpression.cron({ minute: '0', hour: '10' }),
      description: "Staging's slow suites, at 10:00 UTC",
      target: new CodeBuildStartBuild(nightly),
    });

    new Rule(this, 'PipelineFailed', {
      eventPattern: { source: ['aws.codepipeline'], detailType: ['CodePipeline Pipeline Execution State Change'], detail: { pipeline: [PIPELINE_NAME], state: ['FAILED'] } },
      targets: [new SnsTopic(topic, { message: RuleTargetInput.fromText(`The release pipeline failed, run ${EventField.fromPath('$.detail.execution-id')}. See CodePipeline in the control account.`) })],
    });
    new Rule(this, 'NightlyFailed', {
      eventPattern: { source: ['aws.codebuild'], detailType: ['CodeBuild Build State Change'], detail: { 'project-name': [nightly.projectName], 'build-status': ['FAILED'] } },
      targets: [new SnsTopic(topic, { message: RuleTargetInput.fromText(`Staging's nightly suites failed, build ${EventField.fromPath('$.detail.build-id')}. Its log is in CodeBuild in the control account.`) })],
    });
  }
}

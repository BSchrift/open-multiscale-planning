// The release pipeline, in the control account: each main commit is built once, deployed to staging and tested there,
// and after a window in which the owner can stop it, promoted to prod by the backend's canary, tested, and published.
// No one approves it. docs/releasing.md describes it. The steps themselves are scripts/pipeline.sh, run by CodeBuild;
// deploy rights stay in AWS.

import { join } from 'node:path';
import { CfnCapabilities, CfnOutput, Duration, Stack } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { type BuildEnvironmentVariable, BuildEnvironmentVariableType, BuildSpec, ComputeType, LinuxBuildImage, PipelineProject, Project } from 'aws-cdk-lib/aws-codebuild';
import { Artifact, GlobalVariables, Pipeline, PipelineType, Variable } from 'aws-cdk-lib/aws-codepipeline';
import {
  CloudFormationCreateReplaceChangeSetAction, CloudFormationExecuteChangeSetAction, CodeBuildAction, CodeStarConnectionsSourceAction, StateMachineInput,
  StepFunctionInvokeAction,
} from 'aws-cdk-lib/aws-codepipeline-actions';
import { CfnConnection } from 'aws-cdk-lib/aws-codestarconnections';
import { Rule, RuleTargetInput, EventField } from 'aws-cdk-lib/aws-events';
import { SnsTopic } from 'aws-cdk-lib/aws-events-targets';
import { OidcProviderNative, Policy, PolicyStatement, Role, ServicePrincipal, WebIdentityPrincipal } from 'aws-cdk-lib/aws-iam';
import { Key } from 'aws-cdk-lib/aws-kms';
import { Architecture, Code, Function as LambdaFunction, FunctionUrlAuthType, Runtime } from 'aws-cdk-lib/aws-lambda';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { BlockPublicAccess, Bucket, BucketEncryption } from 'aws-cdk-lib/aws-s3';
import { Schedule, ScheduleExpression } from 'aws-cdk-lib/aws-scheduler';
import { CodeBuildStartBuild } from 'aws-cdk-lib/aws-scheduler-targets';
import { Topic } from 'aws-cdk-lib/aws-sns';
import {
  Choice, Condition, DefinitionBody, Errors, IntegrationPattern, QueryLanguage, StateMachine, Succeed, TaskInput, Timeout,
} from 'aws-cdk-lib/aws-stepfunctions';
import { SnsPublish } from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { EmailSubscription } from 'aws-cdk-lib/aws-sns-subscriptions';
import { DEFAULT_MAC_WAIT, DEFAULT_PROMOTE_AFTER, promoteAfterSeconds } from './config.ts';
import type { Config, ControlConfig, EnvName, PipelineConfig } from './config.ts';

/** The pipeline's CodeBuild role. Each environment's release role trusts it by this name. */
export const PIPELINE_ROLE_NAME = 'multiscale-pipeline';
/** The deploy steps' role: the only one that may use CDK's bootstrap roles in staging and prod. */
export const DEPLOYER_ROLE_NAME = 'multiscale-pipeline-deployer';
/** The signing step's role: the only one that may read the release keys. */
export const SIGNER_ROLE_NAME = 'multiscale-pipeline-signer';
/** The KMS key the release keys' SecureStrings are encrypted with. scripts/pipeline.sh config uploads them with it. */
export const SIGNING_KEY_ALIAS = 'alias/multiscale-release-signing';
/** In each environment's account: what the pipeline's tests and publishing sign in as (MultiscaleStack). */
export const RELEASE_ROLE_NAME = 'multiscale-release';
export const PIPELINE_NAME = 'Multiscale';
/** SSM parameters in the control account, under this path, that scripts/pipeline.sh reads and writes. */
export const PIPELINE_PARAMETERS = '/multiscale/pipeline';
/** What GitHub Actions' Mac release signs in as to upload to the inbox, and nothing else (.github/workflows/mac-release.yml). */
export const MAC_INBOX_ROLE_NAME = 'multiscale-mac-inbox';
/** The GitHub environment the workflow's signing job runs in, which alone may assume that role. */
export const MAC_RELEASE_ENVIRONMENT = 'release';
const GITHUB_OIDC = 'token.actions.githubusercontent.com';

export interface PipelineStackProps {
  control: ControlConfig & { pipeline: PipelineConfig };
  environments: Record<EnvName, Config>;
}

export class PipelineStack extends Stack {
  constructor(scope: Construct, id: string, { control, environments }: PipelineStackProps) {
    super(scope, id, { env: { account: control.aws.account, region: control.aws.region } });
    const { repository, branch, email, mac } = control.pipeline;
    const [owner, repo] = repository.split('/') as [string, string];
    for (const [name, env] of Object.entries(environments)) {
      // One region keeps the pipeline free of cross-region replication buckets.
      if (env.aws.region !== control.aws.region) throw new Error(`The pipeline needs ${name} in ${control.aws.region}, control.yaml's region`);
    }

    // Pending until someone authorises it once in the console: docs/releasing.md.
    const connection = new CfnConnection(this, 'GitHub', { connectionName: 'multiscale-github', providerType: 'GitHub' });

    // Each release's notice before prod, failed runs and failed nightly runs.
    const topic = new Topic(this, 'ReleaseTopic');
    topic.addSubscription(new EmailSubscription(email));

    // What each step signs in as. The build, the suites and the Mac check test and publish as each environment's release
    // role. They install and run the app's npm dependencies, so they never hold CDK's bootstrap roles: through those,
    // CloudFormation may do anything in an account, and a dependency that read this role's credentials would have it.
    const role = new Role(this, 'BuildRole', { roleName: PIPELINE_ROLE_NAME, assumedBy: new ServicePrincipal('codebuild.amazonaws.com') });
    role.addToPolicy(new PolicyStatement({
      actions: ['sts:AssumeRole'],
      resources: Object.values(environments).map(({ aws }) => `arn:${this.partition}:iam::${aws.account}:role/${RELEASE_ROLE_NAME}`),
    }));
    // Only the two deploy steps use CDK's bootstrap roles in staging and prod, which trust this account once they are
    // bootstrapped with --trust. They run the CDK command line on the Build output's assemblies, and nothing of the app's.
    const deployerRole = new Role(this, 'DeployerRole', { roleName: DEPLOYER_ROLE_NAME, assumedBy: new ServicePrincipal('codebuild.amazonaws.com') });
    deployerRole.addToPolicy(new PolicyStatement({
      actions: ['sts:AssumeRole'],
      resources: Object.values(environments).flatMap(({ aws }) =>
        ['deploy', 'file-publishing', 'lookup'].map((kind) => `arn:${this.partition}:iam::${aws.account}:role/cdk-hnb659fds-${kind}-role-${aws.account}-${aws.region}`)),
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

    // What GitHub Actions hands the pipeline, and all GitHub may do in AWS: Mac apps it built, signed and notarized, which
    // the MacApp step checks (below), and the TestFlight review's record of the newest iPhone app testers can install,
    // which the releases read. Created with the Mac release.
    const inbox = mac ? new Bucket(this, 'MacInbox', {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      // Each build is checked within hours of its upload. Prod's run reads it up to 6 days later, at most. The TestFlight
      // review writes its record again every hour.
      lifecycleRules: [{ expiration: Duration.days(30) }],
    }) : undefined;

    // Each step's work is scripts/pipeline.sh $STEP, so the steps are read and reviewed in one file.
    const project = (projectId: string, artifacts?: object, environmentVariables?: Record<string, BuildEnvironmentVariable>, projectRole = role) => new PipelineProject(this, projectId, {
      role: projectRole,
      environment,
      environmentVariables,
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
    // mac/ holds each environment's main process, to check a Mac app GitHub Actions built against.
    const builder = project('Build', { files: ['infrastructure/cdk.out/**/*', 'web/**/*', 'mac/**/*'] });
    // The releases switch the iPhone feed to a build with new native code once the TestFlight review's record in the
    // inbox says testers can install an iPhone app with it (scripts/pipeline.sh, publish).
    const releaser = project('Release', undefined, inbox && { MAC_INBOX_BUCKET: { value: inbox.bucketName } });
    // Staging's deploy and prod's assets. With no output, it may only read the pipeline's artifacts.
    const deployer = project('Deploy', undefined, undefined, deployerRole);

    // Signing. Only this step reads a release key: its own project and role, which may read the keys and nothing else
    // but its artifacts. It installs nothing and runs nothing from the repo but the signing script, on the image's own
    // Node, over the web build in the tested Build output. The script comes from this commit's checkout, not from the
    // Build output, which the build's npm dependencies could rewrite. CodeBuild hands it the key from SSM in RELEASE_KEY.
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
        phases: { build: { commands: ['node frontend/scripts/sign-release.mjs "$CODEBUILD_SRC_DIR_Built/web/$ENV_NAME" signed'] } },
        artifacts: { 'base-directory': 'signed', files: ['**/*'] },
      }),
    });
    const sign = (envName: EnvName, signed: Artifact, runOrder: number) => new CodeBuildAction({
      actionName: 'Sign',
      project: signer,
      input: source,
      extraInputs: [built],
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
    const step = (actionName: string, name: string, runOrder = 1, outputs: Artifact[] = [], more: Artifact[] = [], stepProject?: Project) => new CodeBuildAction({
      actionName,
      project: stepProject ?? (outputs.length > 0 ? builder : releaser),
      input: source,
      extraInputs: name === 'build' ? [] : [built, ...more],
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

    // "Promote now", the email's link: a page whose button sends the run's task token back, which ends its window at
    // once. Anyone with the link may open it; the token is what promotes, and only its own run.
    const promoteNowLogs = new LogGroup(this, 'PromoteNowLogs', { retention: RetentionDays.ONE_MONTH });
    const promoteNowRole = new Role(this, 'PromoteNowRole', { assumedBy: new ServicePrincipal('lambda.amazonaws.com') });
    promoteNowLogs.grantWrite(promoteNowRole);
    const promoteNow = new LambdaFunction(this, 'PromoteNow', {
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      code: Code.fromAsset(join(import.meta.dirname, '../promote-now')),
      handler: 'index.handler',
      role: promoteNowRole,
      logGroup: promoteNowLogs,
      timeout: Duration.seconds(10),
    });
    const promoteNowUrl = promoteNow.addFunctionUrl({ authType: FunctionUrlAuthType.NONE });

    // The window before prod, on Step Functions, whose wait costs nothing: a standard workflow pays per state, and a run
    // passes three at most. It emails the time the run goes to prod, counted from its own start, with the link, and
    // waits for the link's token until then. A timeout of 0 isn't allowed, so no window only emails.
    const notice = (link: string) => TaskInput.fromText(`{% $states.input.commit & ' passed staging. It goes to prod at ' & $fromMillis($toMillis($states.context.Execution.StartTime) + $states.input.seconds * 1000, '[Y0001]-[M01]-[D01] [H01]:[m01] UTC') & ' unless you stop it: make pipeline-stop, or Stop execution on the run in CodePipeline. Canary: ' & $states.input.canary & '. Release alarms: ' & $states.input.alarms & '.'${link} %}`);
    const subject = 'A release is on its way to prod';
    const notifyAndWait = SnsPublish.jsonata(this, 'NotifyAndWait', {
      topic,
      subject,
      message: notice(` & ' To send it to prod now: ${promoteNowUrl.url}?token=' & $encodeUrlComponent($states.context.Task.Token)`),
      integrationPattern: IntegrationPattern.WAIT_FOR_TASK_TOKEN,
      taskTimeout: Timeout.jsonata('{% $states.input.seconds %}'),
      outputs: '{% $states.input %}',
    }).addCatch(Succeed.jsonata(this, 'WindowEnded'), { errors: [Errors.TIMEOUT], outputs: '{% $states.input %}' });
    const notify = SnsPublish.jsonata(this, 'Notify', { topic, subject, message: notice(''), outputs: '{% $states.input %}' });
    const promotion = new StateMachine(this, 'Promotion', {
      definitionBody: DefinitionBody.fromChainable(Choice.jsonata(this, 'HasWindow')
        .when(Condition.jsonata('{% $states.input.seconds > 0 %}'), notifyAndWait)
        .otherwise(notify)),
      queryLanguage: QueryLanguage.JSONATA,
      timeout: Duration.days(7),
    });
    // The link's function may answer only this state machine, and only to promote. A policy of its own, not the role's
    // default one, which the function waits on: the state machine already waits on the function, for its address.
    new Policy(this, 'PromoteNowPolicy', {
      roles: [promoteNowRole],
      statements: [new PolicyStatement({ actions: ['states:SendTaskSuccess'], resources: [promotion.stateMachineArn] })],
    });

    // Mac apps from GitHub Actions. For a commit that needs a new Mac app, the workflow builds, signs and notarizes it,
    // and uploads it to the inbox. The MacApp step checks it on Linux (scripts/pipeline.sh mac) and hands what passed to
    // the releases, which publish the disk image before the feed.
    const macApps: Artifact[] = [];
    let macProject: Project | undefined;
    if (mac && inbox) {
      // An account has at most one provider for GitHub's tokens. control.yaml says when it has one already.
      const providerArn = mac.githubOidcProvider === 'existing'
        ? this.formatArn({ service: 'iam', region: '', resource: 'oidc-provider', resourceName: GITHUB_OIDC })
        : new OidcProviderNative(this, 'GitHubOidc', { url: `https://${GITHUB_OIDC}`, clientIds: ['sts.amazonaws.com'] }).oidcProviderArn;
      // Only a job in this repository's release environment, which runs only from main.
      const inboxRole = new Role(this, 'MacInboxRole', {
        roleName: MAC_INBOX_ROLE_NAME,
        description: "GitHub Actions' Mac release and TestFlight review: upload to the release pipeline's inbox, and nothing else",
        maxSessionDuration: Duration.hours(1),
        assumedBy: new WebIdentityPrincipal(providerArn, {
          StringEquals: { [`${GITHUB_OIDC}:aud`]: 'sts.amazonaws.com', [`${GITHUB_OIDC}:sub`]: mac.githubSubject ?? `repo:${repository}:environment:${MAC_RELEASE_ENVIRONMENT}` },
        }),
      });
      inboxRole.addToPolicy(new PolicyStatement({ actions: ['s3:PutObject'], resources: [inbox.arnForObjects('inbox/*')] }));
      // The pipeline only reads the inbox.
      role.addToPolicy(new PolicyStatement({ actions: ['s3:GetObject'], resources: [inbox.arnForObjects('inbox/*')] }));
      role.addToPolicy(new PolicyStatement({ actions: ['s3:ListBucket'], resources: [inbox.bucketArn], conditions: { StringLike: { 's3:prefix': 'inbox/*' } } }));
      const wait = promoteAfterSeconds(mac.waitFor ?? DEFAULT_MAC_WAIT)!;
      macProject = new PipelineProject(this, 'MacApp', {
        role,
        // Mostly waiting, so the smallest.
        environment: { ...environment, computeType: ComputeType.SMALL },
        timeout: Duration.seconds(Math.min(wait + 3600, 8 * 3600)),
        logging: { cloudWatch: { logGroup } },
        environmentVariables: {
          MAC_INBOX_BUCKET: { value: inbox.bucketName },
          MAC_TEAM_ID: { value: mac.teamId },
          MAC_WAIT_SECONDS: { value: String(wait) },
        },
        buildSpec: BuildSpec.fromObject({
          version: '0.2',
          env: { shell: 'bash' },
          phases: { install: { commands: install }, build: { commands: ['scripts/pipeline.sh "$STEP"'] } },
          artifacts: { 'base-directory': 'mac-checked', files: ['**/*'] },
        }),
      });
      macApps.push(new Artifact('MacApps'));
      new CfnOutput(this, 'MacInboxBucket', { value: inbox.bucketName, description: 'AWS_INBOX_BUCKET for the release environment' });
      new CfnOutput(this, 'MacInboxRoleArn', { value: inboxRole.roleArn, description: 'AWS_INBOX_ROLE_ARN for the release environment' });
    }

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
            step('Deploy', 'deploy-staging', 1, [], [], deployer),
            // Beside staging's deploy, since it may wait a while for GitHub Actions' build. A failed check stops the run.
            ...(macProject ? [step('MacApp', 'mac', 1, macApps, [], macProject)] : []),
            sign('staging', signedStaging, 2),
            // Publishes staging's web app and its signed feed, then runs staging's suites against them.
            step('ReleaseAndTest', 'release-staging', 3, [], [signedStaging, ...macApps]),
          ],
        },
        {
          // No approval: staging's pass is emailed, and the run goes to prod when the window ends, or sooner from the
          // email's link, unless the owner stops it (make pipeline-stop). Prod's canary and its alarms still guard it.
          stageName: 'Promote',
          actions: [new StepFunctionInvokeAction({
            actionName: 'Wait',
            stateMachine: promotion,
            stateMachineInput: StateMachineInput.literal({
              commit: sourceAction.variables.commitId,
              seconds: promoteAfterSeconds(control.pipeline.promoteAfter ?? DEFAULT_PROMOTE_AFTER),
              canary: canary.reference(),
              alarms: alarms.reference(),
            }),
          })],
        },
        {
          stageName: 'Prod',
          actions: [
            step('PublishAssets', 'prod-assets', 1, [], [], deployer),
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
            // CloudFormation waits out the canary here, 90 minutes on prod.
            new CloudFormationExecuteChangeSetAction({ actionName: 'Deploy', ...changeSet, role: deployRole, runOrder: 3 }),
            step('Test', 'test-prod', 4),
            // Only once prod's suites pass.
            sign('prod', signedProd, 5),
            // Publishes the web app and its signed feed, then checks them.
            step('Release', 'release-prod', 6, [], [signedProd, ...macApps]),
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

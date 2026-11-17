// Everything one environment runs on AWS. Cost is meant to stay under $1 a month with no one using it, so secrets are SSM
// SecureString parameters under the AWS-managed key rather than Secrets Manager. The one customer-managed key is for
// people's Google tokens, which KMS encrypts for each person: an AWS-managed key can't be called directly.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { Annotations, CfnOutput, CustomResource, Duration, Names, RemovalPolicy, Stack } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { forEnv } from '@multiscale/config';
import { AccessLogFormat } from 'aws-cdk-lib/aws-apigateway';
import { ApiMapping, CorsHttpMethod, DomainName, HttpApi, HttpMethod, HttpNoneAuthorizer, HttpStage, LogGroupLogDestination } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpUserPoolAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { CfnBudget } from 'aws-cdk-lib/aws-budgets';
import { Certificate, CertificateValidation, DnsValidatedCertificate } from 'aws-cdk-lib/aws-certificatemanager';
import { AllowedMethods, CacheHeaderBehavior, CachePolicy, Distribution, KeyGroup, PriceClass, PublicKey, ResponseHeadersPolicy, ViewerProtocolPolicy } from 'aws-cdk-lib/aws-cloudfront';
import { S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { Alarm, ComparisonOperator, Dashboard, GraphWidget, LogQueryVisualizationType, LogQueryWidget, MathExpression, Metric, TreatMissingData } from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import { CfnDeploymentGroup, LambdaApplication, LambdaDeploymentConfig, LambdaDeploymentGroup, TimeBasedCanaryTrafficRouting } from 'aws-cdk-lib/aws-codedeploy';
import { CfnUserPoolClient, FeaturePlan, OAuthScope, UserPool, UserPoolClientIdentityProvider } from 'aws-cdk-lib/aws-cognito';
import { AttributeType, BillingMode, ProjectionType, StreamViewType, Table } from 'aws-cdk-lib/aws-dynamodb';
import { AccountPrincipal, AccountRootPrincipal, PolicyDocument, PolicyStatement, Role } from 'aws-cdk-lib/aws-iam';
import { Key } from 'aws-cdk-lib/aws-kms';
import { Alias, Architecture, CfnEventSourceMapping, Code, EventSourceMapping, FilterCriteria, FilterRule, Function as LambdaFunction, Runtime, StartingPosition } from 'aws-cdk-lib/aws-lambda';
import type { EventSourceMappingOptions } from 'aws-cdk-lib/aws-lambda';
import { FilterPattern, LogGroup, MetricFilter, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { ARecord, CrossAccountZoneDelegationRecord, PublicHostedZone, RecordTarget } from 'aws-cdk-lib/aws-route53';
import { ApiGatewayv2DomainProperties, CloudFrontTarget, UserPoolDomainTarget } from 'aws-cdk-lib/aws-route53-targets';
import { BlockPublicAccess, Bucket, BucketEncryption, HttpMethods } from 'aws-cdk-lib/aws-s3';
import { Schedule, ScheduleExpression } from 'aws-cdk-lib/aws-scheduler';
import { LambdaInvoke } from 'aws-cdk-lib/aws-scheduler-targets';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { Queue, QueueEncryption } from 'aws-cdk-lib/aws-sqs';
import { EmailSubscription } from 'aws-cdk-lib/aws-sns-subscriptions';
import { Provider } from 'aws-cdk-lib/custom-resources';
import { loadRetention } from '../../config/retention.ts';
import { secondUser } from './config.ts';
import type { Config, ControlConfig, EnvName } from './config.ts';
import { DELEGATION_ROLE_NAME } from './control-stack.ts';
import { PERF_NAMESPACE, perfDashboard, serverWidgets } from './perf-dashboard.ts';
import { PIPELINE_ROLE_NAME, RELEASE_ROLE_NAME } from './pipeline-stack.ts';

export interface MultiscaleStackProps {
  envName: EnvName;
  config: Config;
  /** Needed when config sets dns.zone: the zone is delegated from its domain, in its account. */
  control?: ControlConfig;
  /** Holds api/, calendar/, retention/ and canary/, each a bootstrap put there by scripts/deploy.sh. */
  backendDist: string;
  /** Set when deploying, so that a missing build fails instead of shipping the stand-in. */
  requireBinaries: boolean;
  /** 'skip' sends a new backend version all traffic at once, rather than by config/env's canary. The alarms still roll it back. */
  canary?: 'skip';
  /**
   * 'off' turns the deployment groups' alarms off for this deploy, so CodeDeploy starts while a release alarm is already
   * firing, to ship the fix for it. Rollback on a failed deployment or pre-traffic check stays, and the next deploy
   * without it turns them on again.
   */
  alarms?: 'off';
  /** The control account, when control.yaml sets up the release pipeline there: it tests and publishes as this stack's release role. */
  pipelineAccount?: string;
}

export class MultiscaleStack extends Stack {
  constructor(scope: Construct, id: string, props: MultiscaleStackProps) {
    const { envName, config, control, backendDist, requireBinaries, canary, alarms, pipelineAccount } = props;
    super(scope, id, {
      env: { account: config.aws.account, region: config.aws.region },
      terminationProtection: forEnv(envName).stack.terminationProtection,
    });

    const namespace = `Multiscale/${envName}`;
    const ssmPrefix = `/multiscale/${envName}`;
    // The Lambdas read the same file, built into them, by ENV_NAME.
    const retention = loadRetention(envName, { read: (path) => readFileSync(path, 'utf8'), parse });

    const goCode = (name: string) => {
      const dir = join(backendDist, name);
      if (existsSync(join(dir, 'bootstrap'))) return Code.fromAsset(dir);
      if (requireBinaries) throw new Error(`${dir}/bootstrap is not built. Deploy with scripts/deploy.sh.`);
      Annotations.of(this).addWarning(`Go binary ${name} not built: synthesizing with a stand-in. Deploy with scripts/deploy.sh.`);
      return Code.fromAsset(join(import.meta.dirname, '../placeholder'));
    };

    // Sign-in

    const userPool = new UserPool(this, 'UserPool', {
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      featurePlan: FeaturePlan.ESSENTIALS,
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const domain = userPool.addDomain('Domain', { cognitoDomain: { domainPrefix: config.auth.cognitoDomainPrefix } });
    // The web app, on the environment's own zone when it has one, signs in like the apps.
    const webUrl = config.dns?.zone ? `https://${config.dns.zone}` : undefined;
    const signInCallbackUrls = [...config.auth.signInCallbackUrls, ...(webUrl ? [`${webUrl}/auth/callback`] : [])];
    const appClient = userPool.addClient('AppClient', {
      userPoolClientName: 'app',
      generateSecret: false,
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [OAuthScope.OPENID, OAuthScope.EMAIL],
        callbackUrls: signInCallbackUrls,
        logoutUrls: signInCallbackUrls,
      },
      supportedIdentityProviders: [UserPoolClientIdentityProvider.COGNITO],
      refreshTokenValidity: Duration.days(365),
      preventUserExistenceErrors: true,
    });
    // Left unset, Cognito would also turn on password and SRP sign-in for the app client. The hosted UI is the only way in.
    (appClient.node.defaultChild as CfnUserPoolClient).explicitAuthFlows = ['ALLOW_REFRESH_TOKEN_AUTH'];
    // The black-box suite signs in by password with a dedicated test user, since it can't drive a browser.
    const testClient = userPool.addClient('TestClient', {
      userPoolClientName: 'integration-test',
      generateSecret: false,
      authFlows: { userPassword: true },
      disableOAuth: true,
      preventUserExistenceErrors: true,
    });
    // The suite's second user, which proves one user can't read another's records through the real authorizer, made by
    // this deploy rather than by hand (test-user/index.mjs). Its password is made there, never in the template, and goes
    // beside the first test user's, which the release role reads.
    if (secondUser(config)) {
      const parameter = `${ssmPrefix}/second-test-user-password`;
      const testUserFunction = new LambdaFunction(this, 'TestUserFunction', {
        runtime: Runtime.NODEJS_24_X,
        architecture: Architecture.ARM_64,
        code: Code.fromAsset(join(import.meta.dirname, '../test-user')),
        handler: 'index.handler',
        logGroup: new LogGroup(this, 'TestUserLogs', { retention: RetentionDays.ONE_MONTH }),
        timeout: Duration.seconds(30),
      });
      testUserFunction.addToRolePolicy(new PolicyStatement({
        actions: ['cognito-idp:AdminGetUser', 'cognito-idp:AdminCreateUser', 'cognito-idp:AdminSetUserPassword'],
        resources: [userPool.userPoolArn],
      }));
      testUserFunction.addToRolePolicy(new PolicyStatement({
        actions: ['ssm:GetParameter', 'ssm:PutParameter'],
        resources: [this.formatArn({ service: 'ssm', resource: 'parameter', resourceName: parameter.slice(1) })],
      }));
      const provider = new Provider(this, 'TestUserProvider', {
        onEventHandler: testUserFunction,
        logGroup: new LogGroup(this, 'TestUserProviderLogs', { retention: RetentionDays.ONE_MONTH }),
      });
      new CustomResource(this, 'SecondTestUser', {
        serviceToken: provider.serviceToken,
        resourceType: 'Custom::TestUser',
        properties: { UserPoolId: userPool.userPoolId, Username: config.integration!.secondTestUser!, Parameter: parameter },
      });
    }

    // Data

    // Expired records go by DynamoDB's TTL, on each item's expires_at, and the retention function reads TTL's removals
    // from the stream to keep each user's expiry mark. Not a job that removes them, because:
    //   - TTL deletes cost no write units, and Lambda reads the stream at no charge;
    //   - a job would read the whole table each run, or need an index that every write pays for, and pay for each delete;
    //   - late removal is safe: pulls leave out what has expired as soon as it has, the apps remove theirs by expires_at
    //     and the API drops changes to it, so only what was really removed needs the mark (internal/sync/expiry.go);
    //   - staging's periods are minutes, so there alone a cleanup removes what TTL hasn't reached yet, every few minutes
    //     (config/retention.yaml), paced to a read budget so its scan doesn't throttle the table.
    // The stream carries the old image because the mark is the removed item's sequence number.
    const table = new Table(this, 'Table', {
      partitionKey: { name: 'pk', type: AttributeType.STRING },
      sortKey: { name: 'sk', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      stream: StreamViewType.OLD_IMAGE,
      timeToLiveAttribute: 'expires_at',
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    // Local, not global: pulls by sequence must be strongly consistent.
    table.addLocalSecondaryIndex({
      indexName: 'by_seq',
      sortKey: { name: 'seq', type: AttributeType.NUMBER },
      projectionType: ProjectionType.ALL,
    });

    // People's Google connections: each one's refresh token, encrypted by this key under a context naming them, in the
    // table (internal/gcal/aws.go). Not a Secrets Manager secret each, which at $0.40 a month would cost $4,000 a month for
    // 10,000 people; the key is $1 a month and $0.03 per 10,000 decrypts, one a run. Kept if the stack goes, since every
    // stored token is unreadable without it.
    const tokenKey = new Key(this, 'GoogleTokenKey', {
      description: `Multiscale ${envName}: people's Google refresh tokens`,
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.RETAIN,
      // The account administers it, and never uses it: only the two functions' roles may, below, whatever IAM allows.
      policy: new PolicyDocument({
        statements: [new PolicyStatement({
          sid: 'Administer',
          principals: [new AccountRootPrincipal()],
          actions: ['kms:Create*', 'kms:Describe*', 'kms:Enable*', 'kms:List*', 'kms:Put*', 'kms:Update*', 'kms:Revoke*', 'kms:Disable*',
            'kms:Get*', 'kms:Delete*', 'kms:TagResource', 'kms:UntagResource', 'kms:ScheduleKeyDeletion', 'kms:CancelKeyDeletion', 'kms:RotateKeyOnDemand'],
          resources: ['*'],
        })],
      }),
    });
    const tokenPurpose = { StringEquals: { 'kms:EncryptionContext:purpose': 'google-refresh-token', 'kms:EncryptionContext:env': envName } };

    // The worker's queue: one message a person's run, from the schedule, the stream, the API's refresh and the one retry.
    // Visible again only after six times the worker's timeout, as Lambda advises, so a run still going isn't handed out
    // twice. A run that couldn't record its failure three times goes to the dead letters, where an alarm says so; the
    // schedule runs that person again anyway.
    const calendarTimeout = Duration.minutes(5);
    const calendarDeadLetters = new Queue(this, 'CalendarDeadLetters', {
      retentionPeriod: Duration.days(14),
      encryption: QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
    });
    const calendarQueue = new Queue(this, 'CalendarQueue', {
      visibilityTimeout: Duration.minutes(calendarTimeout.toMinutes() * 6),
      encryption: QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      deadLetterQueue: { queue: calendarDeadLetters, maxReceiveCount: 3 },
    });

    // Functions

    const functionLogs = (logId: string) => new LogGroup(this, logId, { retention: RetentionDays.ONE_MONTH });
    const apiLogs = functionLogs('ApiLogs');
    const calendarLogs = functionLogs('CalendarLogs');
    const retentionLogs = functionLogs('RetentionLogs');
    const canaryLogs = functionLogs('CanaryLogs');
    const accessLogs = functionLogs('AccessLogs');

    const httpApi = new HttpApi(this, 'HttpApi', {
      createDefaultStage: false,
      defaultAuthorizer: new HttpUserPoolAuthorizer('Cognito', userPool, { userPoolClients: [appClient, testClient] }),
      // Electron loads from its own app scheme and iPhone from capacitor://. Sign-in is a bearer token, never a cookie, so an
      // open origin grants a web page nothing.
      corsPreflight: {
        allowOrigins: ['*'],
        allowMethods: [CorsHttpMethod.POST, CorsHttpMethod.GET],
        allowHeaders: ['authorization', 'content-type'],
        maxAge: Duration.days(1),
      },
    });
    // On the environment's own zone when it has one, so Google's redirect and the apps' address outlive the API's id.
    const apiHost = config.dns?.zone ? `api.${config.dns.zone}` : undefined;
    const apiUrl = apiHost ? `https://${apiHost}` : httpApi.apiEndpoint;
    const authHost = config.dns?.zone ? `auth.${config.dns.zone}` : undefined;
    const downloadsHost = config.dns?.zone ? `downloads.${config.dns.zone}` : undefined;
    const releaseHost = config.dns?.zone ? `release.${config.dns.zone}` : undefined;
    const stage = new HttpStage(this, 'Stage', {
      httpApi,
      stageName: '$default',
      autoDeploy: true,
      // The Google callback is unauthenticated, so this also caps what a stranger can spend.
      throttle: { rateLimit: 50, burstLimit: 100 },
      accessLogSettings: {
        destination: new LogGroupLogDestination(accessLogs),
        // routeKey rather than the path: the callback's query string carries a Google code.
        format: AccessLogFormat.custom(JSON.stringify({
          requestId: '$context.requestId',
          time: '$context.requestTime',
          route: '$context.routeKey',
          status: '$context.status',
          latencyMs: '$context.responseLatency',
          // message, not messageString: AWS already quotes messageString, which would double the quotes here.
          error: '$context.error.message',
          authorizerError: '$context.authorizer.error',
        })),
      },
    });

    const goFunction = (functionId: string, name: string, logGroup: LogGroup, timeout: Duration, environment: Record<string, string>, functionName?: string) =>
      new LambdaFunction(this, functionId, {
        functionName,
        runtime: Runtime.PROVIDED_AL2023,
        architecture: Architecture.ARM_64,
        handler: 'bootstrap',
        code: goCode(name),
        memorySize: 256,
        timeout,
        logGroup,
        environment: { TABLE_NAME: table.tableName, ENV_NAME: envName, SSM_PREFIX: ssmPrefix, ...environment },
      });

    // Everything invokes a function's live alias, never $LATEST, so that CodeDeploy can move traffic to a new version in
    // steps (Deployments, below). A deploy that changes a function publishes a new version.
    const live = (fn: LambdaFunction) => new Alias(this, `${fn.node.id.replace(/Function$/, '')}Live`, { aliasName: 'live', version: fn.currentVersion });

    const google = { GOOGLE_TOKEN_KEY: tokenKey.keyArn, CALENDAR_QUEUE_URL: calendarQueue.queueUrl };
    const calendarFunction = goFunction('CalendarFunction', 'calendar', calendarLogs, calendarTimeout, google);
    const calendarAlias = live(calendarFunction);
    // The API starts the worker through its alias, named by ARN rather than by the alias resource: CloudFormation counts
    // the alias's UpdatePolicy, so the alias waits on its deployment group, whose alarms watch the API. Referring to the
    // alias resource from the API would make a loop CloudFormation refuses (test/cycles.test.ts).
    const calendarLiveArn = `${calendarFunction.functionArn}:${calendarAlias.aliasName}`;
    const retentionFunction = goFunction('RetentionFunction', 'retention', retentionLogs, Duration.minutes(5), {});
    const retentionAlias = live(retentionFunction);
    const apiFunction = goFunction('ApiFunction', 'api', apiLogs, Duration.seconds(25), {
      API_URL: apiUrl,
      // Read only by the API from before per-person connections, which invoked the worker itself; this one queues the run.
      // shortcut: goes, with the invoke grant below, in the release that removes the legacy connection.
      CALENDAR_FUNCTION_NAME: calendarLiveArn,
      ...google,
    });
    const apiAlias = live(apiFunction);

    const integration = new HttpLambdaIntegration('ApiIntegration', apiAlias);
    httpApi.addRoutes({ path: '/sync', methods: [HttpMethod.POST], integration });
    httpApi.addRoutes({ path: '/calendar/connect', methods: [HttpMethod.POST], integration });
    httpApi.addRoutes({ path: '/calendar/refresh', methods: [HttpMethod.POST], integration });
    httpApi.addRoutes({ path: '/calendar/disconnect', methods: [HttpMethod.POST], integration });
    // OpenTelemetry events from the app, in OTLP/HTTP JSON at OTLP's own path.
    httpApi.addRoutes({ path: '/v1/logs', methods: [HttpMethod.POST], integration });
    // Attachments: an upload's presigned PUT, download links and the person's usage. Routed whether or not the
    // environment stores files, since the API answers them as not configured until it does.
    httpApi.addRoutes({ path: '/files/upload', methods: [HttpMethod.POST], integration });
    httpApi.addRoutes({ path: '/files/download', methods: [HttpMethod.POST], integration });
    httpApi.addRoutes({ path: '/files/usage', methods: [HttpMethod.GET], integration });
    // Its signed state proves who it is for: Google's redirect can't carry a token.
    httpApi.addRoutes({ path: '/calendar/callback', methods: [HttpMethod.GET], integration, authorizer: new HttpNoneAuthorizer() });

    // Permissions. TransactWriteItems is not an IAM action: a sync transaction needs Put and Update, the actions inside it.
    // The consent state is a PutItem and a conditional UpdateItem.

    const dataAccess = new PolicyStatement({
      actions: ['dynamodb:BatchGetItem', 'dynamodb:PutItem', 'dynamodb:Query', 'dynamodb:UpdateItem'],
      resources: [table.tableArn, `${table.tableArn}/index/by_seq`],
    });
    // Only the Google secrets: the test users' passwords sit beside them, for the integration suite alone. The worker
    // never starts a consent, so it doesn't get the key that signs them.
    const readSecrets = (names: string[]) => new PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: names.map((name) => this.formatArn({ service: 'ssm', resource: 'parameter', resourceName: `multiscale/${envName}/google/${name}` })),
    });
    apiFunction.addToRolePolicy(readSecrets(['*']));
    calendarFunction.addToRolePolicy(readSecrets(['client-id', 'client-secret', 'refresh-token']));
    for (const fn of [apiFunction, calendarFunction]) fn.addToRolePolicy(dataAccess);
    apiFunction.addToRolePolicy(new PolicyStatement({
      actions: ['ssm:PutParameter', 'ssm:DeleteParameter'],
      resources: [this.formatArn({ service: 'ssm', resource: 'parameter', resourceName: `multiscale/${envName}/google/refresh-token` })],
    }));
    apiFunction.addToRolePolicy(new PolicyStatement({ actions: ['lambda:InvokeFunction'], resources: [calendarLiveArn] }));
    // Google connections: their items only, by partition, read and deleted with GetItem and a transaction's Delete; the
    // claim on a Google account is a Put, which the data actions above already allow. Only the API seals a token, at
    // consent; both open them, only this environment's and for that purpose, with this key alone.
    const connectionItems = new PolicyStatement({
      actions: ['dynamodb:GetItem', 'dynamodb:DeleteItem'],
      resources: [table.tableArn],
      conditions: { 'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': ['google#connection', 'google#account'] } },
    });
    for (const fn of [apiFunction, calendarFunction]) {
      fn.addToRolePolicy(connectionItems);
      calendarQueue.grantSendMessages(fn);
    }
    apiFunction.addToRolePolicy(new PolicyStatement({ actions: ['kms:Encrypt'], resources: [tokenKey.keyArn], conditions: tokenPurpose }));
    for (const fn of [apiFunction, calendarFunction]) fn.addToRolePolicy(new PolicyStatement({ actions: ['kms:Decrypt'], resources: [tokenKey.keyArn], conditions: tokenPurpose }));
    tokenKey.addToResourcePolicy(new PolicyStatement({
      sid: 'Seal', principals: [apiFunction.role!], actions: ['kms:Encrypt'], resources: ['*'], conditions: tokenPurpose,
    }));
    tokenKey.addToResourcePolicy(new PolicyStatement({
      sid: 'Open', principals: [apiFunction.role!, calendarFunction.role!], actions: ['kms:Decrypt'], resources: ['*'], conditions: tokenPurpose,
    }));

    // What runs the worker

    // A mapping from the stream to an alias. Made here rather than by DynamoEventSource on the alias: under the function,
    // with DynamoEventSource's own id, the mapping each function already had moves to its alias in place. A new mapping
    // would read retention's stream from its start again, and both would run while the old one went.
    const fromStream = (fn: LambdaFunction, alias: Alias, options: Omit<EventSourceMappingOptions, 'eventSourceArn'>) => {
      table.grantStreamRead(alias);
      return new EventSourceMapping(fn, `DynamoDBEventSource:${Names.nodeUniqueId(table.node)}`, {
        target: alias,
        eventSourceArn: table.tableStreamArn!,
        ...options,
      });
    };

    fromStream(calendarFunction, calendarAlias, {
      startingPosition: StartingPosition.LATEST,
      batchSize: 100,
      maxBatchingWindow: Duration.seconds(60),
      retryAttempts: 2,
      // Only its inputs: blocks, the tasks and practices their events take titles from, and calendar modes. Waking on the
      // calendar record it writes itself would loop forever. cmd/local's wakesWorker keeps the same list.
      filters: [FilterCriteria.filter({ dynamodb: { Keys: { sk: { S: [
        { prefix: 'rec#time_block#' }, { prefix: 'rec#task#' }, { prefix: 'rec#practice#' }, { prefix: 'rec#calendar_source#' },
      ] } } } })],
    });
    const calendarSchedule = new Schedule(this, 'CalendarSchedule', {
      schedule: ScheduleExpression.rate(Duration.minutes(30)),
      target: new LambdaInvoke(calendarAlias),
    });
    // Each person's run, ten to an invocation and run at once there. The concurrency is the bound on the load on Google
    // and on Lambda, however many people there are: four invocations of ten runs, each of about eight calls in two
    // seconds, is at most about 9,600 calls a minute, under Google's 10,000 a project. The schedule spreads its runs
    // over 15 minutes, which at 10,000 people is about 670 a minute, within that.
    //
    // The alias by its ARN, not the alias resource: anything that refers to the alias waits for the alias's CodeDeploy
    // update, so the mapping, new in this release, would appear only after the canary, and the per-person runs would
    // first run where no alarm rolls them back. Made now, both versions take batches by the alias's weights through the
    // canary; the old one runs only the legacy person for one, which is harmless. It waits on the schedule instead, which
    // refers to the alias but doesn't change in an update, so a new stack still makes the alias before it.
    calendarQueue.grantConsumeMessages(calendarAlias);
    const queueSource = new EventSourceMapping(calendarFunction, 'CalendarQueueSource', {
      target: calendarFunction,
      eventSourceArn: calendarQueue.queueArn,
      batchSize: 10,
      maxBatchingWindow: Duration.seconds(5),
      reportBatchItemFailures: true,
      maxConcurrency: 4,
    });
    (queueSource.node.defaultChild as CfnEventSourceMapping).functionName = calendarLiveArn;
    queueSource.node.addDependency(calendarSchedule);

    // What keeps the expiry mark: TTL's removals only. A delete from anyone else, staging's cleanup included, isn't
    // expiry, and cleanup raises the mark itself before it removes anything.
    fromStream(retentionFunction, retentionAlias, {
      startingPosition: StartingPosition.TRIM_HORIZON,
      batchSize: 100,
      filters: [FilterCriteria.filter({
        eventName: FilterRule.isEqual('REMOVE'),
        userIdentity: { type: FilterRule.isEqual('Service'), principalId: FilterRule.isEqual('dynamodb.amazonaws.com') },
      })],
    });
    // Raising a mark is an UpdateItem. Cleanup also reads the table and removes what has expired. With attachments, a
    // removed attachment's file goes too: it reads the file# item, then deletes it and takes its bytes off meta#storage
    // in one transaction.
    retentionFunction.addToRolePolicy(new PolicyStatement({
      actions: [...new Set([
        'dynamodb:UpdateItem',
        ...(retention.cleanup ? ['dynamodb:Scan', 'dynamodb:DeleteItem'] : []),
        ...(config.files ? ['dynamodb:GetItem', 'dynamodb:DeleteItem'] : []),
      ])],
      resources: [table.tableArn],
    }));
    if (retention.cleanup) {
      const { days, hours, minutes } = retention.cleanup;
      new Schedule(this, 'CleanupSchedule', {
        schedule: ScheduleExpression.rate(Duration.minutes((days * 24 + hours) * 60 + minutes)),
        target: new LambdaInvoke(retentionAlias),
      });
    }

    // The release canary (cmd/canary): a sync round trip, invoking the API directly as a made-up user of its own. Before
    // a new API version takes traffic, CodeDeploy runs it against that version alone (Deployments, below). Every 5
    // minutes a schedule runs it against the live alias, so a new version's share of traffic sees real requests even
    // with one real user. It isn't split by a canary itself: it's what judges one.
    // The alias by its ARN rather than the resource: the alias waits for the canary to be updated (Deployments, below).
    const apiAliasArn = `${apiFunction.functionArn}:${apiAlias.aliasName}`;
    // Named, so its alarm can name it too: the API's deployment group lists the alarm, and the canary may report to the
    // group, so an alarm that referred to the function would make a loop. CodeDeployHook_ because the deployment
    // group's role may invoke a hook only by that name, through its managed policy, AWSCodeDeployRoleForLambdaLimited.
    // A grant of its own, made in the deploy that adds the hook, would race IAM, as the first staging deploy found.
    const canaryName = `CodeDeployHook_multiscale-${envName}-canary`;
    // Each of its three calls may wait out the API's 25 seconds.
    const canaryFunction = goFunction('CanaryFunction', 'canary', canaryLogs, Duration.minutes(2), {
      API_VERSION: apiFunction.currentVersion.functionArn,
      API_ALIAS: apiAliasArn,
    }, canaryName);
    // Any version or alias of the API, by one pattern, so the grant is the same each release: one that named the new
    // version would change in the deploy that runs the hook, and IAM takes a while to apply a change.
    canaryFunction.addToRolePolicy(new PolicyStatement({ actions: ['lambda:InvokeFunction'], resources: [`${apiFunction.functionArn}:*`] }));
    // A run retried would most likely reach the old version and pass, and its first failure is already counted.
    canaryFunction.configureAsyncInvoke({ retryAttempts: 0 });
    new Schedule(this, 'CanarySchedule', {
      schedule: ScheduleExpression.rate(Duration.minutes(5)),
      target: new LambdaInvoke(canaryFunction),
    });

    // Alarms

    const topic = new Topic(this, 'AlarmTopic');
    topic.addSubscription(new EmailSubscription(config.alarmEmail));
    const alarmAction = new SnsAction(topic);
    const fiveMinutes = Duration.minutes(5);
    const custom = (metricName: string, statistic = 'Sum', period = fiveMinutes) => new Metric({ namespace, metricName, statistic, period });
    // Throttled requests by operation: those the API and the worker make through the store (internal/sync), and the
    // consent state's put and update. Not the staging cleanup's scan and deletes, which page themselves to a budget.
    const throttled = (operation: string) => new Metric({
      namespace: 'AWS/DynamoDB',
      metricName: 'ThrottledRequests',
      dimensionsMap: { TableName: table.tableName, Operation: operation },
      statistic: 'Sum',
      period: fiveMinutes,
    });
    const apiOperations = { query: 'Query', batchGet: 'BatchGetItem', get: 'GetItem', transact: 'TransactWriteItems', put: 'PutItem', update: 'UpdateItem' };

    const apiErrorRate = new MathExpression({
      label: '5xx %',
      expression: 'IF(requests > 0, 100 * errors / requests, 0)',
      usingMetrics: { errors: httpApi.metricServerError({ period: fiveMinutes }), requests: httpApi.metricCount({ period: fiveMinutes }) },
      period: fiveMinutes,
    });
    const lambdaErrors = new MathExpression({
      label: 'Lambda errors',
      expression: 'FILL(api, 0) + FILL(calendar, 0) + FILL(retention, 0)',
      usingMetrics: {
        api: apiFunction.metricErrors({ period: fiveMinutes }),
        calendar: calendarFunction.metricErrors({ period: fiveMinutes }),
        retention: retentionFunction.metricErrors({ period: fiveMinutes }),
      },
      period: fiveMinutes,
    });
    const dynamoThrottles = new MathExpression({
      label: "DynamoDB throttles of the API's requests",
      expression: Object.keys(apiOperations).map((id) => `FILL(${id}, 0)`).join(' + '),
      usingMetrics: Object.fromEntries(Object.entries(apiOperations).map(([id, operation]) => [id, throttled(operation)])),
      period: fiveMinutes,
    });

    const anyFailure = (alarmId: string, description: string, metric: Metric | MathExpression, threshold = 1, evaluationPeriods = 1) => {
      const alarm = new Alarm(this, alarmId, {
        alarmDescription: description,
        metric,
        threshold,
        evaluationPeriods,
        comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      });
      alarm.addAlarmAction(alarmAction);
      return alarm;
    };

    const settings = forEnv(envName).stack;
    const throttleAlarm = anyFailure('DynamoThrottles', "DynamoDB throttled the API's requests", dynamoThrottles);
    // These also roll a new backend version back while it takes traffic. They watch both versions together. Throttles
    // only where config/env says, prod: staging's test load goes through the API and can throttle at any time.
    const releaseAlarms = [
      anyFailure('Api5xxRate', 'At least 10% of API requests failed with a 5xx', apiErrorRate, 10),
      // Over two periods, since with one user a single slow push is the whole p99.
      anyFailure('ApiLatency', 'API p99 latency was 10 seconds or more for 10 minutes', httpApi.metricLatency({ statistic: 'p99', period: fiveMinutes }), 10_000, 2),
      anyFailure('LambdaErrors', 'A Lambda crashed or timed out', lambdaErrors),
      ...(settings.throttleReleaseAlarm ? [throttleAlarm] : []),
      // At least three failed runs in five minutes that are also at least 2% of them all. The floor: one person's lasting
      // failure, a run every 30 minutes, never gets there, nor a few people's at once. The rate: under the smallest canary
      // share, so a new version failing every run of its 10% still fires it however many people there are. A person's
      // removed token, quota, unticked permission or organisation's policy isn't a failure at all (internal/gcal).
      anyFailure('CalendarFailures', 'At least 3 calendar worker runs, and 2% of them, failed in 5 minutes', new MathExpression({
        label: 'Failed runs over the floor and rate',
        expression: 'IF(FILL(failures, 0) >= 3 AND 100 * FILL(failures, 0) / runs >= 2, 1, 0)',
        usingMetrics: { failures: custom('CalendarRunFailures'), runs: custom('CalendarRunFailures', 'SampleCount') },
        period: fiveMinutes,
      })),
      // Its mapping retries a failing batch until the stream drops it, a day later, so a stuck consumer shows as age.
      anyFailure('RetentionBehind', 'The retention consumer is an hour or more behind the stream', retentionFunction.metric('IteratorAge', { statistic: 'Maximum', period: fiveMinutes }), Duration.hours(1).toMilliseconds()),
      // One failed run is enough: a new version gets about 1 run in 20, so two in a row would almost never come.
      anyFailure('CanaryFailures', "The release canary's sync round trip failed", new Metric({
        namespace: 'AWS/Lambda', metricName: 'Errors', dimensionsMap: { FunctionName: canaryName }, statistic: 'Sum', period: fiveMinutes,
      })),
    ];
    // On a message arriving, not on one being there, which it is for 14 days.
    anyFailure('CalendarDeadLetterAlarm', "A person's calendar run failed three times without recording why", new MathExpression({
      label: 'Dead letters arrived',
      expression: 'DIFF(FILL(visible, 0))',
      usingMetrics: { visible: calendarDeadLetters.metricApproximateNumberOfMessagesVisible({ period: fiveMinutes, statistic: 'Maximum' }) },
      period: fiveMinutes,
    }));
    // A wave of people's tokens refused at once, more likely Google's doing than a release's, so not a release alarm.
    anyFailure('CalendarRevocations', "At least half the calendar runs, and 3, found the person's Google access removed", new MathExpression({
      label: 'Runs refused their token',
      expression: 'IF(FILL(revoked, 0) >= 3 AND 100 * FILL(revoked, 0) / runs >= 50, 1, 0)',
      usingMetrics: { revoked: custom('CalendarRevoked'), runs: custom('CalendarRunFailures', 'SampleCount') },
      period: fiveMinutes,
    }));
    // The worker emits CalendarEventsChanged once per successful run, including runs that change nothing, so the
    // sample count is the number of successes.
    new Alarm(this, 'CalendarSilent', {
      alarmDescription: 'The calendar worker has not succeeded for 2 hours',
      metric: custom('CalendarEventsChanged', 'SampleCount', Duration.hours(1)),
      threshold: 1,
      evaluationPeriods: 2,
      comparisonOperator: ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: TreatMissingData.BREACHING,
    }).addAlarmAction(alarmAction);
    // Each sync that writes reports its user's size, so the Maximum is the largest writing user's. One who stops writing
    // reports nothing, which leaves the alarm as it was rather than reading as the size falling.
    const largestUser = custom('ItemCollectionSizeGB', 'Maximum');
    new Alarm(this, 'ItemCollectionSize', {
      alarmDescription: "A user's records reached 5 GB of DynamoDB's 10 GB cap per user. See docs/sync.md.",
      metric: largestUser,
      threshold: 5,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: TreatMissingData.IGNORE,
    }).addAlarmAction(alarmAction);
    // A Mac app reports app-signature when Squirrel refused an app whose zip matched its signed SHA-512: the published app
    // is bad, so someone looks at once. Not a release alarm: it says nothing about the backend a deploy would roll back.
    new MetricFilter(this, 'AppSignatureFilter', {
      logGroup: apiLogs,
      filterPattern: FilterPattern.allTerms('client_event', 'app-signature'),
      metricNamespace: namespace,
      metricName: 'AppSignatureFailures',
      metricValue: '1',
    });
    new Alarm(this, 'AppSignature', {
      alarmDescription: "A Mac app refused an app update for its signature: the published app is bad. Stop it spreading with make release-surface, then revert. See docs/releasing.md.",
      metric: custom('AppSignatureFailures'),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(alarmAction);

    // Deployments: CodeDeploy moves each alias to a new version by config/env's canary, a share of invocations first and
    // the rest after a wait, and moves it back if a release alarm fires on the way. Only code is split like this: the
    // table, IAM, schedules and config change all at once, so they follow the compatibility rules in AGENTS.md.

    const application = new LambdaApplication(this, 'Deployments');
    // Always made, so a release that skips the canary doesn't remove it and the next one finds it again.
    const canaryConfig = new LambdaDeploymentConfig(this, 'Canary', {
      trafficRouting: new TimeBasedCanaryTrafficRouting({ percentage: settings.canaryPercent, interval: Duration.minutes(settings.canaryMinutes) }),
    });
    const deploymentConfig = canary === 'skip' ? LambdaDeploymentConfig.ALL_AT_ONCE : canaryConfig;
    // ALARMS=off, for one release that has to ship while a release alarm fires: CodeDeploy refuses to start while any of
    // its alarms is in ALARM, however old. Set explicitly both ways, so the next release turns them on again.
    const alarmsOff = alarms === 'off';
    const deployment = (id: string, alias: Alias) => {
      const group = new LambdaDeploymentGroup(this, `${id}Deployment`, {
        application,
        alias,
        deploymentConfig,
        alarms: alarmsOff ? [] : releaseAlarms,
        autoRollback: { failedDeployment: true, stoppedDeployment: true, deploymentInAlarm: !alarmsOff },
      });
      if (alarmsOff) (group.node.defaultChild as CfnDeploymentGroup).alarmConfiguration = { enabled: false, alarms: [] };
      // The alias's update runs the deployment as this role, so it waits for the role and every policy on it.
      alias.node.addDependency(group.role);
      return group;
    };
    // Only the API has a check before traffic: the worker and retention can't be run on a made-up input without side
    // effects, so their new versions are judged by the alarms alone.
    deployment('Api', apiAlias).addPreHook(canaryFunction);
    // The hook names the new version in its environment, so it has to be updated before the alias moves.
    apiAlias.node.addDependency(canaryFunction);
    deployment('Calendar', calendarAlias);
    deployment('Retention', retentionAlias);

    // Dashboard

    const width = 12;
    // What the apps report through POST /v1/logs, read with Logs Insights from the API's client_event lines.
    const appEvents = (title: string, view: LogQueryVisualizationType, ...queryLines: string[]) =>
      new LogQueryWidget({ title, width, height: 6, view, logGroupNames: [apiLogs.logGroupName], queryLines: ['filter msg = "client_event"', ...queryLines] });
    new Dashboard(this, 'Dashboard', {
      dashboardName: id,
      widgets: [
        [
          new GraphWidget({ title: 'Requests', width, left: [httpApi.metricCount({ period: fiveMinutes }), calendarFunction.metricInvocations({ period: fiveMinutes })] }),
          new GraphWidget({ title: 'Errors', width, left: [httpApi.metricServerError({ period: fiveMinutes }), httpApi.metricClientError({ period: fiveMinutes }), lambdaErrors, dynamoThrottles] }),
        ],
        [
          new GraphWidget({ title: 'Latency', width, left: [httpApi.metricLatency({ period: fiveMinutes, statistic: 'p50' }), httpApi.metricLatency({ period: fiveMinutes, statistic: 'p99' })] }),
          new GraphWidget({ title: 'Sync volume', width, left: [custom('SyncRecordsMerged'), custom('SyncConflictRetries'), custom('SyncRequestsRejected')] }),
        ],
        [
          new GraphWidget({
            title: 'Worker health',
            width,
            left: [custom('CalendarRunFailures'), custom('CalendarEventsChanged'), custom('CalendarEventsChanged', 'SampleCount'), custom('CalendarRevoked'), custom('CalendarRateLimited')],
            right: [calendarFunction.metricDuration({ period: fiveMinutes }), calendarQueue.metricApproximateAgeOfOldestMessage({ period: fiveMinutes })],
          }),
          new GraphWidget({ title: 'Largest user (GB of the 10 GB cap)', width, left: [largestUser] }),
        ],
        [
          appEvents('App memory (MB), by platform and version', LogQueryVisualizationType.LINE,
            'filter ispresent(`process.memory.usage`)',
            'stats max(`process.memory.usage`) / 1048576 as app_mb by bin(5m), `app.platform`, `service.version`'),
          appEvents('App memory, by platform and version', LogQueryVisualizationType.TABLE,
            'filter ispresent(`process.memory.usage`)',
            'stats count_distinct(`session.id`) as runs, avg(`process.memory.usage`) / 1048576 as avg_mb, pct(`process.memory.usage`, 95) / 1048576 as p95_mb, max(`process.memory.usage`) / 1048576 as max_mb by `app.platform`, `service.version`',
            'sort `service.version` desc'),
        ],
        [
          appEvents('How app runs ended', LogQueryVisualizationType.TABLE,
            'filter event = "app.last_session"',
            'fields @timestamp, `app.platform` as platform, `service.version` as version, `app.last_session.state` as ended, `process.memory.peak` / 1048576 as peak_mb, `app.memory_warnings` as warnings, `app.uptime` as uptime_s, `device.model.identifier` as device, `os.version` as os',
            'sort @timestamp desc',
            'limit 20'),
          appEvents('App errors', LogQueryVisualizationType.TABLE,
            'filter event = "exception"',
            'stats count(*) as times by `app.platform`, `service.version`, `exception.type`, `code.file.path`, `code.line.number`',
            'sort times desc',
            'limit 20'),
        ],
        [
          appEvents('App events by screen', LogQueryVisualizationType.TABLE,
            'stats count(*) as events, max(`process.memory.usage`) / 1048576 as max_mb, avg(`browser.dom.nodes`) as dom_nodes by `app.platform`, `service.version`, `app.screen.name`, event',
            'sort events desc'),
        ],
        [
          // Each over-the-air update check: current, ready, needs-app, or failed with where it stopped or why native
          // code refused the release.
          appEvents('Update checks', LogQueryVisualizationType.TABLE,
            'filter event = "app.update.check"',
            'stats count(*) as checks, count_distinct(`device.id`) as devices by `app.platform`, `service.version`, `app.update.outcome`, `app.update.failure`, `app.update.build`',
            'sort checks desc',
            'limit 20'),
          // A downloaded bundle that never drew the app, reported by the bundle the app went back to.
          appEvents('Updates rolled back', LogQueryVisualizationType.TABLE,
            'filter event = "app.update.rollback"',
            'stats count(*) as times, count_distinct(`device.id`) as devices by `app.platform`, `app.update.build`, `service.version`',
            'sort times desc',
            'limit 20'),
        ],
        // The server's performance KPIs, here for this environment's own traffic (docs/performance.md).
        serverWidgets(accessLogs, [apiLogs, calendarLogs, retentionLogs]),
      ],
    });
    // The performance KPIs, in the spec's sections, where CI's results are published.
    if (settings.performanceDashboard) perfDashboard(this, `${id}-performance`, accessLogs, [apiLogs, calendarLogs, retentionLogs, canaryLogs]);

    // Budgets cover the whole account, so with both environments in one account either one's alert means the total.
    new CfnBudget(this, 'Budget', {
      budget: { budgetName: id, budgetType: 'COST', timeUnit: 'MONTHLY', budgetLimit: { amount: 5, unit: 'USD' } },
      notificationsWithSubscribers: [{
        notification: { notificationType: 'ACTUAL', comparisonOperator: 'GREATER_THAN', threshold: 100, thresholdType: 'PERCENTAGE' },
        subscribers: [{ subscriptionType: 'EMAIL', address: config.alarmEmail }],
      }],
    });

    // Attachments, once make files-key has put a signing key in the environment's config (docs/setup.md). A file goes
    // from the device straight to a private bucket, by a PUT the API presigns after checking its size, type, the hourly
    // limit and the quota, and comes back through CloudFront, which serves only links the API signed: one file for 5
    // minutes each. Nothing runs at the edge and no WAF sits there: CloudFront checks the signature itself, and the API
    // counts downloads as it hands the links out.
    const files = config.files;
    // The apps' pages: the web app on the zone, the Mac app's own scheme (frontend/electron/main.ts), the iPhone's web
    // view, and wherever browser tests sign in to this environment from.
    const appOrigins = [...new Set([
      ...(webUrl ? [webUrl] : []),
      'multiscale-app://app',
      'capacitor://localhost',
      ...config.auth.signInCallbackUrls.filter((url) => url.startsWith('http://localhost')).map((url) => new URL(url).origin),
    ])];
    const filesBucket = files ? new Bucket(this, 'Files', {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      // So a delete is final: a file goes when its record does (docs/retention.md).
      versioned: false,
      // A guard only, since an upload is one PUT. No expiry, since the record decides when its file goes, and no move to
      // Infrequent Access, whose 128 KB minimum and retrieval fees cost more than they save at these sizes.
      lifecycleRules: [{ abortIncompleteMultipartUploadAfter: Duration.days(1) }],
      // PUT for the presigned uploads, which go straight from the apps. GET and HEAD for downloads: CloudFront forwards
      // Origin, which is in its cache key, and S3 answers CORS, as for the release feed, since CloudFront's own CORS
      // headers turned out to be missing from some cached copies.
      cors: [{
        allowedMethods: [HttpMethods.PUT, HttpMethods.GET, HttpMethods.HEAD],
        allowedOrigins: appOrigins,
        allowedHeaders: ['content-type', 'content-disposition', 'x-amz-checksum-sha256'],
        maxAge: Duration.days(1).toSeconds(),
      }],
    }) : undefined;
    const filesHost = files && config.dns?.zone ? `files.${config.dns.zone}` : undefined;
    const filesUploadUrl = filesBucket ? `https://${filesBucket.bucketRegionalDomainName}` : undefined;
    let filesUrl: string | undefined;

    let releaseBucket: Bucket | undefined;
    let zone: PublicHostedZone | undefined;
    let delegation: CrossAccountZoneDelegationRecord | undefined;

    // DNS: this environment's own zone, delegated from the domain in the control account, serving the API on api.<zone>
    // and sign-in on auth.<zone>.

    if (config.dns?.zone) {
      zone = new PublicHostedZone(this, 'Zone', { zoneName: config.dns.zone });
      // shortcut: the delegation handler's log group keeps CloudWatch's default retention, since CDK offers no setting and it
      // logs a few lines per deploy; give it 30 days if it ever logs more.
      delegation = new CrossAccountZoneDelegationRecord(this, 'ZoneDelegation', {
        delegatedZone: zone,
        // loadConfig only allows a zone together with control.yaml's dns section. By id, so no other zone with the
        // domain's name can be picked.
        parentHostedZoneId: control!.dns!.hostedZoneId,
        delegationRole: Role.fromRoleArn(this, 'DelegationRole', `arn:${this.partition}:iam::${control!.aws.account}:role/${DELEGATION_ROLE_NAME}`),
      });
      // ACM checks its record over public DNS, which only reaches the zone once it's delegated.
      const certificate = new Certificate(this, 'ApiCertificate', { domainName: apiHost!, validation: CertificateValidation.fromDns(zone) });
      certificate.node.addDependency(delegation);
      const apiDomain = new DomainName(this, 'ApiDomain', { domainName: apiHost!, certificate });
      new ApiMapping(this, 'ApiMapping', { api: httpApi, domainName: apiDomain, stage });
      new ARecord(this, 'ApiRecord', {
        zone,
        recordName: apiHost,
        target: RecordTarget.fromAlias(new ApiGatewayv2DomainProperties(apiDomain.regionalDomainName, apiDomain.regionalHostedZoneId)),
      });

      // Releases, built and signed on a Mac by scripts/release.sh: the Mac app's disk image on downloads.<zone>, the feed
      // the apps update from on release.<zone>, and the web app on the zone itself. One private bucket, a folder per host.
      // The apps fetch the feed from their own origins: app:// on the Mac, capacitor:// on iPhone. S3 answers CORS and
      // Origin is in the release host's cache key, so every cached copy suits the request it's served to. CloudFront's
      // own CORS headers turned out to be missing from some cached copies.
      releaseBucket = new Bucket(this, 'Releases', {
        blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
        encryption: BucketEncryption.S3_MANAGED,
        enforceSSL: true,
        cors: [{ allowedMethods: [HttpMethods.GET, HttpMethods.HEAD], allowedOrigins: ['*'] }],
      });

      // The web app: the build the apps run, on the zone's own name. Sign-in comes back to /auth/callback, which only the
      // app's page answers. Sign-in sits in the browser's storage, so the page runs only its own scripts: the Mac app's
      // policy (electron/security.ts), plus WebAssembly for SQLite and no framing. SQLite's worker falls under script-src.
      // With attachments it also uploads to the bucket, fetches from the files host and shows images from blob: URLs.
      const webCertificate = new DnsValidatedCertificate(this, 'WebCertificate', { domainName: config.dns.zone, hostedZone: zone, region: 'us-east-1' });
      webCertificate.node.addDependency(delegation);
      const webDistribution = new Distribution(this, 'WebDistribution', {
        defaultBehavior: {
          origin: S3BucketOrigin.withOriginAccessControl(releaseBucket, { originPath: '/web' }),
          viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          responseHeadersPolicy: new ResponseHeadersPolicy(this, 'WebHeaders', {
            securityHeadersBehavior: {
              contentSecurityPolicy: {
                contentSecurityPolicy: [
                  "default-src 'none'",
                  "script-src 'self' 'wasm-unsafe-eval'",
                  "style-src 'self' 'unsafe-inline'",
                  `img-src 'self' data:${files ? ' blob:' : ''}`,
                  "font-src 'self'",
                  `connect-src 'self' https://${apiHost} https://${authHost}${files ? ` https://${filesHost} ${filesUploadUrl}` : ''}`,
                  "base-uri 'none'",
                  "form-action 'none'",
                  "frame-ancestors 'none'",
                ].join('; '),
                override: true,
              },
            },
          }),
        },
        defaultRootObject: 'index.html',
        errorResponses: [403, 404].map((httpStatus) => ({ httpStatus, responseHttpStatus: 200, responsePagePath: '/index.html' })),
        domainNames: [config.dns.zone],
        certificate: webCertificate,
        priceClass: PriceClass.PRICE_CLASS_100,
      });
      // Cognito also refuses a custom domain whose parent doesn't resolve.
      const apex = new ARecord(this, 'ZoneApexRecord', { zone, target: RecordTarget.fromAlias(new CloudFrontTarget(webDistribution)) });
      // Cognito serves sign-in through CloudFront, which only takes us-east-1 certificates. Deprecated, but the
      // replacement needs a second stack, which would need this one's zone while this one needs its certificate.
      const authCertificate = new DnsValidatedCertificate(this, 'AuthCertificate', { domainName: authHost!, hostedZone: zone, region: 'us-east-1' });
      authCertificate.node.addDependency(delegation);
      // Beside the prefix domain, which builds made before it keep signing in through.
      const authDomain = userPool.addDomain('AuthDomain', { customDomain: { domainName: authHost!, certificate: authCertificate } });
      authDomain.node.addDependency(apex);
      new ARecord(this, 'AuthRecord', { zone, recordName: authHost, target: RecordTarget.fromAlias(new UserPoolDomainTarget(authDomain)) });

      // Same certificate reasoning as auth.
      const byOrigin = new CachePolicy(this, 'ReleaseCachePolicy', {
        headerBehavior: CacheHeaderBehavior.allowList('Origin'),
        enableAcceptEncodingGzip: true,
        enableAcceptEncodingBrotli: true,
      });
      const releaseCertificate = new DnsValidatedCertificate(this, 'ReleaseCertificate', {
        domainName: downloadsHost!,
        subjectAlternativeNames: [releaseHost!],
        hostedZone: zone,
        region: 'us-east-1',
      });
      releaseCertificate.node.addDependency(delegation);
      for (const [id, host, folder] of [['Downloads', downloadsHost!, 'downloads'], ['Release', releaseHost!, 'release']] as const) {
        const distribution = new Distribution(this, `${id}Distribution`, {
          defaultBehavior: {
            origin: S3BucketOrigin.withOriginAccessControl(releaseBucket, { originPath: `/${folder}` }),
            viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
            ...(folder === 'release' ? { cachePolicy: byOrigin } : {}),
          },
          domainNames: [host],
          certificate: releaseCertificate,
          priceClass: PriceClass.PRICE_CLASS_100,
        });
        new ARecord(this, `${id}Record`, { zone, recordName: host, target: RecordTarget.fromAlias(new CloudFrontTarget(distribution)) });
      }
    }

    if (files && filesBucket) {
      // Every configured key is trusted, so a rotation adds the new one, moves the API to it, then drops the old.
      const publicKeys = Object.fromEntries(Object.entries(files.keys).map(([name, encodedKey]) => [name, new PublicKey(this, `FilesKey${name}`, { encodedKey })]));
      // Same certificate reasoning as auth.
      const filesCertificate = zone && filesHost ? new DnsValidatedCertificate(this, 'FilesCertificate', { domainName: filesHost, hostedZone: zone, region: 'us-east-1' }) : undefined;
      if (filesCertificate) filesCertificate.node.addDependency(delegation!);
      const filesDistribution = new Distribution(this, 'FilesDistribution', {
        defaultBehavior: {
          origin: S3BucketOrigin.withOriginAccessControl(filesBucket),
          viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: AllowedMethods.ALLOW_GET_HEAD,
          trustedKeyGroups: [new KeyGroup(this, 'FilesKeys', { items: Object.values(publicKeys) })],
          cachePolicy: new CachePolicy(this, 'FilesCachePolicy', { headerBehavior: CacheHeaderBehavior.allowList('Origin') }),
          // Nothing a file holds runs on this host: no sniffing a type it wasn't given, and a page that loads nothing and
          // runs no script. The API also uploads anything but a JPEG or PNG as an attachment to save.
          responseHeadersPolicy: new ResponseHeadersPolicy(this, 'FilesHeaders', {
            securityHeadersBehavior: {
              contentTypeOptions: { override: true },
              contentSecurityPolicy: { contentSecurityPolicy: "default-src 'none'; sandbox", override: true },
            },
          }),
        },
        ...(filesCertificate ? { domainNames: [filesHost!], certificate: filesCertificate } : {}),
        priceClass: PriceClass.PRICE_CLASS_100,
      });
      if (zone && filesHost) new ARecord(this, 'FilesRecord', { zone, recordName: filesHost, target: RecordTarget.fromAlias(new CloudFrontTarget(filesDistribution)) });
      filesUrl = filesHost ? `https://${filesHost}` : `https://${filesDistribution.distributionDomainName}`;

      const signingKey = `${ssmPrefix}/files/${files.signWith}`;
      apiFunction.addEnvironment('FILES_UPLOAD_URL', filesUploadUrl!);
      apiFunction.addEnvironment('FILES_URL', filesUrl);
      apiFunction.addEnvironment('FILES_KEY_ID', publicKeys[files.signWith]!.publicKeyId);
      apiFunction.addEnvironment('FILES_KEY_PARAM', signingKey);
      retentionFunction.addEnvironment('FILES_BUCKET', filesBucket.bucketName);
      // The presigned PUTs are signed with the API's own role, so it may put objects, and only under u/.
      apiFunction.addToRolePolicy(new PolicyStatement({ actions: ['s3:PutObject'], resources: [filesBucket.arnForObjects('u/*')] }));
      // Only the key it signs with, beside the Google secrets: not one being rotated in or out.
      apiFunction.addToRolePolicy(new PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [this.formatArn({ service: 'ssm', resource: 'parameter', resourceName: signingKey.slice(1) })],
      }));
      // A file goes when its record does.
      retentionFunction.addToRolePolicy(new PolicyStatement({ actions: ['s3:DeleteObject'], resources: [filesBucket.arnForObjects('u/*')] }));
    }

    // What the release pipeline (lib/pipeline-stack.ts) signs in as to test this environment and publish to it: the
    // deployed suites' reads, and the release bucket. It deploys through CDK's bootstrap roles instead.
    if (pipelineAccount && releaseBucket) {
      const release = new Role(this, 'ReleaseRole', {
        roleName: RELEASE_ROLE_NAME,
        // By account and name rather than by the role itself, which IAM would need to exist before this.
        assumedBy: new AccountPrincipal(pipelineAccount).withConditions({
          ArnEquals: { 'aws:PrincipalArn': `arn:${this.partition}:iam::${pipelineAccount}:role/${PIPELINE_ROLE_NAME}` },
        }),
      });
      // The test users' passwords, beside the Google secrets the Lambdas read.
      release.addToPolicy(new PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [this.formatArn({ service: 'ssm', resource: 'parameter', resourceName: `multiscale/${envName}/*-user-password` })],
      }));
      // Smoke: that logs and metrics arrive. GetMetricStatistics has no resource to scope it to.
      release.addToPolicy(new PolicyStatement({ actions: ['logs:FilterLogEvents'], resources: [apiLogs.logGroupArn, calendarLogs.logGroupArn] }));
      release.addToPolicy(new PolicyStatement({ actions: ['cloudwatch:GetMetricStatistics'], resources: ['*'] }));
      // The bake check after each surface's release (scripts/pipeline.sh bake-check): whether a release alarm is in ALARM.
      release.addToPolicy(new PolicyStatement({ actions: ['cloudwatch:DescribeAlarms'], resources: ['*'] }));
      // The nightly publishes CI's performance results to the dashboard (scripts/perf-publish.sh): that namespace alone.
      if (settings.performanceDashboard) {
        release.addToPolicy(new PolicyStatement({ actions: ['cloudwatch:PutMetricData'], resources: ['*'], conditions: { StringEquals: { 'cloudwatch:namespace': PERF_NAMESPACE } } }));
      }
      // The outputs the app builds and suites read.
      release.addToPolicy(new PolicyStatement({ actions: ['cloudformation:DescribeStacks'], resources: [this.stackId] }));
      releaseBucket.grantReadWrite(release);
    }

    // Read by scripts/deploy.sh, scripts/smoke.sh and the setup guide.

    const outputs: Record<string, string> = {
      ApiUrl: apiUrl,
      Region: this.region,
      UserPoolId: userPool.userPoolId,
      AppClientId: appClient.userPoolClientId,
      TestClientId: testClient.userPoolClientId,
      CognitoDomain: authHost ? `https://${authHost}` : domain.baseUrl(),
      ApiLogGroup: apiLogs.logGroupName,
      CalendarLogGroup: calendarLogs.logGroupName,
      MetricNamespace: namespace,
      GoogleRedirectUri: `${apiUrl}/calendar/callback`,
      AlarmTopicArn: topic.topicArn,
      // For the pipeline's bake check, which reads their state as the release role. Named whether a release turns them
      // off or not: they still alarm.
      ReleaseAlarms: releaseAlarms.map((alarm) => alarm.alarmName).join(','),
      TableName: table.tableName,
      ...(releaseBucket ? { ReleaseBucket: releaseBucket.bucketName, ReleaseUrl: `https://${releaseHost}`, DownloadsUrl: `https://${downloadsHost}`, WebUrl: webUrl! } : {}),
      // Where the app fetches and uploads files, which its content policy names.
      ...(filesUrl ? { FilesUrl: filesUrl, FilesUploadUrl: filesUploadUrl! } : {}),
    };
    for (const [name, value] of Object.entries(outputs)) new CfnOutput(this, name, { value });
  }
}

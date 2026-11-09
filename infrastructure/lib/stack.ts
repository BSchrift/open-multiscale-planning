// Everything one environment runs on AWS. Cost is meant to stay under $1 a month, so secrets are SSM SecureString
// parameters under the AWS-managed key rather than Secrets Manager or a customer-managed key.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { Annotations, CfnOutput, Duration, Names, RemovalPolicy, Stack } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { forEnv } from '@multiscale/config';
import { AccessLogFormat } from 'aws-cdk-lib/aws-apigateway';
import { ApiMapping, CorsHttpMethod, DomainName, HttpApi, HttpMethod, HttpNoneAuthorizer, HttpStage, LogGroupLogDestination } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpUserPoolAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { CfnBudget } from 'aws-cdk-lib/aws-budgets';
import { Certificate, CertificateValidation, DnsValidatedCertificate } from 'aws-cdk-lib/aws-certificatemanager';
import { CacheHeaderBehavior, CachePolicy, Distribution, PriceClass, ResponseHeadersPolicy, ViewerProtocolPolicy } from 'aws-cdk-lib/aws-cloudfront';
import { S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { Alarm, ComparisonOperator, Dashboard, GraphWidget, LogQueryVisualizationType, LogQueryWidget, MathExpression, Metric, TreatMissingData } from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import { LambdaApplication, LambdaDeploymentConfig, LambdaDeploymentGroup, TimeBasedCanaryTrafficRouting } from 'aws-cdk-lib/aws-codedeploy';
import { CfnUserPoolClient, FeaturePlan, OAuthScope, UserPool, UserPoolClientIdentityProvider } from 'aws-cdk-lib/aws-cognito';
import { AttributeType, BillingMode, ProjectionType, StreamViewType, Table } from 'aws-cdk-lib/aws-dynamodb';
import { AccountPrincipal, PolicyStatement, Role } from 'aws-cdk-lib/aws-iam';
import { Alias, Architecture, Code, EventSourceMapping, FilterCriteria, FilterRule, Function as LambdaFunction, Runtime, StartingPosition } from 'aws-cdk-lib/aws-lambda';
import type { EventSourceMappingOptions } from 'aws-cdk-lib/aws-lambda';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { ARecord, CrossAccountZoneDelegationRecord, PublicHostedZone, RecordTarget } from 'aws-cdk-lib/aws-route53';
import { ApiGatewayv2DomainProperties, CloudFrontTarget, UserPoolDomainTarget } from 'aws-cdk-lib/aws-route53-targets';
import { BlockPublicAccess, Bucket, BucketEncryption, HttpMethods } from 'aws-cdk-lib/aws-s3';
import { Schedule, ScheduleExpression } from 'aws-cdk-lib/aws-scheduler';
import { LambdaInvoke } from 'aws-cdk-lib/aws-scheduler-targets';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { EmailSubscription } from 'aws-cdk-lib/aws-sns-subscriptions';
import { loadRetention } from '../../config/retention.ts';
import type { Config, ControlConfig, EnvName } from './config.ts';
import { DELEGATION_ROLE_NAME } from './control-stack.ts';
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
  /** The control account, when control.yaml sets up the release pipeline there: it tests and publishes as this stack's release role. */
  pipelineAccount?: string;
}

export class MultiscaleStack extends Stack {
  constructor(scope: Construct, id: string, props: MultiscaleStackProps) {
    const { envName, config, control, backendDist, requireBinaries, canary, pipelineAccount } = props;
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

    const calendarFunction = goFunction('CalendarFunction', 'calendar', calendarLogs, Duration.minutes(5), {});
    const calendarAlias = live(calendarFunction);
    // The API starts the worker through its alias, named by ARN rather than by the alias resource: CloudFormation counts
    // the alias's UpdatePolicy, so the alias waits on its deployment group, whose alarms watch the API. Referring to the
    // alias resource from the API would make a loop CloudFormation refuses (test/cycles.test.ts).
    const calendarLiveArn = `${calendarFunction.functionArn}:${calendarAlias.aliasName}`;
    const retentionFunction = goFunction('RetentionFunction', 'retention', retentionLogs, Duration.minutes(5), {});
    const retentionAlias = live(retentionFunction);
    const apiFunction = goFunction('ApiFunction', 'api', apiLogs, Duration.seconds(25), {
      API_URL: apiUrl,
      CALENDAR_FUNCTION_NAME: calendarLiveArn,
    });
    const apiAlias = live(apiFunction);

    const integration = new HttpLambdaIntegration('ApiIntegration', apiAlias);
    httpApi.addRoutes({ path: '/sync', methods: [HttpMethod.POST], integration });
    httpApi.addRoutes({ path: '/calendar/connect', methods: [HttpMethod.POST], integration });
    httpApi.addRoutes({ path: '/calendar/refresh', methods: [HttpMethod.POST], integration });
    httpApi.addRoutes({ path: '/calendar/disconnect', methods: [HttpMethod.POST], integration });
    // OpenTelemetry events from the app, in OTLP/HTTP JSON at OTLP's own path.
    httpApi.addRoutes({ path: '/v1/logs', methods: [HttpMethod.POST], integration });
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
    new Schedule(this, 'CalendarSchedule', {
      schedule: ScheduleExpression.rate(Duration.minutes(30)),
      target: new LambdaInvoke(calendarAlias),
    });

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
    // Raising a mark is an UpdateItem. Cleanup also reads the table and removes what has expired.
    retentionFunction.addToRolePolicy(new PolicyStatement({
      actions: ['dynamodb:UpdateItem', ...(retention.cleanup ? ['dynamodb:Scan', 'dynamodb:DeleteItem'] : [])],
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
    const throttles = (metricName: string) =>
      new Metric({ namespace: 'AWS/DynamoDB', metricName, dimensionsMap: { TableName: table.tableName }, statistic: 'Sum', period: fiveMinutes });

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
      label: 'DynamoDB throttles',
      expression: 'FILL(reads, 0) + FILL(writes, 0)',
      usingMetrics: { reads: throttles('ReadThrottleEvents'), writes: throttles('WriteThrottleEvents') },
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

    // These also roll a new backend version back while it takes traffic. They watch both versions together.
    const releaseAlarms = [
      anyFailure('Api5xxRate', 'At least 10% of API requests failed with a 5xx', apiErrorRate, 10),
      // Over two periods, since with one user a single slow push is the whole p99.
      anyFailure('ApiLatency', 'API p99 latency was 10 seconds or more for 10 minutes', httpApi.metricLatency({ statistic: 'p99', period: fiveMinutes }), 10_000, 2),
      anyFailure('LambdaErrors', 'A Lambda crashed or timed out', lambdaErrors),
      anyFailure('DynamoThrottles', 'DynamoDB throttled a request', dynamoThrottles),
      anyFailure('CalendarFailures', 'A calendar worker run failed', custom('CalendarRunFailures')),
      // Its mapping retries a failing batch until the stream drops it, a day later, so a stuck consumer shows as age.
      anyFailure('RetentionBehind', 'The retention consumer is an hour or more behind the stream', retentionFunction.metric('IteratorAge', { statistic: 'Maximum', period: fiveMinutes }), Duration.hours(1).toMilliseconds()),
      // One failed run is enough: a new version gets about 1 run in 20, so two in a row would almost never come.
      anyFailure('CanaryFailures', "The release canary's sync round trip failed", new Metric({
        namespace: 'AWS/Lambda', metricName: 'Errors', dimensionsMap: { FunctionName: canaryName }, statistic: 'Sum', period: fiveMinutes,
      })),
    ];
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

    // Deployments: CodeDeploy moves each alias to a new version by config/env's canary, a share of invocations first and
    // the rest after a wait, and moves it back if a release alarm fires on the way. Only code is split like this: the
    // table, IAM, schedules and config change all at once, so they follow the compatibility rules in AGENTS.md.

    const settings = forEnv(envName).stack;
    const application = new LambdaApplication(this, 'Deployments');
    // Always made, so a release that skips the canary doesn't remove it and the next one finds it again.
    const canaryConfig = new LambdaDeploymentConfig(this, 'Canary', {
      trafficRouting: new TimeBasedCanaryTrafficRouting({ percentage: settings.canaryPercent, interval: Duration.minutes(settings.canaryMinutes) }),
    });
    const deploymentConfig = canary === 'skip' ? LambdaDeploymentConfig.ALL_AT_ONCE : canaryConfig;
    const deployment = (id: string, alias: Alias) => {
      const group = new LambdaDeploymentGroup(this, `${id}Deployment`, {
        application,
        alias,
        deploymentConfig,
        alarms: releaseAlarms,
        autoRollback: { failedDeployment: true, stoppedDeployment: true, deploymentInAlarm: true },
      });
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
          new GraphWidget({ title: 'Worker health', width, left: [custom('CalendarRunFailures'), custom('CalendarEventsChanged'), custom('CalendarEventsChanged', 'SampleCount')], right: [calendarFunction.metricDuration({ period: fiveMinutes })] }),
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
      ],
    });

    // Budgets cover the whole account, so with both environments in one account either one's alert means the total.
    new CfnBudget(this, 'Budget', {
      budget: { budgetName: id, budgetType: 'COST', timeUnit: 'MONTHLY', budgetLimit: { amount: 5, unit: 'USD' } },
      notificationsWithSubscribers: [{
        notification: { notificationType: 'ACTUAL', comparisonOperator: 'GREATER_THAN', threshold: 100, thresholdType: 'PERCENTAGE' },
        subscribers: [{ subscriptionType: 'EMAIL', address: config.alarmEmail }],
      }],
    });

    let releaseBucket: Bucket | undefined;

    // DNS: this environment's own zone, delegated from the domain in the control account, serving the API on api.<zone>
    // and sign-in on auth.<zone>.

    if (config.dns?.zone) {
      const zone = new PublicHostedZone(this, 'Zone', { zoneName: config.dns.zone });
      // shortcut: the delegation handler's log group keeps CloudWatch's default retention, since CDK offers no setting and it
      // logs a few lines per deploy; give it 30 days if it ever logs more.
      const delegation = new CrossAccountZoneDelegationRecord(this, 'ZoneDelegation', {
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
                  "img-src 'self' data:",
                  "font-src 'self'",
                  `connect-src 'self' https://${apiHost} https://${authHost}`,
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
      TableName: table.tableName,
      ...(releaseBucket ? { ReleaseBucket: releaseBucket.bucketName, ReleaseUrl: `https://${releaseHost}`, DownloadsUrl: `https://${downloadsHost}`, WebUrl: webUrl! } : {}),
    };
    for (const [name, value] of Object.entries(outputs)) new CfnOutput(this, name, { value });
  }
}

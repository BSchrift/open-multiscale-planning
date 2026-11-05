// Everything one environment runs on AWS. Cost is meant to stay under $1 a month, so secrets are SSM SecureString
// parameters under the AWS-managed key rather than Secrets Manager or a customer-managed key.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Annotations, CfnOutput, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { AccessLogFormat } from 'aws-cdk-lib/aws-apigateway';
import { ApiMapping, CorsHttpMethod, DomainName, HttpApi, HttpMethod, HttpNoneAuthorizer, HttpStage, LogGroupLogDestination } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpUserPoolAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { CfnBudget } from 'aws-cdk-lib/aws-budgets';
import { Certificate, CertificateValidation, DnsValidatedCertificate } from 'aws-cdk-lib/aws-certificatemanager';
import { Alarm, ComparisonOperator, Dashboard, GraphWidget, MathExpression, Metric, TreatMissingData } from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import { CfnUserPoolClient, FeaturePlan, OAuthScope, UserPool, UserPoolClientIdentityProvider } from 'aws-cdk-lib/aws-cognito';
import { AttributeType, BillingMode, ProjectionType, StreamViewType, Table } from 'aws-cdk-lib/aws-dynamodb';
import { PolicyStatement, Role } from 'aws-cdk-lib/aws-iam';
import { Architecture, Code, FilterCriteria, Function as LambdaFunction, Runtime, StartingPosition } from 'aws-cdk-lib/aws-lambda';
import { DynamoEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { ARecord, CrossAccountZoneDelegationRecord, PublicHostedZone, RecordTarget } from 'aws-cdk-lib/aws-route53';
import { ApiGatewayv2DomainProperties, UserPoolDomainTarget } from 'aws-cdk-lib/aws-route53-targets';
import { Schedule, ScheduleExpression } from 'aws-cdk-lib/aws-scheduler';
import { LambdaInvoke } from 'aws-cdk-lib/aws-scheduler-targets';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { EmailSubscription } from 'aws-cdk-lib/aws-sns-subscriptions';
import type { Config, ControlConfig, EnvName } from './config.ts';
import { DELEGATION_ROLE_NAME } from './control-stack.ts';

export interface MultiscaleStackProps {
  envName: EnvName;
  config: Config;
  /** Needed when config sets dns.zone: the zone is delegated from its domain, in its account. */
  control?: ControlConfig;
  /** Holds api/ and calendar/, each a bootstrap and the config.yaml it loads, put there by scripts/deploy.sh. */
  backendDist: string;
  /** Set when deploying, so that a missing build fails instead of shipping the stand-in. */
  requireBinaries: boolean;
}

export class MultiscaleStack extends Stack {
  constructor(scope: Construct, id: string, props: MultiscaleStackProps) {
    const { envName, config, control, backendDist, requireBinaries } = props;
    super(scope, id, {
      env: { account: config.aws.account, region: config.aws.region },
      terminationProtection: envName === 'prod',
    });

    const namespace = `Multiscale/${envName}`;
    const ssmPrefix = `/multiscale/${envName}`;

    const goCode = (name: string) => {
      const dir = join(backendDist, name);
      if (existsSync(join(dir, 'bootstrap'))) {
        // The binary fails at startup without it.
        if (requireBinaries && !existsSync(join(dir, 'config.yaml'))) throw new Error(`${dir}/config.yaml is missing. Deploy with scripts/deploy.sh.`);
        return Code.fromAsset(dir);
      }
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
    const appClient = userPool.addClient('AppClient', {
      userPoolClientName: 'app',
      generateSecret: false,
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [OAuthScope.OPENID, OAuthScope.EMAIL],
        callbackUrls: config.auth.signInCallbackUrls,
        logoutUrls: config.auth.signInCallbackUrls,
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

    const table = new Table(this, 'Table', {
      partitionKey: { name: 'pk', type: AttributeType.STRING },
      sortKey: { name: 'sk', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      stream: StreamViewType.KEYS_ONLY,
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

    const goFunction = (functionId: string, name: string, logGroup: LogGroup, timeout: Duration, environment: Record<string, string>) =>
      new LambdaFunction(this, functionId, {
        runtime: Runtime.PROVIDED_AL2023,
        architecture: Architecture.ARM_64,
        handler: 'bootstrap',
        code: goCode(name),
        memorySize: 256,
        timeout,
        logGroup,
        environment: { TABLE_NAME: table.tableName, ENV_NAME: envName, SSM_PREFIX: ssmPrefix, ...environment },
      });

    const calendarFunction = goFunction('CalendarFunction', 'calendar', calendarLogs, Duration.minutes(5), {});
    const apiFunction = goFunction('ApiFunction', 'api', apiLogs, Duration.seconds(25), {
      API_URL: apiUrl,
      CALENDAR_FUNCTION_NAME: calendarFunction.functionName,
    });

    const integration = new HttpLambdaIntegration('ApiIntegration', apiFunction);
    httpApi.addRoutes({ path: '/sync', methods: [HttpMethod.POST], integration });
    httpApi.addRoutes({ path: '/calendar/connect', methods: [HttpMethod.POST], integration });
    httpApi.addRoutes({ path: '/calendar/refresh', methods: [HttpMethod.POST], integration });
    httpApi.addRoutes({ path: '/calendar/disconnect', methods: [HttpMethod.POST], integration });
    // OpenTelemetry events from the app, in OTLP/HTTP JSON at OTLP's own path.
    httpApi.addRoutes({ path: '/v1/logs', methods: [HttpMethod.POST], integration });
    // Its signed state proves who it is for: Google's redirect can't carry a token.
    httpApi.addRoutes({ path: '/calendar/callback', methods: [HttpMethod.GET], integration, authorizer: new HttpNoneAuthorizer() });

    // Permissions. A sync transaction needs Put, Update and ConditionCheck: TransactWriteItems is not an IAM action.

    const dataAccess = new PolicyStatement({
      actions: ['dynamodb:BatchGetItem', 'dynamodb:ConditionCheckItem', 'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:Query', 'dynamodb:UpdateItem'],
      resources: [table.tableArn, `${table.tableArn}/index/by_seq`],
    });
    // Only the Google secrets: the test users' passwords sit beside them, for the integration suite alone.
    const readSecrets = new PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [this.formatArn({ service: 'ssm', resource: 'parameter', resourceName: `multiscale/${envName}/google/*` })],
    });
    for (const fn of [apiFunction, calendarFunction]) {
      fn.addToRolePolicy(dataAccess);
      fn.addToRolePolicy(readSecrets);
    }
    apiFunction.addToRolePolicy(new PolicyStatement({
      actions: ['ssm:PutParameter', 'ssm:DeleteParameter'],
      resources: [this.formatArn({ service: 'ssm', resource: 'parameter', resourceName: `multiscale/${envName}/google/refresh-token` })],
    }));
    calendarFunction.grantInvoke(apiFunction);

    // What runs the worker

    calendarFunction.addEventSource(new DynamoEventSource(table, {
      startingPosition: StartingPosition.LATEST,
      batchSize: 100,
      maxBatchingWindow: Duration.seconds(60),
      retryAttempts: 2,
      // Only its inputs. Waking on the calendar record it writes itself would loop forever.
      filters: [FilterCriteria.filter({ dynamodb: { Keys: { sk: { S: [{ prefix: 'rec#time_block#' }, { prefix: 'rec#calendar_source#' }] } } } })],
    }));
    new Schedule(this, 'CalendarSchedule', {
      schedule: ScheduleExpression.rate(Duration.minutes(30)),
      target: new LambdaInvoke(calendarFunction),
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
      expression: 'FILL(api, 0) + FILL(calendar, 0)',
      usingMetrics: { api: apiFunction.metricErrors({ period: fiveMinutes }), calendar: calendarFunction.metricErrors({ period: fiveMinutes }) },
      period: fiveMinutes,
    });
    const dynamoThrottles = new MathExpression({
      label: 'DynamoDB throttles',
      expression: 'FILL(reads, 0) + FILL(writes, 0)',
      usingMetrics: { reads: throttles('ReadThrottleEvents'), writes: throttles('WriteThrottleEvents') },
      period: fiveMinutes,
    });

    const anyFailure = (alarmId: string, description: string, metric: Metric | MathExpression, threshold = 1) =>
      new Alarm(this, alarmId, {
        alarmDescription: description,
        metric,
        threshold,
        evaluationPeriods: 1,
        comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      }).addAlarmAction(alarmAction);

    anyFailure('Api5xxRate', 'At least 10% of API requests failed with a 5xx', apiErrorRate, 10);
    anyFailure('LambdaErrors', 'A Lambda crashed or timed out', lambdaErrors);
    anyFailure('DynamoThrottles', 'DynamoDB throttled a request', dynamoThrottles);
    anyFailure('CalendarFailures', 'A calendar worker run failed', custom('CalendarRunFailures'));
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

    // Dashboard

    const width = 12;
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

      // Cognito refuses a custom domain whose parent doesn't resolve; what it resolves to doesn't matter to it.
      // shortcut: the zone's own name points at a documentation address (RFC 5737) that serves nothing; point it at a real
      // page if anyone should visit it.
      const apex = new ARecord(this, 'ZoneApexRecord', { zone, target: RecordTarget.fromIpAddresses('192.0.2.1') });
      // Cognito serves sign-in through CloudFront, which only takes us-east-1 certificates. Deprecated, but the
      // replacement needs a second stack, which would need this one's zone while this one needs its certificate.
      const authCertificate = new DnsValidatedCertificate(this, 'AuthCertificate', { domainName: authHost!, hostedZone: zone, region: 'us-east-1' });
      authCertificate.node.addDependency(delegation);
      // Beside the prefix domain, which builds made before it keep signing in through.
      const authDomain = userPool.addDomain('AuthDomain', { customDomain: { domainName: authHost!, certificate: authCertificate } });
      authDomain.node.addDependency(apex);
      new ARecord(this, 'AuthRecord', { zone, recordName: authHost, target: RecordTarget.fromAlias(new UserPoolDomainTarget(authDomain)) });
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
    };
    for (const [name, value] of Object.entries(outputs)) new CfnOutput(this, name, { value });
  }
}

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import { App } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { MultiscaleStack } from '../lib/stack.ts';
import type { Config, ControlConfig } from '../lib/config.ts';

const config: Config = {
  aws: { account: '111111111111', region: 'us-west-2', profile: 'test' },
  alarmEmail: 'alarms@example.com',
  auth: { cognitoDomainPrefix: 'multiscale-test', signInCallbackUrls: ['multiscale://auth/callback'] },
};
const control: ControlConfig = { aws: { account: '333333333333', region: 'us-west-2', profile: 'control' }, dns: { domain: 'example.net', hostedZoneId: 'Z0PARENTZONE' } };

function build(envName: 'staging' | 'prod' = 'staging', backendDist = '/nonexistent', requireBinaries = false, withConfig = config) {
  return new MultiscaleStack(new App(), `Multiscale-${envName}`, { envName, config: withConfig, control, backendDist, requireBinaries });
}

type Resource = { Type: string; Properties: Record<string, any>; DeletionPolicy?: string };
let t: Template;
let all: Record<string, Resource>;
const ofType = (type: string) => Object.entries(all).filter(([, r]) => r.Type === type);
const logicalId = (prefix: string) => {
  const hit = Object.keys(all).find((id) => id.startsWith(prefix) && all[id].Type === 'AWS::Lambda::Function');
  assert.ok(hit, `no function ${prefix}`);
  return hit;
};
const policyFor = (functionPrefix: string) => {
  const role = (all[logicalId(functionPrefix)].Properties.Role as any)['Fn::GetAtt'][0];
  const statements = ofType('AWS::IAM::Policy')
    .filter(([, p]) => p.Properties.Roles.some((r: any) => r.Ref === role))
    .flatMap(([, p]) => p.Properties.PolicyDocument.Statement as any[]);
  return statements.map((s) => ({ ...s, Action: [s.Action].flat() as string[] }));
};
const actions = (functionPrefix: string) => policyFor(functionPrefix).flatMap((s) => s.Action);

before(() => {
  t = Template.fromStack(build());
  all = t.toJSON().Resources;
});

describe('sign-in', () => {
  it('turns self sign-up off and keeps the pool', () => {
    t.hasResource('AWS::Cognito::UserPool', {
      Properties: { AdminCreateUserConfig: { AllowAdminCreateUserOnly: true }, UserPoolTier: 'ESSENTIALS', DeletionProtection: 'ACTIVE' },
      DeletionPolicy: 'Retain',
    });
  });

  it('has a hosted UI domain from config', () => {
    t.hasResourceProperties('AWS::Cognito::UserPoolDomain', { Domain: 'multiscale-test' });
  });

  it('app client is code flow only, with no secret and long-lived refresh tokens', () => {
    t.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      ClientName: 'app',
      GenerateSecret: false,
      AllowedOAuthFlows: ['code'],
      AllowedOAuthFlowsUserPoolClient: true,
      AllowedOAuthScopes: ['openid', 'email'],
      CallbackURLs: ['multiscale://auth/callback'],
      ExplicitAuthFlows: ['ALLOW_REFRESH_TOKEN_AUTH'],
      RefreshTokenValidity: 60 * 24 * 365,
      TokenValidityUnits: Match.objectLike({ RefreshToken: 'minutes' }),
    });
  });

  it('test client signs in by password so that the integration suite has real tokens, and has no hosted flow', () => {
    t.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      ClientName: 'integration-test',
      GenerateSecret: false,
      ExplicitAuthFlows: Match.arrayWith(['ALLOW_USER_PASSWORD_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH']),
      AllowedOAuthFlows: Match.absent(),
    });
  });
});

describe('API', () => {
  const route = (key: string) => {
    const hit = ofType('AWS::ApiGatewayV2::Route').find(([, r]) => r.Properties.RouteKey === key);
    assert.ok(hit, `no route ${key}`);
    return hit[1].Properties;
  };

  it('has exactly the six routes', () => {
    const keys = ofType('AWS::ApiGatewayV2::Route').map(([, r]) => r.Properties.RouteKey).sort();
    assert.deepEqual(keys, ['GET /calendar/callback', 'POST /calendar/connect', 'POST /calendar/disconnect', 'POST /calendar/refresh', 'POST /sync', 'POST /v1/logs']);
  });

  it('protects every route with the JWT authorizer except the Google callback', () => {
    for (const key of ['POST /sync', 'POST /calendar/connect', 'POST /calendar/refresh', 'POST /calendar/disconnect', 'POST /v1/logs']) {
      assert.equal(route(key).AuthorizationType, 'JWT', key);
      assert.ok(route(key).AuthorizerId, key);
    }
    assert.equal(route('GET /calendar/callback').AuthorizationType, 'NONE');
  });

  it('authorizer accepts the app and test clients, from this pool', () => {
    const [[, a]] = ofType('AWS::ApiGatewayV2::Authorizer');
    assert.equal(a.Properties.AuthorizerType, 'JWT');
    assert.equal(a.Properties.JwtConfiguration.Audience.length, 2);
    assert.match(JSON.stringify(a.Properties.JwtConfiguration.Issuer), /cognito-idp/);
  });

  it('allows browser-style preflight from the app, which has no fixed web origin', () => {
    t.hasResourceProperties('AWS::ApiGatewayV2::Api', {
      ProtocolType: 'HTTP',
      CorsConfiguration: Match.objectLike({ AllowOrigins: ['*'], AllowHeaders: Match.arrayWith(['authorization', 'content-type']) }),
    });
    const cors = ofType('AWS::ApiGatewayV2::Api')[0][1].Properties.CorsConfiguration;
    assert.notEqual(cors.AllowCredentials, true);
  });

  it('writes access logs without the query string, which carries the Google code', () => {
    const [[, stage]] = ofType('AWS::ApiGatewayV2::Stage');
    assert.equal(stage.Properties.StageName, '$default');
    assert.equal(stage.Properties.AutoDeploy, true);
    assert.ok(stage.Properties.AccessLogSettings.DestinationArn);
    const format = stage.Properties.AccessLogSettings.Format;
    assert.match(format, /\$context\.routeKey/);
    assert.doesNotMatch(format, /path|querystring|authorizer\.claims/i);
    assert.ok(stage.Properties.DefaultRouteSettings.ThrottlingRateLimit > 0);
  });

  it('writes access log lines that stay valid JSON when the gateway reports an error', () => {
    const [[, stage]] = ofType('AWS::ApiGatewayV2::Stage');
    // AWS fills $context.error.messageString with an already quoted string and every other variable bare.
    const line = stage.Properties.AccessLogSettings.Format
      .replace(/\$context\.error\.messageString/g, '"Unauthorized"')
      .replace(/\$context\.[\w.]+/g, 'Unauthorized');
    assert.equal(JSON.parse(line).error, 'Unauthorized');
  });
});

describe('Lambdas', () => {
  it('are exactly two arm64 Go functions', () => {
    const fns = ofType('AWS::Lambda::Function');
    assert.equal(fns.length, 2);
    for (const [, f] of fns) {
      assert.deepEqual(f.Properties.Architectures, ['arm64']);
      assert.equal(f.Properties.Runtime, 'provided.al2023');
      assert.equal(f.Properties.Handler, 'bootstrap');
    }
  });

  it('each has its own role', () => {
    const roles = new Set(ofType('AWS::Lambda::Function').map(([, f]) => f.Properties.Role['Fn::GetAtt'][0]));
    assert.equal(roles.size, 2);
  });

  it('get what they need through the environment', () => {
    const env = all[logicalId('Api')].Properties.Environment.Variables;
    assert.ok(env.TABLE_NAME);
    assert.equal(env.ENV_NAME, 'staging');
    assert.equal(env.SSM_PREFIX, '/multiscale/staging');
    // Exactly what the Go code reads: the metric namespace comes from ENV_NAME there, so it isn't passed twice.
    assert.deepEqual(Object.keys(env).sort(), ['API_URL', 'CALENDAR_FUNCTION_NAME', 'ENV_NAME', 'SSM_PREFIX', 'TABLE_NAME']);
    assert.ok(env.API_URL);
    assert.ok(env.CALENDAR_FUNCTION_NAME);
    const worker = all[logicalId('Calendar')].Properties.Environment.Variables;
    assert.ok(worker.TABLE_NAME);
    assert.equal(worker.SSM_PREFIX, '/multiscale/staging');
  });
});

describe('table', () => {
  it('is on demand with the keys, by_seq index, stream, PITR, deletion protection and retain', () => {
    t.hasResource('AWS::DynamoDB::Table', {
      Properties: {
        BillingMode: 'PAY_PER_REQUEST',
        KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }],
        LocalSecondaryIndexes: [{
          IndexName: 'by_seq',
          KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'seq', KeyType: 'RANGE' }],
          Projection: { ProjectionType: 'ALL' },
        }],
        StreamSpecification: { StreamViewType: 'KEYS_ONLY' },
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
        DeletionProtectionEnabled: true,
      },
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
    });
  });
});

describe('calendar triggers', () => {
  it('runs every 30 minutes from EventBridge Scheduler', () => {
    t.hasResourceProperties('AWS::Scheduler::Schedule', {
      ScheduleExpression: 'rate(30 minutes)',
      Target: Match.objectLike({ Arn: { 'Fn::GetAtt': [logicalId('Calendar'), 'Arn'] } }),
    });
  });

  it('runs from the stream with a 60 second window, for its inputs only and not the record it writes itself', () => {
    const [[, mapping]] = ofType('AWS::Lambda::EventSourceMapping');
    assert.equal(mapping.Properties.MaximumBatchingWindowInSeconds, 60);
    assert.deepEqual(mapping.Properties.FunctionName, { Ref: logicalId('Calendar') });
    const pattern = JSON.parse(mapping.Properties.FilterCriteria.Filters[0].Pattern);
    // Events take their titles from tasks and practices, so renaming one is an input too.
    assert.deepEqual(pattern.dynamodb.Keys.sk.S, [
      { prefix: 'rec#time_block#' }, { prefix: 'rec#task#' }, { prefix: 'rec#practice#' }, { prefix: 'rec#calendar_source#' },
    ]);
    assert.ok(mapping.Properties.MaximumRetryAttempts <= 3, 'the next run fixes anything a failed one missed');
  });
});

describe('least privilege', () => {
  const data = ['dynamodb:BatchGetItem', 'dynamodb:PutItem', 'dynamodb:Query', 'dynamodb:UpdateItem'];

  for (const fn of ['Api', 'Calendar']) {
    it(`${fn} has only the data actions a sync transaction uses, on this table`, () => {
      const isStream = (a: string) => /Stream|Shard|GetRecords/.test(a);
      const dynamo = policyFor(fn).filter((s) => s.Action.some((a: string) => a.startsWith('dynamodb:') && !isStream(a)));
      assert.deepEqual(dynamo.flatMap((s) => s.Action).filter((a: string) => !isStream(a)).sort(), data);
      for (const s of dynamo) assert.notEqual(s.Resource, '*');
    });

    it(`${fn} has no wildcard actions or a wildcard resource, except what the stream API needs`, () => {
      for (const s of policyFor(fn)) {
        for (const a of s.Action) assert.ok(!a.endsWith(':*') && a !== '*', a);
        if (s.Resource === '*') assert.deepEqual(s.Action, ['dynamodb:ListStreams']);
      }
    });
  }

  it('API may read this environment\'s secrets and write or delete only the refresh token', () => {
    for (const action of ['ssm:PutParameter', 'ssm:DeleteParameter']) {
      const write = policyFor('Api').filter((s) => s.Action.includes(action));
      assert.equal(write.length, 1, action);
      assert.match(JSON.stringify(write[0].Resource), /parameter\/multiscale\/staging\/google\/refresh-token"/, action);
    }
  });

  it("lets both functions read only this environment's Google secrets, never the test users' passwords beside them", () => {
    for (const fn of ['Api', 'Calendar']) {
      const get = policyFor(fn).filter((s) => s.Action.includes('ssm:GetParameter'));
      assert.equal(get.length, 1, fn);
      for (const resource of [get[0].Resource].flat()) assert.match(JSON.stringify(resource), /parameter\/multiscale\/staging\/google\//, fn);
    }
    assert.match(JSON.stringify(policyFor('Api').find((s) => s.Action.includes('ssm:GetParameter'))!.Resource), /google\/\*"/);
  });

  it('lets the worker read only the client and the connection, not the key that signs consents', () => {
    const get = policyFor('Calendar').filter((s) => s.Action.includes('ssm:GetParameter'));
    const names = [get[0].Resource].flat().map((r: unknown) => JSON.stringify(r).match(/google\/([a-z-]+)"/)?.[1]);
    assert.deepEqual(names.sort(), ['client-id', 'client-secret', 'refresh-token']);
  });

  it('worker reads secrets but cannot write them, and only it reads the stream', () => {
    assert.ok(actions('Calendar').includes('ssm:GetParameter'));
    assert.ok(!actions('Calendar').includes('ssm:PutParameter'));
    assert.ok(!actions('Calendar').includes('ssm:DeleteParameter'));
    assert.ok(actions('Calendar').includes('dynamodb:GetRecords'));
    assert.ok(!actions('Api').includes('dynamodb:GetRecords'));
  });

  it('only the API can invoke the worker', () => {
    assert.ok(actions('Api').includes('lambda:InvokeFunction'));
    assert.ok(!actions('Calendar').includes('lambda:InvokeFunction'));
  });
});

describe('observability', () => {
  it('sets 30-day retention on all three log groups, and both functions use theirs', () => {
    const groups = ofType('AWS::Logs::LogGroup');
    assert.equal(groups.length, 3);
    for (const [, g] of groups) assert.equal(g.Properties.RetentionInDays, 30);
    for (const [, f] of ofType('AWS::Lambda::Function')) assert.ok(f.Properties.LoggingConfig.LogGroup);
  });

  it('has exactly six alarms, all sent to one topic that emails the configured address', () => {
    const alarms = ofType('AWS::CloudWatch::Alarm');
    assert.equal(alarms.length, 6);
    const [[topicId]] = ofType('AWS::SNS::Topic');
    for (const [, a] of alarms) assert.deepEqual(a.Properties.AlarmActions, [{ Ref: topicId }]);
    t.hasResourceProperties('AWS::SNS::Subscription', { Protocol: 'email', Endpoint: 'alarms@example.com' });
  });

  const alarm = (name: string) => {
    const hit = ofType('AWS::CloudWatch::Alarm').find(([id]) => id.startsWith(name));
    assert.ok(hit, `no alarm ${name}`);
    return hit[1].Properties;
  };

  it('API 5xx alarm is a rate', () => {
    const a = alarm('Api5xxRate');
    assert.match(JSON.stringify(a.Metrics), /5xx/);
    assert.match(JSON.stringify(a.Metrics), /Count/);
    assert.equal(a.TreatMissingData, 'notBreaching');
  });

  it('Lambda errors alarm covers both functions', () => {
    const body = JSON.stringify(alarm('LambdaErrors').Metrics);
    assert.ok(body.includes(logicalId('Api')) && body.includes(logicalId('Calendar')));
  });

  it('throttle alarm covers reads and writes', () => {
    const body = JSON.stringify(alarm('DynamoThrottles').Metrics);
    assert.ok(body.includes('ReadThrottleEvents') && body.includes('WriteThrottleEvents'));
  });

  it('worker failure alarm reads the custom metric', () => {
    const a = alarm('CalendarFailures');
    assert.equal(a.MetricName, 'CalendarRunFailures');
    assert.equal(a.Namespace, 'Multiscale/staging');
    assert.equal(a.Dimensions, undefined, 'each dimension combination is billed as a metric');
  });

  it('worker silence alarm fires after 2 hours with no success, and missing data breaches', () => {
    const a = alarm('CalendarSilent');
    assert.equal(a.TreatMissingData, 'breaching');
    assert.equal(a.Period * a.EvaluationPeriods, 2 * 3600);
    assert.equal(a.MetricName, 'CalendarEventsChanged');
    assert.equal(a.Statistic, 'SampleCount');
    assert.equal(a.Dimensions, undefined);
  });

  // The by_seq index caps each user's records at 10 GB, and the API reports each writing user's size, so the Maximum is
  // the largest user's. A user who stops writing reports nothing, which mustn't read as the size falling.
  it('item collection alarm fires on the largest user reaching half the 10 GB cap, and holds through missing data', () => {
    const a = alarm('ItemCollectionSize');
    assert.equal(a.MetricName, 'ItemCollectionSizeGB');
    assert.equal(a.Namespace, 'Multiscale/staging');
    assert.equal(a.Statistic, 'Maximum');
    assert.equal(a.Threshold, 5);
    assert.equal(a.ComparisonOperator, 'GreaterThanOrEqualToThreshold');
    assert.equal(a.TreatMissingData, 'ignore');
    assert.equal(a.Dimensions, undefined);
    assert.match(a.AlarmDescription, /docs\/sync\.md/);
  });

  it('has one dashboard with requests, errors, latency, sync volume, worker health and the largest user', () => {
    const dashboards = ofType('AWS::CloudWatch::Dashboard');
    assert.equal(dashboards.length, 1);
    const body = JSON.stringify(dashboards[0][1].Properties.DashboardBody);
    for (const title of ['Requests', 'Errors', 'Latency', 'Sync volume', 'Worker health', 'Largest user (GB of the 10 GB cap)']) assert.ok(body.includes(title), title);
    for (const metric of ['SyncRecordsMerged', 'SyncConflictRetries', 'SyncRequestsRejected', 'CalendarRunFailures', 'CalendarEventsChanged', 'ItemCollectionSizeGB']) {
      assert.ok(body.includes(metric), metric);
    }
    assert.match(body, /ItemCollectionSizeGB[^\]]*Maximum/);
  });

  it('shows what the apps report, from Logs Insights on the API log group', () => {
    const body = JSON.stringify(ofType('AWS::CloudWatch::Dashboard')[0]![1].Properties.DashboardBody);
    for (const title of ['App memory (MB), by platform and version', 'App memory, by platform and version', 'How app runs ended', 'App errors', 'App events by screen', 'Update checks', 'Updates rolled back']) {
      assert.ok(body.includes(title), title);
    }
    assert.equal(body.match(/\\"type\\":\\"log\\"/g)?.length, 7);
    assert.equal(body.match(/client_event/g)?.length, 7);
    // Every panel tells desktop from mobile and one build from another.
    assert.equal(body.match(/app\.platform/g)?.length, 7);
    assert.equal(body.match(/service\.version/g)?.length, 8);
    for (const field of ['app.update.check', 'app.update.outcome', 'app.update.failure', 'app.update.rollback', 'app.update.build']) assert.ok(body.includes(field), field);
    assert.ok(body.includes('ApiLogs'));
  });

  it('uses only the five allowed custom metrics', () => {
    const text = JSON.stringify(t.toJSON());
    const used = new Set([...text.matchAll(/\b(Sync[A-Z]\w+|Calendar(?:Run|Events)\w+)\b/g)].map((m) => m[1]));
    assert.deepEqual([...used].sort(), ['CalendarEventsChanged', 'CalendarRunFailures', 'SyncConflictRetries', 'SyncRecordsMerged', 'SyncRequestsRejected']);
  });

  it('has a budget that alerts at $5 a month', () => {
    t.hasResourceProperties('AWS::Budgets::Budget', {
      Budget: Match.objectLike({ BudgetLimit: { Amount: 5, Unit: 'USD' }, TimeUnit: 'MONTHLY', BudgetType: 'COST' }),
      NotificationsWithSubscribers: [Match.objectLike({
        Notification: Match.objectLike({ NotificationType: 'ACTUAL', Threshold: 100 }),
        Subscribers: [{ SubscriptionType: 'EMAIL', Address: 'alarms@example.com' }],
      })],
    });
  });
});

describe('environments', () => {
  it('prod has its own namespace, secrets path and termination protection', () => {
    const stack = build('prod');
    assert.equal(stack.terminationProtection, true);
    const text = JSON.stringify(Template.fromStack(stack).toJSON());
    assert.ok(text.includes('Multiscale/prod'));
    assert.ok(text.includes('/multiscale/prod'));
    assert.ok(!text.includes('/multiscale/staging'));
  });

  it('outputs what deploy writes into the app and test configs', () => {
    const outputs = Object.keys(t.toJSON().Outputs).sort();
    for (const name of ['ApiUrl', 'Region', 'UserPoolId', 'AppClientId', 'TestClientId', 'CognitoDomain', 'ApiLogGroup', 'CalendarLogGroup', 'MetricNamespace', 'GoogleRedirectUri', 'AlarmTopicArn']) {
      assert.ok(outputs.includes(name), name);
    }
  });
});

describe('Go binaries', () => {
  it('warn and use a stand-in when not built, so that synth needs no Go', () => {
    Annotations.fromStack(build()).hasWarning('*', Match.stringLikeRegexp('not built'));
  });

  it('refuse to deploy a stand-in', () => {
    assert.throws(() => build('staging', '/nonexistent', true), /scripts\/deploy\.sh|not built/);
  });

  const dist = (files: string[]) => {
    const dir = mkdtempSync(join(tmpdir(), 'dist-'));
    for (const name of ['api', 'calendar']) {
      mkdirSync(join(dir, name));
      for (const file of files) writeFileSync(join(dir, name, file), name);
    }
    return dir;
  };

  it('use the build output when it is there', () => {
    const stack = build('staging', dist(['bootstrap']), true);
    Annotations.fromStack(stack).hasNoWarning('*', Match.stringLikeRegexp('not built'));
  });
});

describe('DNS', () => {
  const zoned = (envName: 'staging' | 'prod', zone: string) =>
    Template.fromStack(build(envName, '/nonexistent', false, { ...config, dns: { zone } }));

  it('is skipped until the environment sets dns.zone', () => {
    t.resourceCountIs('AWS::Route53::HostedZone', 0);
    t.resourceCountIs('Custom::CrossAccountZoneDelegation', 0);
    t.resourceCountIs('AWS::ApiGatewayV2::DomainName', 0);
  });

  for (const [envName, zone] of [['staging', 'staging.example.net'], ['prod', 'app.example.net']] as const) {
    it(`${envName} creates its zone and delegates it from the control account's zone by id`, () => {
      const z = zoned(envName, zone);
      z.hasResourceProperties('AWS::Route53::HostedZone', { Name: `${zone}.` });
      // By id, so another zone with the domain's name can never be picked.
      z.hasResourceProperties('Custom::CrossAccountZoneDelegation', {
        ParentZoneId: 'Z0PARENTZONE',
        ParentZoneName: Match.absent(),
        DelegatedZoneName: zone,
        AssumeRoleArn: { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':iam::333333333333:role/multiscale-dns-delegation']] },
      });
    });

    it(`${envName} serves the API on api.${zone}, and Google redirects there`, () => {
      const z = zoned(envName, zone);
      const host = `api.${zone}`;
      z.hasResourceProperties('AWS::ApiGatewayV2::DomainName', { DomainName: host });
      z.resourceCountIs('AWS::ApiGatewayV2::ApiMapping', 1);
      z.hasResourceProperties('AWS::Route53::RecordSet', { Name: `${host}.`, Type: 'A' });
      // Validated over public DNS, so it must wait for the delegation.
      const [cert] = Object.values(z.findResources('AWS::CertificateManager::Certificate', { Properties: { DomainName: host } }));
      const [delegation] = Object.keys(z.findResources('Custom::CrossAccountZoneDelegation'));
      assert.ok(([] as string[]).concat(cert.DependsOn ?? []).includes(delegation));
      z.hasOutput('ApiUrl', { Value: `https://${host}` });
      z.hasOutput('GoogleRedirectUri', { Value: `https://${host}/calendar/callback` });
      const [fn] = Object.values(z.findResources('AWS::Lambda::Function', { Properties: { Environment: { Variables: { API_URL: Match.anyValue() } } } }));
      assert.equal(fn.Properties.Environment.Variables.API_URL, `https://${host}`);
    });

    it(`${envName} signs in on auth.${zone}, keeping the Cognito prefix domain for builds that use it`, () => {
      const z = zoned(envName, zone);
      const host = `auth.${zone}`;
      // Cognito serves it through CloudFront, which only takes us-east-1 certificates.
      const [cert] = Object.values(z.findResources('AWS::CloudFormation::CustomResource', { Properties: { DomainName: host, Region: 'us-east-1' } }));
      const [delegation] = Object.keys(z.findResources('Custom::CrossAccountZoneDelegation'));
      assert.ok(([] as string[]).concat(cert.DependsOn ?? []).includes(delegation));
      z.resourceCountIs('AWS::Cognito::UserPoolDomain', 2);
      const [domain] = Object.values(z.findResources('AWS::Cognito::UserPoolDomain', { Properties: { Domain: host } }));
      assert.ok(domain.Properties.CustomDomainConfig.CertificateArn);
      // Cognito refuses a custom domain whose parent doesn't resolve.
      const [apex] = Object.keys(z.findResources('AWS::Route53::RecordSet', { Properties: { Name: `${zone}.`, Type: 'A' } }));
      assert.ok(([] as string[]).concat(domain.DependsOn ?? []).includes(apex));
      z.hasResourceProperties('AWS::Route53::RecordSet', { Name: `${host}.`, Type: 'A', AliasTarget: Match.objectLike({}) });
      z.hasOutput('CognitoDomain', { Value: `https://${host}` });
    });

    it(`${envName} serves releases on downloads.${zone} and release.${zone}, from one private bucket`, () => {
      const z = zoned(envName, zone);
      z.resourceCountIs('AWS::S3::Bucket', 1);
      z.hasResourceProperties('AWS::S3::Bucket', {
        PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
      });
      // CloudFront only takes us-east-1 certificates; one covers both names.
      const [cert] = Object.values(
        z.findResources('AWS::CloudFormation::CustomResource', { Properties: { DomainName: `downloads.${zone}`, SubjectAlternativeNames: [`release.${zone}`], Region: 'us-east-1' } }),
      );
      const [delegation] = Object.keys(z.findResources('Custom::CrossAccountZoneDelegation'));
      assert.ok(([] as string[]).concat(cert.DependsOn ?? []).includes(delegation));
      const distributions = Object.values(z.findResources('AWS::CloudFront::Distribution')).map((d) => d.Properties.DistributionConfig);
      const byHost = (host: string) => distributions.find((d) => d.Aliases.includes(host));
      // Each host serves its own folder of the bucket.
      assert.equal(byHost(`downloads.${zone}`).Origins[0].OriginPath, '/downloads');
      assert.equal(byHost(`release.${zone}`).Origins[0].OriginPath, '/release');
      // The apps fetch the feed from their own origins. S3 answers CORS, and Origin is in the cache key, so a copy cached
      // for a request without one never reaches the apps.
      z.hasResourceProperties('AWS::S3::Bucket', { CorsConfiguration: { CorsRules: [{ AllowedMethods: ['GET', 'HEAD'], AllowedOrigins: ['*'] }] } });
      const policies = z.findResources('AWS::CloudFront::CachePolicy');
      const releasePolicy = policies[byHost(`release.${zone}`).DefaultCacheBehavior.CachePolicyId.Ref];
      assert.deepEqual(releasePolicy.Properties.CachePolicyConfig.ParametersInCacheKeyAndForwardedToOrigin.HeadersConfig, { HeaderBehavior: 'whitelist', Headers: ['Origin'] });
      for (const host of [`downloads.${zone}`, `release.${zone}`]) assert.equal(byHost(host).DefaultCacheBehavior.ResponseHeadersPolicyId, undefined);
      for (const host of [`downloads.${zone}`, `release.${zone}`]) {
        assert.equal(byHost(host).DefaultCacheBehavior.ViewerProtocolPolicy, 'redirect-to-https');
        z.hasResourceProperties('AWS::Route53::RecordSet', { Name: `${host}.`, Type: 'A', AliasTarget: Match.objectLike({}) });
      }
      z.hasOutput('ReleaseUrl', { Value: `https://release.${zone}` });
      z.hasOutput('DownloadsUrl', { Value: `https://downloads.${zone}` });
      z.hasOutput('ReleaseBucket', { Value: Match.anyValue() });
    });

    it(`${envName} serves the web app on ${zone} itself, from the same bucket, and lets it sign in`, () => {
      const z = zoned(envName, zone);
      const web = Object.values(z.findResources('AWS::CloudFront::Distribution'))
        .map((d) => d.Properties.DistributionConfig)
        .find((d) => d.Aliases.includes(zone));
      assert.equal(web.Origins[0].OriginPath, '/web');
      assert.equal(web.DefaultRootObject, 'index.html');
      assert.equal(web.DefaultCacheBehavior.ViewerProtocolPolicy, 'redirect-to-https');
      // Sign-in comes back to /auth/callback, which only the app's page can answer.
      assert.deepEqual(
        web.CustomErrorResponses.map((r: { ErrorCode: number; ResponseCode: number; ResponsePagePath: string }) => [r.ErrorCode, r.ResponseCode, r.ResponsePagePath]),
        [[403, 200, '/index.html'], [404, 200, '/index.html']],
      );
      // Only the app's own scripts run, with sql.js's WebAssembly, and it talks only to its API and sign-in.
      const policies = z.findResources('AWS::CloudFront::ResponseHeadersPolicy');
      const csp = policies[web.DefaultCacheBehavior.ResponseHeadersPolicyId.Ref].Properties.ResponseHeadersPolicyConfig.SecurityHeadersConfig.ContentSecurityPolicy;
      assert.ok(csp.Override);
      assert.match(csp.ContentSecurityPolicy, /script-src 'self' 'wasm-unsafe-eval';/);
      assert.ok(csp.ContentSecurityPolicy.includes(`connect-src 'self' https://api.${zone} https://auth.${zone};`));
      assert.match(csp.ContentSecurityPolicy, /frame-ancestors 'none'/);
      const [cert] = Object.values(z.findResources('AWS::CloudFormation::CustomResource', { Properties: { DomainName: zone, Region: 'us-east-1' } }));
      const [delegation] = Object.keys(z.findResources('Custom::CrossAccountZoneDelegation'));
      assert.ok(([] as string[]).concat(cert.DependsOn ?? []).includes(delegation));
      // The zone's own name, which Cognito needs to resolve, is the app.
      z.hasResourceProperties('AWS::Route53::RecordSet', { Name: `${zone}.`, Type: 'A', AliasTarget: Match.objectLike({}) });
      z.hasResourceProperties('AWS::Cognito::UserPoolClient', { ClientName: 'app', CallbackURLs: Match.arrayWith([`https://${zone}/auth/callback`]) });
      z.hasOutput('WebUrl', { Value: `https://${zone}` });
    });
  }

  it('has no release hosting without a zone', () => {
    t.resourceCountIs('AWS::S3::Bucket', 0);
    t.resourceCountIs('AWS::CloudFront::Distribution', 0);
  });
});

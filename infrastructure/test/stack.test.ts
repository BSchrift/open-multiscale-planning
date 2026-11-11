import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import { App } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { forEnv } from '@multiscale/config';
import { MultiscaleStack } from '../lib/stack.ts';
import type { Config, ControlConfig } from '../lib/config.ts';

const config: Config = {
  aws: { account: '111111111111', region: 'us-west-2', profile: 'test' },
  alarmEmail: 'alarms@example.com',
  auth: { cognitoDomainPrefix: 'multiscale-test', signInCallbackUrls: ['multiscale://auth/callback'] },
};
const control: ControlConfig = { aws: { account: '333333333333', region: 'us-west-2', profile: 'control' }, dns: { domain: 'example.net', hostedZoneId: 'Z0PARENTZONE' } };

function build(envName: 'staging' | 'prod' = 'staging', backendDist = '/nonexistent', requireBinaries = false, withConfig = config, canary?: 'skip', alarms?: 'off') {
  return new MultiscaleStack(new App(), `Multiscale-${envName}`, { envName, config: withConfig, control, backendDist, requireBinaries, canary, alarms });
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
// A stream mapping names its function as <name>:<alias>, from the alias's ARN.
const mappedTo = (mapping: Resource) => JSON.stringify(mapping.Properties.FunctionName).match(/"Ref":"(\w+)"/)?.[1];
const aliasOf = (functionPrefix: string) => {
  const hit = Object.keys(all).find((id) => id.startsWith(`${functionPrefix}Live`) && all[id].Type === 'AWS::Lambda::Alias');
  assert.ok(hit, `no alias for ${functionPrefix}`);
  return hit;
};

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

  it('has exactly the nine routes, the files ones whether or not the environment stores files', () => {
    const keys = ofType('AWS::ApiGatewayV2::Route').map(([, r]) => r.Properties.RouteKey).sort();
    assert.deepEqual(keys, [
      'GET /calendar/callback', 'GET /files/usage', 'POST /calendar/connect', 'POST /calendar/disconnect', 'POST /calendar/refresh',
      'POST /files/download', 'POST /files/upload', 'POST /sync', 'POST /v1/logs',
    ]);
  });

  it('protects every route with the JWT authorizer except the Google callback', () => {
    for (const key of ['POST /sync', 'POST /calendar/connect', 'POST /calendar/refresh', 'POST /calendar/disconnect', 'POST /v1/logs', 'POST /files/upload', 'POST /files/download', 'GET /files/usage']) {
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
  it('are exactly four arm64 Go functions', () => {
    const fns = ofType('AWS::Lambda::Function');
    assert.equal(fns.length, 4);
    for (const [, f] of fns) {
      assert.deepEqual(f.Properties.Architectures, ['arm64']);
      assert.equal(f.Properties.Runtime, 'provided.al2023');
      assert.equal(f.Properties.Handler, 'bootstrap');
    }
  });

  it('each has its own role', () => {
    const roles = new Set(ofType('AWS::Lambda::Function').map(([, f]) => f.Properties.Role['Fn::GetAtt'][0]));
    assert.equal(roles.size, 4);
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
    // The retention periods are built into the binaries, picked by ENV_NAME, so they aren't passed here.
    const retention = all[logicalId('Retention')].Properties.Environment.Variables;
    assert.ok(retention.TABLE_NAME);
    assert.equal(retention.ENV_NAME, 'staging');
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
        // The old image, for the sequence number of what TTL removed.
        StreamSpecification: { StreamViewType: 'OLD_IMAGE' },
        TimeToLiveSpecification: { AttributeName: 'expires_at', Enabled: true },
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
      Target: Match.objectLike({ Arn: { Ref: aliasOf('Calendar') } }),
    });
  });

  it('runs from the stream with a 60 second window, for its inputs only and not the record it writes itself', () => {
    const [, mapping] = ofType('AWS::Lambda::EventSourceMapping').find(([, m]) => mappedTo(m) === aliasOf('Calendar'))!;
    assert.equal(mapping.Properties.MaximumBatchingWindowInSeconds, 60);
    const pattern = JSON.parse(mapping.Properties.FilterCriteria.Filters[0].Pattern);
    // Events take their titles from tasks and practices, so renaming one is an input too.
    assert.deepEqual(pattern.dynamodb.Keys.sk.S, [
      { prefix: 'rec#time_block#' }, { prefix: 'rec#task#' }, { prefix: 'rec#practice#' }, { prefix: 'rec#calendar_source#' },
    ]);
    assert.ok(mapping.Properties.MaximumRetryAttempts <= 3, 'the next run fixes anything a failed one missed');
  });
});

describe('retention', () => {
  const mapping = (template: Template) => {
    const id = Object.entries(template.toJSON().Resources as Record<string, Resource>).find(([k, r]) => k.startsWith('RetentionLive') && r.Type === 'AWS::Lambda::Alias')![0];
    return Object.values(template.toJSON().Resources as Record<string, Resource>).find((r) => r.Type === 'AWS::Lambda::EventSourceMapping' && mappedTo(r) === id)!;
  };

  it("reads only TTL's removals from the stream, from as far back as it holds", () => {
    const m = mapping(t);
    assert.equal(m.Properties.StartingPosition, 'TRIM_HORIZON');
    assert.deepEqual(JSON.parse(m.Properties.FilterCriteria.Filters[0].Pattern), {
      eventName: ['REMOVE'],
      userIdentity: { type: ['Service'], principalId: ['dynamodb.amazonaws.com'] },
    });
  });

  it("runs staging's cleanup every 5 minutes, from retention.yaml, and prod has none", () => {
    t.hasResourceProperties('AWS::Scheduler::Schedule', {
      ScheduleExpression: 'rate(5 minutes)',
      Target: Match.objectLike({ Arn: { Ref: aliasOf('Retention') } }),
    });
    const prod = Template.fromStack(build('prod'));
    const prodSchedules = Object.values(prod.toJSON().Resources as Record<string, Resource>).filter((r) => r.Type === 'AWS::Scheduler::Schedule');
    // The worker's and the canary's.
    assert.deepEqual(prodSchedules.map((r) => r.Properties.ScheduleExpression).sort(), ['rate(30 minutes)', 'rate(5 minutes)']);
    assert.ok(mapping(prod));
  });

  it('may raise marks, and only on staging read the table and remove from it', () => {
    const dynamo = policyFor('Retention').flatMap((s) => s.Action).filter((a: string) => a.startsWith('dynamodb:') && !/Stream|Shard|GetRecords/.test(a));
    assert.deepEqual(dynamo.sort(), ['dynamodb:DeleteItem', 'dynamodb:Scan', 'dynamodb:UpdateItem']);
    const prod = Template.fromStack(build('prod')).toJSON().Resources as Record<string, Resource>;
    const role = (Object.entries(prod).find(([k, r]) => k.startsWith('Retention') && r.Type === 'AWS::Lambda::Function')![1].Properties.Role as any)['Fn::GetAtt'][0];
    const prodActions = Object.values(prod)
      .filter((r) => r.Type === 'AWS::IAM::Policy' && r.Properties.Roles.some((x: any) => x.Ref === role))
      .flatMap((r) => r.Properties.PolicyDocument.Statement.flatMap((st: any) => [st.Action].flat()))
      .filter((a: string) => a.startsWith('dynamodb:') && !/Stream|Shard|GetRecords/.test(a));
    assert.deepEqual(prodActions, ['dynamodb:UpdateItem']);
    assert.ok(!actions('Retention').some((a) => a.startsWith('ssm:')));
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

  it('Retention has no wildcard actions or a wildcard resource, except what the stream API needs', () => {
    for (const s of policyFor('Retention')) {
      for (const a of s.Action) assert.ok(!a.endsWith(':*') && a !== '*', a);
      if (s.Resource === '*') assert.deepEqual(s.Action, ['dynamodb:ListStreams']);
      else assert.doesNotMatch(JSON.stringify(s.Resource), /index/);
    }
  });

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

describe('the backend canary', () => {
  const functions = ['Api', 'Calendar', 'Retention'];
  // Staging's: its test load goes through the API, so a throttle there isn't a release's doing. Prod adds DynamoThrottles.
  const releaseAlarms = ['Api5xxRate', 'ApiLatency', 'LambdaErrors', 'CalendarFailures', 'RetentionBehind', 'CanaryFailures'];
  const prodReleaseAlarms = [...releaseAlarms, 'DynamoThrottles'];
  const resources = (template: Template) => template.toJSON().Resources as Record<string, Resource & { UpdatePolicy?: any }>;
  const groups = (template: Template) => Object.values(resources(template)).filter((r) => r.Type === 'AWS::CodeDeploy::DeploymentGroup');

  it('gives each function a live alias on its published version', () => {
    for (const fn of functions) {
      const alias = all[aliasOf(fn)];
      assert.equal(alias.Properties.Name, 'live');
      assert.deepEqual(alias.Properties.FunctionName, { Ref: logicalId(fn) });
      const version = alias.Properties.FunctionVersion['Fn::GetAtt'][0];
      assert.equal(all[version].Type, 'AWS::Lambda::Version');
    }
  });

  it('invokes every function through its alias, never $LATEST', () => {
    const [, integration] = ofType('AWS::ApiGatewayV2::Integration')[0];
    assert.deepEqual(integration.Properties.IntegrationUri, { Ref: aliasOf('Api') });
    for (const [id, schedule] of ofType('AWS::Scheduler::Schedule').filter(([id]) => !id.startsWith('CanarySchedule'))) {
      assert.ok([aliasOf('Calendar'), aliasOf('Retention')].includes(schedule.Properties.Target.Arn.Ref), `${id}: ${JSON.stringify(schedule.Properties.Target)}`);
    }
    const mapped = ofType('AWS::Lambda::EventSourceMapping').map(([, m]) => mappedTo(m)).sort();
    assert.deepEqual(mapped, [aliasOf('Calendar'), aliasOf('Retention')].sort());
    // The API starts the worker by this name, and may invoke only the alias.
    // By ARN, not the alias resource, which would make a loop through the alias's deployment group (cycles.test.ts).
    const calendarLive = { 'Fn::Join': ['', [{ 'Fn::GetAtt': [logicalId('Calendar'), 'Arn'] }, ':live']] };
    assert.deepEqual(all[logicalId('Api')].Properties.Environment.Variables.CALENDAR_FUNCTION_NAME, calendarLive);
    const invoke = policyFor('Api').filter((s) => s.Action.includes('lambda:InvokeFunction'));
    assert.deepEqual(invoke.flatMap((s) => [s.Resource].flat()), [calendarLive]);
  });

  it('keeps the stream mappings where they are, so they move to the alias in place rather than start over', () => {
    // A new mapping would read retention's stream from its start again, and both would run while the old one went.
    // Their ids from before the aliases.
    const ids = ofType('AWS::Lambda::EventSourceMapping').map(([id]) => id).sort();
    assert.deepEqual(ids, ['CalendarFunctionDynamoDBEventSourceMultiscalestagingTable7176ACF0553642AA', 'RetentionFunctionDynamoDBEventSourceMultiscalestagingTable7176ACF049B960A6']);
  });

  it('shifts each alias with CodeDeploy, and any release alarm rolls it back', () => {
    const found = groups(t);
    assert.equal(found.length, 3);
    const alarmIds = (group: Resource) => group.Properties.AlarmConfiguration.Alarms.map((a: any) => a.Name.Ref.replace(/[0-9A-F]{8}$/, '')).sort();
    for (const group of found) {
      assert.equal(group.Properties.AlarmConfiguration.Enabled, true);
      assert.deepEqual(alarmIds(group), [...releaseAlarms].sort());
      assert.equal(group.Properties.AutoRollbackConfiguration.Enabled, true);
      assert.deepEqual([...group.Properties.AutoRollbackConfiguration.Events].sort(), ['DEPLOYMENT_FAILURE', 'DEPLOYMENT_STOP_ON_ALARM', 'DEPLOYMENT_STOP_ON_REQUEST']);
    }
    for (const fn of functions) {
      const policy = (all[aliasOf(fn)] as any).UpdatePolicy.CodeDeployLambdaAliasUpdate;
      assert.ok(policy.DeploymentGroupName.Ref.startsWith(`${fn}Deployment`), JSON.stringify(policy));
    }
  });

  const canaryOf = (template: Template) => {
    const configs = Object.entries(resources(template)).filter(([, r]) => r.Type === 'AWS::CodeDeploy::DeploymentConfig');
    assert.equal(configs.length, 1);
    const [[id, config]] = configs;
    return { id, routing: config.Properties.TrafficRoutingConfig };
  };

  it("canaries 5% for 10 minutes on staging, so a release there is quick to test", () => {
    const { id, routing } = canaryOf(t);
    assert.deepEqual(routing, { Type: 'TimeBasedCanary', TimeBasedCanary: { CanaryPercentage: 5, CanaryInterval: 10 } });
    for (const group of groups(t)) assert.deepEqual(group.Properties.DeploymentConfigName, { Ref: id });
  });

  it('canaries 5% for a day on prod', () => {
    const prod = Template.fromStack(build('prod'));
    const { id, routing } = canaryOf(prod);
    assert.deepEqual(routing, { Type: 'TimeBasedCanary', TimeBasedCanary: { CanaryPercentage: 10, CanaryInterval: 90 } });
    for (const group of groups(prod)) assert.deepEqual(group.Properties.DeploymentConfigName, { Ref: id });
  });

  it('skips the canary when asked, sending all traffic at once, and keeps the alarms and rollback', () => {
    const skipped = Template.fromStack(build('prod', '/nonexistent', false, config, 'skip'));
    // The canary's config stays, so the next release goes back to it without making a new one.
    canaryOf(skipped);
    for (const group of groups(skipped)) {
      assert.equal(group.Properties.DeploymentConfigName, 'CodeDeployDefault.LambdaAllAtOnce');
      assert.equal(group.Properties.AlarmConfiguration.Alarms.length, prodReleaseAlarms.length);
      assert.equal(group.Properties.AutoRollbackConfiguration.Enabled, true);
    }
  });

  const alarmNames = (group: Resource) => (group.Properties.AlarmConfiguration?.Alarms ?? []).map((a: any) => a.Name.Ref.replace(/[0-9A-F]{8}$/, '')).sort();

  it('counts DynamoDB throttles as a release alarm on prod, and not on staging, where test load can throttle', () => {
    for (const group of groups(Template.fromStack(build('prod')))) assert.deepEqual(alarmNames(group), [...prodReleaseAlarms].sort());
    for (const group of groups(t)) assert.ok(!alarmNames(group).includes('DynamoThrottles'));
    // Staging still emails it.
    const [, throttles] = ofType('AWS::CloudWatch::Alarm').find(([id]) => id.startsWith('DynamoThrottles'))!;
    const [[topicId]] = ofType('AWS::SNS::Topic');
    assert.deepEqual(throttles.Properties.AlarmActions, [{ Ref: topicId }]);
  });

  it("names the release alarms in an output for the pipeline's bake check, alarms off or not", () => {
    for (const [envName, alarms, expected] of [['staging', undefined, releaseAlarms], ['prod', undefined, prodReleaseAlarms], ['prod', 'off', prodReleaseAlarms]] as const) {
      const template = Template.fromStack(build(envName, '/nonexistent', false, config, undefined, alarms)).toJSON();
      const named = [...JSON.stringify(template.Outputs.ReleaseAlarms.Value).matchAll(/"Ref":"(\w+?)[0-9A-F]{8}"/g)].map(([, id]) => id).sort();
      assert.deepEqual(named, [...expected].sort());
    }
  });

  it('turns the release alarms off for one release when asked, keeping rollback on a failed deployment or check', () => {
    for (const envName of ['staging', 'prod'] as const) {
      const off = Template.fromStack(build(envName, '/nonexistent', false, config, undefined, 'off'));
      for (const group of groups(off)) {
        // CodeDeploy then doesn't refuse to start for an alarm already firing, nor stop on one.
        assert.equal(group.Properties.AlarmConfiguration.Enabled, false);
        assert.deepEqual(group.Properties.AlarmConfiguration.Alarms, []);
        assert.equal(group.Properties.AutoRollbackConfiguration.Enabled, true);
        assert.deepEqual([...group.Properties.AutoRollbackConfiguration.Events].sort(), ['DEPLOYMENT_FAILURE', 'DEPLOYMENT_STOP_ON_REQUEST']);
      }
      // The pre-traffic check stays, and the alarms themselves still email.
      assert.ok((Object.values(resources(off)).find((r) => r.Type === 'AWS::Lambda::Alias' && (r as any).UpdatePolicy?.CodeDeployLambdaAliasUpdate?.BeforeAllowTrafficHook)));
      assert.equal(Object.values(resources(off)).filter((r) => r.Type === 'AWS::CloudWatch::Alarm').length, ofType('AWS::CloudWatch::Alarm').length);
      // The next release without the switch sets them back, explicitly, so CloudFormation turns them on again.
      const next = Template.fromStack(build(envName));
      for (const group of groups(next)) {
        assert.equal(group.Properties.AlarmConfiguration.Enabled, true);
        assert.deepEqual(alarmNames(group), envName === 'prod' ? [...prodReleaseAlarms].sort() : [...releaseAlarms].sort());
        assert.ok(group.Properties.AutoRollbackConfiguration.Events.includes('DEPLOYMENT_STOP_ON_ALARM'));
      }
    }
  });

  const alarmProps = (name: string) => ofType('AWS::CloudWatch::Alarm').find(([id]) => id.startsWith(name))![1].Properties;

  it("alarms when the API's p99 latency stays at 10 seconds or more for 10 minutes", () => {
    const latency = alarmProps('ApiLatency');
    assert.equal(latency.ExtendedStatistic, 'p99');
    assert.equal(latency.MetricName, 'Latency');
    assert.equal(latency.Threshold, 10_000);
    assert.equal(latency.EvaluationPeriods, 2);
    assert.equal(latency.Period, 300);
  });

  // The canary names the API's alias by its ARN, since the alias waits for the canary to be updated.
  const aliasArn = { 'Fn::Join': ['', [{ 'Fn::GetAtt': ['ApiFunctionCE271BD4', 'Arn'] }, ':live']] };

  it('checks a new API version alone before it takes traffic, and only the API', () => {
    const hooks = Object.fromEntries(functions.map((fn) => [fn, (all[aliasOf(fn)] as any).UpdatePolicy.CodeDeployLambdaAliasUpdate.BeforeAllowTrafficHook]));
    assert.deepEqual(hooks.Api, { Ref: logicalId('Canary') });
    assert.equal(hooks.Calendar, undefined);
    assert.equal(hooks.Retention, undefined);
    // It names the version being deployed, so CloudFormation updates it before moving the alias.
    const env = all[logicalId('Canary')].Properties.Environment.Variables;
    const version = all[aliasOf('Api')].Properties.FunctionVersion['Fn::GetAtt'][0];
    assert.deepEqual(env.API_VERSION, { Ref: version });
    assert.deepEqual(env.API_ALIAS, aliasArn);
    assert.ok([(all[aliasOf('Api')] as any).DependsOn].flat().includes(logicalId('Canary')));
  });

  it('runs the canary against the live alias every 5 minutes, once each, since a retry would likely reach the old version', () => {
    t.hasResourceProperties('AWS::Scheduler::Schedule', {
      ScheduleExpression: 'rate(5 minutes)',
      Target: Match.objectLike({ Arn: { 'Fn::GetAtt': [logicalId('Canary'), 'Arn'] } }),
    });
    t.hasResourceProperties('AWS::Lambda::EventInvokeConfig', { FunctionName: { Ref: logicalId('Canary') }, MaximumRetryAttempts: 0 });
  });

  it('lets the canary invoke only the API, any version or alias of it, and tell CodeDeploy how the check went', () => {
    const statements = policyFor('Canary');
    const invoke = statements.filter((s) => s.Action.includes('lambda:InvokeFunction')).flatMap((s) => [s.Resource].flat());
    // Every version by one pattern, so the grant is the same each release and no deploy changes it just before the
    // hook runs: IAM takes a while to apply a change.
    assert.deepEqual(invoke, [{ 'Fn::Join': ['', [{ 'Fn::GetAtt': [logicalId('Api'), 'Arn'] }, ':*']] }]);
    const prod = Template.fromStack(build('prod')).toJSON().Resources as Record<string, Resource>;
    const canaryPolicyOf = (resources: Record<string, Resource>) => JSON.stringify(Object.entries(resources)
      .filter(([id, r]) => r.Type === 'AWS::IAM::Policy' && id.startsWith('CanaryFunctionServiceRoleDefaultPolicy'))
      .map(([, r]) => r.Properties.PolicyDocument));
    // The same with another build of the API, as a release has.
    const built = mkdtempSync(join(tmpdir(), 'dist-'));
    for (const name of ['api', 'calendar', 'retention', 'canary']) {
      mkdirSync(join(built, name));
      writeFileSync(join(built, name, 'bootstrap'), `${name} as released`);
    }
    const released = Template.fromStack(build('staging', built, true)).toJSON().Resources as Record<string, Resource>;
    assert.notDeepEqual(released[aliasOf('Api')].Properties.FunctionVersion, all[aliasOf('Api')].Properties.FunctionVersion);
    assert.equal(canaryPolicyOf(released), canaryPolicyOf(all));
    assert.ok(canaryPolicyOf(prod).includes(':*'));
    assert.deepEqual(statements.flatMap((s) => s.Action).filter((a) => !a.startsWith('lambda:') && !a.startsWith('logs:')).sort(), ['codedeploy:PutLifecycleEventHookExecutionStatus']);
    assert.ok(!statements.some((s) => s.Action.some((a: string) => a.startsWith('dynamodb:') || a.startsWith('ssm:'))));
  });

  it("names the API's hook so CodeDeploy's managed policy already lets its role invoke it", () => {
    // AWSCodeDeployRoleForLambdaLimited allows lambda:InvokeFunction on function:CodeDeployHook_* and nothing else, so a
    // grant made in the same deploy as the hook would race IAM.
    const hook = (all[aliasOf('Api')] as any).UpdatePolicy.CodeDeployLambdaAliasUpdate.BeforeAllowTrafficHook;
    assert.match(all[hook.Ref].Properties.FunctionName, /^CodeDeployHook_/);
    const [group] = ofType('AWS::CodeDeploy::DeploymentGroup').filter(([id]) => id.startsWith('ApiDeployment'));
    const role = all[group[1].Properties.ServiceRoleArn['Fn::GetAtt'][0]];
    assert.deepEqual(role.Properties.ManagedPolicyArns, [{ 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':iam::aws:policy/service-role/AWSCodeDeployRoleForLambdaLimited']] }]);
  });

  it("moves each alias only once its deployment group's role and that role's policies are in place", () => {
    for (const fn of functions) {
      const [, group] = ofType('AWS::CodeDeploy::DeploymentGroup').find(([id]) => id.startsWith(`${fn}Deployment`))!;
      const roleId = group.Properties.ServiceRoleArn['Fn::GetAtt'][0];
      const policies = ofType('AWS::IAM::Policy').filter(([, p]) => p.Properties.Roles.some((r: any) => r.Ref === roleId)).map(([id]) => id);
      const dependsOn = [(all[aliasOf(fn)] as any).DependsOn ?? []].flat();
      for (const id of [roleId, ...policies]) assert.ok(dependsOn.includes(id), `${fn}'s alias doesn't wait for ${id}: ${dependsOn}`);
    }
  });

  it('alarms on one failed canary run, since a new version gets about one run in 20', () => {
    const failures = alarmProps('CanaryFailures');
    assert.equal(failures.Threshold, 1);
    assert.equal(failures.EvaluationPeriods, 1);
    assert.deepEqual(failures.Dimensions, [{ Name: 'FunctionName', Value: 'CodeDeployHook_multiscale-staging-canary' }]);
    assert.equal(all[logicalId('Canary')].Properties.FunctionName, 'CodeDeployHook_multiscale-staging-canary');
  });

  it('alarms when the retention consumer falls an hour behind the stream', () => {
    const behind = alarmProps('RetentionBehind');
    assert.equal(behind.MetricName, 'IteratorAge');
    assert.equal(behind.Statistic, 'Maximum');
    assert.equal(behind.Threshold, 3_600_000);
    assert.deepEqual(behind.Dimensions, [{ Name: 'FunctionName', Value: { Ref: logicalId('Retention') } }]);
  });
});

describe('observability', () => {
  it('sets 30-day retention on all five log groups, and every function uses its own', () => {
    const groups = ofType('AWS::Logs::LogGroup');
    assert.equal(groups.length, 5);
    for (const [, g] of groups) assert.equal(g.Properties.RetentionInDays, 30);
    for (const [, f] of ofType('AWS::Lambda::Function')) assert.ok(f.Properties.LoggingConfig.LogGroup);
  });

  it('has exactly nine alarms, all sent to one topic that emails the configured address', () => {
    const alarms = ofType('AWS::CloudWatch::Alarm');
    assert.equal(alarms.length, 9);
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

  it('Lambda errors alarm covers every function', () => {
    const body = JSON.stringify(alarm('LambdaErrors').Metrics);
    for (const fn of ['Api', 'Calendar', 'Retention']) assert.ok(body.includes(logicalId(fn)), fn);
  });

  it("throttle alarm counts only the API's own operations, not the cleanup's scan and deletes", () => {
    const metrics = alarm('DynamoThrottles').Metrics as any[];
    const operations = metrics.filter((m) => m.MetricStat).map((m) => {
      assert.equal(m.MetricStat.Metric.MetricName, 'ThrottledRequests');
      return m.MetricStat.Metric.Dimensions.find((d: any) => d.Name === 'Operation').Value;
    });
    // What the API and the worker call, through the store: the sync's reads and its transaction, and the consent state.
    assert.deepEqual(operations.sort(), ['BatchGetItem', 'PutItem', 'Query', 'TransactWriteItems', 'UpdateItem']);
    const [expression] = metrics.filter((m) => m.Expression);
    for (const m of metrics.filter((x) => x.MetricStat)) assert.ok(expression.Expression.includes(`FILL(${m.Id}, 0)`), expression.Expression);
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
  it("takes each stack's settings from config/env", () => {
    assert.equal(forEnv('prod').stack.terminationProtection, true);
    assert.equal(build('staging').terminationProtection, forEnv('staging').stack.terminationProtection);
    assert.throws(() => forEnv('dev'), /No environment "dev" in config\/env/);
  });

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
    for (const name of ['api', 'calendar', 'retention', 'canary']) {
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
      // Only the app's own scripts run, with SQLite's WebAssembly, and it talks only to its API and sign-in.
      const policies = z.findResources('AWS::CloudFront::ResponseHeadersPolicy');
      const csp = policies[web.DefaultCacheBehavior.ResponseHeadersPolicyId.Ref].Properties.ResponseHeadersPolicyConfig.SecurityHeadersConfig.ContentSecurityPolicy;
      assert.ok(csp.Override);
      assert.match(csp.ContentSecurityPolicy, /script-src 'self' 'wasm-unsafe-eval';/);
      // The database runs in a worker from the app's own files, which script-src allows while nothing narrower is set.
      assert.doesNotMatch(csp.ContentSecurityPolicy, /worker-src|child-src/);
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

describe('release role', () => {
  const withPipeline = (envName: 'staging' | 'prod', zone?: string) => {
    const app = new App();
    const stack = new MultiscaleStack(app, `Multiscale-${envName}`, {
      envName, config: { ...config, ...(zone ? { dns: { zone } } : {}) }, control, backendDist: '/nonexistent', requireBinaries: false, pipelineAccount: '333333333333',
    });
    return Template.fromStack(stack).toJSON().Resources as Record<string, Resource>;
  };
  const roleOf = (resources: Record<string, Resource>) => Object.entries(resources).find(([, r]) => r.Type === 'AWS::IAM::Role' && r.Properties.RoleName === 'multiscale-release');

  it("is there only when control.yaml sets up the pipeline, and the environment has somewhere to release to", () => {
    assert.equal(roleOf(all), undefined);
    assert.equal(roleOf(withPipeline('staging')), undefined);
    assert.ok(roleOf(withPipeline('staging', 'staging.example.net')));
  });

  it("trusts only the pipeline's build role, in the control account", () => {
    const [, role] = roleOf(withPipeline('prod', 'app.example.net'))!;
    const [statement] = role.Properties.AssumeRolePolicyDocument.Statement;
    assert.equal(statement.Action, 'sts:AssumeRole');
    assert.deepEqual(statement.Principal, { AWS: { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':iam::333333333333:root']] } });
    assert.deepEqual(statement.Condition, { ArnEquals: { 'aws:PrincipalArn': { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':iam::333333333333:role/multiscale-pipeline']] } } });
  });

  it("may read the test users' passwords, logs, metrics, alarms and outputs, and write the release bucket, and nothing else", () => {
    const resources = withPipeline('prod', 'app.example.net');
    const [roleId] = roleOf(resources)!;
    const statements = Object.values(resources)
      .filter((r) => r.Type === 'AWS::IAM::Policy' && r.Properties.Roles.some((x: any) => x.Ref === roleId))
      .flatMap((p) => p.Properties.PolicyDocument.Statement as any[]);
    const actionsOf = statements.flatMap((s) => [s.Action].flat()).sort();
    assert.deepEqual(actionsOf.filter((a) => !a.startsWith('s3:')), ['cloudformation:DescribeStacks', 'cloudwatch:DescribeAlarms', 'cloudwatch:GetMetricStatistics', 'logs:FilterLogEvents', 'ssm:GetParameter']);
    const ssm = statements.find((s) => s.Action === 'ssm:GetParameter');
    assert.match(JSON.stringify(ssm.Resource), /parameter\/multiscale\/prod\/\*-user-password"/);
    assert.ok(!actionsOf.some((a) => a.startsWith('dynamodb:') || a.startsWith('lambda:') || a === '*'));
    const bucket = statements.filter((s) => [s.Action].flat().some((a: string) => a.startsWith('s3:'))).flatMap((s) => [s.Resource].flat());
    assert.ok(bucket.every((r: any) => JSON.stringify(r).includes('Releases')), JSON.stringify(bucket));
  });
});

describe('attachments', () => {
  const publicKey = () => generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }) as string;
  // Two keys, as during a rotation: both trusted, the API signing with the newer.
  const keys = { k1: publicKey(), k2: publicKey() };
  const zone = 'staging.example.net';
  const withFiles = (envName: 'staging' | 'prod', zoned: boolean, pipelineAccount?: string) => {
    const filesConfig: Config = {
      ...config,
      auth: { ...config.auth, signInCallbackUrls: [...config.auth.signInCallbackUrls, 'http://localhost:5199/auth/callback'] },
      ...(zoned ? { dns: { zone } } : {}),
      files: { keys, signWith: 'k2' },
    };
    const stack = new MultiscaleStack(new App(), `Multiscale-${envName}`, { envName, config: filesConfig, control, backendDist: '/nonexistent', requireBinaries: false, pipelineAccount });
    return Template.fromStack(stack);
  };
  const resourcesOf = (template: Template) => template.toJSON().Resources as Record<string, Resource>;
  const idOf = (resources: Record<string, Resource>, type: string, prefix: string) => {
    const hit = Object.keys(resources).find((id) => id.startsWith(prefix) && resources[id].Type === type);
    assert.ok(hit, `no ${type} ${prefix}`);
    return hit;
  };
  const roleOf = (resources: Record<string, Resource>, functionPrefix: string) =>
    (resources[idOf(resources, 'AWS::Lambda::Function', functionPrefix)].Properties.Role as any)['Fn::GetAtt'][0];
  const statementsOf = (resources: Record<string, Resource>, role: string) => Object.values(resources)
    .filter((r) => r.Type === 'AWS::IAM::Policy' && r.Properties.Roles.some((x: any) => x.Ref === role))
    .flatMap((p) => p.Properties.PolicyDocument.Statement as any[])
    .map((s) => ({ ...s, Action: [s.Action].flat() as string[] }));
  const policyIn = (resources: Record<string, Resource>, functionPrefix: string) => statementsOf(resources, roleOf(resources, functionPrefix));
  const underU = (bucket: string) => ({ 'Fn::Join': ['', [{ 'Fn::GetAtt': [bucket, 'Arn'] }, '/u/*']] });

  let z: Template;
  let zr: Record<string, Resource>;
  let bare: Template;
  let bucket: string;
  let distribution: any;
  before(() => {
    z = withFiles('staging', true);
    zr = resourcesOf(z);
    bare = withFiles('staging', false);
    bucket = idOf(zr, 'AWS::S3::Bucket', 'Files');
    distribution = Object.values(zr)
      .filter((r) => r.Type === 'AWS::CloudFront::Distribution')
      .map((r) => r.Properties.DistributionConfig)
      .find((d) => d.Aliases.includes(`files.${zone}`));
  });

  it('keeps files in a private bucket: no public access, encrypted, HTTPS only, no versions, kept with the stack gone', () => {
    const b = zr[bucket];
    assert.deepEqual(b.Properties.PublicAccessBlockConfiguration, { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true });
    assert.deepEqual(b.Properties.BucketEncryption.ServerSideEncryptionConfiguration, [{ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }]);
    // A delete is final: the record decides when a file goes.
    assert.equal(b.Properties.VersioningConfiguration, undefined);
    assert.equal(b.DeletionPolicy, 'Retain');
  });

  it('has one lifecycle rule, aborting uploads left unfinished for a day, and no expiry or move to another class', () => {
    assert.deepEqual(zr[bucket].Properties.LifecycleConfiguration.Rules, [{ AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 }, Status: 'Enabled' }]);
  });

  it('lets only the files distribution read the bucket, through origin access control, and refuses plain HTTP', () => {
    const [policy] = Object.values(zr).filter((r) => r.Type === 'AWS::S3::BucketPolicy' && r.Properties.Bucket.Ref === bucket);
    const statements = policy.Properties.PolicyDocument.Statement as any[];
    const allows = statements.filter((s) => s.Effect === 'Allow');
    assert.equal(allows.length, 1, JSON.stringify(allows));
    assert.equal(allows[0].Action, 's3:GetObject');
    assert.deepEqual(allows[0].Principal, { Service: 'cloudfront.amazonaws.com' });
    const filesDistribution = idOf(zr, 'AWS::CloudFront::Distribution', 'FilesDistribution');
    assert.match(JSON.stringify(allows[0].Condition.StringEquals['AWS:SourceArn']), new RegExp(`"Ref":"${filesDistribution}"`));
    const denies = statements.filter((s) => s.Effect === 'Deny');
    assert.equal(denies.length, 1);
    assert.deepEqual(denies[0].Condition, { Bool: { 'aws:SecureTransport': 'false' } });
  });

  it("takes uploads, and answers downloads' CORS, only from the apps' own origins", () => {
    const origins = ['multiscale-app://app', 'capacitor://localhost', 'http://localhost:5199'];
    for (const [template, expected] of [[z, [`https://${zone}`, ...origins]], [bare, origins]] as const) {
      const [rule] = resourcesOf(template)[idOf(resourcesOf(template), 'AWS::S3::Bucket', 'Files')].Properties.CorsConfiguration.CorsRules;
      assert.deepEqual(rule, {
        AllowedMethods: ['PUT', 'GET', 'HEAD'],
        AllowedOrigins: expected,
        AllowedHeaders: ['content-type', 'content-disposition', 'x-amz-checksum-sha256'],
        MaxAge: 86400,
      });
    }
  });

  it(`serves files on files.${zone} only to requests signed by a trusted key, with Origin in the cache key`, () => {
    const behaviour = distribution.DefaultCacheBehavior;
    assert.deepEqual(behaviour.TrustedKeyGroups, [{ Ref: idOf(zr, 'AWS::CloudFront::KeyGroup', 'FilesKeys') }]);
    assert.equal(behaviour.ViewerProtocolPolicy, 'redirect-to-https');
    assert.deepEqual(behaviour.AllowedMethods, ['GET', 'HEAD']);
    assert.ok(distribution.Origins[0].OriginAccessControlId);
    assert.ok(!distribution.Origins[0].OriginPath);
    const policy = zr[behaviour.CachePolicyId.Ref].Properties.CachePolicyConfig;
    assert.deepEqual(policy.ParametersInCacheKeyAndForwardedToOrigin.HeadersConfig, { HeaderBehavior: 'whitelist', Headers: ['Origin'] });
    assert.equal(distribution.PriceClass, 'PriceClass_100');
    // CloudFront only takes us-east-1 certificates, validated once the zone is delegated.
    const [cert] = Object.values(z.findResources('AWS::CloudFormation::CustomResource', { Properties: { DomainName: `files.${zone}`, Region: 'us-east-1' } }));
    const [delegation] = Object.keys(z.findResources('Custom::CrossAccountZoneDelegation'));
    assert.ok(([] as string[]).concat(cert.DependsOn ?? []).includes(delegation));
    z.hasResourceProperties('AWS::Route53::RecordSet', { Name: `files.${zone}.`, Type: 'A', AliasTarget: Match.objectLike({}) });
  });

  it('runs nothing at the edge: no Lambda@Edge, no functions, no WAF, and nothing a file holds can run', () => {
    for (const template of [z, bare]) {
      for (const d of Object.values(template.findResources('AWS::CloudFront::Distribution')).map((r) => r.Properties.DistributionConfig)) {
        assert.equal(d.DefaultCacheBehavior.LambdaFunctionAssociations, undefined);
        assert.equal(d.DefaultCacheBehavior.FunctionAssociations, undefined);
        assert.equal(d.WebACLId, undefined);
      }
      assert.equal(Object.values(resourcesOf(template)).filter((r) => r.Type.startsWith('AWS::WAFv2::') || r.Type === 'AWS::CloudFront::Function').length, 0);
    }
    const headers = zr[distribution.DefaultCacheBehavior.ResponseHeadersPolicyId.Ref].Properties.ResponseHeadersPolicyConfig.SecurityHeadersConfig;
    assert.deepEqual(headers.ContentTypeOptions, { Override: true });
    assert.deepEqual(headers.ContentSecurityPolicy, { ContentSecurityPolicy: "default-src 'none'; sandbox", Override: true });
  });

  it('trusts every configured public key, and the API signs with the one signWith names', () => {
    const publicKeys = Object.entries(zr).filter(([, r]) => r.Type === 'AWS::CloudFront::PublicKey');
    assert.deepEqual(publicKeys.map(([, r]) => r.Properties.PublicKeyConfig.EncodedKey).sort(), [keys.k1, keys.k2].sort());
    const group = zr[idOf(zr, 'AWS::CloudFront::KeyGroup', 'FilesKeys')].Properties.KeyGroupConfig;
    assert.deepEqual(group.Items.map((item: any) => item.Ref).sort(), publicKeys.map(([id]) => id).sort());
    const signer = publicKeys.find(([, r]) => r.Properties.PublicKeyConfig.EncodedKey === keys.k2)![0];
    const env = zr[idOf(zr, 'AWS::Lambda::Function', 'ApiFunction')].Properties.Environment.Variables;
    assert.deepEqual(env.FILES_KEY_ID, { Ref: signer });
    assert.equal(env.FILES_KEY_PARAM, '/multiscale/staging/files/k2');
  });

  it('tells the API where uploads go and where files are served, and retention which bucket to delete from', () => {
    const upload = { 'Fn::Join': ['', ['https://', { 'Fn::GetAtt': [bucket, 'RegionalDomainName'] }]] };
    const api = zr[idOf(zr, 'AWS::Lambda::Function', 'ApiFunction')].Properties.Environment.Variables;
    assert.deepEqual(api.FILES_UPLOAD_URL, upload);
    assert.equal(api.FILES_URL, `https://files.${zone}`);
    assert.deepEqual(zr[idOf(zr, 'AWS::Lambda::Function', 'RetentionFunction')].Properties.Environment.Variables.FILES_BUCKET, { Ref: bucket });
    z.hasOutput('FilesUrl', { Value: `https://files.${zone}` });
    z.hasOutput('FilesUploadUrl', { Value: upload });
    // Without a zone, the distribution's own name.
    const br = resourcesOf(bare);
    const bareDistribution = idOf(br, 'AWS::CloudFront::Distribution', 'FilesDistribution');
    const own = { 'Fn::Join': ['', ['https://', { 'Fn::GetAtt': [bareDistribution, 'DomainName'] }]] };
    assert.deepEqual(br[idOf(br, 'AWS::Lambda::Function', 'ApiFunction')].Properties.Environment.Variables.FILES_URL, own);
    bare.hasOutput('FilesUrl', { Value: own });
    assert.equal(br[bareDistribution].Properties.DistributionConfig.Aliases, undefined);
  });

  it('lets the API presign uploads only into u/, and read only the key it signs with beside the Google secrets', () => {
    const api = policyIn(zr, 'Api');
    const s3 = api.filter((s) => s.Action.some((a: string) => a.startsWith('s3:')));
    assert.deepEqual(s3.map((s) => [s.Action, s.Resource]), [[['s3:PutObject'], underU(bucket)]]);
    const get = api.filter((s) => s.Action.includes('ssm:GetParameter'));
    assert.equal(get.length, 2);
    const files = get.find((s) => JSON.stringify(s.Resource).includes('/files/'))!;
    assert.deepEqual(files.Action, ['ssm:GetParameter']);
    assert.match(JSON.stringify(files.Resource), /:parameter\/multiscale\/staging\/files\/k2"\]\]\}$/);
    assert.match(JSON.stringify(get.find((s) => s !== files)!.Resource), /google\/\*"/);
  });

  it('lets retention delete only files under u/, and read and remove what the API keeps about them', () => {
    const retention = policyIn(zr, 'Retention');
    const s3 = retention.filter((s) => s.Action.some((a: string) => a.startsWith('s3:')));
    assert.deepEqual(s3.map((s) => [s.Action, s.Resource]), [[['s3:DeleteObject'], underU(bucket)]]);
    const dynamo = (statements: any[]) => statements.flatMap((s) => s.Action).filter((a: string) => a.startsWith('dynamodb:') && !/Stream|Shard|GetRecords/.test(a)).sort();
    assert.deepEqual(dynamo(retention), ['dynamodb:DeleteItem', 'dynamodb:GetItem', 'dynamodb:Scan', 'dynamodb:UpdateItem']);
    const prod = resourcesOf(withFiles('prod', true));
    assert.deepEqual(dynamo(policyIn(prod, 'Retention')), ['dynamodb:DeleteItem', 'dynamodb:GetItem', 'dynamodb:UpdateItem']);
  });

  it('gives no other role any access to the files bucket', () => {
    const resources = resourcesOf(withFiles('staging', true, '333333333333'));
    const files = idOf(resources, 'AWS::S3::Bucket', 'Files');
    const allowed = new Set([roleOf(resources, 'Api'), roleOf(resources, 'Retention')]);
    const naming = Object.values(resources)
      .filter((r) => r.Type === 'AWS::IAM::Policy' && JSON.stringify(r.Properties.PolicyDocument).includes(`"${files}"`))
      .flatMap((r) => r.Properties.Roles.map((x: any) => x.Ref));
    assert.deepEqual(new Set(naming), allowed);
    for (const r of Object.values(resources).filter((r) => r.Type === 'AWS::IAM::Role')) {
      assert.doesNotMatch(JSON.stringify(r.Properties.Policies ?? []), new RegExp(`"${files}"`));
    }
  });

  it("adds the files host and the bucket to the web app's connect-src, and blob: images", () => {
    const web = Object.values(zr).filter((r) => r.Type === 'AWS::CloudFront::Distribution').map((r) => r.Properties.DistributionConfig).find((d) => d.Aliases.includes(zone));
    const csp = JSON.stringify(zr[web.DefaultCacheBehavior.ResponseHeadersPolicyId.Ref].Properties.ResponseHeadersPolicyConfig.SecurityHeadersConfig.ContentSecurityPolicy);
    assert.ok(csp.includes(`connect-src 'self' https://api.${zone} https://auth.${zone} https://files.${zone} https://"`), csp);
    assert.ok(csp.includes(`{"Fn::GetAtt":["${bucket}","RegionalDomainName"]}`), csp);
    assert.ok(csp.includes("img-src 'self' data: blob:"), csp);
  });

  it('has none of it until the environment sets files', () => {
    for (const type of ['AWS::CloudFront::KeyGroup', 'AWS::CloudFront::PublicKey', 'AWS::CloudFront::Distribution', 'AWS::S3::Bucket']) t.resourceCountIs(type, 0);
    for (const fn of ['Api', 'Retention']) assert.ok(!actions(fn).some((a) => a.startsWith('s3:')), fn);
    const variables = ofType('AWS::Lambda::Function').flatMap(([, r]) => Object.keys(r.Properties.Environment?.Variables ?? {}));
    assert.ok(!variables.some((name) => name.startsWith('FILES_')));
    assert.ok(!Object.keys(t.toJSON().Outputs).some((name) => name.startsWith('Files')));
  });
});

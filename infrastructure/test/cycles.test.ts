// CloudFormation refuses a template whose resources depend on each other in a loop, and only says so when it makes the
// change set. CDK's own check misses some of the edges CloudFormation counts, such as a reference in an alias's
// UpdatePolicy to its CodeDeploy deployment group, so this walks every reference in each resource.

import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { describe, it } from 'node:test';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { MultiscaleStack } from '../lib/stack.ts';
import type { Config, ControlConfig, EnvName } from '../lib/config.ts';

type Resources = Record<string, Record<string, unknown>>;

/** The resources each resource refers to: Ref, Fn::GetAtt, Fn::Sub and DependsOn, anywhere in it but its Metadata. */
function edges(resources: Resources): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();
  for (const [id, resource] of Object.entries(resources)) {
    const to = new Set<string>();
    const add = (target: unknown) => {
      if (typeof target === 'string' && target in resources && target !== id) to.add(target);
    };
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) return value.forEach(walk);
      if (value === null || typeof value !== 'object') return;
      for (const [key, inner] of Object.entries(value)) {
        if (key === 'Ref') add(inner);
        else if (key === 'Fn::GetAtt') add(Array.isArray(inner) ? inner[0] : String(inner).split('.')[0]);
        else if (key === 'Fn::Sub') {
          const text = Array.isArray(inner) ? inner[0] : inner;
          for (const [, name] of String(text).matchAll(/\$\{([^}.!]+)(?:\.[^}]*)?\}/g)) add(name);
          if (Array.isArray(inner)) walk(inner[1]);
        }
        walk(inner);
      }
    };
    for (const [key, value] of Object.entries(resource)) {
      if (key === 'Metadata') continue;
      if (key === 'DependsOn') [value].flat().forEach(add);
      else walk(value);
    }
    graph.set(id, to);
  }
  return graph;
}

/** Each loop in the graph, as the resources in it, by Tarjan's strongly connected components. */
function cycles(resources: Resources): string[][] {
  const graph = edges(resources);
  let next = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const found: string[][] = [];
  const visit = (v: string) => {
    index.set(v, next);
    low.set(v, next++);
    stack.push(v);
    onStack.add(v);
    for (const w of graph.get(v)!) {
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, index.get(w)!));
      }
    }
    if (low.get(v) === index.get(v)) {
      const component: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      if (component.length > 1) found.push(component.sort());
    }
  };
  for (const v of graph.keys()) if (!index.has(v)) visit(v);
  return found;
}

const control: ControlConfig = { aws: { account: '333333333333', region: 'us-west-2', profile: 'control' }, dns: { domain: 'example.net', hostedZoneId: 'Z0PARENTZONE' } };
// Shaped like the real ones: each with its own zone, so release hosting and the web app are there, attachments' storage,
// whose key the API names, and staging with retention's cleanup schedule.
const filesKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }) as string;
const shaped = (envName: EnvName, zone: string): Config => ({
  aws: { account: envName === 'staging' ? '111111111111' : '222222222222', region: 'us-west-2', profile: `ms-${envName}` },
  alarmEmail: 'alarms@example.com',
  auth: { cognitoDomainPrefix: `multiscale-${envName}`, signInCallbackUrls: ['multiscale://auth/callback'] },
  dns: { zone },
  files: { keys: { k1: filesKey }, signWith: 'k1' },
});

describe('the stack CloudFormation would deploy', () => {
  for (const [envName, zone] of [['staging', 'staging.example.net'], ['prod', 'app.example.net']] as const) {
    for (const [canary, alarms] of [[undefined, undefined], ['skip', undefined], [undefined, 'off'], ['skip', 'off']] as const) {
      it(`has no dependency loop, for ${envName}${canary ? ' skipping the canary' : ''}${alarms ? ' with the alarms off' : ''}`, () => {
        const stack = new MultiscaleStack(new App(), `Multiscale-${envName}`, {
          envName, config: shaped(envName, zone), control, backendDist: '/nonexistent', requireBinaries: false, canary, alarms,
          // With the release pipeline set up, so its release role is in the walk too.
          pipelineAccount: control.aws.account,
        });
        assert.deepEqual(cycles(Template.fromStack(stack).toJSON().Resources as Resources), []);
      });
    }
  }

  it('finds a loop through an UpdatePolicy, which is where this one hid', () => {
    const resources: Resources = {
      Alias: { Type: 'AWS::Lambda::Alias', UpdatePolicy: { CodeDeployLambdaAliasUpdate: { DeploymentGroupName: { Ref: 'Group' } } } },
      Group: { Type: 'AWS::CodeDeploy::DeploymentGroup', Properties: { AlarmConfiguration: { Alarms: [{ Name: { Ref: 'Alarm' } }] } } },
      Alarm: { Type: 'AWS::CloudWatch::Alarm', Properties: { Dimensions: [{ Value: { 'Fn::Sub': '${Function}' } }] } },
      Function: { Type: 'AWS::Lambda::Function', DependsOn: ['Policy'] },
      Policy: { Type: 'AWS::IAM::Policy', Properties: { Resource: { 'Fn::GetAtt': ['Alias', 'Arn'] } } },
      Unrelated: { Type: 'AWS::SNS::Topic', Properties: { Name: { Ref: 'Alias' } } },
    };
    assert.deepEqual(cycles(resources), [['Alarm', 'Alias', 'Function', 'Group', 'Policy']]);
  });
});

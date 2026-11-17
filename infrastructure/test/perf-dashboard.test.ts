import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { API_ROUTES, KPIS, LAMBDA_INIT, SECTIONS } from '../../config/perf.ts';
import { PERF_NAMESPACE } from '../lib/perf-dashboard.ts';
import { MultiscaleStack } from '../lib/stack.ts';
import type { Config, ControlConfig } from '../lib/config.ts';

const config: Config = {
  aws: { account: '111111111111', region: 'us-west-2', profile: 'test' },
  alarmEmail: 'alarms@example.com',
  auth: { cognitoDomainPrefix: 'multiscale-test', signInCallbackUrls: ['multiscale://auth/callback'] },
  dns: { zone: 'env.example.net' },
};
const control: ControlConfig = { aws: { account: '333333333333', region: 'us-west-2', profile: 'control' }, dns: { domain: 'example.net', hostedZoneId: 'Z0PARENTZONE' } };

type Resource = { Type: string; Properties: Record<string, any> };
const resources = (envName: 'staging' | 'prod') =>
  Template.fromStack(new MultiscaleStack(new App(), `Multiscale-${envName}`, { envName, config, control, backendDist: '/nonexistent', requireBinaries: false, pipelineAccount: '333333333333' })).toJSON()
    .Resources as Record<string, Resource>;
const dashboards = (all: Record<string, Resource>) => Object.values(all).filter((r) => r.Type === 'AWS::CloudWatch::Dashboard');

/** A dashboard's widgets, from its body, which CloudFormation gets as a join of strings and references. */
function widgets(dashboard: Resource): any[] {
  const body = dashboard.Properties.DashboardBody;
  // Each reference sits inside a string of the body, such as a log group's name.
  const text = typeof body === 'string' ? body : (body['Fn::Join'][1] as unknown[]).map((part) => (typeof part === 'string' ? part : 'REF')).join('');
  return JSON.parse(text).widgets;
}

let staging: Record<string, Resource>;
let perf: any[];
before(() => {
  staging = resources('staging');
  const named = dashboards(staging).find((d) => d.Properties.DashboardName === 'Multiscale-staging-performance');
  assert.ok(named, 'no performance dashboard');
  perf = widgets(named);
});

describe('the performance dashboard', () => {
  it("has a header for each of the spec's sections, in its order", () => {
    const headers = perf.filter((w) => w.type === 'text' && /^## /.test(w.properties.markdown)).map((w) => w.properties.markdown.split('\n')[0].slice(3));
    assert.deepEqual(headers, SECTIONS.map((s) => s.title));
  });

  it("graphs each client KPI's p50, p95 and p99 per platform and scenario from Multiscale/Perf, its targets drawn across", () => {
    const graphs = perf.filter((w) => w.type === 'metric');
    for (const kpi of KPIS) {
      for (const target of kpi.targets) {
        const graph = graphs.find((g) => g.properties.title.startsWith(`${kpi.name}: `) && target.platforms.every((p) => g.properties.title.includes(p)) && g.properties.title.includes(target.scenario ?? 'one-year'));
        assert.ok(graph, `${kpi.name} ${target.platforms.join(',')} ${target.scenario ?? ''}`);
        const metrics = graph.properties.metrics as unknown[][];
        for (const platform of target.platforms) {
          for (const stat of ['p50', 'p95', 'p99']) {
            assert.ok(
              metrics.some((m) => m[0] === PERF_NAMESPACE && m[1] === stat && m.includes('KPI') && m.includes(kpi.name) && m.includes('Platform') && m.includes(platform) && m.includes('Scenario') && m.includes(target.scenario ?? 'one-year')),
              `${kpi.name} ${platform} ${stat}`,
            );
          }
        }
        const lines = (graph.properties.annotations?.horizontal ?? []) as { value: number; label: string }[];
        for (const stat of ['p50', 'p95', 'p99'] as const) {
          if (target[stat] !== undefined) assert.ok(lines.some((l) => l.value === target[stat] && l.label.includes(stat)), `${kpi.name} target ${stat}`);
        }
      }
    }
  });

  it('reads per-route API latency from the access logs, and Lambda init from the functions’ logs, with their targets in the text', () => {
    const queries = perf.filter((w) => w.type === 'log').map((w) => w.properties.query as string);
    const routes = queries.find((q) => q.includes('latencyMs'));
    assert.ok(routes, 'no per-route latency');
    assert.match(routes, /pct\(latencyMs, 50\).*pct\(latencyMs, 95\).*pct\(latencyMs, 99\).* by route/s);
    const init = queries.find((q) => q.includes('@initDuration'));
    assert.ok(init, 'no Lambda init');
    assert.match(init, /pct\(@initDuration, 99\)/);
    const text = perf.filter((w) => w.type === 'text').map((w) => w.properties.markdown).join('\n');
    for (const row of API_ROUTES) assert.ok(text.includes(`${row.routes.join(', ')} | ${row.request} | ${row.p50} | ${row.p95} | ${row.p99}`), row.request);
    assert.ok(text.includes(`| ${LAMBDA_INIT.p50} | ${LAMBDA_INIT.p95} | ${LAMBDA_INIT.p99} |`));
  });

  it('leaves room in each section for numbers from real devices, later', () => {
    const later = perf.filter((w) => w.type === 'text' && /^Real phones and Macs: later/.test(w.properties.markdown));
    assert.equal(later.length, SECTIONS.length);
  });

  it('is only on staging, whose release role may publish to Multiscale/Perf and nothing else in CloudWatch', () => {
    const prod = resources('prod');
    assert.equal(dashboards(prod).filter((d) => d.Properties.DashboardName.endsWith('-performance')).length, 0);
    const publish = (all: Record<string, Resource>) => {
      const roleId = Object.entries(all).find(([, r]) => r.Type === 'AWS::IAM::Role' && r.Properties.RoleName === 'multiscale-release')![0];
      return Object.values(all)
        .filter((r) => r.Type === 'AWS::IAM::Policy' && r.Properties.Roles.some((x: any) => x.Ref === roleId))
        .flatMap((p) => p.Properties.PolicyDocument.Statement as any[])
        .filter((s) => [s.Action].flat().includes('cloudwatch:PutMetricData'));
    };
    assert.deepEqual(publish(prod), []);
    const [statement] = publish(staging);
    assert.deepEqual(statement.Condition, { StringEquals: { 'cloudwatch:namespace': PERF_NAMESPACE } });
  });

  it('adds per-route latency and Lambda init to every environment’s own dashboard', () => {
    for (const all of [staging, resources('prod')]) {
      const main = dashboards(all).find((d) => !d.Properties.DashboardName.endsWith('-performance'))!;
      const titles = widgets(main).map((w) => w.properties.title);
      assert.ok(titles.includes('API latency by route (ms)'), titles.join(', '));
      assert.ok(titles.includes('Lambda cold starts: init duration (ms)'));
    }
  });
});

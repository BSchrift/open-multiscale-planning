import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { join } from 'node:path';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { SiteStack } from '../lib/site-stack.ts';
import type { ControlConfig } from '../lib/config.ts';

const control: ControlConfig = {
  aws: { account: '333333333333', region: 'us-west-2', profile: 'control' },
  dns: { domain: 'example.net', hostedZoneId: 'Z0PARENTZONE' },
};
const stack = new SiteStack(new App(), 'Multiscale-site', { control, siteDir: join(import.meta.dirname, '../../site') });
const t = Template.fromStack(stack);

describe('site', () => {
  it("lives in the control account in us-east-1, where CloudFront takes its certificate", () => {
    assert.equal(stack.account, '333333333333');
    assert.equal(stack.region, 'us-east-1');
  });

  it('has a certificate for www, validated in the domain zone', () => {
    t.hasResourceProperties('AWS::CertificateManager::Certificate', {
      DomainName: 'www.example.net',
      ValidationMethod: 'DNS',
      DomainValidationOptions: [{ DomainName: 'www.example.net', HostedZoneId: 'Z0PARENTZONE' }],
    });
  });

  it('serves www over HTTPS only, from a bucket nobody else can read', () => {
    t.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        Aliases: ['www.example.net'],
        DefaultRootObject: 'index.html',
        DefaultCacheBehavior: Match.objectLike({ ViewerProtocolPolicy: 'redirect-to-https' }),
      }),
    });
    t.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
    });
    t.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
  });

  it('points www at it, over IPv4 and IPv6', () => {
    for (const Type of ['A', 'AAAA']) {
      t.hasResourceProperties('AWS::Route53::RecordSet', { Name: 'www.example.net.', Type, HostedZoneId: 'Z0PARENTZONE', AliasTarget: Match.anyValue() });
    }
  });

  it('uploads the site folder and keeps the upload logs 30 days, like every other log group', () => {
    t.resourceCountIs('Custom::CDKBucketDeployment', 1);
    for (const group of Object.values(t.findResources('AWS::Logs::LogGroup'))) assert.equal(group.Properties.RetentionInDays, 30);
  });
});

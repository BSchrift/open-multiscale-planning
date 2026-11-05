// The public page at www.<domain>, in the control account beside the domain's zone. CloudFront only takes a certificate
// from us-east-1, so this stack lives there whatever control.yaml's region is.

import { Stack } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { Certificate, CertificateValidation } from 'aws-cdk-lib/aws-certificatemanager';
import { Distribution, ViewerProtocolPolicy } from 'aws-cdk-lib/aws-cloudfront';
import { S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { AaaaRecord, ARecord, HostedZone, RecordTarget } from 'aws-cdk-lib/aws-route53';
import { CloudFrontTarget } from 'aws-cdk-lib/aws-route53-targets';
import { BlockPublicAccess, Bucket, BucketEncryption } from 'aws-cdk-lib/aws-s3';
import { BucketDeployment, Source } from 'aws-cdk-lib/aws-s3-deployment';
import type { ControlConfig } from './config.ts';

export interface SiteStackProps {
  /** Needs dns: the page is served on www.<domain>, validated and routed in its zone. */
  control: ControlConfig;
  /** The site/ folder, uploaded as it is. */
  siteDir: string;
}

export class SiteStack extends Stack {
  constructor(scope: Construct, id: string, { control, siteDir }: SiteStackProps) {
    super(scope, id, { env: { account: control.aws.account, region: 'us-east-1' } });
    const { domain, hostedZoneId } = control.dns!;
    const zone = HostedZone.fromHostedZoneAttributes(this, 'Zone', { hostedZoneId, zoneName: domain });
    const name = `www.${domain}`;

    const bucket = new Bucket(this, 'Bucket', {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
    });
    const distribution = new Distribution(this, 'Distribution', {
      defaultBehavior: { origin: S3BucketOrigin.withOriginAccessControl(bucket), viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS },
      defaultRootObject: 'index.html',
      domainNames: [name],
      certificate: new Certificate(this, 'Certificate', { domainName: name, validation: CertificateValidation.fromDns(zone) }),
    });
    new BucketDeployment(this, 'Content', {
      sources: [Source.asset(siteDir)],
      destinationBucket: bucket,
      distribution,
      logGroup: new LogGroup(this, 'ContentLogs', { retention: RetentionDays.ONE_MONTH }),
    });

    const target = RecordTarget.fromAlias(new CloudFrontTarget(distribution));
    new ARecord(this, 'WwwA', { zone, recordName: name, target });
    new AaaaRecord(this, 'WwwAaaa', { zone, recordName: name, target });
  }
}

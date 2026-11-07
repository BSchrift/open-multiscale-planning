// The control account: lets staging and prod delegate their own subzones from the domain's public zone.
// Everything here is DNS, so the stack is empty until control.yaml sets dns.domain.

import { Stack } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { AccountPrincipal, CompositePrincipal, Role } from 'aws-cdk-lib/aws-iam';
import { HostedZone, TxtRecord } from 'aws-cdk-lib/aws-route53';
import type { Config, ControlConfig } from './config.ts';

/** Fixed, so that staging and prod can name it without a reference across accounts. */
export const DELEGATION_ROLE_NAME = 'multiscale-dns-delegation';

export interface ControlStackProps {
  control: ControlConfig;
  /** Staging and prod. Those that set dns.zone may delegate it. */
  environments: Config[];
}

export class ControlStack extends Stack {
  constructor(scope: Construct, id: string, { control, environments }: ControlStackProps) {
    super(scope, id, { env: { account: control.aws.account, region: control.aws.region } });
    const dns = control.dns;
    if (!dns) return;

    // The zone Route 53 made when the domain was registered, so the domain already points at it and this stack never
    // owns it.
    const zone = HostedZone.fromHostedZoneAttributes(this, 'Zone', { hostedZoneId: dns.hostedZoneId, zoneName: dns.domain });
    // Proofs of owning the domain, such as Google's site verification. A name has one TXT record, so they share it.
    if (dns.txt?.length) new TxtRecord(this, 'DomainTxt', { zone, values: dns.txt });

    // Without a zone to limit it to, the grant would allow delegating any name.
    const zones = environments.flatMap((e) => (e.dns?.zone ? [e.dns.zone] : []));
    if (zones.length === 0) return;
    const accounts = [...new Set(environments.filter((e) => e.dns?.zone).map((e) => e.aws.account))];
    const role = new Role(this, 'DelegationRole', {
      roleName: DELEGATION_ROLE_NAME,
      assumedBy: new CompositePrincipal(...accounts.map((account) => new AccountPrincipal(account))),
    });
    zone.grantDelegation(role, { delegatedZoneNames: zones });
  }
}

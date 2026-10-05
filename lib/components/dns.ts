// =============================================================================
// 11 — Private DNS zone
// WHAT  A Route 53 private hosted zone for dns.privateZone.domain, associated with the VPC.
// WHY   Makes the LangSmith hostname resolve inside the VPC (your corporate DNS forwards the
//       domain to it, README.md, Network). The record hostname -> ALB is written by
//       load-balancer.ts (ingress.mode 'envoy-gateway'), or after `helm install` by post-deploy/05
//       (ingress.mode 'alb': that ALB does not exist before then).
// HOW   AWS::Route53::HostedZone with VPCs. The TLS certificate is not created here: give an
//       ISSUED ACM certificate ARN in config, importing PEM files with post-deploy/00 first
//       (CloudFormation cannot import a certificate).
//       Deleted by `cdk destroy` whatever dataRemovalPolicy says: it holds no data, and a kept zone
//       stays associated with the VPC, so a redeploy into the same VPC fails (ConflictingDomainExists).
// =============================================================================
import { aws_ec2 as ec2, aws_route53 as route53, RemovalPolicy } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { LangSmithConfig } from '../config';

export interface PrivateDnsProps { cfg: LangSmithConfig; vpc: ec2.IVpc }

export class PrivateDns extends Construct {
  public readonly zoneId: string;

  constructor(scope: Construct, id: string, props: PrivateDnsProps) {
    super(scope, id);
    const zone = new route53.PrivateHostedZone(this, 'Zone', {
      zoneName: props.cfg.dns.privateZone.domain,
      vpc: props.vpc,
      comment: `LangSmith ${props.cfg.name}`,
    });
    zone.applyRemovalPolicy(RemovalPolicy.DESTROY);
    this.zoneId = zone.hostedZoneId;
  }
}

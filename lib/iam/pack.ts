// =============================================================================
// pack.ts — the "IAM pack": every role this config uses, as plain JSON, for an IAM
// team that creates roles by hand (config.existingRoles) or just wants to review them.
//
// It calls the SAME spec functions as the stack (roles.ts), with literal values
// instead of CloudFormation references. Values that only exist after deploy are
// printed as scoped wildcards or <PLACEHOLDERS>, with a note on how to narrow them.
// =============================================================================
import { LangSmithConfig } from '../config';
import { namesFor } from '../naming';
import { loadBalancerControllerPolicy } from './policies';
import {
  bastionRoleSpec, clusterAutoscalerRoleSpec, ebsCsiRoleSpec, eksClusterRoleSpec, eksNodeRoleSpec, externalSecretsRoleSpec,
  langsmithRoleSpec, loadBalancerControllerRoleSpec, roleEnabled, RoleKey, RoleSpec, smithdbRoleSpec, SpecInputs, vpcCniRoleSpec,
} from './roles';
import { irsaTrustForHumans, podIdentityTrust } from './trust';

export interface PackedRole {
  roleName: string;
  description: string;
  /** true = you create it (config.existingRoles has it); false = this CDK app creates it. */
  broughtByYou: boolean;
  usedBy: string[];
  trustPolicy: unknown;
  managedPolicyArns: string[];
  inlinePolicies: Record<string, object>;
  notes: string[];
}

export interface IamPack {
  workloadIdentity: string;
  roles: PackedRole[];
  /** Customer-managed policies the roles reference, by name. */
  managedPolicies: Record<string, object>;
}

export interface PackOptions {
  /** IRSA: the cluster's OIDC issuer host (oidc.eks.<region>.amazonaws.com/id/<ID>), once it exists. */
  issuer?: string;
}

/** Every role spec, in the order the stack creates them. */
const SPECS: [RoleKey, (i: SpecInputs) => RoleSpec][] = [
  ['eksCluster', eksClusterRoleSpec], ['eksNode', eksNodeRoleSpec], ['bastion', bastionRoleSpec],
  ['vpcCni', vpcCniRoleSpec], ['ebsCsi', ebsCsiRoleSpec], ['langsmith', langsmithRoleSpec], ['smithdb', smithdbRoleSpec],
  ['externalSecrets', externalSecretsRoleSpec], ['loadBalancerController', loadBalancerControllerRoleSpec],
  ['clusterAutoscaler', clusterAutoscalerRoleSpec],
];

/** The roles this config uses (roleEnabled, the same rule as the stack). */
export function enabledRoleSpecs(cfg: LangSmithConfig, i: SpecInputs): RoleSpec[] {
  return SPECS.filter(([key]) => roleEnabled(cfg, key)).map(([, spec]) => spec(i));
}

/** The ARN partition of a region: aws, aws-cn (China) or aws-us-gov (GovCloud). */
export function partitionOf(region: string): string {
  if (region.startsWith('cn-')) return 'aws-cn';
  if (region.startsWith('us-gov-')) return 'aws-us-gov';
  return 'aws';
}

export function buildIamPack(cfg: LangSmithConfig, opts: PackOptions = {}): IamPack {
  const names = namesFor(cfg);
  const partition = partitionOf(cfg.region);
  const { region, account } = cfg;
  const irsa = cfg.workloadIdentity === 'irsa';
  const oidc = {
    issuerHost: opts.issuer ?? cfg.eks.existingOidcIssuer ?? '<OIDC_ISSUER_HOST>',
    providerArn: (opts.issuer ?? cfg.eks.existingOidcIssuer)
      ? `arn:${partition}:iam::${account}:oidc-provider/${opts.issuer ?? cfg.eks.existingOidcIssuer}`
      : '<OIDC_PROVIDER_ARN>',
  };

  // KMS for the cluster role: when this app creates the key AND you bring the cluster role, the key
  // policy grants the role (kms.ts), so the role itself needs no KMS statement.
  const keyArn = cfg.kms.existingKeyArn ?? (cfg.kms.enabled ? `arn:${partition}:kms:${region}:${account}:key/<KEY_ID>` : undefined);
  const kmsByKeyPolicy = cfg.kms.enabled && !!cfg.existingRoles.eksCluster;

  const core = cfg.postgres.core.existing;
  const meta = cfg.postgres.metastore.existing;
  const inputs: SpecInputs = {
    partition, region, account, cfg, names,
    podTrust: (ns, sa) => (irsa ? irsaTrustForHumans(ns, sa, oidc) : podIdentityTrust()),
    eksSecretsKeyArn: kmsByKeyPolicy ? undefined : keyArn,
    coreDbResourceId: core?.resourceId ?? '*',
    metastoreDbResourceId: meta?.resourceId ?? '*',
    rdsMasterSecretArns: (core && meta)
      ? [core.masterSecretArn, meta.masterSecretArn]
      : [`arn:${partition}:secretsmanager:${region}:${account}:secret:rds!db-*`],
    loadBalancerControllerPolicyArn: `arn:${partition}:iam::${account}:policy/${names.lbcManagedPolicy}`,
  };

  const roles = enabledRoleSpecs(cfg, inputs).map((spec): PackedRole => {
    const notes: string[] = [];
    if (irsa && spec.serviceAccounts && !(opts.issuer ?? cfg.eks.existingOidcIssuer)) {
      notes.push('IRSA: the trust names the cluster\'s OIDC issuer, which exists after the first deploy. '
        + 'Re-run with --issuer <host> (aws eks describe-cluster --query cluster.identity.oidc.issuer) and update the trust.');
    }
    if (spec.key === 'eksCluster' && kmsByKeyPolicy) {
      notes.push('KMS: no statement needed here — the stack\'s KMS key policy grants this role.');
    }
    if (spec.key === 'langsmith' && !core) {
      notes.push('rds-db:connect uses dbuser:*/<user> because the core database\'s resource ID exists only after deploy. '
        + 'To narrow it: aws rds describe-db-instances --db-instance-identifier ' + names.coreDbInstance + ' --query "DBInstances[0].DbiResourceId"');
    }
    if (spec.key === 'smithdb' && !meta) {
      notes.push('rds-db:connect uses dbuser:*/smithdb_app until the metastore exists (narrow it like the LangSmith role).');
    }
    if (spec.key === 'externalSecrets' && !(core && meta)) {
      notes.push('rds!db-* covers the two RDS-managed master secrets, whose ARNs exist only after deploy. Narrow it to the '
        + 'CoreDbMasterSecretArn and MetastoreDbMasterSecretArn stack outputs.');
    }
    if (spec.key === 'loadBalancerController') {
      notes.push(`Create the customer-managed policy ${names.lbcManagedPolicy} from managedPolicies["${names.lbcManagedPolicy}"] first.`);
    }
    return {
      roleName: spec.roleName,
      description: spec.description,
      broughtByYou: !!cfg.existingRoles[spec.key],
      usedBy: (spec.serviceAccounts ?? []).map((sa) => `${sa.namespace}/${sa.name}`),
      trustPolicy: spec.trust,
      managedPolicyArns: spec.managedPolicyArns,
      inlinePolicies: spec.inlinePolicies,
      notes,
    };
  });

  const managedPolicies: Record<string, object> = {};
  if (cfg.workloadRoles.loadBalancerController) managedPolicies[names.lbcManagedPolicy] = loadBalancerControllerPolicy(partition);

  return { workloadIdentity: cfg.workloadIdentity, roles, managedPolicies };
}

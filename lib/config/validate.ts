// =============================================================================
// lib/config/validate.ts — plain-English checks that run before anything is built.
// Every rule is one `need(...)` with a message that says what to change.
// =============================================================================
import { ENVIRONMENT_PROTECTION, instanceVcpus, resolveSizes, SIZE_PRESETS, SMITHDB_LAB_LARGEST_POD_VCPU, SMITHDB_LARGEST_POD_VCPU } from './sizing';
import { ExistingRoles, ingressMode, LangSmithConfig, layoutOf, VPC_CNI_MIN_FOR_SUBNET_TAGS } from './types';

/**
 * The account IDs AWS uses in its documentation. The example configs use them, so their placeholder
 * values (such as the all-zero certificate ARN) are only refused once you put in a real account.
 */
export const DOCUMENTATION_ACCOUNT_IDS = ['123456789012', '111122223333'];

/** The retention values CloudWatch Logs accepts. */
export const LOG_RETENTION_DAYS = [1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653];

export function validateConfig(cfg: LangSmithConfig): void {
  const errors: string[] = [];
  const need = (ok: boolean, message: string) => { if (!ok) errors.push(message); };
  const irsa = cfg.workloadIdentity === 'irsa';
  const net = cfg.network;
  const roles = cfg.workloadRoles;
  const existing = cfg.existingRoles;

  // ---- basics
  need(/^[a-z][a-z0-9-]{0,19}$/.test(cfg.name) && !cfg.name.endsWith('-') && !cfg.name.includes('--'),
    `name "${cfg.name}": use lowercase letters, digits and '-', start with a letter, no '--' or trailing '-', max 20 characters.`);
  need(/^\d{12}$/.test(cfg.account), `account "${cfg.account}": must be the 12-digit AWS account ID.`);
  need(/^[a-z]{2}(-[a-z]+)+-\d$/.test(cfg.region), `region "${cfg.region}": must look like us-east-1.`);
  need(['irsa', 'podIdentity'].includes(cfg.workloadIdentity), `workloadIdentity must be 'irsa' or 'podIdentity'.`);
  const knownEnvironment = Object.keys(ENVIRONMENT_PROTECTION).includes(cfg.environment);
  const knownSize = cfg.size === undefined || Object.keys(SIZE_PRESETS).includes(cfg.size);
  need(knownEnvironment, `environment "${cfg.environment}": use 'dev', 'stage' or 'prod'.`);
  need(knownSize, `size "${cfg.size}": use 'lab', 'small', 'medium' or 'large'.`);
  need(cfg.cdkQualifier === undefined || /^[a-z0-9]{1,10}$/.test(cfg.cdkQualifier),
    `cdkQualifier "${cfg.cdkQualifier}": lowercase letters and digits, max 10 (the --qualifier of \`cdk bootstrap\`).`);
  if (knownEnvironment && knownSize) {
    const z = resolveSizes(cfg);
    need(z.nodeMin <= z.nodeDesired && z.nodeDesired <= z.nodeMax,
      `sizes: node counts must be nodeMin <= nodeDesired <= nodeMax (now ${z.nodeMin}, ${z.nodeDesired}, ${z.nodeMax}).`);
    // RDS storage autoscaling: the maximum must be at least 10% above the allocated storage.
    need(z.pgMaxStorageGib >= Math.ceil(z.pgStorageGib * 1.1),
      `sizes: pgStorageGib (${z.pgStorageGib}) needs pgMaxStorageGib of at least ${Math.ceil(z.pgStorageGib * 1.1)} (10% more), not ${z.pgMaxStorageGib}.`);
  }
  need(cfg.sizes?.smithdbTier === undefined || ['small', 'medium'].includes(cfg.sizes.smithdbTier),
    `sizes.smithdbTier "${cfg.sizes?.smithdbTier}": use 'small' or 'medium' ('large' needs local NVMe nodes, README.md, Sizing).`);
  need(cfg.sizes?.smithdbResources === undefined || ['tier', 'lab'].includes(cfg.sizes.smithdbResources),
    `sizes.smithdbResources "${cfg.sizes?.smithdbResources}": use 'tier' or 'lab'.`);
  need(cfg.size !== 'lab' || cfg.environment === 'dev',
    `size 'lab' is for functional tests only and needs environment 'dev' (it is not a LangChain-tested shape).`);
  for (const [key, value] of Object.entries(cfg.extraTags ?? {})) {
    need(!['app', 'langsmith-env', 'Name'].includes(key) && !key.toLowerCase().startsWith('aws:'),
      `extraTags."${key}": app, langsmith-env and Name are set by this app, and aws: is reserved — use another key.`);
    need(key.length <= 128 && value.length <= 256, `extraTags."${key}": keys max 128 and values max 256 characters.`);
  }
  if (cfg.eks.logRetentionDays !== undefined) {
    need(LOG_RETENTION_DAYS.includes(cfg.eks.logRetentionDays),
      `eks.logRetentionDays ${cfg.eks.logRetentionDays}: use one of ${LOG_RETENTION_DAYS.join(', ')}.`);
  }

  // ---- network
  // A field that only applies to the other choice of createVpc is an error, not silently ignored.
  const setFields = (fields: (keyof typeof net)[]) =>
    fields.filter((f) => { const v = net[f]; return Array.isArray(v) ? v.length > 0 : v !== undefined; });
  if (net.createVpc) {
    need((net.availabilityZones ?? []).length === 3, 'network.createVpc = true: list exactly 3 network.availabilityZones.');
    const ignored = setFields(['vpcId', 'vpcCidrs', 'privateSubnets', 'podSubnets', 's3GatewayEndpointId']);
    need(ignored.length === 0, `network.createVpc = true: remove ${ignored.join(', ')} (the new VPC provides them).`);
    need(!(net.podCidr && layoutOf(cfg) === 'A'), "network.podCidr is for a separate pod range (layout: 'B'); remove it with layout: 'A'.");
    if (net.podCidr) {
      const m = /^(\d{1,3})\.(\d{1,3})\.0\.0\/16$/.exec(net.podCidr);
      const [a, b] = m ? [Number(m[1]), Number(m[2])] : [0, 0];
      need(!!m && ((a === 100 && b >= 64 && b <= 127) || (a === 198 && b === 19)),
        `network.podCidr '${net.podCidr}': use a /16 inside 100.64.0.0/10 or 198.19.0.0/16, such as 100.64.0.0/16 (README.md, Network).`);
    }
    need(!(net.addressPlan && layoutOf(cfg) === 'B'),
      "network.addressPlan is for pods in the private subnets (layout: 'A'); the default separate pod range has one fixed plan (README.md, Network).");
  } else {
    need(!!net.vpcId, 'network.createVpc = false: set network.vpcId.');
    need((net.vpcCidrs ?? []).length > 0, 'network.createVpc = false: set network.vpcCidrs (every CIDR of the VPC).');
    const azs = new Set((net.privateSubnets ?? []).map((s) => s.az));
    need(azs.size >= 2, 'network.privateSubnets: give at least 2 subnets in different AZs.');
    const podAzs = new Set((net.podSubnets ?? []).map((s) => s.az));
    for (const s of net.podSubnets ?? []) {
      need(azs.has(s.az), `network.podSubnets: ${s.id} is in ${s.az}, which has no private subnet.`);
    }
    if (podAzs.size > 0) {
      for (const az of azs) need(podAzs.has(az), `network.podSubnets: no pod subnet in ${az} (a separate pod range needs one in every AZ of privateSubnets).`);
    }
    const ignored = setFields(['availabilityZones', 'layout', 'natMode', 'addressPlan', 'podCidr']);
    need(ignored.length === 0, `network.createVpc = false: remove ${ignored.join(', ')} (they describe a VPC this app creates).`);
  }

  // Pods in their own subnets rely on the VPC CNI honouring kubernetes.io/role/cni=0 on the node subnets.
  const podSubnetsUsed = net.createVpc ? layoutOf(cfg) === 'B' : (net.podSubnets ?? []).length > 0;
  const pinnedCni = cfg.eks.addonVersions?.vpcCni;
  if (podSubnetsUsed && pinnedCni) {
    need(versionAtLeast(pinnedCni, VPC_CNI_MIN_FOR_SUBNET_TAGS),
      `eks.addonVersions.vpcCni ${pinnedCni}: pods in their own subnets need VPC CNI v${VPC_CNI_MIN_FOR_SUBNET_TAGS} or later (the kubernetes.io/role/cni=0 tag on the node subnets). Remove the pin or use a later version.`);
  }

  // ---- KMS
  need(!(cfg.kms.enabled && cfg.kms.existingKeyArn), 'kms: set either enabled = true or existingKeyArn, not both.');
  need(!(cfg.kms.enabled && !cfg.eks.enabled),
    'kms.enabled = true but eks.enabled = false: the key only encrypts the Kubernetes secrets of a cluster this app creates. Set kms.enabled = false.');

  // ---- EKS
  const eks = cfg.eks;
  if (!eks.enabled) {
    need(!!eks.existingClusterName, 'eks.enabled = false: set eks.existingClusterName (the add-ons, node group and roles attach to it).');
    if (irsa) need(!!eks.existingOidcIssuer, "eks.enabled = false with workloadIdentity 'irsa': set eks.existingOidcIssuer.");
  }
  if (eks.enabled) {
    need(eks.adminRoleArns.length > 0 || cfg.bastion.enabled,
      'eks.adminRoleArns is empty and there is no bastion: nobody could use the cluster. Add your admin role ARN.');
    for (const arn of new Set(eks.adminRoleArns.filter((a, i) => eks.adminRoleArns.indexOf(a) !== i))) {
      errors.push(`eks.adminRoleArns lists ${arn} twice: an access entry can exist only once.`);
    }
  }
  if (!irsa && (eks.enabled || eks.addons.vpcCni || eks.addons.ebsCsiDriver)) {
    need(eks.addons.podIdentityAgent, "workloadIdentity 'podIdentity' needs eks.addons.podIdentityAgent = true.");
  }
  if (eks.nodeGroup.enabled) need(eks.addons.vpcCni, 'eks.nodeGroup needs eks.addons.vpcCni (nodes have no pod networking without it).');
  if (eks.nodeGroup.enabled && knownEnvironment && knownSize) {
    // A SmithDB pod bigger than every node stays Pending forever. Leave 1 vCPU for system pods.
    const sizes = resolveSizes(cfg);
    const vcpus = instanceVcpus(sizes.nodeInstanceType);
    const largest = sizes.smithdbResources === 'lab' ? SMITHDB_LAB_LARGEST_POD_VCPU : SMITHDB_LARGEST_POD_VCPU[sizes.smithdbTier];
    if (vcpus !== undefined) {
      need(vcpus - 1 >= largest,
        `sizes.nodeInstanceType ${sizes.nodeInstanceType} (${vcpus} vCPU) is too small for SmithDB tier '${sizes.smithdbTier}': ` +
        `its largest pod needs ${largest} vCPU on one node, plus 1 for system pods. Use ${largest > 8 ? '8xlarge' : largest > 2 ? '4xlarge' : 'xlarge'} or larger.`);
    }
  }

  // ---- consumers that need a store: created here, or `existing...` given
  const coreDb = cfg.postgres.core.enabled || !!cfg.postgres.core.existing;
  const metaDb = cfg.postgres.metastore.enabled || !!cfg.postgres.metastore.existing;
  const cache = cfg.valkey.enabled || !!cfg.valkey.existing;
  const blob = cfg.s3.blob.enabled || !!cfg.s3.blob.existingBucketName;
  const smithdbBucket = cfg.s3.smithdb.enabled || !!cfg.s3.smithdb.existingBucketName;
  need(!(cfg.postgres.core.enabled && cfg.postgres.core.existing), 'postgres.core: set enabled = true or existing, not both.');
  need(!(cfg.postgres.metastore.enabled && cfg.postgres.metastore.existing), 'postgres.metastore: set enabled = true or existing, not both.');
  need(!(cfg.valkey.enabled && cfg.valkey.existing), 'valkey: set enabled = true or existing, not both.');
  need(!(cfg.s3.blob.enabled && cfg.s3.blob.existingBucketName), 's3.blob: set enabled = true or existingBucketName, not both.');
  need(!(cfg.s3.smithdb.enabled && cfg.s3.smithdb.existingBucketName), 's3.smithdb: set enabled = true or existingBucketName, not both.');
  if (roles.langsmith) {
    need(blob, 'workloadRoles.langsmith needs the blob bucket: s3.blob.enabled = true or s3.blob.existingBucketName.');
    need(coreDb, 'workloadRoles.langsmith needs the core database: postgres.core.enabled = true or postgres.core.existing.');
    need(cache, 'workloadRoles.langsmith needs Valkey: valkey.enabled = true or valkey.existing.');
  }
  if (roles.smithdb) {
    need(smithdbBucket, 'workloadRoles.smithdb needs the SmithDB bucket: s3.smithdb.enabled = true or s3.smithdb.existingBucketName.');
    need(metaDb, 'workloadRoles.smithdb needs the metastore: postgres.metastore.enabled = true or postgres.metastore.existing.');
  }
  need(!roles.bedrock || roles.langsmith, 'workloadRoles.bedrock adds permissions to the LangSmith role: also set workloadRoles.langsmith = true.');
  need(!roles.externalSecrets || cfg.secrets.enabled, 'workloadRoles.externalSecrets reads the <name>/ secrets: set secrets.enabled = true.');
  if (!irsa && roles.langsmith) {
    need(cfg.kubernetes.langsmithServiceAccounts.length > 0, 'kubernetes.langsmithServiceAccounts is empty: list the LangSmith ServiceAccounts.');
    need(!cfg.kubernetes.langsmithServiceAccounts.includes('langsmith-smithdb'),
      'kubernetes.langsmithServiceAccounts: remove langsmith-smithdb (it gets the <name>-smithdb role).');
  }

  // ---- DNS
  const d = cfg.dns;
  need(d.hostname.endsWith(`.${d.privateZone.domain}`), `dns.hostname "${d.hostname}" must be inside dns.privateZone.domain "${d.privateZone.domain}".`);
  need(!(d.privateZone.enabled && d.privateZone.existingZoneId), 'dns.privateZone: set enabled = true or existingZoneId, not both.');

  // ---- ingress (README.md, Network)
  need(!('albAllowedCidrs' in cfg), 'albAllowedCidrs has moved: write it as ingress: { allowedCidrs: [...] } (same meaning).');
  for (const cidr of cfg.ingress?.allowedCidrs ?? []) {
    need(/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(cidr), `ingress.allowedCidrs: "${cidr}" is not an IPv4 CIDR such as 10.0.0.0/8.`);
  }
  const mode = ingressMode(cfg);
  need(['envoy-gateway', 'alb'].includes(mode), `ingress.mode "${mode}": use 'envoy-gateway' or 'alb'.`);
  if (d.certificateArn) {
    need(new RegExp(`^arn:aws[a-z-]*:acm:${cfg.region}:${cfg.account}:certificate/[0-9a-f-]+$`).test(d.certificateArn),
      `dns.certificateArn: must be an ACM certificate in account ${cfg.account} and region ${cfg.region} (the ALB's).`);
    need(DOCUMENTATION_ACCOUNT_IDS.includes(cfg.account) || !d.certificateArn.endsWith('/00000000-0000-0000-0000-000000000000'),
      'dns.certificateArn is the example placeholder: replace it with your ISSUED ACM certificate ' +
      '(import PEM files with post-deploy/00-import-certificate.sh).');
  }
  if (mode === 'envoy-gateway') {
    need(eks.enabled, "ingress.mode 'envoy-gateway' needs eks.enabled = true (the ALB's rule to the Envoy pods goes on the " +
      "cluster's security group). On a cluster you bring, use ingress.mode 'alb'.");
    need(!!d.certificateArn, "ingress.mode 'envoy-gateway': set dns.certificateArn — CDK creates the HTTPS listener, so the " +
      'certificate must exist before `cdk deploy` (import PEM files with post-deploy/00-import-certificate.sh first).');
    need(roles.loadBalancerController, "ingress.mode 'envoy-gateway': the AWS Load Balancer Controller registers the Envoy pods " +
      'in the ALB target group — set workloadRoles.loadBalancerController = true.');
  }

  // ---- bring-your-own roles
  const off = (component: boolean, role: keyof ExistingRoles, label: string) =>
    need(!(existing[role] && !component), `existingRoles.${role} is set but ${label} is off — remove it or turn ${label} on.`);
  off(eks.enabled, 'eksCluster', 'eks.enabled');
  off(eks.nodeGroup.enabled, 'eksNode', 'eks.nodeGroup.enabled');
  off(cfg.bastion.enabled, 'bastion', 'bastion.enabled');
  off(eks.addons.vpcCni, 'vpcCni', 'eks.addons.vpcCni');
  off(eks.addons.ebsCsiDriver, 'ebsCsi', 'eks.addons.ebsCsiDriver');
  off(roles.langsmith, 'langsmith', 'workloadRoles.langsmith');
  off(roles.smithdb, 'smithdb', 'workloadRoles.smithdb');
  off(roles.externalSecrets, 'externalSecrets', 'workloadRoles.externalSecrets');
  off(roles.loadBalancerController, 'loadBalancerController', 'workloadRoles.loadBalancerController');
  off(roles.clusterAutoscaler, 'clusterAutoscaler', 'workloadRoles.clusterAutoscaler');
  need(!existing.bastion === !existing.bastionInstanceProfileName,
    'existingRoles.bastion and existingRoles.bastionInstanceProfileName go together: set both or neither.');
  const byoIrsaRoles = (['vpcCni', 'ebsCsi', 'langsmith', 'smithdb', 'externalSecrets', 'loadBalancerController', 'clusterAutoscaler'] as const)
    .filter((r) => existing[r]);
  if (irsa && byoIrsaRoles.length > 0) {
    need(cfg.irsaTrustManagedExternally === true,
      `existingRoles ${byoIrsaRoles.join(', ')} with workloadIdentity 'irsa': their trust must name this cluster's OIDC issuer, ` +
      'which exists only after the first deploy. Set irsaTrustManagedExternally = true to confirm your IAM team updates it ' +
      "(or use workloadIdentity 'podIdentity', whose trust never changes).");
  }
  if (existing.bastion && cfg.bastion.operatorPolicyArn) {
    errors.push('bastion.operatorPolicyArn cannot be attached to a role you bring (existingRoles.bastion): attach it yourself.');
  }

  if (errors.length > 0) {
    throw new Error(`Invalid configuration "${cfg.name}":\n  - ${errors.join('\n  - ')}`);
  }
}

/** 'v1.23.1-eksbuild.1' >= '1.22.2'? Compares major.minor.patch only. */
function versionAtLeast(version: string, minimum: string): boolean {
  const parse = (v: string) => (v.replace(/^v/, '').split('-')[0].split('.').map((x) => parseInt(x, 10) || 0));
  const [a, b] = [parse(version), parse(minimum)];
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
}

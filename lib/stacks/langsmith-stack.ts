// =============================================================================
// langsmith-stack.ts — every AWS resource LangSmith needs, in install order.
//
// Read this file top to bottom: each numbered block (2..13; 1 is the optional network stack)
// calls one component in lib/components/, whose header carries the same number, and
// README.md (1.1 and "Common changes") lists them. Every block checks its toggle in config first.
// IAM roles are all defined in lib/iam/roles.ts; this file only decides WHEN each is created
// (a role can only point at resources that already exist).
//
// Run order around it (README.md, Part 2): post-deploy/00 (certificate) before `cdk deploy`;
// after it post-deploy/01, 03, 04, then out/helm-install-langsmith.sh, then post-deploy/05.
// =============================================================================
import { Aws, aws_ec2 as ec2, aws_iam as iam, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { ingressMode, LangSmithConfig, resolveSizes } from '../config';
import { namesFor, tagsFor } from '../naming';
import { NetworkInfo } from '../network-info';
import { addOutputs } from '../outputs';
import { podIdentityTrust, irsaTrustForStack } from '../iam/trust';
import { loadBalancerControllerPolicy } from '../iam/policies';
import {
  bastionRoleSpec, clusterAutoscalerRoleSpec, createOrImportBastionInstanceProfile, createOrImportRole, ebsCsiRoleSpec,
  eksClusterRoleSpec, eksNodeRoleSpec, externalSecretsRoleSpec, langsmithRoleSpec, loadBalancerControllerRoleSpec,
  roleEnabled, RoleRef, RoleSpec, smithdbRoleSpec, SpecInputs, vpcCniRoleSpec,
} from '../iam/roles';
import { SecurityGroups } from '../components/security-groups';
import { EksSecretsKey } from '../components/kms';
import { EksCluster } from '../components/eks-cluster';
import { EksAddonsAfterNodes, EksAddonsBeforeNodes } from '../components/eks-addons';
import { NodeGroup } from '../components/node-group';
import { S3Buckets } from '../components/s3-buckets';
import { Postgres } from '../components/postgres';
import { Valkey, ValkeyInfo } from '../components/valkey';
import { AppSecrets } from '../components/secrets';
import { PodIdentityBindings } from '../components/workload-bindings';
import { PrivateDns } from '../components/dns';
import { Bastion } from '../components/bastion';
import { LoadBalancer } from '../components/load-balancer';

export interface LangSmithStackProps extends StackProps {
  cfg: LangSmithConfig;
  network: NetworkInfo;
}

export class LangSmithStack extends Stack {
  constructor(scope: Construct, id: string, props: LangSmithStackProps) {
    super(scope, id, props);
    const { cfg, network } = props;
    const names = namesFor(cfg);
    const sizes = resolveSizes(cfg);
    const irsa = cfg.workloadIdentity === 'irsa';
    const retain = cfg.dataRemovalPolicy === 'retain';
    const dataRemoval = retain ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;
    const databaseRemoval = retain ? RemovalPolicy.SNAPSHOT : RemovalPolicy.DESTROY;
    const privateSubnetIds = network.privateSubnets.map((s) => s.id);

    // ---- The VPC (yours, or the one the network stack created): referenced, never looked up.
    // Security groups and the private DNS zone only need its ID; subnets are passed as plain IDs.
    const vpc = ec2.Vpc.fromVpcAttributes(this, 'Vpc', {
      vpcId: network.vpcId,
      vpcCidrBlock: network.vpcCidrs[0],
      availabilityZones: network.privateSubnets.map((s) => s.az),
    });

    // ---- Inputs for the IAM role specs (lib/iam/roles.ts), FILLED IN AS RESOURCES APPEAR below:
    // the KMS key (block 3), the database resource IDs (block 8), the Load Balancer Controller
    // policy (block 10). A role created before its input is set would get '*' — keep the order.
    // podTrust: who may assume a workload role — the OIDC provider (IRSA) or EKS Pod Identity.
    let oidc: { providerArn: string; issuerHost: string } | undefined;
    const iamInputs: SpecInputs = {
      partition: Aws.PARTITION,
      region: cfg.region,
      account: cfg.account,
      cfg,
      names,
      podTrust: (namespace, serviceAccount) => (irsa ? irsaTrustForStack(namespace, serviceAccount, oidc!) : podIdentityTrust()),
      eksSecretsKeyArn: undefined,
      coreDbResourceId: '*',
      metastoreDbResourceId: '*',
      rdsMasterSecretArns: [],
      loadBalancerControllerPolicyArn: '',
    };

    // =========================================================================
    // 2 Security groups
    // =========================================================================
    const sgs = new SecurityGroups(this, 'SecurityGroups', {
      cfg, names, vpc, vpcCidrs: network.vpcCidrs,
      createEksApi: cfg.eks.enabled,
      createRds: cfg.postgres.core.enabled || cfg.postgres.metastore.enabled,
      createCache: cfg.valkey.enabled,
      createAlb: true, // every ingress mode has an internal ALB (CDK's, or the Load Balancer Controller's)
    });

    // =========================================================================
    // 3 KMS key + the base roles (cluster, nodes, bastion)
    // =========================================================================
    let secretsKeyArn = cfg.kms.existingKeyArn;
    if (cfg.kms.enabled) {
      secretsKeyArn = new EksSecretsKey(this, 'EksSecretsKey', {
        names, removalPolicy: dataRemoval, importedClusterRoleArn: cfg.existingRoles.eksCluster,
      }).keyArn;
    }
    iamInputs.eksSecretsKeyArn = cfg.existingRoles.eksCluster ? undefined : secretsKeyArn;

    // roleEnabled (lib/iam/roles.ts) decides which roles a config uses; iam-pack reads the same rule.
    const clusterRole = roleEnabled(cfg, 'eksCluster') ? createOrImportRole(this, eksClusterRoleSpec(iamInputs), cfg) : undefined;
    const nodeRole = roleEnabled(cfg, 'eksNode') ? createOrImportRole(this, eksNodeRoleSpec(iamInputs), cfg) : undefined;
    const bastionRole = roleEnabled(cfg, 'bastion') ? createOrImportRole(this, bastionRoleSpec(iamInputs), cfg) : undefined;

    // =========================================================================
    // 4 EKS cluster (+ the OIDC provider in IRSA mode)
    // =========================================================================
    let clusterName = names.clusterName;
    let clusterSecurityGroupId: string | undefined;
    if (cfg.eks.enabled) {
      const eksCluster = new EksCluster(this, 'Eks', {
        cfg, names,
        clusterRoleArn: clusterRole!.arn,
        subnetIds: privateSubnetIds,
        securityGroupId: sgs.eksApi!.securityGroupId,
        secretsKeyArn,
        adminPrincipalArns: cfg.eks.adminRoleArns,
        bastionRoleArn: bastionRole?.arn,
        logRemovalPolicy: dataRemoval,
      });
      clusterName = eksCluster.cluster.ref; // a reference, so everything below waits for the cluster
      clusterSecurityGroupId = eksCluster.clusterSecurityGroupId;
      oidc = eksCluster.oidc;
    } else if (irsa) {
      // Your cluster: its OIDC provider already exists in IAM.
      const host = cfg.eks.existingOidcIssuer!;
      oidc = { providerArn: `arn:${Aws.PARTITION}:iam::${cfg.account}:oidc-provider/${host}`, issuerHost: host };
    }

    // =========================================================================
    // 5 Add-ons nodes need from their first boot: vpc-cni, kube-proxy, pod identity agent
    // =========================================================================
    const vpcCniRole = roleEnabled(cfg, 'vpcCni') ? createOrImportRole(this, vpcCniRoleSpec(iamInputs), cfg) : undefined;
    const addonsBeforeNodes = new EksAddonsBeforeNodes(this, 'AddonsBeforeNodes', {
      clusterName, eksConfig: cfg.eks, workloadIdentity: cfg.workloadIdentity,
      vpcCniRoleArn: vpcCniRole?.arn,
      podSubnets: network.podSubnets.length > 0,
    });

    // =========================================================================
    // 6 Node group, then the add-ons that run on nodes: coredns, EBS CSI, metrics-server
    // =========================================================================
    let nodeGroup: NodeGroup | undefined;
    if (cfg.eks.nodeGroup.enabled) {
      nodeGroup = new NodeGroup(this, 'NodeGroup', {
        names, envName: cfg.name, tags: tagsFor(cfg), clusterName, nodeRoleArn: nodeRole!.arn, subnetIds: privateSubnetIds, sizes,
      });
      for (const addon of addonsBeforeNodes.all) nodeGroup.nodegroup.node.addDependency(addon);
    }
    // These add-ons run as Deployments: without nodes they never become ACTIVE and the deploy would hang.
    // So they wait for this stack's node group — or, on a cluster you bring, for the nodes you already have.
    if (nodeGroup || !cfg.eks.enabled) {
      const ebsCsiRole = roleEnabled(cfg, 'ebsCsi') ? createOrImportRole(this, ebsCsiRoleSpec(iamInputs), cfg) : undefined;
      const addonsAfterNodes = new EksAddonsAfterNodes(this, 'AddonsAfterNodes', {
        clusterName, eksConfig: cfg.eks, workloadIdentity: cfg.workloadIdentity, ebsCsiRoleArn: ebsCsiRole?.arn,
        volumeTags: tagsFor(cfg),
      });
      if (nodeGroup) addonsAfterNodes.node.addDependency(nodeGroup);
    }

    // =========================================================================
    // 7 S3 buckets
    // =========================================================================
    new S3Buckets(this, 'Buckets', { cfg, names, removalPolicy: dataRemoval, s3GatewayEndpointId: network.s3GatewayEndpointId });

    // =========================================================================
    // 8 Data stores: RDS PostgreSQL x2, ElastiCache Valkey
    // =========================================================================
    const postgres = new Postgres(this, 'Postgres', {
      cfg, names, sizes, subnetIds: privateSubnetIds, securityGroupId: sgs.rds?.securityGroupId, removalPolicy: databaseRemoval,
    });
    let valkey: ValkeyInfo | undefined = cfg.valkey.existing;
    if (cfg.valkey.enabled) {
      valkey = new Valkey(this, 'Valkey', {
        cfg, names, sizes, subnetIds: privateSubnetIds, securityGroupId: sgs.cache!.securityGroupId, removalPolicy: databaseRemoval,
      }).info;
    }
    iamInputs.coreDbResourceId = postgres.core?.resourceId ?? '*';
    iamInputs.metastoreDbResourceId = postgres.metastore?.resourceId ?? '*';
    iamInputs.rdsMasterSecretArns = [postgres.core, postgres.metastore].filter((db) => db !== undefined).map((db) => db!.masterSecretArn);

    // =========================================================================
    // 9 Secrets Manager
    // =========================================================================
    if (cfg.secrets.enabled) {
      new AppSecrets(this, 'Secrets', {
        cfg, names, removalPolicy: dataRemoval, core: postgres.core, metastore: postgres.metastore, valkey,
      });
    }

    // =========================================================================
    // 10 Workload roles (one per Kubernetes workload) and, for Pod Identity, their bindings
    // =========================================================================
    if (cfg.postgres.core.enabled) assertSet(iamInputs.coreDbResourceId, 'the core database resource ID');
    if (cfg.postgres.metastore.enabled) assertSet(iamInputs.metastoreDbResourceId, 'the metastore resource ID');
    const workload: { spec: RoleSpec; role: RoleRef }[] = [];
    const addWorkloadRole = (spec: RoleSpec) => {
      const role = createOrImportRole(this, spec, cfg);
      workload.push({ spec, role });
      return role;
    };
    const langsmithRole = roleEnabled(cfg, 'langsmith') ? addWorkloadRole(langsmithRoleSpec(iamInputs)) : undefined;
    const smithdbRole = roleEnabled(cfg, 'smithdb') ? addWorkloadRole(smithdbRoleSpec(iamInputs)) : undefined;
    const esoRole = roleEnabled(cfg, 'externalSecrets') ? addWorkloadRole(externalSecretsRoleSpec(iamInputs)) : undefined;
    let lbcRole: RoleRef | undefined;
    if (roleEnabled(cfg, 'loadBalancerController')) {
      if (!cfg.existingRoles.loadBalancerController) {
        // The controller's published policy, as a customer-managed policy <name>-lbc.
        iamInputs.loadBalancerControllerPolicyArn = new iam.CfnManagedPolicy(this, 'LoadBalancerControllerPolicy', {
          managedPolicyName: names.lbcManagedPolicy,
          description: 'AWS Load Balancer Controller v3.5.0 (published policy)',
          policyDocument: loadBalancerControllerPolicy(Aws.PARTITION),
        }).ref;
      }
      lbcRole = addWorkloadRole(loadBalancerControllerRoleSpec(iamInputs));
    }
    const caRole = roleEnabled(cfg, 'clusterAutoscaler') ? addWorkloadRole(clusterAutoscalerRoleSpec(iamInputs)) : undefined;

    if (!irsa && workload.length > 0) {
      new PodIdentityBindings(this, 'PodIdentity', { clusterName, roles: workload });
    }

    // =========================================================================
    // 11 Private DNS zone
    // =========================================================================
    let zoneId = cfg.dns.privateZone.existingZoneId;
    if (cfg.dns.privateZone.enabled) {
      zoneId = new PrivateDns(this, 'Dns', { cfg, vpc }).zoneId;
    }

    // =========================================================================
    // 12 Internal ALB -> Envoy Gateway (ingress.mode 'envoy-gateway'; with 'alb', the Load Balancer
    //    Controller creates the ALB during `helm install` instead)
    // =========================================================================
    let loadBalancer: LoadBalancer | undefined;
    if (ingressMode(cfg) === 'envoy-gateway' && cfg.eks.enabled) {
      loadBalancer = new LoadBalancer(this, 'Ingress', {
        cfg, names, vpcId: network.vpcId, subnetIds: privateSubnetIds,
        albSecurityGroupId: sgs.alb!.securityGroupId,
        clusterSecurityGroupId: clusterSecurityGroupId!,
        zoneId,
        deletionProtection: sizes.deletionProtection,
      });
    }

    // =========================================================================
    // 13 Bastion (optional)
    // =========================================================================
    let bastionInstanceId: string | undefined;
    if (cfg.bastion.enabled) {
      const profile = createOrImportBastionInstanceProfile(this, cfg, names, bastionRole!);
      bastionInstanceId = new Bastion(this, 'Bastion', {
        cfg, names, vpc, vpcCidrs: network.vpcCidrs, subnetIds: privateSubnetIds, instanceProfileName: profile,
      }).instanceId;
    }

    // =========================================================================
    // Outputs for post-deploy/ (lib/outputs.ts)
    // =========================================================================
    addOutputs(this, {
      Name: cfg.name,
      Region: cfg.region,
      Account: cfg.account,
      WorkloadIdentity: cfg.workloadIdentity,
      SmithdbTier: sizes.smithdbTier,
      SmithdbResources: sizes.smithdbResources,
      ClusterName: clusterName,
      ClusterSecurityGroupId: clusterSecurityGroupId,
      VpcId: network.vpcId,
      VpcCidrs: network.vpcCidrs.join(','),
      PrivateSubnetIds: privateSubnetIds.join(','),
      PodSubnets: network.podSubnets.map((s) => `${s.az}=${s.id}`).join(','),
      AlbSecurityGroupId: sgs.alb?.securityGroupId,
      KmsKeyArn: secretsKeyArn,
      BlobBucket: cfg.s3.blob.enabled || cfg.s3.blob.existingBucketName ? names.blobBucket : undefined,
      SmithdbBucket: cfg.s3.smithdb.enabled || cfg.s3.smithdb.existingBucketName ? names.smithdbBucket : undefined,
      SecretsPrefix: cfg.secrets.enabled ? names.secretsPrefix : undefined,
      ConnectionsSecretName: cfg.secrets.enabled && postgres.core && postgres.metastore && valkey ? names.secret('connections') : undefined,
      CoreDbEndpoint: postgres.core?.endpoint,
      CoreDbMasterSecretArn: postgres.core?.masterSecretArn,
      MetastoreDbEndpoint: postgres.metastore?.endpoint,
      MetastoreDbMasterSecretArn: postgres.metastore?.masterSecretArn,
      ValkeyEndpoint: valkey?.primaryEndpoint,
      PrivateZoneId: zoneId,
      Hostname: cfg.dns.hostname,
      CertificateArn: cfg.dns.certificateArn,
      IngressMode: ingressMode(cfg),
      TargetGroupArn: loadBalancer?.targetGroupArn,
      LoadBalancerDnsName: loadBalancer?.loadBalancerDnsName,
      LangsmithNamespace: cfg.kubernetes.langsmithNamespace,
      LangsmithRoleArn: langsmithRole?.arn,
      SmithdbRoleArn: smithdbRole?.arn,
      ExternalSecretsRoleArn: esoRole?.arn,
      LoadBalancerControllerRoleArn: lbcRole?.arn,
      ClusterAutoscalerRoleArn: caRole?.arn,
      BastionInstanceId: bastionInstanceId,
    });
  }
}

/** A role input that must have been filled in by an earlier block (see iamInputs above). */
function assertSet(value: string, what: string): void {
  if (value === '*' || value === '') throw new Error(`langsmith-stack: ${what} is not set yet — a block was moved above the one that creates it.`);
}

// validateConfig: every example is valid, and each rule fires with a readable message.
import * as fs from 'fs';
import * as path from 'path';
import { effectiveSize, ENVIRONMENT_PROTECTION, explainSizes, ingressMode, SMITHDB_LAB_LARGEST_POD_VCPU, instanceVcpus, resolveSizes, SIZE_PRESETS, validateConfig } from '../lib/config';
import { namesFor } from '../lib/naming';
import { EXAMPLES, loadConfig, synth } from './helpers';

describe('example configs', () => {
  test.each(EXAMPLES)('%s is valid', (name) => {
    expect(() => validateConfig(loadConfig(name))).not.toThrow();
  });
});

describe('validation rules', () => {
  const base = () => loadConfig('example');

  test('name must be short and lowercase', () => {
    const cfg = base();
    cfg.name = 'My_LangSmith_Install_Name';
    expect(() => validateConfig(cfg)).toThrow(/name "My_LangSmith_Install_Name"/);
    for (const name of ['ls-', 'ls--dev']) { // RDS identifiers reject a trailing or double hyphen
      cfg.name = name;
      expect(() => validateConfig(cfg)).toThrow(new RegExp(`name "${name}"`));
    }
  });

  test('a bucket is created or brought, not both', () => {
    const cfg = base();
    cfg.s3.blob = { enabled: true, existingBucketName: 'mine-blob' };
    expect(() => validateConfig(cfg)).toThrow(/s3.blob: set enabled = true or existingBucketName, not both/);
  });

  test('own VPC needs subnets in 2 AZs', () => {
    const cfg = base();
    cfg.network.privateSubnets = [{ id: 'subnet-1', az: 'us-east-1a' }];
    expect(() => validateConfig(cfg)).toThrow(/at least 2 subnets in different AZs/);
  });

  test('a store that is off must be given as existing when a role needs it', () => {
    const cfg = base();
    cfg.postgres.core.enabled = false;
    expect(() => validateConfig(cfg)).toThrow(/workloadRoles.langsmith needs the core database/);
    cfg.postgres.core.existing = { endpoint: 'db.example', resourceId: 'db-ABC', masterSecretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:x' };
    expect(() => validateConfig(cfg)).not.toThrow();
  });

  test('turning EKS off requires an existing cluster (and its issuer for IRSA)', () => {
    const cfg = base();
    cfg.eks.enabled = false;
    expect(() => validateConfig(cfg)).toThrow(/existingClusterName[\s\S]*existingOidcIssuer/);
  });

  test('Pod Identity needs the agent add-on', () => {
    const cfg = base();
    cfg.workloadIdentity = 'podIdentity';
    cfg.eks.addons.podIdentityAgent = false;
    expect(() => validateConfig(cfg)).toThrow(/podIdentityAgent = true/);
  });

  test('pre-created IRSA roles need the explicit acknowledgement', () => {
    const cfg = base();
    cfg.existingRoles.langsmith = 'arn:aws:iam::123456789012:role/mine';
    expect(() => validateConfig(cfg)).toThrow(/irsaTrustManagedExternally/);
    cfg.irsaTrustManagedExternally = true;
    expect(() => validateConfig(cfg)).not.toThrow();
  });

  test('an existing role for a component that is off is rejected', () => {
    const cfg = base();
    cfg.workloadRoles.clusterAutoscaler = false;
    cfg.existingRoles.clusterAutoscaler = 'arn:aws:iam::123456789012:role/ca';
    cfg.irsaTrustManagedExternally = true;
    expect(() => validateConfig(cfg)).toThrow(/existingRoles.clusterAutoscaler is set but workloadRoles.clusterAutoscaler is off/);
  });

  test('a cluster needs at least one admin', () => {
    const cfg = base();
    cfg.eks.adminRoleArns = [];
    expect(() => validateConfig(cfg)).toThrow(/nobody could use the cluster/);
  });

  test('hostname must be inside the private domain', () => {
    const cfg = base();
    cfg.dns.hostname = 'langsmith.other.internal';
    expect(() => validateConfig(cfg)).toThrow(/must be inside dns.privateZone.domain/);
  });

  test('ingress: envoy-gateway is the default and needs a certificate before deploy', () => {
    const cfg = base();
    delete cfg.ingress;
    expect(ingressMode(cfg)).toBe('envoy-gateway');
    cfg.dns.certificateArn = undefined;
    expect(() => validateConfig(cfg)).toThrow(/set dns.certificateArn[\s\S]*before `cdk deploy`/);
  });

  test("ingress: 'alb' mode may import the certificate after deploy", () => {
    const cfg = base();
    cfg.ingress = { mode: 'alb' };
    cfg.dns.certificateArn = undefined;
    expect(() => validateConfig(cfg)).not.toThrow();
  });

  test('ingress: unknown mode is rejected', () => {
    const cfg = base();
    cfg.ingress = { mode: 'nginx' as never };
    expect(() => validateConfig(cfg)).toThrow(/ingress.mode "nginx"/);
  });

  test('ingress: the certificate must be in the ALB account and region', () => {
    const cfg = base();
    cfg.dns.certificateArn = 'arn:aws:acm:eu-west-1:123456789012:certificate/00000000-0000-0000-0000-000000000000';
    expect(() => validateConfig(cfg)).toThrow(/account 123456789012 and region us-east-1/);
  });

  test("ingress: 'envoy-gateway' needs this stack's cluster and the Load Balancer Controller", () => {
    const cfg = base();
    cfg.eks.enabled = false;
    cfg.eks.existingClusterName = 'mine';
    cfg.eks.existingOidcIssuer = 'oidc.eks.us-east-1.amazonaws.com/id/EXAMPLE';
    cfg.workloadRoles.loadBalancerController = false;
    expect(() => validateConfig(cfg)).toThrow(/needs eks.enabled = true[\s\S]*workloadRoles.loadBalancerController = true/);
  });

  test('all errors are reported at once', () => {
    const cfg = base();
    cfg.account = '42';
    cfg.region = 'nowhere';
    expect(() => validateConfig(cfg)).toThrow(/account "42"[\s\S]*region "nowhere"/);
  });
});

describe('sizes: environment (how protected) and size (how big)', () => {
  test('size presets match README.md, Sizing', () => {
    expect(SIZE_PRESETS.small).toMatchObject({ nodeInstanceType: 'm6i.4xlarge', nodeMin: 3, nodeMax: 6, smithdbTier: 'small' });
    expect(SIZE_PRESETS.medium).toMatchObject({ nodeInstanceType: 'm6i.8xlarge', nodeMin: 3, nodeMax: 8, smithdbTier: 'medium' });
    expect(SIZE_PRESETS.large).toMatchObject({ nodeInstanceType: 'm6i.8xlarge', nodeMin: 4, nodeMax: 10, smithdbTier: 'medium' });
  });

  test('environments set only protection', () => {
    expect(ENVIRONMENT_PROTECTION.dev).toEqual({ pgMultiAz: false, pgBackupDays: 7, deletionProtection: false, cacheNodes: 1 });
    expect(ENVIRONMENT_PROTECTION.prod).toEqual({ pgMultiAz: true, pgBackupDays: 14, deletionProtection: true, cacheNodes: 3 });
    for (const env of Object.values(ENVIRONMENT_PROTECTION)) {
      expect(Object.keys(env).filter((k) => Object.keys(SIZE_PRESETS.small).includes(k))).toEqual([]);
    }
  });

  // LangChain's SmithDB metastore sizing: small 2 vCPU / 16 GiB, medium 4 vCPU / 32 GiB (r6g = 8 GiB per vCPU).
  test('the SmithDB metastore follows the SmithDB tier sizing', () => {
    expect(SIZE_PRESETS.small.pgMetastoreClass).toBe('db.r6g.large');
    expect(SIZE_PRESETS.medium.pgMetastoreClass).toBe('db.r6g.xlarge');
    expect(SIZE_PRESETS.large.pgMetastoreClass).toBe('db.r6g.xlarge');
  });

  test('the default size follows the environment: dev small, stage medium, prod large', () => {
    const cfg = loadConfig('example');
    delete cfg.size;
    for (const [env, size] of [['dev', 'small'], ['stage', 'medium'], ['prod', 'large']] as const) {
      cfg.environment = env;
      expect(effectiveSize(cfg)).toBe(size);
      expect(resolveSizes(cfg)).toMatchObject({ ...SIZE_PRESETS[size], ...ENVIRONMENT_PROTECTION[env] });
    }
  });

  test('size and environment combine freely: a small but protected prod', () => {
    const cfg = loadConfig('example');
    cfg.environment = 'prod';
    cfg.size = 'small';
    expect(resolveSizes(cfg)).toMatchObject({ nodeInstanceType: 'm6i.4xlarge', pgMultiAz: true, deletionProtection: true, cacheNodes: 3 });
  });

  test('every size and environment combination is valid and fits SmithDB on a node', () => {
    for (const environment of ['dev', 'stage', 'prod'] as const) {
      for (const size of ['small', 'medium', 'large'] as const) {
        const cfg = loadConfig('example');
        Object.assign(cfg, { environment, size });
        expect(() => validateConfig(cfg)).not.toThrow();
      }
    }
  });

  test('overrides win over size and environment', () => {
    const cfg = loadConfig('example');
    cfg.sizes = { nodeMax: 9, deletionProtection: true };
    expect(resolveSizes(cfg)).toMatchObject({ nodeMax: 9, nodeMin: 3, deletionProtection: true });
  });

  test.each([
    [{ environment: 'production' }, /environment "production"/],
    [{ size: 'huge' }, /size "huge"/],
    [{ sizes: { smithdbTier: 'large' } }, /sizes.smithdbTier "large"/],
  ])('unknown values are refused: %j', (change, message) => {
    const cfg = Object.assign(loadConfig('example'), change);
    expect(() => validateConfig(cfg)).toThrow(message);
  });

  describe("size 'lab'", () => {
    const lab = () => Object.assign(loadConfig('example'), { environment: 'dev', size: 'lab' });

    test('is valid with environment dev, on 2 m6i.4xlarge nodes with burstable databases and cache', () => {
      expect(() => validateConfig(lab())).not.toThrow();
      expect(resolveSizes(lab())).toMatchObject({
        nodeInstanceType: 'm6i.4xlarge', nodeDesired: 2, smithdbTier: 'small', smithdbResources: 'lab',
        pgCoreClass: 'db.t3.medium', pgMetastoreClass: 'db.t3.medium', cacheNodeType: 'cache.t3.medium',
      });
    });

    test.each(['stage', 'prod'] as const)('is refused with environment %s', (environment) => {
      expect(() => validateConfig(Object.assign(lab(), { environment }))).toThrow(/size 'lab' is for functional tests only/);
    });

    test('the node check uses the lab SmithDB pods (2 vCPU), not the tier', () => {
      expect(() => validateConfig(Object.assign(lab(), { sizes: { nodeInstanceType: 'm6i.xlarge' } }))).not.toThrow();
      expect(() => validateConfig(Object.assign(lab(), { sizes: { nodeInstanceType: 'm6i.large' } }))).toThrow(/too small/);
    });

    test('helm/smithdb-lab.yaml: its largest pod is the one the node check assumes, and the cache is plain gp3', () => {
      const text = fs.readFileSync(path.join(__dirname, '..', 'helm', 'smithdb-lab.yaml'), 'utf8');
      const cpus = [...text.matchAll(/cpu: "?(\d+)(m?)"?/g)].map((m) => Number(m[1]) / (m[2] ? 1000 : 1));
      expect(Math.max(...cpus)).toBe(SMITHDB_LAB_LARGEST_POD_VCPU);
      expect(text).toMatch(/storageClassName: gp3/);
    });

    test("the stack tells post-deploy/04 which SmithDB values to use", () => {
      const out = (cfg: ReturnType<typeof loadConfig>) => synth(cfg).langsmith.toJSON().Outputs.SmithdbResources.Value;
      expect(out(lab())).toBe('lab');
      expect(out(loadConfig('example'))).toBe('tier');
    });
  });

  test('npm run sizes says where each value came from', () => {
    const cfg = loadConfig('example');
    cfg.environment = 'stage';
    delete cfg.size;
    cfg.sizes = { nodeMax: 12 };
    const from = Object.fromEntries(explainSizes(cfg).map((r) => [r.field, r.from]));
    expect(from.nodeInstanceType).toBe("size 'medium' (default for 'stage')");
    expect(from.pgMultiAz).toBe("environment 'stage'");
    expect(from.nodeMax).toBe('sizes (override)');
  });

  test('subnet CIDRs never follow size, and a pinned addressPlan survives an environment change', () => {
    const cfg = loadConfig('examples/irsa-dev');
    const cidrs = (c: typeof cfg) => Object.values(synth(c).network!.toJSON().Resources)
      .filter((r: any) => r.Type === 'AWS::EC2::Subnet').map((r: any) => r.Properties.CidrBlock);
    expect(cidrs({ ...cfg, size: 'large' })).toEqual(cidrs({ ...cfg, size: 'small' }));
    expect(cidrs({ ...cfg, environment: 'prod' })).toEqual(cidrs({ ...cfg, environment: 'dev' })); // Layout B: one plan
    const pinned = { ...cfg, network: { ...cfg.network, layout: 'A' as const, podCidr: undefined, addressPlan: 'standard' as const } };
    expect(cidrs({ ...pinned, environment: 'prod' })).toEqual(cidrs({ ...pinned, environment: 'dev' }));
  });
});

describe('SmithDB pods must fit on a node', () => {
  test('vCPUs come from the instance size', () => {
    expect(instanceVcpus('m6i.large')).toBe(2);
    expect(instanceVcpus('m6i.xlarge')).toBe(4);
    expect(instanceVcpus('m6i.4xlarge')).toBe(16);
    expect(instanceVcpus('i4i.8xlarge')).toBe(32);
    expect(instanceVcpus('m6i.metal')).toBeUndefined();
  });

  test.each([
    ['m6i.2xlarge', 'small'], // 8 vCPU: the 8-vCPU compaction worker leaves nothing for system pods
    ['m6i.4xlarge', 'medium'], // 16 vCPU < the 28-vCPU query pod
  ] as const)('%s is refused for SmithDB tier %s', (type, tier) => {
    const cfg = loadConfig('example');
    cfg.sizes = { nodeInstanceType: type, smithdbTier: tier };
    expect(() => validateConfig(cfg)).toThrow(/too small for SmithDB tier/);
  });

  test('no check when this app does not create the node group', () => {
    const cfg = loadConfig('example');
    cfg.eks.nodeGroup.enabled = false;
    cfg.sizes = { nodeInstanceType: 'm6i.large' };
    expect(() => validateConfig(cfg)).not.toThrow();
  });

  test('the node group name carries the instance type, so a new type creates a new group', () => {
    const cfg = loadConfig('example');
    expect(namesFor(cfg).nodeGroupName).toBe('general-m6i-4xlarge');
    cfg.sizes = { nodeInstanceType: 'm7i.8xlarge' };
    expect(namesFor(cfg).nodeGroupName).toBe('general-m7i-8xlarge');
  });
});

describe('more validation rules', () => {
  const base = () => loadConfig('example');

  test("the size error names every size, 'lab' included", () => {
    const cfg = base();
    (cfg as any).size = 'huge';
    expect(() => validateConfig(cfg)).toThrow(/'lab', 'small', 'medium' or 'large'/);
  });

  test('node counts and storage overrides must be in order', () => {
    const cfg = base();
    cfg.sizes = { nodeMin: 5, nodeDesired: 3, nodeMax: 4 };
    expect(() => validateConfig(cfg)).toThrow(/nodeMin <= nodeDesired <= nodeMax/);
    cfg.sizes = { pgStorageGib: 600, pgMaxStorageGib: 500 };
    expect(() => validateConfig(cfg)).toThrow(/pgStorageGib .* pgMaxStorageGib/);
    cfg.sizes = { pgStorageGib: 500, pgMaxStorageGib: 540 }; // RDS wants at least 10% headroom
    expect(() => validateConfig(cfg)).toThrow(/pgMaxStorageGib of at least 550/);
    cfg.sizes = { pgStorageGib: 500, pgMaxStorageGib: 550 };
    expect(() => validateConfig(cfg)).not.toThrow();
  });

  test('your pod subnets must cover every AZ of your private subnets', () => {
    const cfg = loadConfig('examples/byo-vpc');
    cfg.network.podSubnets = [cfg.network.podSubnets![0]];
    expect(() => validateConfig(cfg)).toThrow(/podSubnets: no pod subnet in us-east-1b/);
  });

  test('network fields that would be ignored are rejected', () => {
    const own = base();
    own.network.layout = 'B';
    expect(() => validateConfig(own)).toThrow(/createVpc = false: remove layout/);
    const created = loadConfig('examples/irsa-dev');
    created.network.vpcCidrs = ['10.0.0.0/16'];
    expect(() => validateConfig(created)).toThrow(/createVpc = true: remove vpcCidrs/);
    const b = loadConfig('examples/irsa-dev'); // Layout B
    b.network.addressPlan = 'large';
    expect(() => validateConfig(b)).toThrow(/addressPlan is for pods in the private subnets/);
    delete b.network.layout; // the default is B too
    expect(() => validateConfig(b)).toThrow(/addressPlan is for pods in the private subnets/);
    expect(() => validateConfig(loadConfig('examples/layout-a'))).not.toThrow();
  });

  test('network.podCidr: a /16 inside 100.64.0.0/10 or 198.19.0.0/16, Layout B on a new VPC only', () => {
    const cfg = loadConfig('examples/irsa-dev');
    for (const ok of ['100.64.0.0/16', '100.127.0.0/16', '198.19.0.0/16']) {
      cfg.network.podCidr = ok;
      expect(() => validateConfig(cfg)).not.toThrow();
    }
    for (const bad of ['10.0.0.0/16', '100.128.0.0/16', '100.64.0.0/17', '100.64.1.0/16', '198.18.0.0/16']) {
      cfg.network.podCidr = bad;
      expect(() => validateConfig(cfg)).toThrow(/network.podCidr/);
    }
    const a = loadConfig('examples/layout-a');
    a.network.podCidr = '100.64.0.0/16';
    expect(() => validateConfig(a)).toThrow(/podCidr is for a separate pod range/);
    const own = loadConfig('examples/byo-vpc');
    own.network.podCidr = '100.64.0.0/16';
    expect(() => validateConfig(own)).toThrow(/createVpc = false: remove podCidr/);
  });

  test('pods in their own subnets need a VPC CNI that honours the cni=0 subnet tag', () => {
    for (const name of ['examples/irsa-dev', 'examples/byo-vpc']) {
      const cfg = loadConfig(name);
      cfg.eks.addonVersions = { vpcCni: 'v1.21.1-eksbuild.3' };
      expect(() => validateConfig(cfg)).toThrow(/vpcCni v1.21.1-eksbuild.3: pods in their own subnets need VPC CNI v1.22.2/);
      cfg.eks.addonVersions = { vpcCni: 'v1.22.2-eksbuild.1' };
      expect(() => validateConfig(cfg)).not.toThrow();
    }
    const a = loadConfig('examples/layout-a'); // pods in the private subnets: any version
    a.eks.addonVersions = { vpcCni: 'v1.19.0-eksbuild.1' };
    expect(() => validateConfig(a)).not.toThrow();
  });

  test('the example certificate ARN is refused once the account is a real one', () => {
    const cfg = base();
    expect(() => validateConfig(cfg)).not.toThrow(); // documentation account: examples stay valid
    cfg.account = '210987654321';
    cfg.dns.certificateArn = 'arn:aws:acm:us-east-1:210987654321:certificate/00000000-0000-0000-0000-000000000000';
    cfg.eks.adminRoleArns = ['arn:aws:iam::210987654321:role/Admin'];
    expect(() => validateConfig(cfg)).toThrow(/dns.certificateArn is the example placeholder/);
  });

  test('a KMS key needs a cluster of this app to encrypt', () => {
    const cfg = base();
    cfg.eks.enabled = false; cfg.eks.existingClusterName = 'mine'; cfg.eks.existingOidcIssuer = 'oidc.eks.us-east-1.amazonaws.com/id/EXAMPLE';
    cfg.ingress = { mode: 'alb' };
    expect(() => validateConfig(cfg)).toThrow(/kms.enabled = true but eks.enabled = false/);
    cfg.kms.enabled = false;
    expect(() => validateConfig(cfg)).not.toThrow();
  });

  test('an admin role listed twice is rejected', () => {
    const cfg = base();
    cfg.eks.adminRoleArns = [cfg.eks.adminRoleArns[0], cfg.eks.adminRoleArns[0]];
    expect(() => validateConfig(cfg)).toThrow(/adminRoleArns lists .* twice/);
  });

  test('cdkQualifier: lowercase letters and digits, max 10', () => {
    const cfg = base();
    cfg.cdkQualifier = 'Dev_Toolkit_1';
    expect(() => validateConfig(cfg)).toThrow(/cdkQualifier "Dev_Toolkit_1"/);
    cfg.cdkQualifier = 'lsdev';
    expect(() => validateConfig(cfg)).not.toThrow();
  });
});

describe('ingress.allowedCidrs', () => {
  test('the old top-level albAllowedCidrs is refused with the new place to put it', () => {
    const cfg = loadConfig('example') as any;
    cfg.albAllowedCidrs = ['10.0.0.0/8'];
    expect(() => validateConfig(cfg)).toThrow(/albAllowedCidrs has moved: write it as ingress: \{ allowedCidrs/);
  });

  test('only IPv4 CIDRs, and they open the ALB security group instead of the VPC CIDRs', () => {
    const cfg = loadConfig('examples/byo-vpc');
    const alb = Object.values(synth(cfg).resources).find((r) => (r.Properties as any)?.GroupName === 'ls-byovpc-alb')!;
    expect((alb.Properties as any).SecurityGroupIngress.map((i: any) => i.CidrIp)).toEqual(['10.0.0.0/8']);
    cfg.ingress!.allowedCidrs = ['10.0.0.0'];
    expect(() => validateConfig(cfg)).toThrow(/"10.0.0.0" is not an IPv4 CIDR/);
  });
});

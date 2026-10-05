// IAM: the role inventory, the two trust models, bring-your-own roles, and the IAM pack.
import * as fs from 'fs';
import * as path from 'path';
import { buildIamPack } from '../lib/iam/pack';
import { countOf, EXAMPLES, loadConfig, rolesByName, synth } from './helpers';

const ALL_ROLES = (n: string) => [
  `${n}-eks-cluster`, `${n}-eks-node`, `${n}-vpc-cni`, `${n}-ebs-csi`, `${n}-langsmith`,
  `${n}-smithdb`, `${n}-eso`, `${n}-lbc`, `${n}-cluster-autoscaler`,
].sort();

describe('role inventory', () => {
  test('example: exactly the documented roles (README.md, Appendix C)', () => {
    const s = synth(loadConfig('example'));
    expect(Object.keys(rolesByName(s)).sort()).toEqual(ALL_ROLES('langsmith-dev'));
  });

  // Found on the first live deploy: without it the bastion is a cluster admin that cannot write a kubeconfig.
  test('the bastion may describe its cluster (aws eks update-kubeconfig), nothing more', () => {
    const role = rolesByName(synth(loadConfig('examples/irsa-dev')))['ls-irsa-bastion'];
    const inline = role.Properties.Policies.find((p: { PolicyName: string }) => p.PolicyName === 'kubeconfig');
    expect(inline.PolicyDocument.Statement).toEqual([expect.objectContaining({
      Action: 'eks:DescribeCluster',
      Resource: { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':eks:us-east-1:123456789012:cluster/ls-irsa']] },
    })]);
  });

  test('bastion adds <name>-bastion and its instance profile', () => {
    const s = synth(loadConfig('examples/irsa-dev'));
    expect(Object.keys(rolesByName(s)).sort()).toEqual([...ALL_ROLES('ls-irsa'), 'ls-irsa-bastion'].sort());
    expect(countOf(s, 'AWS::IAM::InstanceProfile')).toBe(1);
  });

  test('switching a workload role off removes it', () => {
    const cfg = loadConfig('example');
    cfg.workloadRoles.clusterAutoscaler = false;
    cfg.workloadRoles.loadBalancerController = false;
    cfg.ingress = { mode: 'alb' }; // 'envoy-gateway' needs the controller (its TargetGroupBinding)
    const s = synth(cfg);
    const names = Object.keys(rolesByName(s));
    expect(names).not.toContain('langsmith-dev-cluster-autoscaler');
    expect(names).not.toContain('langsmith-dev-lbc');
    expect(countOf(s, 'AWS::IAM::ManagedPolicy')).toBe(0);
  });

  test('the node role has no CNI policy and no inline permissions', () => {
    const node = rolesByName(synth(loadConfig('example')))['langsmith-dev-eks-node'].Properties;
    expect(JSON.stringify(node.ManagedPolicyArns)).not.toContain('CNI');
    expect(node.Policies ?? []).toEqual([]);
  });

  test('permissions boundary goes on every role', () => {
    const cfg = loadConfig('example');
    cfg.permissionsBoundaryArn = 'arn:aws:iam::123456789012:policy/boundary';
    for (const role of Object.values(rolesByName(synth(cfg)))) {
      expect(role.Properties.PermissionsBoundary).toBe('arn:aws:iam::123456789012:policy/boundary');
    }
  });
});

describe('trust: IRSA vs Pod Identity', () => {
  test('IRSA: OIDC provider, Fn::Sub trust scoped to the ServiceAccount, no associations', () => {
    const s = synth(loadConfig('example'));
    expect(countOf(s, 'AWS::IAM::OIDCProvider')).toBe(1);
    expect(countOf(s, 'AWS::EKS::PodIdentityAssociation')).toBe(0);
    const trust = rolesByName(s)['langsmith-dev-eso'].Properties.AssumeRolePolicyDocument;
    const [text] = trust['Fn::Sub'];
    expect(text).toContain('"Federated": "${OidcProviderArn}"');
    expect(text).toContain('"${IssuerHost}:sub": "system:serviceaccount:external-secrets:external-secrets"');
    expect(text).toContain('"${IssuerHost}:aud": "sts.amazonaws.com"');
    // The shared LangSmith role covers every ServiceAccount in the namespace (StringLike).
    const ls = rolesByName(s)['langsmith-dev-langsmith'].Properties.AssumeRolePolicyDocument['Fn::Sub'][0];
    expect(ls).toContain('"StringLike"');
    expect(ls).toContain('system:serviceaccount:langsmith:*');
  });

  test('IRSA add-on roles are bound through the add-on', () => {
    const s = synth(loadConfig('example'));
    s.langsmith.hasResourceProperties('AWS::EKS::Addon', { AddonName: 'vpc-cni', ServiceAccountRoleArn: { 'Fn::GetAtt': ['VpcCniRole', 'Arn'] } });
  });

  test('Pod Identity: no OIDC provider, static trust, one association per ServiceAccount', () => {
    const cfg = loadConfig('examples/podidentity-dev');
    const s = synth(cfg);
    expect(countOf(s, 'AWS::IAM::OIDCProvider')).toBe(0);
    for (const [name, role] of Object.entries(rolesByName(s))) {
      if (/eks-cluster|eks-node|bastion/.test(name)) continue;
      expect(role.Properties.AssumeRolePolicyDocument).toEqual({
        Version: '2012-10-17',
        Statement: [{ Effect: 'Allow', Principal: { Service: 'pods.eks.amazonaws.com' }, Action: ['sts:AssumeRole', 'sts:TagSession'] }],
      });
    }
    // langsmith SAs + smithdb + eso + lbc + cluster-autoscaler
    expect(countOf(s, 'AWS::EKS::PodIdentityAssociation')).toBe(cfg.kubernetes.langsmithServiceAccounts.length + 4);
    s.langsmith.hasResourceProperties('AWS::EKS::PodIdentityAssociation', {
      Namespace: 'langsmith', ServiceAccount: 'langsmith-smithdb', RoleArn: { 'Fn::GetAtt': ['SmithdbRole', 'Arn'] },
    });
    s.langsmith.hasResourceProperties('AWS::EKS::Addon', {
      AddonName: 'vpc-cni', PodIdentityAssociations: [{ RoleArn: { 'Fn::GetAtt': ['VpcCniRole', 'Arn'] }, ServiceAccount: 'aws-node' }],
    });
    s.langsmith.hasResourceProperties('AWS::EKS::Addon', { AddonName: 'eks-pod-identity-agent' });
  });
});

describe('permissions are exactly the written ones', () => {
  test('LangSmith role: blob bucket, rds-db:connect per user, elasticache:Connect per user', () => {
    const role = rolesByName(synth(loadConfig('example')))['langsmith-dev-langsmith'].Properties;
    const doc = role.Policies.find((p: any) => p.PolicyName === 'langsmith-app').PolicyDocument;
    const sids = doc.Statement.map((st: any) => st.Sid);
    expect(sids).toEqual(['BlobBucket', 'BlobObjects', 'PostgresIamAuth', 'ValkeyIamAuth']);
    const rds = doc.Statement.find((st: any) => st.Sid === 'PostgresIamAuth');
    expect(rds.Resource).toHaveLength(4);
    expect(JSON.stringify(rds.Resource)).toContain('DbiResourceId');
    expect(role.Policies.map((p: any) => p.PolicyName)).toEqual(['langsmith-app']); // bedrock off
  });

  test('bedrock: true adds the bedrock inline policy', () => {
    const cfg = loadConfig('example');
    cfg.workloadRoles.bedrock = true;
    const role = rolesByName(synth(cfg))['langsmith-dev-langsmith'].Properties;
    expect(role.Policies.map((p: any) => p.PolicyName)).toEqual(['langsmith-app', 'bedrock']);
  });

  test('ESO reads <name>/* and the two RDS master secrets only', () => {
    const role = rolesByName(synth(loadConfig('example')))['langsmith-dev-eso'].Properties;
    const st = role.Policies[0].PolicyDocument.Statement[0];
    expect(st.Action).toEqual(['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret']);
    expect(st.Resource).toHaveLength(3);
  });

  test('Cluster Autoscaler may scale only this cluster', () => {
    const role = rolesByName(synth(loadConfig('example')))['langsmith-dev-cluster-autoscaler'].Properties;
    const scale = role.Policies[0].PolicyDocument.Statement[1];
    expect(scale.Condition).toEqual({ StringEquals: { 'aws:ResourceTag/k8s.io/cluster-autoscaler/langsmith-dev': 'owned' } });
  });
});

describe('bring your own roles', () => {
  test('every role pre-created: the stack creates no IAM at all', () => {
    const s = synth(loadConfig('examples/byo-iam'));
    for (const type of ['AWS::IAM::Role', 'AWS::IAM::Policy', 'AWS::IAM::ManagedPolicy', 'AWS::IAM::InstanceProfile', 'AWS::IAM::OIDCProvider']) {
      expect(countOf(s, type)).toBe(0);
    }
  });

  test('the given ARNs are used where the roles are needed', () => {
    const s = synth(loadConfig('examples/byo-iam'));
    s.langsmith.hasResourceProperties('AWS::EKS::Cluster', { RoleArn: 'arn:aws:iam::123456789012:role/platform/ls-byoiam-eks-cluster' });
    s.langsmith.hasResourceProperties('AWS::EKS::Nodegroup', { NodeRole: 'arn:aws:iam::123456789012:role/platform/ls-byoiam-eks-node' });
    s.langsmith.hasResourceProperties('AWS::EKS::PodIdentityAssociation', {
      ServiceAccount: 'external-secrets', RoleArn: 'arn:aws:iam::123456789012:role/platform/ls-byoiam-eso',
    });
    s.langsmith.hasResourceProperties('AWS::EKS::AccessEntry', { PrincipalArn: 'arn:aws:iam::123456789012:role/platform/ls-byoiam-bastion' });
  });

  test('the KMS key policy (not the role) grants the imported cluster role', () => {
    const s = synth(loadConfig('examples/byo-iam'));
    const key = Object.values(s.resources).find((r) => r.Type === 'AWS::KMS::Key')!;
    const statements = (key.Properties as any).KeyPolicy.Statement;
    const grant = statements.find((st: any) => st.Sid === 'EksClusterRoleEnvelopeEncryption');
    expect(grant.Principal).toEqual({ AWS: 'arn:aws:iam::123456789012:role/platform/ls-byoiam-eks-cluster' });
  });
});

describe('IAM pack (npm run iam-pack)', () => {
  const noNodeGroup = () => { const c = loadConfig('example'); c.eks.nodeGroup.enabled = false; return c; };
  test.each([...EXAMPLES.map((n) => [n, () => loadConfig(n)] as const), ['example without a node group', noNodeGroup] as const])(
    '%s: lists the same roles, with the same actions, as the stack', (_name, load) => {
    const cfg = load();
    const stackRoles = rolesByName(synth(cfg));
    const pack = buildIamPack(cfg);
    // Roles you bring are in the pack (to create) but not in the stack.
    expect(pack.roles.filter((r) => !r.broughtByYou).map((r) => r.roleName).sort()).toEqual(Object.keys(stackRoles).sort());
    const actions = (policies: any[]) => policies.flatMap((p) => p.Statement).flatMap((st: any) => [st.Action].flat()).sort();
    for (const packed of pack.roles.filter((r) => !r.broughtByYou)) {
      const deployed = stackRoles[packed.roleName].Properties;
      expect(actions(Object.values(packed.inlinePolicies))).toEqual(actions((deployed.Policies ?? []).map((p: any) => p.PolicyDocument)));
      expect(packed.managedPolicyArns.length).toBe((deployed.ManagedPolicyArns ?? []).length);
    }
  });

  test('Pod Identity roles can be written in advance: no placeholders in the trust', () => {
    const pack = buildIamPack(loadConfig('examples/byo-iam'));
    expect(JSON.stringify(pack.roles.map((r) => r.trustPolicy))).not.toContain('<');
    expect(pack.roles.every((r) => r.broughtByYou)).toBe(true);
  });

  test('IRSA trust shows placeholders until --issuer is given', () => {
    const cfg = loadConfig('example');
    const before = buildIamPack(cfg).roles.find((r) => r.roleName === 'langsmith-dev-eso')!;
    expect(JSON.stringify(before.trustPolicy)).toContain('<OIDC_ISSUER_HOST>:sub');
    const after = buildIamPack(cfg, { issuer: 'oidc.eks.us-east-1.amazonaws.com/id/EXAMPLE' }).roles.find((r) => r.roleName === 'langsmith-dev-eso')!;
    expect(after.trustPolicy).toMatchObject({
      Statement: [{
        Principal: { Federated: 'arn:aws:iam::123456789012:oidc-provider/oidc.eks.us-east-1.amazonaws.com/id/EXAMPLE' },
        Condition: { StringEquals: { 'oidc.eks.us-east-1.amazonaws.com/id/EXAMPLE:sub': 'system:serviceaccount:external-secrets:external-secrets' } },
      }],
    });
  });

  test('the partition follows the region (China, GovCloud)', () => {
    const cfg = loadConfig('examples/podidentity-dev');
    cfg.region = 'cn-north-1';
    const pack = buildIamPack(cfg);
    expect(JSON.stringify(pack.roles)).toContain('arn:aws-cn:iam::aws:policy/');
    expect(JSON.stringify(pack.roles)).not.toContain('arn:aws:');
  });

  test('GovCloud: roles and the Load Balancer Controller policy use arn:aws-us-gov', () => {
    const cfg = loadConfig('examples/podidentity-dev');
    cfg.region = 'us-gov-west-1';
    const pack = buildIamPack(cfg);
    const text = JSON.stringify([pack.roles, pack.managedPolicies]);
    expect(text).toContain('arn:aws-us-gov:');
    expect(text).not.toContain('arn:aws:');
  });

  // README.md, Appendix C lists every permission by hand: this fails when a policy changes and the README does not.
  test('README.md, Appendix C lists every role, managed policy, statement and action', () => {
    const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
    const appendix = readme.slice(readme.indexOf('### C. IAM roles and permissions'), readme.indexOf('### D. '));
    const cfg = loadConfig('examples/irsa-dev'); // every role, plus the bastion
    cfg.workloadRoles.bedrock = true;
    const listed = (role: string, text: string) => expect([role, text, appendix.includes(`\`${text}\``)]).toEqual([role, text, true]);
    for (const role of buildIamPack(cfg).roles) {
      const short = role.roleName.replace(`${cfg.name}-`, '');
      listed(short, short);
      for (const arn of role.managedPolicyArns) listed(short, arn.split('/').pop()!.replace(cfg.name, '<name>'));
      for (const doc of Object.values(role.inlinePolicies) as any[]) {
        for (const st of doc.Statement) {
          listed(short, st.Sid);
          for (const action of [st.Action].flat()) listed(short, action);
        }
      }
    }
  });
});

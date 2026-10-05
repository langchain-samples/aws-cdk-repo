// The IAM policy files in iam/ that an admin renders and creates by hand
// (README.md, Appendix C): valid JSON, only the documented placeholders, small enough.
import * as fs from 'fs';
import * as path from 'path';
import { namesFor } from '../lib/naming';
import { loadConfig } from './helpers';

const dir = path.join(__dirname, '..', 'iam');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));

test('there are policy files', () => {
  expect(files.sort()).toEqual([
    'cdk-execution-policy-1-network-compute.json',
    'cdk-execution-policy-2-data.json',
    'cdk-execution-policy-3-iam.json',
    'operator-policy.json',
  ]);
});

describe.each(files)('%s', (file) => {
  const text = fs.readFileSync(path.join(dir, file), 'utf8');

  test('is a valid policy document with a Sid on every statement', () => {
    const doc = JSON.parse(text);
    expect(doc.Version).toBe('2012-10-17');
    for (const st of doc.Statement) expect(st.Sid).toMatch(/^[A-Za-z0-9]+$/);
  });

  test('uses only the ${AWS_PARTITION}, ${ACCOUNT_ID}, ${AWS_REGION} and ${NAME} placeholders', () => {
    const placeholders = new Set(text.match(/\$\{[A-Z_]+\}/g) ?? []);
    for (const p of placeholders) expect(['${AWS_PARTITION}', '${ACCOUNT_ID}', '${AWS_REGION}', '${NAME}']).toContain(p);
  });

  // GovCloud (aws-us-gov) and China (aws-cn) ARNs do not start with arn:aws:.
  test('writes every ARN with the ${AWS_PARTITION} placeholder', () => {
    expect(text).not.toMatch(/"arn:aws[:-]/);
  });

  test('fits in a customer-managed policy (6,144 characters without whitespace)', () => {
    expect(JSON.stringify(JSON.parse(text)).length).toBeLessThan(6144);
  });
});

// Found on the first live deploy: CloudFormation reads SSM parameters while creating the change
// set — the CDK bootstrap version (every stack) and the bastion's AMI ({{resolve:ssm:...}}).
test('the execution policies let CloudFormation read the SSM parameters the templates use', () => {
  const doc = JSON.parse(fs.readFileSync(path.join(dir, 'cdk-execution-policy-1-network-compute.json'), 'utf8'));
  const st = doc.Statement.find((s: { Sid: string }) => s.Sid === 'ReadSsmParametersInTemplates');
  expect(st.Action).toContain('ssm:GetParameters');
  expect(st.Resource).toEqual(expect.arrayContaining([
    'arn:${AWS_PARTITION}:ssm:${AWS_REGION}:${ACCOUNT_ID}:parameter/cdk-bootstrap/*',
    'arn:${AWS_PARTITION}:ssm:${AWS_REGION}::parameter/aws/service/ami-amazon-linux-latest/*',
  ]));
});

// Found on the first live deploy: the main stack reads the VPC from <name>-network with
// Fn::GetStackOutput, which CloudFormation resolves by calling DescribeStacks as the execution role.
test('the execution policies let CloudFormation read the network stack outputs', () => {
  const doc = JSON.parse(fs.readFileSync(path.join(dir, 'cdk-execution-policy-1-network-compute.json'), 'utf8'));
  const st = doc.Statement.find((s: { Sid: string }) => s.Sid === 'ReadNetworkStackOutputs');
  expect(st).toMatchObject({ Action: 'cloudformation:DescribeStacks', Resource: 'arn:${AWS_PARTITION}:cloudformation:${AWS_REGION}:${ACCOUNT_ID}:stack/${NAME}-network/*' });
});

// Found on the first live deploy: AWS::RDS::DBParameterGroup reads the engine defaults first.
test('the execution policies let CloudFormation read RDS engine defaults', () => {
  const doc = JSON.parse(fs.readFileSync(path.join(dir, 'cdk-execution-policy-2-data.json'), 'utf8'));
  const st = doc.Statement.find((s: { Sid: string }) => s.Sid === 'RdsEngineDefaultsReadOnly');
  expect(st.Action).toContain('rds:DescribeEngineDefaultParameters');
});

// rds:CreateDBInstance is also authorized against the default option group the instance joins.
test('the execution policies let CloudFormation use the default Postgres option group', () => {
  const doc = JSON.parse(fs.readFileSync(path.join(dir, 'cdk-execution-policy-2-data.json'), 'utf8'));
  const st = doc.Statement.find((s: { Sid: string }) => s.Sid === 'RdsDefaultOptionGroup');
  expect(st).toMatchObject({
    Action: ['rds:CreateDBInstance', 'rds:ModifyDBInstance'],
    Resource: 'arn:${AWS_PARTITION}:rds:${AWS_REGION}:${ACCOUNT_ID}:og:default:postgres-*',
  });
});

// The replication group joins default.valkey<major> (lib/components/valkey.ts), which follows engineVersion.
test('the execution policies allow the default Valkey parameter group of any major version', () => {
  const doc = JSON.parse(fs.readFileSync(path.join(dir, 'cdk-execution-policy-2-data.json'), 'utf8'));
  const st = doc.Statement.find((s: { Sid: string }) => s.Sid === 'ElastiCacheForThisInstall');
  expect(st.Resource).toContain('arn:${AWS_PARTITION}:elasticache:${AWS_REGION}:${ACCOUNT_ID}:parametergroup:default.valkey*');
});

// Found on the first live deploy: updating AWS::IAM::ManagedPolicy (the <name>-lbc policy) lists
// what it is attached to first; deleting a role lists its instance profiles.
test('the IAM execution policy has the reads CloudFormation needs to update and delete roles and policies', () => {
  const doc = JSON.parse(fs.readFileSync(path.join(dir, 'cdk-execution-policy-3-iam.json'), 'utf8'));
  const actions = doc.Statement.flatMap((s: { Action: string | string[] }) => [s.Action].flat());
  for (const a of ['iam:ListEntitiesForPolicy', 'iam:ListPolicyTags', 'iam:ListRoleTags', 'iam:ListInstanceProfilesForRole']) {
    expect(actions).toContain(a);
  }
});

// Found on the first live deploy: EKS checks that AWSServiceRoleForAmazonEKSNodegroup exists
// (iam:GetRole as the caller) before it creates a node group.
test('the execution policies let AWS services check their service-linked roles', () => {
  const doc = JSON.parse(fs.readFileSync(path.join(dir, 'cdk-execution-policy-1-network-compute.json'), 'utf8'));
  const st = doc.Statement.find((s: { Sid: string }) => s.Sid === 'CheckServiceLinkedRolesExist');
  expect(st).toMatchObject({ Action: 'iam:GetRole', Resource: 'arn:${AWS_PARTITION}:iam::${ACCOUNT_ID}:role/aws-service-role/*' });
});

// Found on the first live deploy: the AWS::Route53::HostedZone handler reads the zone's query logging.
test('the execution policies let CloudFormation read hosted-zone query logging', () => {
  const doc = JSON.parse(fs.readFileSync(path.join(dir, 'cdk-execution-policy-2-data.json'), 'utf8'));
  const st = doc.Statement.find((s: { Sid: string }) => s.Sid === 'PrivateHostedZone');
  expect(st.Action).toContain('route53:ListQueryLoggingConfigs');
});

// Found on the first live deploy: updating an EKS add-on (and the cluster itself, e.g. closing the
// public endpoint) waits on the update with eks:DescribeUpdate.
test('the execution policies let CloudFormation follow EKS updates', () => {
  const doc = JSON.parse(fs.readFileSync(path.join(dir, 'cdk-execution-policy-1-network-compute.json'), 'utf8'));
  const st = doc.Statement.find((s: { Sid: string }) => s.Sid === 'EksClusterNodegroupsAddonsAccessPodIdentity');
  expect(st.Action).toEqual(expect.arrayContaining(['eks:DescribeUpdate', 'eks:ListUpdates']));
});

// ingress.mode 'envoy-gateway': CloudFormation creates the internal ALB, its listener and the Envoy
// target group (lib/components/load-balancer.ts) — only resources named after this install.
test('the execution policies let CloudFormation create the internal ALB, scoped to this install', () => {
  const doc = JSON.parse(fs.readFileSync(path.join(dir, 'cdk-execution-policy-1-network-compute.json'), 'utf8'));
  const st = doc.Statement.find((s: { Sid: string }) => s.Sid === 'InternalAlbForEnvoyGateway');
  expect(st.Action).toEqual(expect.arrayContaining([
    'elasticloadbalancing:CreateLoadBalancer', 'elasticloadbalancing:CreateTargetGroup', 'elasticloadbalancing:CreateListener',
    'elasticloadbalancing:AddTags',
  ]));
  expect(st.Action.some((a: string) => a.includes('*'))).toBe(false);
  const names = namesFor(loadConfig('example'));
  expect([names.alb, names.envoyTargetGroup]).toEqual(['langsmith-dev-alb', 'langsmith-dev-envoy']);
  expect(st.Resource).toEqual([
    'arn:${AWS_PARTITION}:elasticloadbalancing:${AWS_REGION}:${ACCOUNT_ID}:loadbalancer/app/${NAME}-alb/*',
    'arn:${AWS_PARTITION}:elasticloadbalancing:${AWS_REGION}:${ACCOUNT_ID}:targetgroup/${NAME}-envoy/*',
    'arn:${AWS_PARTITION}:elasticloadbalancing:${AWS_REGION}:${ACCOUNT_ID}:listener/app/${NAME}-alb/*',
  ]);
  const discovery = doc.Statement.find((s: { Sid: string }) => s.Sid === 'ReadOnlyDiscovery');
  expect(discovery.Action).toContain('elasticloadbalancing:Describe*');
});

test('the execution policies let CloudFormation write the hostname record', () => {
  const doc = JSON.parse(fs.readFileSync(path.join(dir, 'cdk-execution-policy-2-data.json'), 'utf8'));
  const st = doc.Statement.find((s: { Sid: string }) => s.Sid === 'PrivateHostedZone');
  expect(st.Action).toEqual(expect.arrayContaining(['route53:ChangeResourceRecordSets', 'route53:ListResourceRecordSets']));
});

test('the operator policy lets post-deploy/04 wait for healthy Envoy targets', () => {
  const doc = JSON.parse(fs.readFileSync(path.join(dir, 'operator-policy.json'), 'utf8'));
  expect(JSON.stringify(doc)).toContain('elasticloadbalancing:DescribeTargetHealth');
});

test('the CDK execution policies delete only what this environment tagged (EC2 deletes, KMS key deletion)', () => {
  const guarded = ['ec2:DeleteVpc', 'ec2:DeleteSubnet', 'ec2:DeleteSecurityGroup', 'ec2:TerminateInstances', 'ec2:DeleteNatGateway',
    'ec2:ReleaseAddress', 'ec2:DeleteLaunchTemplate', 'kms:ScheduleKeyDeletion', 'kms:PutKeyPolicy'];
  const statements = files.filter((f) => f.startsWith('cdk-execution-policy'))
    .flatMap((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).Statement as any[]);
  for (const action of guarded) {
    const allowing = statements.filter((st) => [st.Action].flat().includes(action));
    expect([action, allowing.length]).toEqual([action, 1]);
    expect(allowing[0].Condition).toEqual({ StringEquals: { 'aws:ResourceTag/langsmith-env': '${NAME}' } });
  }
});

/** Every statement of a policy file that allows the action. */
const allowing = (file: string, action: string) =>
  (JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')).Statement as any[]).filter((st) => [st.Action].flat().includes(action));
const tagCondition = (key: 'RequestTag' | 'ResourceTag') => ({ StringEquals: { [`aws:${key}/langsmith-env`]: '${NAME}' } });

test('the operator policy writes only the seeded secrets: the admin login is read-only', () => {
  const put = allowing('operator-policy.json', 'secretsmanager:PutSecretValue');
  expect(put).toHaveLength(1);
  expect(put[0].Resource.map((r: string) => r.replace(/.*secret:\$\{NAME\}\//, ''))).toEqual(['license-key-*', 'fernet/*']);
  const read = allowing('operator-policy.json', 'secretsmanager:GetSecretValue').flatMap((st) => st.Resource).join(' ');
  expect(read).toContain('initial-org-admin-password');
});

test('the operator policy imports or re-imports only certificates tagged for this environment', () => {
  for (const action of ['acm:ImportCertificate', 'acm:AddTagsToCertificate']) {
    expect(allowing('operator-policy.json', action).map((st) => st.Condition))
      .toEqual([tagCondition('RequestTag'), tagCondition('ResourceTag')]);
  }
});

test("execution policy 3 creates OIDC providers only with this environment's tag, and changes only its own", () => {
  const f = 'cdk-execution-policy-3-iam.json';
  expect(allowing(f, 'iam:CreateOpenIDConnectProvider').map((st) => st.Condition)).toEqual([tagCondition('RequestTag')]);
  for (const action of ['iam:DeleteOpenIDConnectProvider', 'iam:UntagOpenIDConnectProvider', 'iam:UpdateOpenIDConnectProviderThumbprint',
    'iam:AddClientIDToOpenIDConnectProvider']) {
    expect([action, allowing(f, action).map((st) => st.Condition)]).toEqual([action, [tagCondition('ResourceTag')]]);
  }
});

test('no action is allowed twice on the same resources (duplicates only cost policy size)', () => {
  for (const f of files) {
    const seen = new Set<string>();
    for (const st of JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).Statement) {
      for (const a of [st.Action].flat()) {
        const key = `${a} ${JSON.stringify(st.Resource)} ${JSON.stringify(st.Condition ?? {})}`;
        expect([f, key, seen.has(key)]).toEqual([f, key, false]);
        seen.add(key);
      }
    }
  }
});

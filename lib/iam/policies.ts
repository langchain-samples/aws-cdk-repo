// =============================================================================
// policies.ts — WHAT each role may do (its permission policies), written out.
//
// Every function returns a plain IAM policy document — the same JSON you would
// paste into the IAM console. No CDK grant*() helpers are used anywhere in this
// repo, so the only permissions that exist are the ones written in this file
// (plus the AWS managed policies named in roles.ts).
//
// The functions take plain strings. In the stack those strings may be
// CloudFormation references (e.g. an RDS resource ID that exists only after
// deploy); in iam-pack they are literal values or <PLACEHOLDERS>. Same function,
// same statements — that is how the printed IAM pack always matches the stack.
//
// Statement IDs (Sid) say what each statement allows; README.md, Appendix C summarizes them.
// =============================================================================

/** Common inputs. `partition` is 'aws' in commercial regions. */
export interface Where {
  partition: string;
  region: string;
  account: string;
}

// ---- cluster role --------------------------------------------------------------
/** EKS encrypts Kubernetes Secrets with this KMS key (envelope encryption). */
export function eksSecretsEncryptionPolicy(keyArn: string) {
  return {
    Version: '2012-10-17',
    Statement: [{
      Sid: 'EnvelopeEncryptionOfSecrets',
      Effect: 'Allow',
      Action: ['kms:Encrypt', 'kms:Decrypt', 'kms:ListGrants', 'kms:DescribeKey', 'kms:CreateGrant'],
      Resource: keyArn,
    }],
  };
}

// ---- bastion -------------------------------------------------------------------
/**
 * The bastion is a cluster admin (access entry), but kubectl first needs a kubeconfig:
 * `aws eks update-kubeconfig` reads the cluster's endpoint and CA with eks:DescribeCluster.
 */
export function eksDescribeClusterPolicy(w: Where, clusterName: string) {
  return {
    Version: '2012-10-17',
    Statement: [{
      Sid: 'WriteKubeconfig',
      Effect: 'Allow',
      Action: 'eks:DescribeCluster',
      Resource: `arn:${w.partition}:eks:${w.region}:${w.account}:cluster/${clusterName}`,
    }],
  };
}

// ---- shared LangSmith role -----------------------------------------------------
export interface LangSmithAppInputs extends Where {
  /** Blob bucket name. */
  blobBucket: string;
  /** DbiResourceId of the core PostgreSQL instance (db-...), or '*' when not known yet. */
  coreDbResourceId: string;
  /** PostgreSQL login roles in the core instance that LangSmith pods connect as. */
  coreDbUsers: readonly string[];
  /** ElastiCache replication group ID. */
  cacheReplicationGroupId: string;
  /** ElastiCache user IDs the pods connect as. */
  cacheUserIds: string[];
}

export function langsmithAppPolicy(i: LangSmithAppInputs) {
  const s3 = `arn:${i.partition}:s3:::${i.blobBucket}`;
  const ec = `arn:${i.partition}:elasticache:${i.region}:${i.account}`;
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'BlobBucket',
        Effect: 'Allow',
        Action: ['s3:ListBucket', 's3:GetBucketLocation', 's3:ListBucketMultipartUploads'],
        Resource: s3,
      },
      {
        Sid: 'BlobObjects',
        Effect: 'Allow',
        Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:AbortMultipartUpload', 's3:ListMultipartUploadParts'],
        Resource: `${s3}/*`,
      },
      {
        // IAM database authentication: pods ask for a 15-minute token instead of a password.
        Sid: 'PostgresIamAuth',
        Effect: 'Allow',
        Action: 'rds-db:connect',
        Resource: i.coreDbUsers.map((u) => `arn:${i.partition}:rds-db:${i.region}:${i.account}:dbuser:${i.coreDbResourceId}/${u}`),
      },
      {
        // ElastiCache IAM authentication: the replication group plus each user the pods connect as.
        Sid: 'ValkeyIamAuth',
        Effect: 'Allow',
        Action: 'elasticache:Connect',
        Resource: [`${ec}:replicationgroup:${i.cacheReplicationGroupId}`, ...i.cacheUserIds.map((u) => `${ec}:user:${u}`)],
      },
    ],
  };
}

/** Optional (workloadRoles.bedrock): call Amazon Bedrock models from LangSmith (playground, evaluators). */
export function bedrockPolicy(w: Where) {
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'InvokeModels',
        Effect: 'Allow',
        Action: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        Resource: [
          `arn:${w.partition}:bedrock:${w.region}::foundation-model/*`,
          `arn:${w.partition}:bedrock:${w.region}:${w.account}:inference-profile/*`,
        ],
      },
      { Sid: 'ListModels', Effect: 'Allow', Action: 'bedrock:ListFoundationModels', Resource: '*' },
    ],
  };
}

// ---- SmithDB role ----------------------------------------------------------------
export interface SmithdbInputs extends Where {
  smithdbBucket: string;
  /** DbiResourceId of the metastore instance, or '*' when not known yet. */
  metastoreDbResourceId: string;
  metastoreDbUser: string;
}

export function smithdbPolicy(i: SmithdbInputs) {
  const s3 = `arn:${i.partition}:s3:::${i.smithdbBucket}`;
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'SmithdbBucket',
        Effect: 'Allow',
        Action: ['s3:ListBucket', 's3:GetBucketLocation', 's3:ListBucketMultipartUploads'],
        Resource: s3,
      },
      {
        Sid: 'SmithdbObjects',
        Effect: 'Allow',
        Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:AbortMultipartUpload', 's3:ListMultipartUploadParts'],
        Resource: `${s3}/*`,
      },
      {
        Sid: 'MetastoreIamAuth',
        Effect: 'Allow',
        Action: 'rds-db:connect',
        Resource: `arn:${i.partition}:rds-db:${i.region}:${i.account}:dbuser:${i.metastoreDbResourceId}/${i.metastoreDbUser}`,
      },
    ],
  };
}

// ---- External Secrets Operator -------------------------------------------------
export interface SecretsReadInputs extends Where {
  /** e.g. "langsmith-dev/" — every app secret lives under it. */
  secretsPrefix: string;
  /** ARNs of the RDS-managed master-password secrets (read only by the DB bootstrap Job). */
  rdsMasterSecretArns: string[];
}

export function secretsReadPolicy(i: SecretsReadInputs) {
  return {
    Version: '2012-10-17',
    Statement: [{
      Sid: 'ReadLangSmithSecrets',
      Effect: 'Allow',
      Action: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
      Resource: [
        `arn:${i.partition}:secretsmanager:${i.region}:${i.account}:secret:${i.secretsPrefix}*`,
        ...i.rdsMasterSecretArns,
      ],
    }],
  };
}

// ---- Cluster Autoscaler -----------------------------------------------------------
/** Describe everything; change only Auto Scaling groups tagged as owned by THIS cluster. */
export function clusterAutoscalerPolicy(clusterName: string) {
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'Describe',
        Effect: 'Allow',
        Action: [
          'autoscaling:DescribeAutoScalingGroups', 'autoscaling:DescribeAutoScalingInstances',
          'autoscaling:DescribeLaunchConfigurations', 'autoscaling:DescribeScalingActivities', 'autoscaling:DescribeTags',
          'ec2:DescribeImages', 'ec2:DescribeInstanceTypes', 'ec2:DescribeLaunchTemplateVersions',
          'ec2:GetInstanceTypesFromInstanceRequirements', 'eks:DescribeNodegroup',
        ],
        Resource: '*',
      },
      {
        Sid: 'ScaleOwnClusterOnly',
        Effect: 'Allow',
        Action: ['autoscaling:SetDesiredCapacity', 'autoscaling:TerminateInstanceInAutoScalingGroup'],
        Resource: '*',
        // EKS tags the node group's Auto Scaling group with this key automatically.
        Condition: { StringEquals: { [`aws:ResourceTag/k8s.io/cluster-autoscaler/${clusterName}`]: 'owned' } },
      },
    ],
  };
}

// ---- AWS Load Balancer Controller ----------------------------------------------------
/**
 * The policy the AWS Load Balancer Controller project publishes for each release:
 * https://raw.githubusercontent.com/kubernetes-sigs/aws-load-balancer-controller/v3.5.0/docs/install/iam_policy.json
 * Vendored for chart 3.5.0 (appVersion v3.5.0). When you upgrade the chart, replace the file
 * with the one for the new appVersion.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const loadBalancerControllerPolicyDocument: object = require('./aws-load-balancer-controller-policy.json');
/** The published policy with its `arn:aws:` ARNs moved to the deployment's partition (GovCloud, China). */
export const loadBalancerControllerPolicy = (partition: string): object =>
  JSON.parse(JSON.stringify(loadBalancerControllerPolicyDocument).split('arn:aws:').join(`arn:${partition}:`));

// ---- AWS managed policies used by the roles ------------------------------------------
export const managed = (partition: string, name: string) => `arn:${partition}:iam::aws:policy/${name}`;

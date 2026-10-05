// =============================================================================
// 8 — RDS PostgreSQL x2
// WHAT  <name>-core      PostgreSQL 16: LangSmith + the Fleet/Insights/Chat databases.
//       <name>-metastore PostgreSQL 18: the SmithDB catalog. Each can be switched off.
// WHY   IAM database authentication: pods connect with 15-minute IAM tokens, so no database
//       password exists in the cluster. RDS generates the master password and keeps it in its
//       own Secrets Manager secret (rds!db-...); nobody types or sees it. Only the one-shot DB
//       bootstrap Job (post-deploy/04) reads it, to create the IAM-login roles.
//       rds.force_ssl=1 makes TLS mandatory.
// HOW   AWS::RDS::DBSubnetGroup, DBParameterGroup, DBInstance — L1, 1:1 with the flags of
//       `aws rds create-db-instance`. Takes 10-20 minutes.
// =============================================================================
import { aws_rds as rds, RemovalPolicy } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { LangSmithConfig, Sizes } from '../config';
import { Names } from '../naming';

/** What the rest of the stack needs from a database (created here or brought by you). */
export interface PostgresInfo {
  endpoint: string;
  /** DbiResourceId (db-...), used in rds-db:connect permissions. */
  resourceId: string;
  /** ARN of the secret holding the master credentials. */
  masterSecretArn: string;
}

export interface PostgresProps {
  cfg: LangSmithConfig;
  names: Names;
  sizes: Sizes;
  subnetIds: string[];
  securityGroupId?: string;
  /** SNAPSHOT keeps a final snapshot on delete; DESTROY does not. */
  removalPolicy: RemovalPolicy;
}

export class Postgres extends Construct {
  public readonly core?: PostgresInfo;
  public readonly metastore?: PostgresInfo;

  constructor(scope: Construct, id: string, props: PostgresProps) {
    super(scope, id);
    const { cfg, names } = props;
    this.core = cfg.postgres.core.existing;
    this.metastore = cfg.postgres.metastore.existing;
    if (!cfg.postgres.core.enabled && !cfg.postgres.metastore.enabled) return;

    const subnetGroup = new rds.CfnDBSubnetGroup(this, 'SubnetGroup', {
      dbSubnetGroupName: names.dbSubnetGroup,
      dbSubnetGroupDescription: `LangSmith ${cfg.name}`,
      subnetIds: props.subnetIds,
    });

    if (cfg.postgres.core.enabled) {
      this.core = this.instance('Core', props, subnetGroup, {
        identifier: names.coreDbInstance, engineVersion: cfg.postgres.core.engineVersion,
        instanceClass: props.sizes.pgCoreClass, dbName: 'langsmith', masterUsername: 'langsmith_admin',
      });
    }
    if (cfg.postgres.metastore.enabled) {
      this.metastore = this.instance('Metastore', props, subnetGroup, {
        identifier: names.metastoreDbInstance, engineVersion: cfg.postgres.metastore.engineVersion,
        instanceClass: props.sizes.pgMetastoreClass, dbName: 'smithdb', masterUsername: 'smithdb_admin',
      });
    }
  }

  private instance(id: string, props: PostgresProps, subnetGroup: rds.CfnDBSubnetGroup,
    o: { identifier: string; engineVersion: string; instanceClass: string; dbName: string; masterUsername: string }): PostgresInfo {
    const { sizes } = props;
    const major = o.engineVersion.split('.')[0];

    // One parameter group per instance: the engine family's defaults plus "TLS required".
    const parameters = new rds.CfnDBParameterGroup(this, `${id}Parameters`, {
      dbParameterGroupName: `${o.identifier}-pg${major}`,
      family: `postgres${major}`,
      description: `LangSmith ${o.identifier} PostgreSQL ${major} (TLS required)`,
      parameters: { 'rds.force_ssl': '1' },
    });

    const db = new rds.CfnDBInstance(this, id, {
      dbInstanceIdentifier: o.identifier,
      engine: 'postgres',
      engineVersion: o.engineVersion,
      dbInstanceClass: o.instanceClass,
      multiAz: sizes.pgMultiAz,
      storageType: 'gp3',
      allocatedStorage: String(sizes.pgStorageGib),
      maxAllocatedStorage: sizes.pgMaxStorageGib,
      storageEncrypted: true,
      masterUsername: o.masterUsername,
      manageMasterUserPassword: true, // RDS creates and keeps the password (rds!db-... secret)
      dbName: o.dbName,
      dbSubnetGroupName: subnetGroup.ref,
      vpcSecurityGroups: props.securityGroupId ? [props.securityGroupId] : undefined,
      dbParameterGroupName: parameters.ref,
      enableIamDatabaseAuthentication: true,
      publiclyAccessible: false,
      backupRetentionPeriod: sizes.pgBackupDays,
      copyTagsToSnapshot: true,
      deletionProtection: sizes.deletionProtection,
      autoMinorVersionUpgrade: true,
      allowMajorVersionUpgrade: true, // RDS rejects an engineVersion major bump without it
    });
    db.applyRemovalPolicy(props.removalPolicy);

    return {
      endpoint: db.attrEndpointAddress,
      resourceId: db.attrDbiResourceId,
      masterSecretArn: db.attrMasterUserSecretSecretArn,
    };
  }
}

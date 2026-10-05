// The Helm values (helm/) and manifests (k8s/) post-deploy/04 renders: the settings the docs and the
// CDK stack rely on. Read as text, like post-deploy does (envsubst), without a YAML parser.
import * as fs from 'fs';
import * as path from 'path';
import { ENVOY_PROXY_PORT } from '../lib/components/load-balancer';

const read = (...p: string[]) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
/** The YAML documents of a multi-document file, by kind. */
const docs = (text: string) => Object.fromEntries(text.split(/^---$/m)
  .map((d) => [/^kind: (\w+)/m.exec(d)?.[1], d] as const).filter(([k]) => k !== undefined)) as Record<string, string>;

describe("ingress mode 'envoy-gateway'", () => {
  const resources = docs(read('k8s', 'envoy-gateway-resources.yaml'));

  test('the Gateway listens on the port the CDK target group expects (Envoy adds 10000)', () => {
    const port = Number(/port: (\d+)/.exec(resources.Gateway)![1]);
    expect(port + 10000).toBe(ENVOY_PROXY_PORT);
    expect(read('k8s', 'envoy-gateway-target-group-binding.yaml')).toMatch(new RegExp(`serviceRef:\\s+name: \\$\\{ENVOY_SERVICE\\}\\s+port: ${port}`));
    expect(read('k8s', 'envoy-gateway-target-group-binding.yaml')).toMatch(/targetType: ip/);
  });

  test('the proxy Service is ClusterIP (no second load balancer), with 2 replicas and a disruption budget', () => {
    expect(resources.EnvoyProxy).toMatch(/envoyService:\s+type: ClusterIP/);
    expect(resources.EnvoyProxy).toMatch(/replicas: 2/);
    expect(resources.EnvoyProxy).toMatch(/envoyPDB:\s+minAvailable: 1/);
    expect(resources.EnvoyProxy).toMatch(/topologyKey: topology.kubernetes.io\/zone/);
  });

  test('only routes from the LangSmith namespace attach to the Gateway', () => {
    expect(resources.Gateway).toMatch(/namespace: \$\{NS\}/);
    expect(resources.Gateway).toMatch(/from: Same/);
  });

  test("Envoy's 15 s default request timeout is raised for every route on the Gateway", () => {
    expect(resources.BackendTrafficPolicy).toMatch(/kind: Gateway\s+name: langsmith-gateway/);
    expect(resources.BackendTrafficPolicy).toMatch(/requestTimeout: 3600s/);
  });

  test('connections from the ALB: idle longer than the ALB (3600 s), client IP from its X-Forwarded-For', () => {
    const idle = Number(/idleTimeout: (\d+)s/.exec(resources.ClientTrafficPolicy)![1]);
    expect(idle).toBeGreaterThan(3600);
    expect(resources.ClientTrafficPolicy).toMatch(/numTrustedHops: 1/);
  });

  test('the LangSmith overlay turns the Ingress off and the Gateway API on, for the same Gateway', () => {
    const overlay = read('helm', 'langsmith-ingress-envoy-gateway.yaml');
    expect(overlay).toMatch(/ingress:\s+enabled: false/);
    expect(overlay).toMatch(/gateway:\s+enabled: true\s+name: langsmith-gateway\s+namespace: \$\{NS\}/);
  });

  test('controller and proxy images come from your ECR', () => {
    const values = read('helm', 'envoy-gateway.yaml');
    expect(values).toMatch(/image: "\$\{IMAGE_BASE\}\/envoyproxy\/gateway:\$\{ENVOY_GATEWAY_CHART_VERSION\}"/);
    expect(values).toMatch(/image: "\$\{IMAGE_BASE\}\/envoyproxy\/envoy:\$\{ENVOY_PROXY_IMAGE_TAG\}"/);
    // The GatewayClass's EnvoyProxy replaces the chart's default proxy settings, image included.
    expect(resources.EnvoyProxy).toMatch(/container:[\s\S]*image: "\$\{IMAGE_BASE\}\/envoyproxy\/envoy:\$\{ENVOY_PROXY_IMAGE_TAG\}"/);
  });
});

test("ingress mode 'alb': the Ingress overlay keeps the ALB settings, the main values have none", () => {
  const overlay = read('helm', 'langsmith-ingress-alb.yaml');
  expect(overlay).toMatch(/ingressClassName: alb/);
  expect(overlay).toMatch(/certificate-arn: "\$\{CERTIFICATE_ARN\}"/);
  expect(read('helm', 'langsmith-values.yaml')).not.toMatch(/^ingress:/m);
});

describe('versions and images', () => {
  const lib = read('post-deploy', 'lib.sh');
  const pins = [...lib.matchAll(/\$\{([A-Z_]+(?:VERSION|TAG|IMAGE)):=([^}]+)\}/g)].map((m) => [m[1], m[2]] as const);

  test('post-deploy/lib.sh is the one place versions are set; settings.env.example only shows them, commented out', () => {
    const example = read('post-deploy', 'settings.env.example');
    expect(pins.length).toBeGreaterThanOrEqual(12);
    for (const [name, value] of pins) {
      expect(example).not.toMatch(new RegExp(`^${name}=`, 'm'));
      expect([name, new RegExp(`^# ${name}=(\\S+)`, 'm').exec(example)?.[1]]).toEqual([name, value]);
    }
  });

  test('every helper image has an exact tag (ECR repositories are immutable: a moving tag would freeze)', () => {
    for (const [name, value] of pins.filter(([n]) => n.endsWith('_IMAGE'))) {
      expect([name, /:(\d+\.\d+[\w.-]*)$/.test(value)]).toEqual([name, true]);
    }
    expect(read('helm', 'langsmith-values.yaml')).not.toMatch(/image: \$\{IMAGE_BASE\}\/(redis|pgvector)/);
  });
});

describe('k8s/ manifests', () => {
  test('the database bootstrap SQL is static: no placeholders, fixed names only', () => {
    for (const f of ['core.sql', 'metastore.sql', 'bootstrap.sh']) expect(read('k8s', 'db-bootstrap', f)).not.toMatch(/\$\{[A-Z_]+\}/);
    const core = read('k8s', 'db-bootstrap', 'core.sql');
    for (const role of ['langsmith_app', 'langsmith_fleet', 'langsmith_insights', 'langsmith_polly']) {
      // rds_iam is granted last for every role (docs: ORDER MATTERS on RDS).
      expect(core.lastIndexOf(`GRANT rds_iam TO ${role};`)).toBeGreaterThan(core.lastIndexOf(`REVOKE ${role} FROM CURRENT_USER;`));
    }
  });

  test('the bootstrap SQL revokes rds_iam only from a role that has it (no warnings on a first install)', () => {
    for (const f of ['core.sql', 'metastore.sql']) {
      const sql = read('k8s', 'db-bootstrap', f);
      expect([f, /^\s*REVOKE rds_iam/m.test(sql)]).toEqual([f, false]);
      for (const m of sql.matchAll(/REVOKE rds_iam FROM (\w+);/g)) {
        expect(sql).toContain(`IF pg_has_role('${m[1]}', 'rds_iam', 'MEMBER') THEN REVOKE rds_iam FROM ${m[1]};`);
      }
    }
  });

  test('ExternalSecrets: every Kubernetes Secret the chart reads, nothing secret in the template', () => {
    const es = read('k8s', 'externalsecrets.yaml');
    for (const name of ['langsmith-secrets', 'langsmith-postgres', 'langsmith-redis', 'smithdb-metastore',
      'langsmith-fleet-postgres', 'langsmith-fleet-redis', 'langsmith-insights-postgres', 'langsmith-insights-redis',
      'langsmith-polly-postgres', 'langsmith-polly-redis']) {
      expect(es).toContain(`name: ${name}, namespace: \${NS} }`);
    }
    expect(es).toMatch(/^ {6}\$\{ESO_AUTH\}$/m);
  });
});

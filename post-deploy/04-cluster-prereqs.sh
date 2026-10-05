#!/usr/bin/env bash
# =============================================================================
# post-deploy/04-cluster-prereqs.sh — prepare the EKS cluster for LangSmith
#
#   ./post-deploy/04-cluster-prereqs.sh all           run steps 1..9 in order (the usual way)
#   ./post-deploy/04-cluster-prereqs.sh list          show the steps
#   ./post-deploy/04-cluster-prereqs.sh 5             run one step (number or name)
#   ./post-deploy/04-cluster-prereqs.sh 7 8 9         run several, in the order given
#   ./post-deploy/04-cluster-prereqs.sh render        write every manifest and values file
#                                                     to out/ for review; nothing is applied
#
# Run after `cdk deploy` (outputs in out/cdk-outputs.json), 01-seed-secrets.sh and
# 03-mirror-images.sh. The last step does NOT install LangSmith: it validates the values and
# writes the exact `helm upgrade --install langsmith ...` command to out/helm-install-langsmith.sh
# for you to review and run. Then run 05.
#
# How to read this file
#   * Every step starts with WHAT / WHY / HOW / VERIFY.
#   * What gets applied is first written to out/ (render_* functions, no AWS or cluster
#     calls), then applied by the step. `render` runs only the render_* functions.
#   * The manifests are templates in k8s/ and the Helm values are templates in helm/; render
#     (post-deploy/lib.sh) fills in their ${PLACEHOLDERS} from the CDK outputs.
#   * Every step is safe to re-run: kubectl apply and helm upgrade --install converge.
#   * Workload identity (output WorkloadIdentity) changes three things:
#       irsa         ServiceAccounts get eks.amazonaws.com/role-arn annotations; the
#                    ClusterSecretStore authenticates with the ESO ServiceAccount's token.
#       podIdentity  no annotations (CDK created the pod identity associations); the
#                    ClusterSecretStore has no auth block (ESO's default credential chain).
#     In both modes the AWS region is set explicitly on every AWS-calling workload.
#
# NEEDS  aws, kubectl, helm, jq, envsubst; network access to the EKS API endpoint and to
#        the public Helm chart repositories; an IAM identity with an EKS access entry.
# =============================================================================
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
# shellcheck source-path=SCRIPTDIR/..
. post-deploy/lib.sh

CLUSTER_NAME=$(out ClusterName)

# =============================================================================
# 1 — kubeconfig
# =============================================================================
# WHAT   Writes out/kubeconfig for the cluster (all later steps use it).
# WHY    A kubeconfig per install, inside out/, never touches your ~/.kube/config.
# HOW    aws eks update-kubeconfig --kubeconfig out/kubeconfig.
# VERIFY kubectl get nodes   (with KUBECONFIG=out/kubeconfig)
step_kubeconfig() {
  section "1 kubeconfig"
  need_tools aws kubectl
  aws eks update-kubeconfig --name "$CLUSTER_NAME" --region "$AWS_REGION" --kubeconfig "$KUBECONFIG" >/dev/null
  kubectl get --raw /readyz >/dev/null || die "cannot reach the EKS API (private endpoint? run from inside the VPC / the bastion)"
  kubectl get nodes >&2
  log "KUBECONFIG=$KUBECONFIG"
}

# =============================================================================
# 2 — StorageClasses and the LangSmith namespace
# =============================================================================
# WHAT   gp3 (default) and smithdb-cache StorageClasses; the LangSmith namespace
#        (output LangsmithNamespace, default "langsmith").
# WHY    SmithDB caches trace data on a per-pod EBS volume; the docs require gp3 with
#        7000 IOPS / 1000 MiB/s for it. WaitForFirstConsumer creates the volume in the
#        pod's AZ. Volumes are encrypted with the AWS-managed EBS key.
#        gp2 (the EKS default) stops being the default class.
# HOW    k8s/storage.yaml -> out/storage.yaml; kubectl apply.
# VERIFY kubectl get storageclass ; kubectl get namespace <namespace>
render_storage() {
  render k8s/storage.yaml "$OUT_DIR/storage.yaml" NS
}
step_storage() {
  section "2 StorageClasses + namespace"
  need_kubeconfig
  render_storage
  kubectl apply -f "$OUT_DIR/storage.yaml"
  if kubectl get storageclass gp2 >/dev/null 2>&1; then
    kubectl annotate storageclass gp2 storageclass.kubernetes.io/is-default-class=false --overwrite >/dev/null
  fi
  log "StorageClasses gp3 (default), smithdb-cache; namespace $NS"
}

# =============================================================================
# 3 — Pod network check (only with a separate pod range: pod subnets)
# =============================================================================
# WHAT   Checks, and changes nothing, that pods get their IPs from the pod subnets (output
#        PodSubnets = "<az>=<subnet-id>,..."). Skipped when there is no PodSubnets output.
# WHY    The VPC CNI picks the subnets for pod IPs by tag (enhanced subnet discovery):
#        kubernetes.io/role/cni=1 on each pod subnet, =0 on each private subnet so the nodes'
#        own (routable) subnet serves no pod IPs. CDK sets these tags on a VPC it creates; on
#        your own VPC you set them. A missing tag, or a VPC CNI older than v1.22.2, quietly
#        puts pods on routable addresses or leaves them without an IP.
# HOW    aws ec2 describe-subnets (the tags); kubectl get ds aws-node (version, settings);
#        kubectl get pods (every pod that is not hostNetwork has an IP in a pod subnet).
# VERIFY kubectl get pods -A -o wide   (pod IPs in the pod CIDR, e.g. 100.64.x.x)
# Split a dotted IPv4 address on purpose (IFS=.):
# shellcheck disable=SC2086
ip2int() { local IFS=.; set -- $1; echo $(( ($1 << 24) + ($2 << 16) + ($3 << 8) + $4 )); }
in_cidr() {  # in_cidr <ip> <cidr>
  local bits=${2#*/} mask
  mask=$(( bits == 0 ? 0 : (0xFFFFFFFF << (32 - bits)) & 0xFFFFFFFF ))
  [ $(( $(ip2int "$1") & mask )) -eq $(( $(ip2int "${2%/*}") & mask )) ]
}
step_pod_network() {
  section "3 Pod network (pod subnets)"
  local pod_subnets pod_ids="" pair subnets bad ds image version pods cidrs outside="" ns_name ip cidr ok
  pod_subnets=$(out PodSubnets "")
  if [ -z "$pod_subnets" ]; then log "no PodSubnets output: pods use the private subnets (nothing to check)"; return; fi
  need_tools aws kubectl jq
  need_kubeconfig
  for pair in $(csv "$pod_subnets"); do pod_ids="$pod_ids ${pair#*=}"; done

  # 1. Subnet tags: pod subnets cni=1 (and, if any cluster tag is set, this cluster's), private subnets cni=0.
  # shellcheck disable=SC2046,SC2086
  subnets=$(aws ec2 describe-subnets --region "$AWS_REGION" --subnet-ids $pod_ids $(csv "$(out PrivateSubnetIds)") --output json)
  bad=$(jq -r --arg pods "$pod_ids" --arg cluster "$CLUSTER_NAME" '
    ($pods | split(" ") | map(select(. != ""))) as $p
    | .Subnets[]
    | ((.Tags // []) | map({(.Key): .Value}) | add // {}) as $t
    | (if (.SubnetId | IN($p[])) then "1" else "0" end) as $want
    | ($t | keys | map(select(startswith("cni.networking.k8s.aws/cluster/")))) as $clusterTags
    | (if ($t["kubernetes.io/role/cni"] // "") != $want
         then "\(.SubnetId) (\(.AvailabilityZone), \(.CidrBlock)): tag kubernetes.io/role/cni=\($t["kubernetes.io/role/cni"] // "<none>"), needs \($want)"
       elif $want == "1" and ($clusterTags | length) > 0 and ($clusterTags | index("cni.networking.k8s.aws/cluster/" + $cluster) | not)
         then "\(.SubnetId): tagged for other clusters only (\($clusterTags | join(", "))), not \($cluster)"
       else empty end)' <<<"$subnets")
  [ -z "$bad" ] || die "subnet tags for pod IPs are wrong (README.md, Network):
$bad"
  log "subnet tags: pod subnets kubernetes.io/role/cni=1, private subnets =0"

  # 2. The VPC CNI: new enough for the =0 tag, subnet discovery on, custom networking off.
  ds=$(kubectl -n kube-system get ds aws-node -o json)
  image=$(jq -r '.spec.template.spec.containers[] | select(.name == "aws-node") | .image' <<<"$ds")
  version=${image##*:v}; version=${version%%-*}
  [ "$(printf '%s\n%s\n' 1.22.2 "$version" | sort -V | head -n1)" = 1.22.2 ] \
    || die "the VPC CNI is $image; pods in their own subnets need v1.22.2 or later (eks.addonVersions.vpcCni)"
  [ "$(jq -r '.spec.template.spec.containers[] | select(.name == "aws-node") | .env[]? | select(.name == "ENABLE_SUBNET_DISCOVERY") | .value' <<<"$ds")" != false ] \
    || die "aws-node has ENABLE_SUBNET_DISCOVERY=false: pods cannot use the pod subnets"
  [ "$(jq -r '.spec.template.spec.containers[] | select(.name == "aws-node") | .env[]? | select(.name == "AWS_VPC_K8S_CNI_CUSTOM_NETWORK_CFG") | .value' <<<"$ds")" != true ] \
    || die "aws-node has custom networking on (AWS_VPC_K8S_CNI_CUSTOM_NETWORK_CFG=true), which overrides the subnet tags"
  log "VPC CNI v$version, subnet discovery on"

  # 3. Every pod that is not hostNetwork has an IP in a pod subnet.
  cidrs=$(jq -r --arg pods "$pod_ids" '($pods | split(" ")) as $p | .Subnets[] | select(.SubnetId | IN($p[])) | .CidrBlock' <<<"$subnets")
  pods=$(kubectl get pods -A -o json | jq -r '.items[] | select(.spec.hostNetwork != true and (.status.podIP // "") != "") | "\(.metadata.namespace)/\(.metadata.name) \(.status.podIP)"')
  if [ -z "$pods" ]; then warn "no pods with their own IP yet: run this step again after step 4"; return; fi
  while read -r ns_name ip; do
    ok=""
    for cidr in $cidrs; do in_cidr "$ip" "$cidr" && { ok=1; break; }; done
    [ -n "$ok" ] || outside="$outside
    $ns_name $ip"
  done <<<"$pods"
  [ -z "$outside" ] || die "these pods have IPs outside the pod subnets (${cidrs//$'\n'/ }):$outside
  Fix the tags above if needed, then replace the nodes once (scale the node group to 0 and back)."
  log "every pod IP is in a pod subnet ($(echo "$pods" | wc -l | tr -d ' ') pods)"
}

# =============================================================================
# 4 — Platform components (Helm)
# =============================================================================
# WHAT   AWS Load Balancer Controller, External Secrets Operator, Cluster Autoscaler, KEDA.
# WHY    LBC registers the Envoy pods in CDK's ALB target group (ingress mode 'envoy-gateway',
#        step 5), or turns the LangSmith Ingress into an internal ALB ('alb'). ESO syncs Secrets
#        Manager into Kubernetes Secrets. Cluster Autoscaler adds/removes nodes within the node
#        group's min..max (installed only when CDK created its role, output
#        ClusterAutoscalerRoleArn). KEDA is required by LangSmith Deployments.
# HOW    helm upgrade --install with pinned chart versions (post-deploy/lib.sh), images from
#        your ECR, and the workload identity on each ServiceAccount.
#        Values: helm/<chart>.yaml rendered into out/<chart>.yaml.
#          irsa         serviceAccount annotations = { eks.amazonaws.com/role-arn: <role> }
#          podIdentity  serviceAccount annotations = {}  (CDK created the associations)
#        The region is explicit for every AWS-calling controller: LBC (region, vpcId),
#        Cluster Autoscaler (awsRegion), ESO (on the ClusterSecretStore, step 7).
# VERIFY kubectl get deploy -n kube-system ; kubectl get deploy -n external-secrets ; kubectl get deploy -n keda
# The upper-case locals are read by envsubst (render exports them):
# shellcheck disable=SC2034
render_platform() {
  local VPC_ID LBC_SA_ANNOTATIONS ESO_SA_ANNOTATIONS CLUSTER_AUTOSCALER_SA_ANNOTATIONS role
  VPC_ID=$(out VpcId)
  role=""; [ "$WORKLOAD_IDENTITY" = irsa ] && role=$(out LoadBalancerControllerRoleArn)
  LBC_SA_ANNOTATIONS=$(sa_annotations "$role")
  role=""; [ "$WORKLOAD_IDENTITY" = irsa ] && role=$(out ExternalSecretsRoleArn)
  ESO_SA_ANNOTATIONS=$(sa_annotations "$role")
  render helm/aws-load-balancer-controller.yaml "$OUT_DIR/aws-load-balancer-controller.yaml" \
    CLUSTER_NAME AWS_REGION VPC_ID IMAGE_BASE LBC_SA_ANNOTATIONS NAME
  render helm/external-secrets.yaml "$OUT_DIR/external-secrets.yaml" IMAGE_BASE ESO_SA_ANNOTATIONS
  if [ -n "$(out ClusterAutoscalerRoleArn "")" ]; then
    role=""; [ "$WORKLOAD_IDENTITY" = irsa ] && role=$(out ClusterAutoscalerRoleArn)
    CLUSTER_AUTOSCALER_SA_ANNOTATIONS=$(sa_annotations "$role")
    render helm/cluster-autoscaler.yaml "$OUT_DIR/cluster-autoscaler.yaml" \
      AWS_REGION CLUSTER_NAME IMAGE_BASE CLUSTER_AUTOSCALER_IMAGE_TAG CLUSTER_AUTOSCALER_SA_ANNOTATIONS
  else
    rm -f "$OUT_DIR/cluster-autoscaler.yaml"
  fi
  render helm/keda.yaml "$OUT_DIR/keda.yaml" IMAGE_BASE
}
step_platform() {
  section "4 Platform charts: LBC, ESO, Cluster Autoscaler, KEDA ($WORKLOAD_IDENTITY)"
  need_tools helm kubectl envsubst
  need_kubeconfig
  render_platform

  helm upgrade --install aws-load-balancer-controller aws-load-balancer-controller --repo "$LBC_CHART_REPO" \
    --version "$LBC_CHART_VERSION" -n kube-system --wait -f "$OUT_DIR/aws-load-balancer-controller.yaml"
  # Its admission webhook must answer before anything creates an Ingress or a TargetGroupBinding.
  wait_for_endpoints kube-system aws-load-balancer-webhook-service

  helm upgrade --install external-secrets external-secrets --repo "$ESO_CHART_REPO" \
    --version "$ESO_CHART_VERSION" -n external-secrets --create-namespace --wait -f "$OUT_DIR/external-secrets.yaml"

  if [ -s "$OUT_DIR/cluster-autoscaler.yaml" ]; then
    helm upgrade --install cluster-autoscaler cluster-autoscaler --repo "$CLUSTER_AUTOSCALER_CHART_REPO" \
      --version "$CLUSTER_AUTOSCALER_CHART_VERSION" -n kube-system --wait -f "$OUT_DIR/cluster-autoscaler.yaml"
  else
    log "no ClusterAutoscalerRoleArn output: Cluster Autoscaler skipped (turned off in the CDK config)"
  fi

  helm upgrade --install keda keda --repo "$KEDA_CHART_REPO" \
    --version "$KEDA_CHART_VERSION" -n keda --create-namespace --wait -f "$OUT_DIR/keda.yaml"
  kubectl get deploy -n kube-system >&2
  kubectl get deploy -n external-secrets >&2; kubectl get deploy -n keda >&2
}

# =============================================================================
# 5 — Envoy Gateway, bound to CDK's ALB (ingress mode 'envoy-gateway' only)
# =============================================================================
# WHAT   The Envoy Gateway chart, the Gateway LangSmith uses (langsmith-gateway) and its Envoy
#        proxy pods, and a TargetGroupBinding that puts those pods behind the ALB CDK created.
#        Skipped with ingress mode 'alb' (output IngressMode).
# WHY    Envoy Gateway routes the ALB's traffic to LangSmith and to every agent deployment
#        with Gateway API HTTPRoutes (README.md, Network).
# HOW    1. the chart (controller + Gateway API CRDs), images checked against your ECR first;
#        2. k8s/envoy-gateway-resources.yaml: EnvoyProxy (2 proxy pods, ClusterIP Service),
#           GatewayClass, Gateway langsmith-gateway, and the timeout / client-IP policies;
#        3. wait until the Gateway is Programmed and the proxy pods are ready;
#        4. find the proxy Service by label (its name carries a hash) and apply
#           k8s/envoy-gateway-target-group-binding.yaml (target group = output TargetGroupArn);
#        5. wait until the ALB reports the proxy pods healthy.
# VERIFY kubectl -n <namespace> get gateway ; kubectl -n envoy-gateway-system get pods,targetgroupbinding
#        aws elbv2 describe-target-health --target-group-arn <TargetGroupArn>
render_envoy_gateway() {
  if [ "$INGRESS_MODE" = envoy-gateway ]; then
    render helm/envoy-gateway.yaml "$OUT_DIR/envoy-gateway.yaml" IMAGE_BASE ENVOY_GATEWAY_CHART_VERSION ENVOY_PROXY_IMAGE_TAG
    render k8s/envoy-gateway-resources.yaml "$OUT_DIR/envoy-gateway-resources.yaml" NS IMAGE_BASE ENVOY_PROXY_IMAGE_TAG
  else
    rm -f "$OUT_DIR/envoy-gateway.yaml" "$OUT_DIR/envoy-gateway-resources.yaml"
  fi
}

# envoy_service: the name of the Service Envoy Gateway created for langsmith-gateway ("" until it exists).
envoy_service() {
  kubectl -n envoy-gateway-system get svc -o jsonpath='{.items[0].metadata.name}' \
    -l "gateway.envoyproxy.io/owning-gateway-name=langsmith-gateway,gateway.envoyproxy.io/owning-gateway-namespace=$NS" 2>/dev/null || true
}

# The upper-case locals are read by envsubst (render exports them):
# shellcheck disable=SC2034
step_envoy_gateway() {
  local ENVOY_SERVICE TARGET_GROUP_ARN n states
  section "5 Envoy Gateway (ingress $INGRESS_MODE)"
  if [ "$INGRESS_MODE" = alb ]; then
    log "ingress mode alb: no Envoy Gateway (the Load Balancer Controller creates the ALB from the Ingress at helm install)"
    return
  fi
  need_tools aws helm kubectl envsubst
  need_kubeconfig
  render_envoy_gateway
  TARGET_GROUP_ARN=$(out TargetGroupArn)
  log "Envoy Gateway $ENVOY_GATEWAY_CHART_VERSION (proxy $ENVOY_PROXY_IMAGE_TAG)"
  helm template envoy-gateway "$ENVOY_GATEWAY_CHART" --version "$ENVOY_GATEWAY_CHART_VERSION" -n envoy-gateway-system \
    -f "$OUT_DIR/envoy-gateway.yaml" > "$OUT_DIR/envoy-gateway-rendered.yaml"
  check_images_in_ecr "$OUT_DIR/envoy-gateway-rendered.yaml"
  helm upgrade --install envoy-gateway "$ENVOY_GATEWAY_CHART" --version "$ENVOY_GATEWAY_CHART_VERSION" \
    -n envoy-gateway-system --create-namespace --wait -f "$OUT_DIR/envoy-gateway.yaml"

  kubectl get namespace "$NS" >/dev/null 2>&1 || die "namespace $NS is missing: run step 2 (storage) first"
  kubectl apply -f "$OUT_DIR/envoy-gateway-resources.yaml"
  kubectl -n "$NS" wait gateway/langsmith-gateway --for=condition=Programmed --timeout=300s \
    || die "the Gateway is not programmed: kubectl -n $NS describe gateway langsmith-gateway ; kubectl -n envoy-gateway-system logs deploy/envoy-gateway"

  for n in $(seq 30); do ENVOY_SERVICE=$(envoy_service); [ -n "$ENVOY_SERVICE" ] && break; log "waiting for the Envoy proxy Service ($n/30)"; sleep 10; done
  [ -n "$ENVOY_SERVICE" ] || die "no Envoy proxy Service for langsmith-gateway: kubectl -n envoy-gateway-system get svc,pods"
  kubectl -n envoy-gateway-system wait deploy --for=condition=Available --timeout=300s \
    -l "gateway.envoyproxy.io/owning-gateway-name=langsmith-gateway,gateway.envoyproxy.io/owning-gateway-namespace=$NS"
  render k8s/envoy-gateway-target-group-binding.yaml "$OUT_DIR/envoy-gateway-target-group-binding.yaml" ENVOY_SERVICE TARGET_GROUP_ARN
  kubectl apply -f "$OUT_DIR/envoy-gateway-target-group-binding.yaml"

  # The Load Balancer Controller registers the pod IPs; the ALB health-checks them every 15 s.
  for n in $(seq 30); do
    states=$(aws elbv2 describe-target-health --target-group-arn "$TARGET_GROUP_ARN" \
      --query 'TargetHealthDescriptions[].TargetHealth.State' --output text | tr '\t' ' ')
    case " $states " in
      *" healthy "*) case "$states" in *initial*|*unhealthy*|*draining*) ;; *) break ;; esac ;;
    esac
    log "ALB targets: ${states:-none registered yet} ($n/30)"; sleep 10
  done
  case " $states " in *" healthy "*) ;; *) die "the ALB has no healthy Envoy target: kubectl -n envoy-gateway-system describe targetgroupbinding langsmith-envoy" ;; esac
  log "ALB -> Envoy: targets $states"
  kubectl -n envoy-gateway-system get pods -o wide >&2
}

# =============================================================================
# 6 — Custom CA bundle (optional)
# =============================================================================
# WHAT   Secret langsmith-custom-ca (key ca-bundle.crt) from CUSTOM_CA_BUNDLE_FILE.
#        Skipped when CUSTOM_CA_BUNDLE_FILE is empty.
# WHY    If pods must trust a private CA (your certificate's issuer, a TLS-inspecting
#        proxy). The chart REPLACES the pods' trust store with this file, so the bundle
#        must also contain the public roots.
# HOW    kubectl create secret --dry-run=client -o yaml | kubectl apply (create or update).
#        The file content goes straight to the cluster; it is not written to out/.
# VERIFY kubectl -n <namespace> get secret langsmith-custom-ca
step_custom_ca() {
  section "6 Custom CA bundle"
  if [ -z "$CUSTOM_CA_BUNDLE_FILE" ]; then log "CUSTOM_CA_BUNDLE_FILE is empty: nothing to do"; return; fi
  [ -r "$CUSTOM_CA_BUNDLE_FILE" ] || die "CUSTOM_CA_BUNDLE_FILE '$CUSTOM_CA_BUNDLE_FILE' is not readable"
  grep -q 'BEGIN CERTIFICATE' "$CUSTOM_CA_BUNDLE_FILE" || die "$CUSTOM_CA_BUNDLE_FILE does not look like a PEM bundle"
  need_kubeconfig
  kubectl -n "$NS" create secret generic langsmith-custom-ca --from-file="ca-bundle.crt=$CUSTOM_CA_BUNDLE_FILE" \
    --dry-run=client -o yaml | kubectl apply -f - >/dev/null
  log "secret $NS/langsmith-custom-ca ($(grep -c 'BEGIN CERTIFICATE' "$CUSTOM_CA_BUNDLE_FILE") certificates)"
}

# =============================================================================
# 7 — ClusterSecretStore and ExternalSecrets
# =============================================================================
# WHAT   The ClusterSecretStore "aws-secretsmanager" and the ExternalSecrets that produce
#        the Kubernetes Secrets the chart reads: langsmith-secrets, langsmith-postgres,
#        langsmith-redis, smithdb-metastore, and a postgres + redis Secret for each of
#        Fleet, Insights and Chat (polly).
# WHY    Nothing secret lives in Helm values. CDK already created every Secrets Manager
#        secret under <SecretsPrefix>, including <SecretsPrefix>connections (host names and
#        IAM user names, no passwords); this step only maps them into Kubernetes.
#        Each add-on needs its own database and its own Redis URL. Redis database index:
#        0 core, 1 Fleet, 2 Chat, 3 Insights.
#        Store authentication depends on the workload identity:
#          irsa         auth.jwt.serviceAccountRef = external-secrets/external-secrets
#                       (ESO exchanges that ServiceAccount's token for the IRSA role)
#          podIdentity  no auth block: ESO uses its own pod's credentials (default chain)
# HOW    k8s/externalsecrets.yaml -> out/externalsecrets.yaml; kubectl apply; wait until every
#        ExternalSecret is Ready. Stops first if a secret 01 fills in still holds REPLACE_ME.
# VERIFY kubectl get clustersecretstore ; kubectl -n <namespace> get externalsecret
#        (all READY True). If one is not: kubectl -n <namespace> describe externalsecret <name>
# The upper-case locals are read by envsubst (render exports them):
# shellcheck disable=SC2034
render_externalsecrets() {
  local SECRETS_PREFIX CONNECTIONS_SECRET ESO_AUTH
  SECRETS_PREFIX=$(out SecretsPrefix); CONNECTIONS_SECRET=$(out ConnectionsSecretName)
  if [ "$WORKLOAD_IDENTITY" = irsa ]; then
    ESO_AUTH='auth: { jwt: { serviceAccountRef: { name: external-secrets, namespace: external-secrets } } }'
  else
    ESO_AUTH="# no auth block: ESO uses its own pod's credentials (EKS Pod Identity)"
  fi
  render k8s/externalsecrets.yaml "$OUT_DIR/externalsecrets.yaml" NS AWS_REGION SECRETS_PREFIX CONNECTIONS_SECRET ESO_AUTH
}
step_secrets() {
  section "7 ClusterSecretStore + ExternalSecrets ($WORKLOAD_IDENTITY)"
  need_kubeconfig
  # A secret that still holds REPLACE_ME would sync without error, and LangSmith would only fail
  # later (license, encryption keys). Stop here instead.
  local s p; p=$(out SecretsPrefix)
  for s in $SEEDED_SECRETS; do
    if secret_is_placeholder "$p$s"; then die "secret $p$s still holds $SECRET_PLACEHOLDER: run ./post-deploy/01-seed-secrets.sh first"; fi
  done
  render_externalsecrets
  kubectl apply -f "$OUT_DIR/externalsecrets.yaml"
  kubectl wait --for=condition=Ready clustersecretstore/aws-secretsmanager --timeout=180s
  kubectl -n "$NS" wait --for=condition=Ready externalsecret --all --timeout=180s
  kubectl -n "$NS" get externalsecret >&2
}

# =============================================================================
# 8 — Database bootstrap Job
# =============================================================================
# WHAT   A one-shot Kubernetes Job that creates the IAM-login roles (langsmith_app,
#        langsmith_fleet, langsmith_insights, langsmith_polly, smithdb_app), the 3 feature
#        databases, the extensions LangSmith needs, and hands each database to its role.
# WHY    RDS IAM auth needs a Postgres role with the rds_iam grant. ORDER MATTERS on RDS:
#        any role that inherits rds_iam becomes IAM-only — including the master user if
#        it is a member of such a role. So: extensions first (master still owns the DB),
#        ownership via a temporary membership after REVOKE rds_iam, and GRANT rds_iam last.
#        Doing this before the first chart migration means all tables belong to the app role.
# HOW    A temporary ExternalSecret (langsmith-db-admin) exposes the RDS-managed master
#        credentials (outputs CoreDbMasterSecretArn, MetastoreDbMasterSecretArn) to the Job
#        only; it is deleted when the Job ends, whatever the result. Safe to re-run.
#        The SQL is in k8s/db-bootstrap/ (core.sql, metastore.sql): fixed role and database
#        names only — nothing from your settings is put into SQL.
# VERIFY The Job log ends with "bootstrap complete".
# The upper-case locals are read by envsubst (render exports them):
# shellcheck disable=SC2034
render_db_bootstrap() {
  local CONNECTIONS_SECRET CORE_MASTER_SECRET META_MASTER_SECRET BOOTSTRAP_IMAGE f
  CONNECTIONS_SECRET=$(out ConnectionsSecretName)
  CORE_MASTER_SECRET=$(out CoreDbMasterSecretArn); META_MASTER_SECRET=$(out MetastoreDbMasterSecretArn)
  BOOTSTRAP_IMAGE=$(ecr_image "$BOOTSTRAP_PG_IMAGE")
  render k8s/db-admin-externalsecret.yaml "$OUT_DIR/db-admin-externalsecret.yaml" NS CONNECTIONS_SECRET CORE_MASTER_SECRET META_MASTER_SECRET
  render k8s/db-bootstrap/job.yaml "$TMP/db-bootstrap-job.yaml" NS BOOTSTRAP_IMAGE
  # The ConfigMap holds the three files of k8s/db-bootstrap/ as they are (indented under data:).
  {
    printf 'apiVersion: v1\nkind: ConfigMap\nmetadata: { name: langsmith-db-bootstrap, namespace: %s }\ndata:\n' "$NS"
    for f in bootstrap.sh core.sql metastore.sql; do
      printf '  %s: |\n' "$f"; sed 's/^/    /' "k8s/db-bootstrap/$f"
    done
    echo ---
    cat "$TMP/db-bootstrap-job.yaml"
  } > "$OUT_DIR/db-bootstrap.yaml"
}
remove_db_admin() {
  kubectl -n "$NS" delete externalsecret langsmith-db-admin --ignore-not-found >/dev/null || true
  kubectl -n "$NS" delete secret langsmith-db-admin --ignore-not-found >/dev/null || true
}
step_db_bootstrap() {
  section "8 Database bootstrap Job"
  local rc=0
  need_kubeconfig
  render_db_bootstrap
  # The master credentials leave the cluster whatever the outcome: also on an error or Ctrl-C.
  trap 'remove_db_admin; rm -rf "$TMP"' EXIT
  kubectl apply -f "$OUT_DIR/db-admin-externalsecret.yaml"
  kubectl -n "$NS" wait --for=condition=Ready externalsecret/langsmith-db-admin --timeout=180s || rc=$?
  if [ $rc -eq 0 ]; then
    kubectl -n "$NS" delete job langsmith-db-bootstrap --ignore-not-found --wait=true >/dev/null
    kubectl apply -f "$OUT_DIR/db-bootstrap.yaml"
    wait_job "$NS" langsmith-db-bootstrap 900 || rc=$?   # returns at once if the Job fails
    kubectl -n "$NS" logs job/langsmith-db-bootstrap --tail=50 >&2 || true
  fi
  remove_db_admin
  trap 'rm -rf "$TMP"' EXIT
  [ $rc -eq 0 ] || die "database bootstrap failed (log above; or: kubectl -n $NS describe externalsecret langsmith-db-admin). Fix, then re-run: ./post-deploy/04-cluster-prereqs.sh db-bootstrap"
  kubectl -n "$NS" delete job/langsmith-db-bootstrap configmap/langsmith-db-bootstrap --ignore-not-found >/dev/null
  log "roles and databases ready; master credentials removed from the cluster"
}

# =============================================================================
# 9 — LangSmith Helm values (render + validate; YOU run helm install)
# =============================================================================
# WHAT   Renders helm/langsmith-values.yaml into out/langsmith-values.yaml, validates it
#        with `helm template` against the pinned chart, and writes the exact
#        `helm upgrade --install langsmith ...` command to out/helm-install-langsmith.sh.
#        Re-run this step after any change to the values (it is the one you re-run most).
# WHY    `helm template` runs the chart's own validation, and this step refuses any image
#        that is not in your ECR. Installing is left to you so that you see and control
#        the one long-running, user-visible change (10-20 minutes, migrations first).
#        Workload identity: LANGSMITH_SA_ANNOTATIONS / SMITHDB_SA_ANNOTATIONS are the
#        role-arn annotations (irsa) or {} (podIdentity).
#        Ingress (output IngressMode) is a separate overlay, out/langsmith-ingress.yaml:
#          envoy-gateway  helm/langsmith-ingress-envoy-gateway.yaml: an HTTPRoute on langsmith-gateway
#                         (step 5), and the same Gateway for the operator's agent routes.
#          alb            helm/langsmith-ingress-alb.yaml: an Ingress; the Load Balancer Controller
#                         creates the internal ALB with the certificate, the <Name>-alb security
#                         group and the private subnets.
# HOW    render (envsubst, only the listed placeholders); helm template > out/rendered.yaml.
#        The values files, in order: VALUES_FILES (set by render_values), used for the check
#        and in out/helm-install-langsmith.sh, so both always use the same files.
#        With output SmithdbResources = lab (CDK `size: 'lab'`), helm/smithdb-lab.yaml is added
#        (reduced SmithDB resources, cache on plain gp3). EXTRA_VALUES_FILE (optional) goes last.
#        The admin email is read from <SecretsPrefix>initial-org-admin-email (it is not a
#        secret value). Set ADMIN_EMAIL in the environment to skip that read.
# VERIFY out/langsmith-values.yaml ; the printed object count ; then, after your helm
#        install: kubectl -n <namespace> get pods ; kubectl -n <namespace> get httproute (or: get ingress)
# The upper-case locals are read by envsubst (render exports them):
# shellcheck disable=SC2034
render_values() {
  local LANGSMITH_HOSTNAME SMITHDB_TIER BLOB_BUCKET SMITHDB_BUCKET CERTIFICATE_ARN PRIVATE_SUBNET_IDS \
        ALB_SECURITY_GROUP_ID LANGSMITH_SA_ANNOTATIONS SMITHDB_SA_ANNOTATIONS REDIS_IMAGE PGVECTOR_IMAGE \
        CUSTOM_CA_SECRET_NAME="" CUSTOM_CA_SECRET_KEY="" role p
  LANGSMITH_HOSTNAME=$(out Hostname); SMITHDB_TIER=$(out SmithdbTier)
  BLOB_BUCKET=$(out BlobBucket); SMITHDB_BUCKET=$(out SmithdbBucket)
  if [ "$INGRESS_MODE" = alb ]; then
    PRIVATE_SUBNET_IDS=$(out PrivateSubnetIds); ALB_SECURITY_GROUP_ID=$(out AlbSecurityGroupId)
    CERTIFICATE_ARN=$(cert_arn)
    [ -n "$CERTIFICATE_ARN" ] || die "no certificate: set certificateArn in your CDK config (and re-deploy) or run ./post-deploy/00-import-certificate.sh"
    render helm/langsmith-ingress-alb.yaml "$OUT_DIR/langsmith-ingress.yaml" CERTIFICATE_ARN PRIVATE_SUBNET_IDS ALB_SECURITY_GROUP_ID NAME
  else
    render helm/langsmith-ingress-envoy-gateway.yaml "$OUT_DIR/langsmith-ingress.yaml" NS
  fi
  role=""; [ "$WORKLOAD_IDENTITY" = irsa ] && role=$(out LangsmithRoleArn)
  LANGSMITH_SA_ANNOTATIONS=$(sa_annotations "$role")
  role=""; [ "$WORKLOAD_IDENTITY" = irsa ] && role=$(out SmithdbRoleArn)
  SMITHDB_SA_ANNOTATIONS=$(sa_annotations "$role")
  if [ -n "$CUSTOM_CA_BUNDLE_FILE" ]; then CUSTOM_CA_SECRET_NAME=langsmith-custom-ca; CUSTOM_CA_SECRET_KEY=ca-bundle.crt; fi
  # The operator's per-agent images: the ECR copies of the tags pinned in lib.sh.
  REDIS_IMAGE=$(ecr_image "$OPERATOR_REDIS_IMAGE"); PGVECTOR_IMAGE=$(ecr_image "$OPERATOR_PGVECTOR_IMAGE")
  if [ -z "${ADMIN_EMAIL:-}" ]; then
    need_tools aws
    p=$(out SecretsPrefix)
    ADMIN_EMAIL=$(aws secretsmanager get-secret-value --secret-id "${p}initial-org-admin-email" --query SecretString --output text)
  fi
  render helm/langsmith-values.yaml "$OUT_DIR/langsmith-values.yaml" \
    IMAGE_BASE AWS_REGION NAME LANGSMITH_HOSTNAME ADMIN_EMAIL SMITHDB_TIER BLOB_BUCKET SMITHDB_BUCKET \
    LANGSMITH_SA_ANNOTATIONS SMITHDB_SA_ANNOTATIONS CUSTOM_CA_SECRET_NAME CUSTOM_CA_SECRET_KEY REDIS_IMAGE PGVECTOR_IMAGE

  # The values files, in order (absolute paths: the install command may run from anywhere).
  VALUES_FILES=("$OUT_ABS/langsmith-values.yaml" "$OUT_ABS/langsmith-ingress.yaml")
  case "$(out SmithdbResources tier)" in
    lab)  VALUES_FILES+=("$PWD/helm/smithdb-lab.yaml")
          log "size lab: adding helm/smithdb-lab.yaml (reduced SmithDB resources; not for performance tests)" ;;
    tier) ;;
    *)    die "output SmithdbResources must be 'tier' or 'lab'" ;;
  esac
  if [ -n "$EXTRA_VALUES_FILE" ]; then
    [ -r "$EXTRA_VALUES_FILE" ] || die "EXTRA_VALUES_FILE '$EXTRA_VALUES_FILE' is not readable"
    VALUES_FILES+=("$(cd "$(dirname "$EXTRA_VALUES_FILE")" && pwd)/$(basename "$EXTRA_VALUES_FILE")")
  fi

  # Gate: the chart validates the values, and every image must come from your ECR.
  local f args=()
  for f in "${VALUES_FILES[@]}"; do args+=(-f "$f"); done
  helm template langsmith langsmith --repo "$LANGSMITH_CHART_REPO" --version "$LANGSMITH_CHART_VERSION" -n "$NS" \
    "${args[@]}" > "$OUT_DIR/rendered.yaml"
  check_images_in_ecr "$OUT_DIR/rendered.yaml"
  if [ "$INGRESS_MODE" = envoy-gateway ]; then
    grep -q '^kind: HTTPRoute' "$OUT_DIR/rendered.yaml" || die "ingress mode envoy-gateway, but the chart renders no HTTPRoute"
    ! grep -q '^kind: Ingress' "$OUT_DIR/rendered.yaml" || die "ingress mode envoy-gateway, but the chart still renders an Ingress"
  fi
  log "values OK ($INGRESS_MODE): $(grep -c '^kind:' "$OUT_DIR/rendered.yaml") objects (full render: $OUT_DIR/rendered.yaml)"
}
# write_install_command: out/helm-install-langsmith.sh, the exact command for YOU to review and run.
write_install_command() {
  local f
  {
    echo '#!/usr/bin/env bash'
    echo "# Written by post-deploy/04-cluster-prereqs.sh values for '$NAME' (account $ACCOUNT, region $AWS_REGION)."
    echo '# Installs or upgrades LangSmith: about 10-20 minutes, database migrations first. Review, then run:'
    echo "#   bash $OUT_ABS/helm-install-langsmith.sh"
    echo 'set -euo pipefail'
    printf 'export KUBECONFIG=%q\n' "$KUBECONFIG"
    printf 'helm upgrade --install langsmith langsmith --repo %q --version %q -n %q \\\n' \
      "$LANGSMITH_CHART_REPO" "$LANGSMITH_CHART_VERSION" "$NS"
    for f in "${VALUES_FILES[@]}"; do printf '  -f %q \\\n' "$f"; done
    echo '  --wait --timeout 25m'
  } > "$OUT_DIR/helm-install-langsmith.sh"
}
step_values() {
  section "9 LangSmith values $LANGSMITH_CHART_VERSION ($WORKLOAD_IDENTITY, ingress $INGRESS_MODE)"
  need_tools helm envsubst
  render_values
  write_install_command
  cat >&2 <<EOF

  Next: install (or upgrade) LangSmith yourself. The exact command is in
  $OUT_ABS/helm-install-langsmith.sh — review it, then run:

    bash $OUT_ABS/helm-install-langsmith.sh

  If it fails: kubectl -n $NS get pods,jobs ; kubectl -n $NS logs <pod>
  Then run:    ./post-deploy/05-dns-and-smoke-test.sh

EOF
}

# =============================================================================
# render — every file of steps 2-9 into out/, nothing applied
# =============================================================================
# For review (or a change-approval ticket) before anything touches the cluster. No kubectl
# call; the only AWS call is reading the admin email (skip it by setting ADMIN_EMAIL).
step_render() {
  section "render: write every manifest and values file to $OUT_DIR/ (nothing is applied)"
  need_tools helm envsubst
  render_storage; render_platform; render_envoy_gateway; render_externalsecrets; render_db_bootstrap
  render_values; write_install_command
  local f written=""
  for f in storage.yaml aws-load-balancer-controller.yaml external-secrets.yaml cluster-autoscaler.yaml keda.yaml \
           envoy-gateway.yaml envoy-gateway-resources.yaml externalsecrets.yaml db-admin-externalsecret.yaml db-bootstrap.yaml \
           langsmith-values.yaml langsmith-ingress.yaml rendered.yaml helm-install-langsmith.sh; do
    [ -s "$OUT_DIR/$f" ] && written="$written $f"
  done
  log "written to $OUT_DIR/:$written"
  [ "$INGRESS_MODE" = alb ] || log "envoy-gateway-target-group-binding.yaml is written by step 5: it needs the proxy Service's name from the cluster"
}

# ------------------------------------------------------------------- main ----
list() {
  cat <<'EOF'
  1  kubeconfig     aws eks update-kubeconfig -> out/kubeconfig
  2  storage        StorageClasses gp3 (default) + smithdb-cache, LangSmith namespace
  3  pod-network    check pods get IPs from the pod subnets (only with the PodSubnets output; read-only)
  4  platform       Helm: AWS Load Balancer Controller, External Secrets, Cluster Autoscaler, KEDA
  5  envoy-gateway  Envoy Gateway + the LangSmith Gateway, bound to CDK's ALB (ingress mode envoy-gateway)
  6  custom-ca      Secret langsmith-custom-ca (only with CUSTOM_CA_BUNDLE_FILE)
  7  secrets        ClusterSecretStore + ExternalSecrets (stops if 01 has not run)
  8  db-bootstrap   Job: IAM-login database roles and the feature databases
  9  values         render + validate out/langsmith-values.yaml, write out/helm-install-langsmith.sh
     render         write every file of steps 2-9 to out/ for review, apply nothing
     all            steps 1-9 in order
EOF
}
[ $# -gt 0 ] || { sed -n '5,10p' "$0" | sed 's/^# \{0,1\}//'; list; exit 0; }
for arg in "$@"; do
  case "$arg" in
    list) list ;;
    all) for s in kubeconfig storage pod_network platform envoy_gateway custom_ca secrets db_bootstrap values; do "step_$s"; done ;;
    1|kubeconfig)    step_kubeconfig ;;
    2|storage)       step_storage ;;
    3|pod-network)   step_pod_network ;;
    4|platform)      step_platform ;;
    5|envoy-gateway) step_envoy_gateway ;;
    6|custom-ca)     step_custom_ca ;;
    7|secrets)       step_secrets ;;
    8|db-bootstrap)  step_db_bootstrap ;;
    9|values)        step_values ;;
    render)         step_render ;;
    *) die "unknown step '$arg' (./post-deploy/04-cluster-prereqs.sh list)" ;;
  esac
done

#!/usr/bin/env bash
# =============================================================================
# tools/teardown.sh — remove one LangSmith environment, in the right order.
#
#   ./tools/teardown.sh <config>                  all four stages, from a machine with Node.js that can
#                                                  reach the EKS API
#   ./tools/teardown.sh --cluster-only            stage 1 only, on the bastion (no Node.js needed): reads
#                                                  out/cdk-outputs.json instead of the config
#   ./tools/teardown.sh <config> --skip-cluster   stages 2-4, on the deploy machine, after --cluster-only
#
# <config> is what you pass to cdk as -c config=<config> (config/<config>.ts). The name, region,
# cluster, namespace and bootstrap toolkit (cdkQualifier) are read from that file.
# You are asked to type the environment's name before anything is deleted.
# Do not run stages 2-4 on the bastion: it has no Node.js, and cdk destroy deletes the bastion.
#
# WHY AN ORDER: the EBS volumes (and, with ingress mode 'alb', the ALB) are created by Kubernetes
# controllers, not by CloudFormation. If the cluster goes first, they are orphaned and block the
# VPC's deletion. With ingress mode 'envoy-gateway' the ALB is CloudFormation's, but the Load
# Balancer Controller registered the Envoy pods in its target group, and Envoy Gateway runs pods
# for the Gateway: both are removed while their controllers still run.
#
#   1. Kubernetes: uninstall the LangSmith release; envoy-gateway: delete the TargetGroupBinding,
#      the Gateway resources, then uninstall Envoy Gateway; delete the Ingresses, LoadBalancer
#      Services and PersistentVolumeClaims of the LangSmith namespace (and envoy-gateway-system),
#      and wait until the controllers have deleted any load balancer they created and the volumes.
#      Only those namespaces: on a cluster you share, other teams' resources are never touched.
#   2. `cdk destroy --all` — both stacks (with CDK's ALB, its target group and the DNS record).
#      First, what would make it fail: the record post-deploy/05 wrote into CDK's zone (ingress
#      mode 'alb'), and, with dataRemovalPolicy 'destroy', the objects in CDK's buckets.
#   3. tools/list-resources.sh — what is left.
#   4. PRINTS (never runs) the commands for what dataRemovalPolicy 'retain' kept on purpose:
#      buckets, secrets, the KMS key, final snapshots — and for ECR repositories and the bootstrap
#      toolkit. Deleting data stays your decision. Nothing is ever deleted by tag alone.
#
# Needs: aws CLI v2, jq; kubectl and helm for stage 1; node/npm (npm ci done) for the other stages.
# With a private EKS endpoint: --cluster-only on the bastion, then --skip-cluster on the deploy machine.
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

section() { printf '\n\033[1m======== %s ========\033[0m\n' "$*" >&2; }
log()     { printf '  -> %s\n' "$*" >&2; }
die()     { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

usage() { echo "usage: $0 <config> [--skip-cluster]   or   $0 --cluster-only" >&2; exit 2; }
MODE=all CONFIG=""
case "${1:-}" in
  --cluster-only) [ $# -eq 1 ] || usage; MODE=cluster-only ;;
  ''|-*) usage ;;
  *) CONFIG=$1
     case "${2:-}" in '') ;; --skip-cluster) MODE=skip-cluster ;; *) usage ;; esac
     [ $# -le 2 ] || usage ;;
esac

if [ "$MODE" = cluster-only ]; then
  # On the bastion: everything stage 1 needs is a CDK output (no Node.js, no config file).
  OUTPUTS=${CDK_OUTPUTS:-out/cdk-outputs.json}
  [ -s "$OUTPUTS" ] || die "$OUTPUTS not found: copy it from the deploy machine (README.md, Step 6)"
  read -r NAME REGION ACCOUNT NS INGRESS CLUSTER < <(jq -r '[.[]] | add |
    "\(.Name) \(.Region) \(.Account) \(.LangsmithNamespace) \(.IngressMode // "alb") \(.ClusterName)"' "$OUTPUTS")
  [ -n "${CLUSTER:-}" ] && [ "$CLUSTER" != null ] || die "could not read the outputs in $OUTPUTS"
  RETAIN="" QUALIFIER=""
else
  # A path under config/, no "..": it is put into the node command below.
  [[ "$CONFIG" =~ ^[A-Za-z0-9_/-]+$ && "$CONFIG" != *..* && -f "config/$CONFIG.ts" ]] || die "config/$CONFIG.ts not found"
  # Read everything from the config file itself (the same file cdk uses). QUALIFIER is '-' without cdkQualifier.
  # BLOB/SDB are the buckets CDK created ('-' for none or your own); ZONE_OWNED: CDK created the private zone.
  read -r NAME REGION ACCOUNT NS RETAIN INGRESS CLUSTER HOST ZONE_OWNED BLOB SDB QUALIFIER < <(npx ts-node --prefer-ts-exts -e \
    "const c = require('./config/$CONFIG').default; const n = require('./lib/naming').namesFor(c);
     console.log(c.name, c.region, c.account, c.kubernetes.langsmithNamespace, c.dataRemovalPolicy,
       require('./lib/config').ingressMode(c), n.clusterName, c.dns.hostname, c.dns.privateZone.enabled,
       c.s3.blob.enabled ? n.blobBucket : '-', c.s3.smithdb.enabled ? n.smithdbBucket : '-', c.cdkQualifier || '-');")
  [ -n "${QUALIFIER:-}" ] || die "could not read config/$CONFIG.ts (does 'npx cdk synth -c config=$CONFIG' work?)"
  [ "$QUALIFIER" != - ] || QUALIFIER=""
fi
export AWS_REGION=$REGION AWS_DEFAULT_REGION=$REGION AWS_PAGER=""
case "$REGION" in us-gov-*) PARTITION=aws-us-gov ;; cn-*) PARTITION=aws-cn ;; *) PARTITION=aws ;; esac

CALLER=$(aws sts get-caller-identity --query Account --output text)
[ "$CALLER" = "$ACCOUNT" ] || die "your credentials are for account $CALLER, the config is for $ACCOUNT"

CDK_ARGS=(-c "config=$CONFIG")   # the config's cdkQualifier selects the bootstrap toolkit

if [ "$MODE" = cluster-only ]; then
  cat >&2 <<EOF

This UNINSTALLS LangSmith from the EKS cluster '$CLUSTER' (environment '$NAME', account $ACCOUNT, region $REGION),
and deletes what Kubernetes created in AWS for it: load balancer targets, load balancers, EBS volumes.
No CloudFormation stack is touched. Afterwards, on the deploy machine: ./tools/teardown.sh <config> --skip-cluster
EOF
else
  cat >&2 <<EOF

This DELETES the LangSmith environment '$NAME' (account $ACCOUNT, region $REGION):
  stacks $NAME-langsmith and $NAME-network, the EKS cluster and everything in it,
  the databases and the cache$( [ "$RETAIN" = retain ] && echo " (final snapshots are kept)" ),
  and — dataRemovalPolicy is '$RETAIN' — $( [ "$RETAIN" = retain ] && echo "buckets, secrets and the KMS key are KEPT" || echo "buckets, secrets and the KMS key too" ).
EOF
fi
read -r -p "Type the environment name to continue: " answer
[ "$answer" = "$NAME" ] || die "not confirmed"

# -----------------------------------------------------------------------------
section "1 Kubernetes-created AWS resources (load balancer targets / ALB, EBS volumes) — ingress $INGRESS"
# -----------------------------------------------------------------------------
KUBECONFIG=$(mktemp); export KUBECONFIG
trap 'rm -f "$KUBECONFIG"' EXIT
if [ "$MODE" = skip-cluster ]; then
  log "skipped (--skip-cluster): run './tools/teardown.sh --cluster-only' on the bastion first"
elif aws eks describe-cluster --name "$CLUSTER" --query cluster.status --output text >/dev/null 2>&1 \
   && aws eks update-kubeconfig --name "$CLUSTER" --kubeconfig "$KUBECONFIG" >/dev/null \
   && kubectl get --raw /readyz >/dev/null 2>&1; then
  if helm status langsmith -n "$NS" >/dev/null 2>&1; then
    log "helm uninstall langsmith (namespace $NS)"
    helm uninstall langsmith -n "$NS" --wait --timeout 10m
  fi
  # Only this environment's namespaces: the LangSmith one and envoy-gateway-system.
  EG_NS=envoy-gateway-system
  if kubectl get crd targetgroupbindings.elbv2.k8s.aws >/dev/null 2>&1; then
    log "deleting the TargetGroupBindings in $EG_NS and $NS (the Load Balancer Controller deregisters the pods)"
    for ns in "$EG_NS" "$NS"; do kubectl -n "$ns" delete targetgroupbinding --all --wait=true --timeout=5m; done
  fi
  if helm status envoy-gateway -n envoy-gateway-system >/dev/null 2>&1; then
    # The Gateway resources first, while the controller runs: it removes the proxy pods and Service.
    log "deleting the Gateway, its policies, GatewayClass and EnvoyProxy, then uninstalling Envoy Gateway"
    kubectl -n "$NS" delete gateway/langsmith-gateway backendtrafficpolicy/langsmith-timeouts \
      clienttrafficpolicy/langsmith-from-alb --ignore-not-found --wait=true --timeout=5m
    kubectl delete gatewayclass/langsmith --ignore-not-found --wait=true --timeout=5m
    kubectl -n envoy-gateway-system delete envoyproxy/langsmith-proxy --ignore-not-found --wait=true --timeout=5m
    helm uninstall envoy-gateway -n envoy-gateway-system --wait --timeout 10m
  fi
  log "deleting the Ingresses and LoadBalancer Services in $NS and $EG_NS (the Load Balancer Controller deletes the ALB/NLB)"
  kubectl -n "$NS" delete ingress --all --wait=true --timeout=5m
  for ns in "$NS" "$EG_NS"; do
    kubectl -n "$ns" get svc -o jsonpath='{range .items[?(@.spec.type=="LoadBalancer")]}{.metadata.name}{"\n"}{end}' 2>/dev/null |
      while read -r svc; do [ -n "$svc" ] && kubectl -n "$ns" delete svc "$svc" --wait=true --timeout=5m; done
  done
  log "deleting the PersistentVolumeClaims in $NS (the EBS CSI driver deletes the volumes)"
  kubectl -n "$NS" delete pvc --all --wait=true --timeout=10m
  log "waiting for the load balancers the controllers created (tagged langsmith-env=$NAME) to disappear (up to 5 minutes)"
  for _ in $(seq 30); do
    # CDK's own ALB (<name>-alb, ingress mode envoy-gateway) goes with cdk destroy in step 2.
    lbs=$(aws resourcegroupstaggingapi get-resources --resource-type-filters elasticloadbalancing:loadbalancer \
      --tag-filters "Key=langsmith-env,Values=$NAME" \
      --query "length(ResourceTagMappingList[?!contains(ResourceARN, ':loadbalancer/app/$NAME-alb/')])" --output text)
    [ "$lbs" = 0 ] && break
    sleep 10
  done
  [ "$lbs" = 0 ] || log "still $lbs load balancer(s): check tools/list-resources.sh output below"
else
  [ "$MODE" != cluster-only ] || die "the cluster '$CLUSTER' does not exist or its API is not reachable from here"
  cat >&2 <<EOF
  !! The cluster '$CLUSTER' does not exist or its API is not reachable from here (private endpoint?).
     Anything Kubernetes created (an ALB, EBS volumes) cannot be cleaned up by this step and may
     block the VPC's deletion. Either stop now, run './tools/teardown.sh --cluster-only' on the
     bastion and then this with --skip-cluster, or continue and delete what step 3 lists by hand.
EOF
  read -r -p "Type 'continue' to go on without this step: " answer
  [ "$answer" = continue ] || die "stopped"
fi
if [ "$MODE" = cluster-only ]; then
  log "done. Now, on the deploy machine: ./tools/teardown.sh <config> --skip-cluster"
  exit 0
fi

# -----------------------------------------------------------------------------
section "2 cdk destroy"
# -----------------------------------------------------------------------------
log "RDS instances and CDK's ALB with deletion protection (environment stage/prod) make this fail: set sizes.deletionProtection: false and deploy first"
# CloudFormation deletes a hosted zone only when it is empty, but in ingress mode 'alb' post-deploy/05
# wrote the hostname's record into CDK's zone, outside CloudFormation.
if [ "$INGRESS" = alb ] && [ "$ZONE_OWNED" = true ]; then
  ZONE_ID=$(aws cloudformation describe-stacks --stack-name "$NAME-langsmith" \
    --query "Stacks[0].Outputs[?OutputKey=='PrivateZoneId'].OutputValue | [0]" --output text 2>/dev/null || true)
  if [ -n "$ZONE_ID" ] && [ "$ZONE_ID" != None ]; then
    RECORD=$(aws route53 list-resource-record-sets --hosted-zone-id "$ZONE_ID" --output json \
      --query "ResourceRecordSets[?Name=='$(echo "$HOST" | tr '[:upper:]' '[:lower:]').' && Type=='A'] | [0]")
    if [ "$RECORD" != null ]; then
      log "deleting the record $HOST that post-deploy/05 wrote (zone $ZONE_ID)"
      aws route53 change-resource-record-sets --hosted-zone-id "$ZONE_ID" \
        --change-batch "$(jq -c '{Changes: [{Action: "DELETE", ResourceRecordSet: .}]}' <<<"$RECORD")" >/dev/null
    fi
  fi
fi
# CloudFormation deletes a bucket only when it is empty (autoDeleteObjects would add a Lambda).
if [ "$RETAIN" = destroy ]; then
  for b in "$BLOB" "$SDB"; do
    if [ "$b" = - ] || ! aws s3api head-bucket --bucket "$b" >/dev/null 2>&1; then continue; fi
    log "emptying s3://$b (dataRemovalPolicy 'destroy')"
    aws s3 rm "s3://$b" --recursive --only-show-errors
  done
fi
npx cdk destroy --all --force "${CDK_ARGS[@]}"

# -----------------------------------------------------------------------------
section "3 What is left"
# -----------------------------------------------------------------------------
LIST_ARGS=("$NAME" --region "$REGION")
[ -z "$QUALIFIER" ] || LIST_ARGS+=(--qualifier "$QUALIFIER")
./tools/list-resources.sh "${LIST_ARGS[@]}"

# -----------------------------------------------------------------------------
section "4 Commands for what is left (review, then run what you want)"
# -----------------------------------------------------------------------------
cat <<EOF
# Buckets (deleting a bucket also needs all object versions gone; the console's "Empty" does it):
aws s3 rb s3://$NAME-blob-$ACCOUNT --force
aws s3 rb s3://$NAME-smithdb-$ACCOUNT --force
# Secrets (test environments only: no recovery window, the names are free again at once):
aws secretsmanager list-secrets --include-planned-deletion --filters Key=name,Values=$NAME/ --query 'SecretList[].Name' --output text |
  tr '\t' '\n' | xargs -I{} aws secretsmanager delete-secret --secret-id {} --force-delete-without-recovery
# KMS key (7 days is the shortest waiting period); the key ID is in section 1 above:
aws kms schedule-key-deletion --pending-window-in-days 7 --key-id <key-id>
# Final snapshots (section 7 above):
aws rds delete-db-snapshot --db-snapshot-identifier <snapshot>
aws elasticache delete-snapshot --snapshot-name <snapshot>
# ECR repositories from post-deploy/03 (with their images):
aws ecr describe-repositories --query "repositories[?starts_with(repositoryName, '$NAME/')].repositoryName" --output text |
  tr '\t' '\n' | xargs -I{} aws ecr delete-repository --repository-name {} --force
# Ingress mode 'alb' with your own zone (dns.privateZone.existingZoneId) only: the DNS record
# post-deploy/05 wrote: delete it in Route 53. (In CDK's zone, step 2 deleted it.)
EOF
if [ -n "$QUALIFIER" ]; then
cat <<EOF
# The CDK bootstrap toolkit '$QUALIFIER' (only if nothing else uses it) — its bucket is kept by CloudFormation:
aws cloudformation delete-stack --stack-name CDKToolkit-$QUALIFIER
aws s3 rb s3://cdk-$QUALIFIER-assets-$ACCOUNT-$REGION --force   # versioned: empty all versions first if this fails
# The scoped execution policies (README.md, Appendix C):
for p in 1-network-compute 2-data 3-iam; do aws iam delete-policy --policy-arn arn:$PARTITION:iam::$ACCOUNT:policy/$NAME-cdk-execution-policy-\$p; done
EOF
fi

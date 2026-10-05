#!/usr/bin/env bash
# =============================================================================
# tools/check-offline.sh — every offline check, the same ones CI runs (.github/workflows/ci.yml)
#
#   ./tools/check-offline.sh
#
# 1. npm test: type check and unit tests.
# 2. cdk synth of every config in config/example.ts and config/examples/.
# 3. shellcheck of every script (skipped with a note when shellcheck is not installed).
# 4. post-deploy/04 render against the made-up outputs in test/fixtures/ (both ingress modes,
#    IRSA and Pod Identity): every template renders, and the LangSmith chart validates the values.
#
# No AWS calls: ADMIN_EMAIL is set, so `render` does not read Secrets Manager. Steps 2 and 4
# need the public Helm chart repositories (internet).
# Needs: node/npm (npm ci done), helm, jq, envsubst; shellcheck optional.
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
section() { printf '\n\033[1m======== %s ========\033[0m\n' "$*" >&2; }

section "1 npm test"
npm test --silent

section "2 cdk synth of every example config"
for f in config/example.ts config/examples/*.ts; do
  c=${f#config/}; c=${c%.ts}
  npx cdk synth -c "config=$c" --quiet -o "$TMP/cdk.out-${c//\//-}" >"$TMP/synth.log" 2>&1 || { cat "$TMP/synth.log" >&2; exit 1; }
  echo "  ok  $c" >&2
done

section "3 shellcheck"
if command -v shellcheck >/dev/null 2>&1; then
  shellcheck -x post-deploy/*.sh tools/*.sh k8s/db-bootstrap/bootstrap.sh && echo "  ok" >&2
else
  echo "  shellcheck not installed: skipped" >&2
fi

section "4 post-deploy/04 render with test/fixtures/"
for f in test/fixtures/cdk-outputs-*.json; do
  m=$(basename "$f" .json); m=${m#cdk-outputs-}
  OUT_DIR="$TMP/render-$m" CDK_OUTPUTS="$f" ADMIN_EMAIL=admin@example.com SETTINGS_FILE=/dev/null \
    ./post-deploy/04-cluster-prereqs.sh render 2>"$TMP/render-$m.log" || { cat "$TMP/render-$m.log" >&2; exit 1; }
  echo "  ok  $m: $(grep -o 'values OK ([^)]*): [0-9]* objects' "$TMP/render-$m.log")" >&2
done

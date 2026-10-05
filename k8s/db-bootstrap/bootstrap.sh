# shellcheck shell=sh
# k8s/db-bootstrap/bootstrap.sh — run by the database bootstrap Job (post-deploy/04 step 8) with psql.
# The connection settings come from the temporary Secret langsmith-db-admin (k8s/db-admin-externalsecret.yaml):
# the RDS master users, over TLS. Each SQL file is idempotent, so the Job is safe to re-run.
set -eu
run() { PGPASSWORD="$3" psql "host=$1 port=5432 dbname=$4 user=$2 sslmode=require connect_timeout=10" -v ON_ERROR_STOP=1 -q -f "$5"; }
run "$CORE_PGHOST" "$CORE_PGUSER" "$CORE_PGPASSWORD" langsmith /sql/core.sql
run "$META_PGHOST" "$META_PGUSER" "$META_PGPASSWORD" smithdb   /sql/metastore.sql
echo "bootstrap complete"

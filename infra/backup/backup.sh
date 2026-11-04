#!/usr/bin/env bash
# Nightly logical backup: one custom-format pg_dump per schema, encrypted with age, uploaded to S3/R2.
# Needs: pg_dump, age, aws (S3 API; R2 works via AWS_ENDPOINT_URL). Reads everything from the environment:
#   BACKUP_DATABASE_URL   a dedicated backup role with BYPASSRLS and SELECT everywhere (tables use FORCE ROW LEVEL SECURITY,
#                         so pg_dump fails for any role without BYPASSRLS). Used by this job only; never by an app.
#   BACKUP_AGE_RECIPIENT  age public key (the private key lives offline, not on this host)
#   BACKUP_BUCKET         bucket name;  BACKUP_PREFIX  optional key prefix (default: pg)
set -euo pipefail

: "${BACKUP_DATABASE_URL:?}" "${BACKUP_AGE_RECIPIENT:?}" "${BACKUP_BUCKET:?}"
prefix="${BACKUP_PREFIX:-pg}"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

schemas="$(psql "$BACKUP_DATABASE_URL" -Atc "select nspname from pg_namespace where nspname !~ '^(pg_|information_schema)' order by 1")"
[ -n "$schemas" ] || { echo "no schemas found" >&2; exit 1; }

for s in $schemas; do
  out="$work/${stamp}-${s}.dump.age"
  # -Fc: compressed and restorable per object; the pipe keeps plaintext off disk.
  pg_dump "$BACKUP_DATABASE_URL" --schema="$s" -Fc --no-owner --no-privileges \
    | age -r "$BACKUP_AGE_RECIPIENT" -o "$out"
  aws s3 cp --only-show-errors "$out" "s3://${BACKUP_BUCKET}/${prefix}/${stamp}/${s}.dump.age"
  echo "backed up schema ${s}"
done
# Roles are not part of a per-schema dump: they are provisioned with the database (docs/runbooks/restore.md).
echo "done ${stamp}"

#!/usr/bin/env bash
# Restore a backup set into a FRESH database (staging drill or disaster recovery). Refuses a non-empty target.
#   restore.sh <backup-stamp> <target-database-url>
# Needs the age PRIVATE key at $BACKUP_AGE_IDENTITY (a file), plus pg_restore, psql, age, aws.
set -euo pipefail

stamp="${1:?backup stamp, e.g. 20261103T020000Z}"
target="${2:?target database url (admin role)}"
: "${BACKUP_BUCKET:?}" "${BACKUP_AGE_IDENTITY:?path to the age identity file}"
prefix="${BACKUP_PREFIX:-pg}"

existing="$(psql "$target" -Atc "select count(*) from pg_namespace where nspname !~ '^(pg_|information_schema|public)'")"
[ "$existing" = "0" ] || { echo "target is not empty ($existing schemas): refusing" >&2; exit 1; }

started="$(date +%s)"
# The dumps carry no ownership: the application roles must already exist (provisioned with the database, with REAL
# passwords; never run the dev init SQL here, it creates roles with placeholder passwords).
for role in wb_migrator wb_app wb_worker wb_chainer wb_identity; do
  [ "$(psql "$target" -Atc "select count(*) from pg_roles where rolname = '$role'")" = "1" ] \n    || { echo "role $role is missing on the target: provision roles first (docs/runbooks/restore.md)" >&2; exit 1; }
done
for ext in pgcrypto pg_trgm vector pg_stat_statements; do psql "$target" -v ON_ERROR_STOP=1 -q -c "create extension if not exists $ext"; done

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
aws s3 cp --only-show-errors --recursive "s3://${BACKUP_BUCKET}/${prefix}/${stamp}/" "$work/"
for f in "$work"/*.dump.age; do
  age -d -i "$BACKUP_AGE_IDENTITY" "$f" | pg_restore --dbname="$target" --no-owner --no-privileges --exit-on-error
  echo "restored $(basename "$f" .dump.age)"
done

# Sanity: every schema has tables, and forced RLS survived the round trip.
psql "$target" -v ON_ERROR_STOP=1 -Atc "
  select 'tables: ' || count(*) from information_schema.tables where table_schema !~ '^(pg_|information_schema)';
  select 'forced rls tables: ' || count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where c.relrowsecurity and c.relforcerowsecurity and n.nspname !~ '^(pg_|information_schema)';"
echo "restore finished in $(( $(date +%s) - started )) s (record this as the measured RTO)"

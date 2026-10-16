#!/usr/bin/env bash
# The cutover copy (docs/cutover/better-auth-cutover.md, step 6): app database
# → auth database, then the cross-database audit.
#
# Run ONLY inside the auth image, via `railway ssh` into the auth service
# (docs/cutover/better-auth-cutover.md), so the password hashes never transit
# an operator machine. APP_DATABASE_URL and AUTH_DATABASE_URL are
# entered for this session only: never set on a service, never written to a
# file. This script writes no file either: 01's rows go through a pipe into
# 02's session, whose import table is TEMP.
#
# Prints counts and checksums only. Exits non-zero on any failure or audit
# difference; the runbook's next step (the app window migration) runs only
# after a clean exit.
set -euo pipefail
set +o history 2>/dev/null || true

die() { echo "copy.sh: $*" >&2; exit 2; }

# Only inside the auth image (apps/auth/Dockerfile bakes the marker), reached
# by `railway ssh` into the auth service: never on an operator machine.
# `railway shell` on a laptop injects the same Railway variables, so no
# environment variable can prove where this runs.
[ -f /etc/ansari-auth-image ] \
  || die "refusing to run outside the auth image (no /etc/ansari-auth-image; run it from 'railway ssh' into the auth service, never from a laptop)"
[ -n "${APP_DATABASE_URL:-}" ] || die "APP_DATABASE_URL is unset"
[ -n "${AUTH_DATABASE_URL:-}" ] || die "AUTH_DATABASE_URL is unset"
[ "$APP_DATABASE_URL" != "$AUTH_DATABASE_URL" ] || die "APP_DATABASE_URL and AUTH_DATABASE_URL are the same database"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
psql_app() { psql "$APP_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 "$@"; }
psql_auth() { psql "$AUTH_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 "$@"; }

echo "copy.sh: copying non-system users (app → auth)"
psql_app -f "$here/01-export-app.sql" | psql_auth -f "$here/02-import-auth.sql"

echo "copy.sh: auditing"
app_audit="$(psql_app -f "$here/03-audit-app.sql")"
auth_audit="$(psql_auth -f "$here/03-audit-auth.sql")"
echo "-- app"
echo "$app_audit"
echo "-- auth"
echo "$auth_audit"
if [ "$app_audit" != "$auth_audit" ]; then
  echo "copy.sh: AUDIT MISMATCH — do NOT run the app window migration; empty the auth database and start again from the 0000 baseline" >&2
  diff <(echo "$app_audit") <(echo "$auth_audit") >&2 || true
  exit 1
fi
echo "copy.sh: audit OK"

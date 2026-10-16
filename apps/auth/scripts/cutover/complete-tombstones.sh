#!/usr/bin/env bash
# Completes deletions whose auth-side step did not finish (an apps/auth failure
# during DELETE /v2/users/me): lists the pending tombstones in the app
# database (04a), deletes those users directly in the auth database (04b; the
# cascade removes their sessions and accounts), and marks them done (04c).
# It never calls the delete endpoint. Auth image only, like copy.sh. Ids only.
set -euo pipefail
set +o history 2>/dev/null || true

die() { echo "complete-tombstones.sh: $*" >&2; exit 2; }

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
ids="$(psql "$APP_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -f "$here/04-tombstones-pending-app.sql")"
echo "complete-tombstones.sh: pending $ids"
[ "$ids" != "{}" ] || { echo "complete-tombstones.sh: nothing pending"; exit 0; }
psql "$AUTH_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -v ids="$ids" -f "$here/04-tombstones-delete-auth.sql"
psql "$APP_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -v ids="$ids" -f "$here/04-tombstones-mark-app.sql"
echo "complete-tombstones.sh: done"

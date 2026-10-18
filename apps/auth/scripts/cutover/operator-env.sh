# The operator-environment check for the cutover scripts (spec 300 amendment
# H-8): sourced by copy.sh and complete-tombstones.sh, which run on the
# owner's machine through Railway's Tailscale forwarder (docs.railway.com,
# "Set up a Tailscale forwarder"): a Railway service on the owner's tailnet
# that relays a port to a database's private host. It replaces the old
# auth-image marker. It refuses, before any database is touched:
#
#   1. a missing or empty APP_DATABASE_URL / AUTH_DATABASE_URL, or both the same;
#   2. a database host that is not a Tailscale forwarder's MagicDNS name
#      (`<project>-<environment>-tailscale-forwarder`, optionally with
#      Tailscale's `-<n>` dedupe suffix and the tailnet's `.<tailnet>.ts.net`):
#      Railway's public TCP proxy (`*.proxy.rlwy.net`), `*.railway.internal`
#      (it resolves only inside Railway), IPs and every other host are refused;
#   3. a psql that is not major 18 (the production major);
#   4. a checkout that is not clean, or whose HEAD is not PROMOTED_COMMIT, the
#      commit the window recorded: the scripts and SQL run from this tree;
#   5. stdout that is not a terminal, so the output (counts and checksums
#      only) cannot be captured to a file by accident.
#
# It prints a warning when a URL does not carry sslmode=require (runbook step
# 1 records whether TLS is offered through the forwarder). Ids only; it never
# prints a URL.
#
# `--allow-local` (local end-to-end testing only, LOCAL-TESTING) replaces check
# 2 with a stricter one: BOTH hosts must be loopback (localhost, 127.0.0.1,
# ::1). Loopback is not local: a tunnel or port-forward on loopback (railway
# connect, ssh -L, a Tailscale forward) would reach a Railway database, so never
# run it while one is open; it is for throwaway local clusters. Every other
# check still runs, and it says so on stderr.
#
# Usage: operator_check <script name> [--allow-local]
#        (dies with exit 2 on the first refusal, or on any other argument)

operator_die() { echo "$1: $2" >&2; exit 2; }

# The host of a postgres URL: scheme://[user[:password]@]host[:port][/db][?params].
operator_url_host() {
  local rest="${1#*://}"
  rest="${rest##*@}"
  rest="${rest%%[/?]*}"
  if [[ "$rest" == \[* ]]; then
    rest="${rest%%]*}"
    echo "${rest#[}"
  else
    echo "${rest%%:*}"
  fi
}

# 0 when the host is a Tailscale forwarder's MagicDNS name, 1 otherwise:
# `<project>-<environment>-tailscale-forwarder`, an optional `-<n>` (Tailscale
# dedupes a reused machine name), and optionally `.<tailnet>.ts.net`.
# Lower-cased; a trailing dot is allowed.
operator_host_allowed() {
  local host
  host="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  host="${host%.}"
  [[ "$host" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?-tailscale-forwarder(-[0-9]+)?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?\.ts\.net)?$ ]]
}

# 0 when the host is loopback (the only hosts --allow-local accepts), 1 otherwise.
operator_host_loopback() {
  local host
  host="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  host="${host%.}"
  [ "$host" = "localhost" ] || [ "$host" = "127.0.0.1" ] || [ "$host" = "::1" ]
}

operator_check() {
  local name="$1"
  shift
  local allow_local=0
  if [ "$#" -gt 0 ]; then
    [ "$#" -eq 1 ] && [ "$1" = "--allow-local" ] \
      || operator_die "$name" "unknown argument (the only one accepted is --allow-local)"
    allow_local=1
  fi
  [ -n "${APP_DATABASE_URL:-}" ] || operator_die "$name" "APP_DATABASE_URL is unset"
  [ -n "${AUTH_DATABASE_URL:-}" ] || operator_die "$name" "AUTH_DATABASE_URL is unset"
  [ "$APP_DATABASE_URL" != "$AUTH_DATABASE_URL" ] \
    || operator_die "$name" "APP_DATABASE_URL and AUTH_DATABASE_URL are the same database"

  local var host
  for var in APP_DATABASE_URL AUTH_DATABASE_URL; do
    host="$(operator_url_host "${!var}")"
    if [ "$allow_local" = 1 ]; then
      operator_host_loopback "$host" \
        || operator_die "$name" "--allow-local: $var's host is not loopback (localhost, 127.0.0.1 or ::1)"
      continue
    fi
    case "$host" in
      *.proxy.rlwy.net | *.proxy.rlwy.net.)
        operator_die "$name" "$var points at Railway's public TCP proxy; use the Tailscale forwarder's host (<project>-<environment>-tailscale-forwarder)" ;;
    esac
    operator_host_allowed "$host" \
      || operator_die "$name" "$var's host is not a Tailscale forwarder (<project>-<environment>-tailscale-forwarder)"
  done

  command -v psql >/dev/null 2>&1 || operator_die "$name" "psql is not on PATH (install the PostgreSQL 18 client)"
  local version major
  version="$(psql --version 2>/dev/null || true)"
  major="$(printf '%s' "$version" | sed -nE 's/^psql \(PostgreSQL\) ([0-9]+).*/\1/p')"
  [ "$major" = "18" ] || operator_die "$name" "psql must be major 18 (found: ${version:-none})"

  local here repo
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  repo="$(git -C "$here" rev-parse --show-toplevel 2>/dev/null)" \
    || operator_die "$name" "not inside a git checkout"
  [ -n "${PROMOTED_COMMIT:-}" ] || operator_die "$name" "PROMOTED_COMMIT is unset (the commit the window recorded)"
  [ -z "$(git -C "$repo" status --porcelain)" ] || operator_die "$name" "the checkout has uncommitted changes"
  [ "$(git -C "$repo" rev-parse HEAD)" = "$(git -C "$repo" rev-parse --verify --quiet "$PROMOTED_COMMIT^{commit}")" ] \
    || operator_die "$name" "HEAD is not PROMOTED_COMMIT"

  [ -t 1 ] || operator_die "$name" "refusing to run with stdout redirected: run it in the terminal, and read its counts there"

  [ "$allow_local" = 0 ] \
    || echo "$name: LOCAL TEST RUN (--allow-local): loopback databases only; the Tailscale forwarder host check is skipped" >&2

  for var in APP_DATABASE_URL AUTH_DATABASE_URL; do
    case "${!var}" in
      *sslmode=require* | *sslmode=verify-ca* | *sslmode=verify-full*) ;;
      *) echo "$name: WARNING: $var carries no sslmode=require (runbook step 1 records whether TLS is offered through the forwarder)" >&2 ;;
    esac
  done
}

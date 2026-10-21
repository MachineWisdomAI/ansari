#!/usr/bin/env bash
# Public-only transfer rehearsal. Requires Node, pnpm and Docker; no credentials.
set -euo pipefail
app_root=$(cd "$(dirname "$0")/.." && pwd)
verify_root=$(mktemp -d)
container=""
image="ansari-public-ci:$(date +%s)-$$"
cleanup() {
  if [[ -n "$container" ]]; then docker rm -f "$container" >/dev/null 2>&1 || true; fi
  docker image rm "$image" >/dev/null 2>&1 || true
  rm -rf "$verify_root"
}
trap cleanup EXIT
mkdir -p "$verify_root/apps/ansari-faithful-answers"
# Copy only application files. Do not carry an installation, lockfile or credentials.
tar -C "$app_root" --exclude=node_modules --exclude=dist --exclude=.git --exclude='.env*' --exclude=.npmrc --exclude=pnpm-lock.yaml --exclude=test-results --exclude=playwright-report -cf "$verify_root/app.tar" .
tar -C "$verify_root/apps/ansari-faithful-answers" -xf "$verify_root/app.tar"
rm "$verify_root/app.tar"
app="$verify_root/apps/ansari-faithful-answers"
printf '{"private":true,"packageManager":"pnpm@10.33.0"}\n' > "$verify_root/package.json"
# Exercise the documented destination-root placement of the adapter override.
printf "packages:\n  - apps/*\ncatalog:
  typescript: ~6.0.3
overrides:\n  '@a2ui/markdown-it': '0.2.1'\n" > "$verify_root/pnpm-workspace.yaml"
: > "$verify_root/npm-user.conf"
: > "$verify_root/npm-global.conf"
export NPM_CONFIG_USERCONFIG="$verify_root/npm-user.conf"
export NPM_CONFIG_GLOBALCONFIG="$verify_root/npm-global.conf"
export NPM_CONFIG_REGISTRY=https://registry.npmjs.org/
unset NODE_AUTH_TOKEN NPM_TOKEN || true
cd "$verify_root"
pnpm install --strict-peer-dependencies --store-dir "$verify_root/store"
cd "$app"
pnpm check:release
pnpm exec playwright install chromium
pnpm verify
# The Dockerfile supplies its isolated catalog and dependency override.
docker build --no-cache -t "$image" "$app"
container=$(docker run -d --network none -e ANSARI_RELEASE=ci-public-smoke -e ANSARI_API_BASE_URL=http://127.0.0.1:4010 -e MCP_RESPONSE_MODE=json "$image")
[[ $(docker inspect "$container" --format '{{len .Mounts}}') == 0 ]]
docker exec -i "$container" node --input-type=module < "$app/scripts/docker-smoke.mjs"
docker stop --time 10 "$container" >/dev/null
[[ $(docker inspect "$container" --format '{{.State.ExitCode}}') == 0 ]]
echo 'Public-package standalone tests and Docker smoke passed.'

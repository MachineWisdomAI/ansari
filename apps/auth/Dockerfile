# Better Auth service (apps/auth, spec 300) image. Build context is the REPO
# ROOT (the pnpm workspace needs the root lockfile):
#   docker build -f apps/auth/Dockerfile .
#
# Same shape as apps/api/Dockerfile, on purpose: single stage, the install CI
# verifies, real environment variables injected by Railway at RUNTIME and none
# baked in. The full install is kept (not prod-pruned) because the operator's
# scripts run in this image, from /repo/apps/auth:
#   ./node_modules/.bin/tsx scripts/grant-admin.ts …   (and scripts/ban-user.ts)
# They need tsx and the raw-TS @ansari/auth workspace link. Call tsx directly,
# not `pnpm exec`: corepack cached pnpm for root at build time, so as `node`
# it would try to download pnpm at run time.

# Debian-based (not alpine): bcrypt's prebuilt native binaries target glibc;
# musl would force a node-gyp toolchain into the image. bcrypt stays an
# external import of node_modules (tsdown neverBundle), so the runtime needs
# this install's node_modules/bcrypt.
FROM node:22-slim

# packageManager in the root package.json pins the exact pnpm version.
RUN corepack enable

# The cutover operator's environment (spec 300): the window's database steps
# (copy.sh, the app migrations 0009-0011, grant-admin.ts, the audits) run from
# `railway ssh` into THIS image, so the password hashes never reach an operator
# machine. That needs psql, the repo's SQL and the scripts in a runtime image.
# Do not slim them out while the cutover tooling exists.
#
# psql's major must be >= the Railway Postgres server's major. Both servers
# (app and auth) run Postgres 18 (owner decision, 2026-10-17); Debian
# bookworm's own postgresql-client is 15, so the client comes from the PGDG
# repository, pinned by PG_CLIENT_MAJOR. The runbook checks `psql --version`
# against `select version()` on both servers before the window. Client package
# only; the apt lists and the download tool go in the same layer.
ARG PG_CLIENT_MAJOR=18
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && install -d /usr/share/postgresql-common/pgdg \
 && curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
      https://www.postgresql.org/media/keys/ACCC4CF8.asc \
 && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
      > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends "postgresql-client-${PG_CLIENT_MAJOR}" \
 && apt-get purge -y curl \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /repo

# Workspace manifests first so the dependency layer caches independently of
# source changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/auth/package.json apps/auth/
# Shared workspace packages must be present BEFORE install (workspace:* links),
# and their CONTENTS are needed at build time: tsdown bundles @ansari/auth and
# @ansari/types into dist, and tsconfig extends the shared base.
COPY packages packages
RUN pnpm install --frozen-lockfile --filter ansari-auth...

COPY apps/auth apps/auth
# The app migrations the window applies from this image (0009-0011). SQL only;
# nothing else of apps/api is in this image.
COPY apps/api/drizzle apps/api/drizzle

# tsdown needs no env: nothing reads the environment at import.
RUN pnpm --filter ansari-auth build

ENV NODE_ENV=production

# COPY keeps the build context's file modes. A checkout with a restrictive
# umask (files 0600) would leave every copied source unreadable to `node`
# below: the service still boots (it reads only dist/ and node_modules/,
# which this build created), but the operator scripts fail with EACCES.
# Open the copied sources for reading; node_modules is not walked (pnpm's
# entries there are symlinks), so this layer stays small.
RUN chmod -R a+rX /repo/package.json /repo/pnpm-workspace.yaml /repo/pnpm-lock.yaml \
    /repo/packages /repo/apps/auth /repo/apps/api/drizzle

# The cutover scripts refuse to run anywhere this file does not exist, so a
# laptop `railway shell` (which injects the same Railway variables) cannot run
# them. It marks "inside the auth image".
RUN touch /etc/ansari-auth-image

WORKDIR /repo/apps/auth

# Run as the image's unprivileged `node` user. Nothing is written at runtime.
USER node

# Two listeners (plan P-1). PORT (3100) is the PUBLIC one, the only port a
# Railway domain targets. INTERNAL_PORT (3101) is for `backend` over the private
# network only; no domain may ever target it. See railway.toml.
EXPOSE 3100 3101
CMD ["node", "dist/index.mjs"]

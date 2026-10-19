# Cutover deployment guide (spec 300)

The commands only, in order. The full runbook, [`better-auth-cutover.md`](better-auth-cutover.md),
is the authority: it has the reason, the check and the abort for every step. If any check fails
after step 2, stop and follow [`rollback.md`](rollback.md) (valid until `CUTOVER_AT` + 24 hours).

Auto-deploy stays **on** throughout. The merge in step 8 is the deploy.

## Before the day (Railway dashboard)

- `backend`: `AUTH_URL` and `AUTH_JWT_ISSUER` set to the auth domain; `MAINTENANCE_MODE=false`;
  the legacy `JWT_SECRET`, `ACCESS_TOKEN_EXPIRY_HOURS`, `REFRESH_TOKEN_EXPIRY_HOURS` and
  `ADMIN_EMAILS` are still set.
- `auth`: variables set (`docs/self-hosting.md`), `PORT=3100`, `CORS_ORIGIN` lists the web
  origins, **no domain and no active deployment** (staging: remove the PIR #59 deployment).
- The web service: `EXPO_PUBLIC_API_URL` and `EXPO_PUBLIC_AUTH_URL` set.
- The auth domain's DNS record exists and is not attached to any service.
- The Tailscale forwarder: port 5432 to the app database, port 5433 to the auth database.
- In the release record: the current deployment ID and commit of `backend`, the web service and
  `auth` (`none` if it has no deployment). These are the rollback targets.
- The admin list is approved, #307 and #317 are merged, and the cutover PR is approved and
  current with `develop`.

## 1. Open the operator session

```bash
tailscale status                                   # the forwarder is listed
git -C <repo> fetch origin && git -C <repo> checkout --detach <promoted commit>
cd <repo> && git status --porcelain                # prints nothing
set +o history
export PROMOTED_COMMIT=<promoted commit>           # staging: the cutover PR's head
export CUTOVER_ENV=production                      # or staging
read -rs APP_DATABASE_URL && export APP_DATABASE_URL     # paste at the prompt
read -rs AUTH_DATABASE_URL && export AUTH_DATABASE_URL
export API=https://api.askansari.ai AUTH=https://auth.askansari.ai   # staging: api-staging / auth-staging
```

Both databases are on Postgres 18, and they are two different clusters. The auth database is empty:

```bash
psql "$APP_DATABASE_URL" -X -At -c "select version()"     # PostgreSQL 18
psql "$AUTH_DATABASE_URL" -X -At -c "select version()"    # PostgreSQL 18
psql "$APP_DATABASE_URL" -X -At -c "select system_identifier from pg_control_system()"
psql "$AUTH_DATABASE_URL" -X -At -c "select system_identifier from pg_control_system()"   # a different number
psql "$AUTH_DATABASE_URL" -X -At -c "select count(*) from information_schema.tables where table_schema not in ('pg_catalog','information_schema')"   # 0
```

## 2. Go offline

Post the notice and silence alerts. In Railway, set `MAINTENANCE_MODE=true` on `backend` and
detach the web domain from the web service. Then:

```bash
export CUTOVER_AT="$(psql "$APP_DATABASE_URL" -X -At -c "select now()")"
echo "$CUTOVER_AT"                                 # into the release record
curl -s $API/api/v2/app-check -H 'Content-Type: application/json' -d '{"platform":"ios","native_application_version":"1.0.0","native_build_version":"1"}' | jq .maintenance_mode   # true
```

In production, also run the probe on `https://api-35.ansari.chat`. Take a Railway snapshot of
both databases and record their ids.

## 3. Auth schema

```bash
psql "$AUTH_DATABASE_URL" -X -v ON_ERROR_STOP=1 --single-transaction -f packages/auth/drizzle/0000_auth_schema.sql
psql "$AUTH_DATABASE_URL" -X -At -c "select count(*) from information_schema.tables where table_schema = 'auth'"   # 6
```

## 4. Copy the users

```bash
psql "$APP_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f apps/auth/scripts/cutover/00-preflight-app.sql   # no collision, not_bcrypt = 0
apps/auth/scripts/cutover/copy.sh                  # copy.sh: audit OK
```

## 5. App schema

Skip any file the release record says is already applied.

```bash
psql "$APP_DATABASE_URL" -X -v ON_ERROR_STOP=1 --single-transaction -f apps/api/drizzle/0009_better_auth_scaffold_cleanup.sql
psql "$APP_DATABASE_URL" -X -v ON_ERROR_STOP=1 --single-transaction -f apps/api/drizzle/0010_deleted_users.sql
psql "$APP_DATABASE_URL" -X -v ON_ERROR_STOP=1 --single-transaction -f apps/api/drizzle/0011_better_auth_window.sql
psql "$APP_DATABASE_URL" -X -At -c "select count(*) from users where email <> lower(trim(email))"   # 0
```

## 6. Admin roles

For each approved address, show the account first, then grant it by its id:

```bash
(cd apps/auth && DATABASE_URL="$AUTH_DATABASE_URL" pnpm exec tsx scripts/grant-admin.ts <email>)
(cd apps/auth && DATABASE_URL="$AUTH_DATABASE_URL" pnpm exec tsx scripts/grant-admin.ts <email> --confirm <id>)
psql "$AUTH_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -f apps/auth/scripts/cutover/05-audit-admins-auth.sql   # exactly the approved list
```

If the first command prints a warning (a recent or unverified account), confirm with the person
before you run `--confirm`.

## 7. Attach the auth domain

In Railway, attach the auth domain to the `auth` service on port 3100. Then:

```bash
curl -s -o /dev/null -w '%{http_code}' $AUTH/health   # 404 or 502; never 200, never 000
```

## 8. Deploy: merge

- **Staging:** merge the cutover PR into `develop`.
- **Production:** promote `develop` to `main`:

```bash
git fetch origin && [ "$(git rev-parse origin/develop)" = "$(git rev-parse "$PROMOTED_COMMIT")" ] && echo develop-unchanged   # production, before the push
git fetch origin && git push origin origin/develop:main          # production
git fetch origin && git diff-tree --quiet "$PROMOTED_COMMIT" origin/main && echo same-tree   # origin/develop on staging
```

Auto-deploy builds `auth`, `backend` and the web service. Wait until all three are healthy.

## 9. Verify

```bash
curl -fsS $AUTH/health
curl -fsS $AUTH/api/auth/jwks | jq '.keys | length'                                   # 1 or more
curl -s -o /dev/null -w '%{http_code}' $AUTH/api/account/me                           # 401
```

- Run the edge probes in [`edge-check.md`](edge-check.md).
- Attach the web domain to the `apps/frontend` web service.
- In a private window, run the smoke test: guest, sign up, sign out, sign in, ask a question,
  reset the password from the email, and delete the account.

## 10. Back online

In Railway, set `MAINTENANCE_MODE=false` on `backend`. Then:

```bash
curl -s $API/api/v2/app-check -H 'Content-Type: application/json' -d '{"platform":"ios","native_application_version":"1.0.0","native_build_version":"1"}' | jq .maintenance_mode   # false
```

- Relaunch a released mobile build and sign in.
- Un-silence the alerts and close the release record.
- Remove the Tailscale forwarder and revoke its key.
- `exit` the shell.

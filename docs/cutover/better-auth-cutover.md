# Better Auth cutover: the window runbook (spec 300)

The production cutover from `apps/api`'s legacy JWT auth to `apps/auth` (Better Auth). Read
it whole before the window. Every step names the file it runs, the commit it is applied from,
a **check** that is mechanical (a command and the output it must show) and the **abort**
action if the check fails. Rollback, within 24 hours, is [`rollback.md`](rollback.md). The
operator SQL is described in
[`apps/auth/scripts/cutover/README.md`](../../apps/auth/scripts/cutover/README.md).

**The operator environment.** Every database step runs inside the **auth image**, reached with

```bash
railway ssh --service auth --environment production
cd /repo
export AUTH_DATABASE_URL="$DATABASE_URL"   # the auth service's own database
export APP_DATABASE_URL='<app database URL>'   # typed into this ssh session only
```

The image carries `psql`, the cutover scripts, both migration journals and the operator
scripts, at the commit the service was deployed from (step 6). Nothing here runs on a laptop:
`railway shell` on a laptop injects the same Railway variables, so the scripts refuse to run
anywhere without the image's marker (`/etc/ansari-auth-image`). A local `docker run` of the
image would also have the marker (an accepted residual): these steps run **only** through
`railway ssh` into the auth service. `APP_DATABASE_URL` is never set on a service and never
written to a file; it ends with the ssh session.

**`psql`.** Every `psql` that applies a migration is `psql -X -v ON_ERROR_STOP=1 --single-transaction -f <file>`:
with both flags, a failed statement stops the run **and** rolls back everything before it. The
cutover scripts are the exception named in their README: they open their own transaction and
run without `--single-transaction`.

**Release record.** Keep one record for the window, in the release notes. It gets the promoted
commit, every SQL file with the commit it was applied from, `cutover_at`, every check's output
(counts and checksums only) and every decision taken.

**Schema freeze.** From the merge of the cutover PR to the end of this window, no other
migration merges to `develop`, in either journal.

## 1. Preconditions (all must hold; any missing → do not start)

- **`main` is current except for spec 300.** A normal release of `develop` at the tip just
  before the cutover PR has been promoted and has soaked, so this window promotes only the
  spec 300 delta.
- The phase 13 rehearsal ([`rehearsal.md`](rehearsal.md): staging users seeded with every anomaly class, owner amendment R-1, plus a fresh auth
  database, including a rollback rehearsal) is signed off, and was re-run after the branch's
  last rebase.
- The phase 13 image check passed: `docker build -f apps/auth/Dockerfile .`, run as the image's
  `node` user, `./node_modules/.bin/tsx scripts/grant-admin.ts --list` inside it.
- Baselines B-1 to B-4 are recorded in [`baselines.md`](baselines.md). `AUTH_RATE_LIMIT_MODE` for
  production is the staging edge check's verdict ([`edge-check.md`](edge-check.md)).
- The owner has approved the **admin list** (by address), from `00-preflight-app.sql`'s
  inventory.
- **Postgres 18 on both servers, so the cutover runs 18 to 18.** The production app database
  has been upgraded from 17 to 18 (Railway's native upgrade, **before** this window, never inside
  it), and the auth database was provisioned on 18. From the operator
  environment, `psql "$APP_DATABASE_URL" -X -At -c "select version()"` and
  `psql "$AUTH_DATABASE_URL" -X -At -c "select version()"` both report `PostgreSQL 18`, and
  `psql --version` beside them reports 18 (the auth image's `PG_CLIENT_MAJOR`).
- Every **collision** the preflight lists is decided and resolved (the copy and `0011` abort on
  any), the preflight shows no NULL `created_at`/`updated_at` (the copy aborts on any: it
  copies timestamps exactly), and `not_bcrypt = 0` (the copy aborts on any hash that is not
  bcrypt `$2a$`/`$2b$` of length 60: apps/auth would send it to scrypt and the user could not
  sign in).
- Phases 10b (#304) and 10c (#306) are merged into `builder/spir-300`, so the cutover PR carries
  the reset and delete-account pages (legacy web retires in step 16).
- The cutover PR is approved and merged to `develop`; record its merge commit.
- Railway (main architect's runbook section): the `auth` service exists with its variables set
  (see `docs/self-hosting.md`) **and `ADMIN_EMAILS` empty** until step 10; private networking on;
  **no domain on `INTERNAL_PORT` (3101)**; its own Postgres with snapshots or PITR **on**. The
  auth database is **empty** (no schema yet).
- **Auto-deploy is OFF for `backend`, the web service and `auth`** for the window. Railway deploys
  `backend` from `main` on every push, so with auto-deploy on, the promotion in step 4 would boot
  the new `apps/api` before `0011` and the auth database exist. Every deploy below is manual,
  from the promoted commit.
- **`backend` keeps its legacy variables** `JWT_SECRET`, `ACCESS_TOKEN_EXPIRY_HOURS`,
  `REFRESH_TOKEN_EXPIRY_HOURS` and `ADMIN_EMAILS` until the contract PR: the rollback redeploys
  the previous `apps/api`, which does not boot without them.
- `CORS_ORIGIN` on `auth` lists the **real web origins** (the `apps/frontend` web domains). No CI
  check can see this; if it is wrong, every web sign-in fails.
- The web service has both build variables set, for production:
  `EXPO_PUBLIC_API_URL=https://api.askansari.ai`, `EXPO_PUBLIC_AUTH_URL=https://auth.askansari.ai`.
- DNS for `auth.askansari.ai` points at Railway, and the domain is **not yet attached**.

**Check:** each item ticked in the release record by name. **Abort:** postpone the window.

## 2. Comms and alert silencing

Post the maintenance notice (the time window, "you will be asked to sign in again"). Silence
the uptime and Sentry alerts that the offline step would page on.

**Check:** the notice is visible; the alert silences are listed in the record.
**Abort:** none needed; un-silence if the window is postponed.

## 3. `apps/api` offline

By the mechanism the rehearsal chose (recorded there).

**Check:** `curl -s -o /dev/null -w '%{http_code}' https://api.askansari.ai/api/health` and the
same for `https://api-35.ansari.chat/api/health` return the offline response, not 200.
**Abort:** bring `apps/api` back online. Nothing has changed.

## 4. Promote `develop` to `main`

The fast-forward of `RELEASE.md`'s standard checklist, now that `apps/api` is offline and
auto-deploy is off. Every deploy and every applied file below comes from this commit.

```bash
git fetch origin && git push origin origin/develop:main
```

**Check:** `git rev-parse origin/main` equals the cutover PR's merge commit (or a later
`develop` commit carrying no migration); record it. No Railway deployment started.
**Abort:** bring `apps/api` back online on its current deployment. `main` holding the new
commit is harmless while nothing deploys from it; revert the promotion before re-enabling
auto-deploy.

## 5. Snapshots

Take a Railway snapshot (or note the PITR mark) of the **app database**, and of the (empty)
**auth database**.

**Check:** both snapshot ids or PITR timestamps are in the record.
**Abort:** bring `apps/api` back online.

## 6. Deploy `apps/auth` privately (the operator environment)

Deploy the `auth` service from the promoted commit, with **`ADMIN_EMAILS` empty** and **no
domain**. It boots without a schema (`/health` only pings the database), and with no
configured admins its boot assertion has nothing to check. Then open the operator environment
above (`railway ssh`, the two exports).

Then take **`cutover_at`** from the app database's own clock:

```bash
psql "$APP_DATABASE_URL" -X -At -c "select now()"
```

It is taken **here**, with `apps/api` offline and before any new code can create a user (the new
`apps/api` first deploys in step 12), so the rollback's "users created at or after
`cutover_at`" catches every one of them.

**Check:** the deployment is healthy; in the ssh session, `test -f /etc/ansari-auth-image && echo image`
prints `image`; `psql --version` shows 18, and `select version()` reports `PostgreSQL 18` on both
`$APP_DATABASE_URL` and `$AUTH_DATABASE_URL`; `cutover_at` is in the record.
**Abort:** remove the deployment, bring `apps/api` back online.

## 7. The auth baseline

`packages/auth/drizzle/0000_auth_schema.sql`, in the operator environment:

```bash
psql "$AUTH_DATABASE_URL" -X -v ON_ERROR_STOP=1 --single-transaction -f packages/auth/drizzle/0000_auth_schema.sql
```

**Check:** `psql "$AUTH_DATABASE_URL" -X -At -c "select count(*) from information_schema.tables where table_schema = 'auth'"`
prints `6`, and `psql "$AUTH_DATABASE_URL" -X -At -c "select count(*) from auth.users"` prints `0`.
Record `auth-journal-applied: 0000_auth_schema` and the commit.
**Abort:** `psql "$AUTH_DATABASE_URL" -X -c 'DROP SCHEMA auth CASCADE'`, remove the `auth`
deployment, bring `apps/api` back online.

## 8. The copy and the audits

Re-run the preflight first; it must show no collision, `no_password_hash = 0`, `not_bcrypt = 0` and no NULL timestamp. Then copy:

```bash
psql "$APP_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f apps/auth/scripts/cutover/00-preflight-app.sql
apps/auth/scripts/cutover/copy.sh
```

**Check:** `copy.sh` exits 0 and prints `copy.sh: audit OK`, with the same six lines for the app
and the auth side (`rows` equal to the preflight's `to_copy`). Record both blocks.
**Abort:** do **not** run step 9. Empty the auth database (`DROP SCHEMA auth CASCADE`), and
either re-run from step 7 or bring `apps/api` back online on the old code.

## 9. The app window migration

In the operator environment, in journal order, each applied only if not already applied
(`0009` and `0010` may have shipped earlier; the release record says):

```bash
psql "$APP_DATABASE_URL" -X -v ON_ERROR_STOP=1 --single-transaction -f apps/api/drizzle/0009_better_auth_scaffold_cleanup.sql
psql "$APP_DATABASE_URL" -X -v ON_ERROR_STOP=1 --single-transaction -f apps/api/drizzle/0010_deleted_users.sql
psql "$APP_DATABASE_URL" -X -v ON_ERROR_STOP=1 --single-transaction -f apps/api/drizzle/0011_better_auth_window.sql
```

**Check:** `psql "$APP_DATABASE_URL" -X -At -c "select is_nullable from information_schema.columns where table_name = 'users' and column_name = 'password_hash'"`
prints `YES`, and `psql "$APP_DATABASE_URL" -X -At -c "select count(*) from users where email <> lower(trim(email))"`
prints `0`. Each guard is one `DO` block: a guard failure aborts its file with nothing applied.
**Abort:** a guard failure changed nothing; the legacy code still runs on this database. Bring
`apps/api` back online on the old code and investigate. If `0011` applied and the window must
still stop, follow [`rollback.md`](rollback.md).

## 10. Admin roles

In the operator environment (the service's own `DATABASE_URL` is the auth database), for each
address on the approved list, then the audit:

```bash
(cd apps/auth && ./node_modules/.bin/tsx scripts/grant-admin.ts <email>)
psql "$AUTH_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -f apps/auth/scripts/cutover/05-audit-admins-auth.sql
```

Then set `ADMIN_EMAILS` on the `auth` service to exactly the approved list, and redeploy `auth`
(same commit, still no domain).

**Check:** `05-audit-admins-auth.sql` prints exactly the approved list, one address per line. The
redeployed `auth` is healthy: its production boot asserts that every `ADMIN_EMAILS` address holds
the role, and exits otherwise. A legacy admin left off the list holds no admin role.
**Abort:** `(cd apps/auth && ./node_modules/.bin/tsx scripts/grant-admin.ts --revoke <email>)`
for any extra; fix and re-check.

## 11. Private-network smoke tests

From the `backend` service's ssh (the network path `apps/api` will use), with the internal
credential:

```bash
curl -s -o /dev/null -w '%{http_code}' http://<auth>.railway.internal:3101/api/auth/jwks
curl -s -H "X-Ansari-Internal-Auth: $AUTH_INTERNAL_SECRET" http://<auth>.railway.internal:3101/api/auth/jwks | jq '.keys | length'
```

**Check:** the first prints `401` (the internal listener demands the credential); the second
prints `1` or more. `apps/auth` is still unreachable from the public internet (scenario 31): it
has no domain, and its `*.up.railway.app` domain is not generated.
**Abort:** follow [`rollback.md`](rollback.md).

## 12. Deploy `apps/api` and `apps/frontend`

Deploy the `backend` service and the web service from the promoted commit.

**Check:** both deployments healthy. On each `*.up.railway.app` production domain of `backend`,
the P-4 probe `curl -s https://<backend>.up.railway.app/api/v2/_diag/client-ip` shows your own
IP as `x_real_ip` (see [`edge-check.md`](edge-check.md) for the reading).
**Abort:** follow [`rollback.md`](rollback.md).

## 13. Re-attach `apps/api`'s domains

Undo step 3's mechanism for `api.askansari.ai` and `api-35.ansari.chat`.

**Check:** `curl -fsS https://api.askansari.ai/api/health` and
`curl -fsS https://api-35.ansari.chat/api/health` return 200. A released mobile build signs in
through `/v2/users/login` (the compatibility layer) and loads its threads.
**Abort:** follow [`rollback.md`](rollback.md).

## 14. Edge probe on the `apps/api` production domains (P-4)

On `api.askansari.ai` and `api-35.ansari.chat`, over IPv4 and IPv6 where reachable, both
properties of [`edge-check.md`](edge-check.md):

```bash
curl -s -H 'X-Real-IP: 203.0.113.9' -H 'X-Forwarded-For: 203.0.113.9' https://api.askansari.ai/api/v2/_diag/client-ip
```

**Check:** **overwrite:** `x_real_ip` is your real address, never `203.0.113.9`; **distinctness:**
the same probe from a second network (a phone hotspot) shows a different `x_real_ip`. Record
both, per domain, in `edge-check.md`.
**Abort (no rollback):** if either property fails, set `AUTH_RATE_LIMIT_MODE=email` on `auth` and
redeploy it. It can only move to `email` here, never to `ip`.

## 15. Attach `auth.askansari.ai`

Attach the public domain to the `auth` service, targeting **`PORT` (3100) only**. This comes
before the web swap: the new web app signs in, and provisions guests, only through this domain.

**Check:** `curl -fsS https://auth.askansari.ai/health` returns 200;
`curl -s -o /dev/null -w '%{http_code}' https://auth.askansari.ai/internal/users/00000000-0000-0000-0000-000000000000/profile`
prints `404` (the internal routes are not on the public listener); and the edge properties, as
in step 14, on its probe:
`curl -s -H 'X-Real-IP: 203.0.113.9' -H 'X-Forwarded-For: 203.0.113.9' https://auth.askansari.ai/__diag/client-ip`
shows your real address, and a second network shows a different one. Record them.
**Abort:** detach the domain; follow [`rollback.md`](rollback.md). An edge failure alone is step
14's abort: `AUTH_RATE_LIMIT_MODE=email`, redeploy `auth`.

## 16. Replace legacy web with `apps/frontend`

Move the web domain from the legacy web service to the `apps/frontend` web service (owner,
2026-10-16: legacy web retires at go-live).

**Check:** the web domain serves `apps/frontend` (its page title and the sign-in sheet), and a
private window provisions a guest (one `sign-up/email` then one `token` at `auth.askansari.ai`).
**Abort:** move the domain back; follow [`rollback.md`](rollback.md) if anything else changed.

## 17. Public smoke tests (scenario 31)

On the production web app, in a private window: open the app (a guest is provisioned), sign up
a throwaway account, sign out, sign in, ask one question. Request a password reset for it and
complete the reset from the email. Delete the account at `/delete-account`.

**Check:** each succeeds; the reset email's link has the shape
`https://<web domain>/reset-password?token=…` and opens the reset page.
**Abort:** follow [`rollback.md`](rollback.md).

## 18. Re-enable alerting and close the record

Un-silence the alerts from step 2. Re-enable auto-deploy for `backend`, the web service and
`auth`. Complete the release record: the promoted commit, each applied file with its commit,
`cutover_at`, the rollback deadline (`cutover_at` + 24 hours), and every check's output.

**Check:** the record is complete and posted; auto-deploy is on again.
**Abort:** n/a.

## What users and operators will notice

- **Everyone signs in once more.** Old JWTs and refresh tokens are dead.
- **Users signed in to a real account before the cutover** open the new web app signed out, on
  their device's guest. Their account is unchanged; they sign in with the same email and
  password. Say this in the release note and the maintenance notice.
- **Key rotation is not revocation.** A rotated signing key does not invalidate existing JWTs
  until `apps/api`'s cached key set expires (10 minutes, plus a 15-minute grace while `apps/auth`
  is unreachable) or `apps/api` restarts. To cut a user off, ban them (`ban-user.ts`, which
  deletes their sessions); their JWT still verifies until it expires (15 minutes).
- **Reset links in access logs.** `GET /reset-password?token=…` is logged by the web host on every
  click. The token is single-use and expires after an hour. Changing the link shape is with the
  owner.
- **If the offline mechanism detaches domains,** `backend`'s `*.up.railway.app` domain stays
  reachable during the window. Accepted; the rehearsal records it.

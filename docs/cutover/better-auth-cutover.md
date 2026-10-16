# Better Auth cutover: the window runbook (spec 300)

The production cutover from `apps/api`'s legacy JWT auth to `apps/auth` (Better Auth). Read
it whole before the window. Every step names the file it runs, the `develop` commit it is
applied from, a **check** that is mechanical (a command and the output it must show) and
the **abort** action if the check fails. Rollback, within 24 hours, is
[`rollback.md`](rollback.md). The operator SQL is described in
[`apps/auth/scripts/cutover/README.md`](../../apps/auth/scripts/cutover/README.md).

**Shell.** Steps that touch a database run in a **Railway shell** inside the project, with
`APP_DATABASE_URL` (the app database) and `AUTH_DATABASE_URL` (the auth database) entered for
that session only. Never set them on a service; never write them to a file. Every `psql` that
applies a migration is `psql -X -v ON_ERROR_STOP=1 --single-transaction -f <file>`: with both
flags, a failed statement stops the run **and** rolls back everything before it. The cutover
scripts are the exception named in their README: they open their own transaction and run
without `--single-transaction`.

**Release record.** Keep one record for the window, in the release notes. It gets the
`develop` commit every SQL file is applied from, `cutover_at`, every check's output (counts
and checksums only) and every decision taken.

**Schema freeze.** From the merge of the cutover PR to the end of this window, no other
migration merges to `develop`, in either journal.

## 1. Preconditions (all must hold; any missing → do not start)

- The phase 13 rehearsal (staging, a clone of the production app database plus a fresh auth
  database, including a rollback rehearsal) is signed off, and was re-run after the branch's
  last rebase.
- The phase 13 image check passed: `docker build -f apps/auth/Dockerfile .`, run as the
  image's `node` user, `./node_modules/.bin/tsx scripts/grant-admin.ts --list` inside it.
- Baselines B-1 to B-4 are recorded in [`baselines.md`](baselines.md). `AUTH_RATE_LIMIT_MODE`
  for production is the staging edge check's verdict ([`edge-check.md`](edge-check.md)).
- The owner has approved the **admin list** (by address), from `00-preflight-app.sql`'s
  inventory.
- Every **collision** the preflight lists is decided and resolved (the copy and `0011`
  abort on any).
- Phases 10b (#304) and 10c (#306) are merged into `builder/spir-300`, so the cutover PR
  carries the reset and delete-account pages (legacy web retires in step 13).
- The cutover PR is approved and merged to `develop`; record its merge commit. Every file
  below is applied from that commit.
- Railway (main architect's runbook section): the `auth` service exists with its variables
  set (see `docs/self-hosting.md`), private networking on, **no domain on `INTERNAL_PORT`
  (3101)**, and its own Postgres with snapshots or PITR **on**. The auth database is
  **empty** (no schema yet).
- `CORS_ORIGIN` on `auth` lists the **real web origins** (the `apps/frontend` web
  domains). No CI check can see this; if it is wrong, every web sign-in fails.
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

By the mechanism the rehearsal chose (recorded there). Then take `cutover_at`:

```bash
psql "$APP_DATABASE_URL" -X -At -c "select now()"
```

**Check:** `curl -s -o /dev/null -w '%{http_code}' https://api.askansari.ai/api/health` and the
same for `https://api-35.ansari.chat/api/health` return the offline response, not 200.
`cutover_at` is in the record. It is taken **here**, before any new code can create a user, so
the rollback's "users created at or after `cutover_at`" catches every one of them.
**Abort:** bring `apps/api` back online. Nothing has changed.

## 4. Snapshots

Take a Railway snapshot (or note the PITR mark) of the **app database**, and of the (empty)
**auth database**.

**Check:** both snapshot ids or PITR timestamps are in the record.
**Abort:** bring `apps/api` back online.

## 5. The auth baseline

From the merge commit: `packages/auth/drizzle/0000_auth_schema.sql`.

```bash
psql "$AUTH_DATABASE_URL" -X -v ON_ERROR_STOP=1 --single-transaction -f packages/auth/drizzle/0000_auth_schema.sql
```

**Check:** `psql "$AUTH_DATABASE_URL" -X -At -c "select count(*) from information_schema.tables where table_schema = 'auth'"`
prints `6`, and `psql "$AUTH_DATABASE_URL" -X -At -c "select count(*) from auth.users"` prints `0`.
Record `auth-journal-applied: 0000_auth_schema` and the commit.
**Abort:** drop the `auth` schema (`DROP SCHEMA auth CASCADE`), bring `apps/api` back online.

## 6. The copy and the audits

Re-run the preflight first; it must show no collision and `no_password_hash = 0`:

```bash
psql "$APP_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f apps/auth/scripts/cutover/00-preflight-app.sql
RAILWAY_ENVIRONMENT="$RAILWAY_ENVIRONMENT" apps/auth/scripts/cutover/copy.sh
```

**Check:** `copy.sh` exits 0 and prints `copy.sh: audit OK`, with the same six lines for the
app and the auth side (`rows` equal to the preflight's `to_copy`). Record both blocks.
**Abort:** do **not** run step 7. Empty the auth database (`DROP SCHEMA auth CASCADE`), and
either re-run from step 5 or bring `apps/api` back online on the old code.

## 7. The app window migration

From the merge commit, in journal order, each applied only if not already applied
(`0009` and `0010` may have shipped earlier; the release record says):

```bash
psql "$APP_DATABASE_URL" -X -v ON_ERROR_STOP=1 --single-transaction -f apps/api/drizzle/0009_better_auth_scaffold_cleanup.sql
psql "$APP_DATABASE_URL" -X -v ON_ERROR_STOP=1 --single-transaction -f apps/api/drizzle/0010_deleted_users.sql
psql "$APP_DATABASE_URL" -X -v ON_ERROR_STOP=1 --single-transaction -f apps/api/drizzle/0011_better_auth_window.sql
```

**Check:** `psql "$APP_DATABASE_URL" -X -At -c "select is_nullable from information_schema.columns where table_name = 'users' and column_name = 'password_hash'"`
prints `YES`, and `... -c "select count(*) from users where email <> lower(trim(email))"` prints `0`.
Each guard is one `DO` block: a guard failure aborts its file with nothing applied.
**Abort:** a guard failure changed nothing; the legacy code still runs on this database.
Bring `apps/api` back online on the old code and investigate. If `0011` applied and the window
must still stop, follow [`rollback.md`](rollback.md).

## 8. Admin roles

From a shell on the `auth` service (it holds the auth `DATABASE_URL`), for each address on the
approved list:

```bash
./node_modules/.bin/tsx scripts/grant-admin.ts <email>
psql "$AUTH_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f apps/auth/scripts/cutover/05-audit-admins-auth.sql
```

**Check:** `05-audit-admins-auth.sql` prints exactly the approved list, one address per line.
`ADMIN_EMAILS` on `auth` equals that list. A legacy admin left off the list holds no admin role.
**Abort:** `grant-admin.ts --revoke <email>` for any extra; fix and re-check.

## 9. Deploy `apps/auth` (private only)

Deploy the `auth` service from the merge commit. No domain is attached.

**Check:** its deployment is healthy (healthcheck `/health` is 200 only when the auth database
answers), and its boot did not fail the admin assertion. From the `backend` shell:
`curl -s -o /dev/null -w '%{http_code}' http://<auth>.railway.internal:3101/api/auth/jwks` prints
`401` (the internal listener demands the credential).
**Abort:** follow [`rollback.md`](rollback.md) from step 3.

## 10. Private-network smoke tests

From the `backend` shell, with the internal credential:

```bash
curl -s -H "X-Ansari-Internal-Auth: $AUTH_INTERNAL_SECRET" http://<auth>.railway.internal:3101/api/auth/jwks | jq '.keys | length'
```

**Check:** prints `1` or more. `apps/auth` is still unreachable from the public internet (scenario
31): it has no domain, and its `*.up.railway.app` domain is not generated.
**Abort:** follow [`rollback.md`](rollback.md).

## 11. Deploy `apps/api` and `apps/frontend`

Deploy the `backend` service and the web service from the merge commit.

**Check:** both deployments healthy. On each `*.up.railway.app` production domain of
`backend`, the P-4 probe: `curl -s https://<backend>.up.railway.app/api/v2/_diag/client-ip`
shows your own IP as `x_real_ip` (see [`edge-check.md`](edge-check.md) for the reading).
**Abort:** follow [`rollback.md`](rollback.md).

## 12. Re-attach `apps/api`'s domains

Undo step 3's mechanism for `api.askansari.ai` and `api-35.ansari.chat`.

**Check:** `curl -fsS https://api.askansari.ai/api/health` and
`curl -fsS https://api-35.ansari.chat/api/health` return 200. A released mobile build signs in
through `/v2/users/login` (the compatibility layer) and loads its threads.
**Abort:** follow [`rollback.md`](rollback.md).

## 13. Replace legacy web with `apps/frontend`

Move the web domain from the legacy web service to the `apps/frontend` web service (owner,
2026-10-16: legacy web retires at go-live).

**Check:** the web domain serves `apps/frontend` (its page title and the sign-in sheet).
**Abort:** move the domain back; follow [`rollback.md`](rollback.md) if anything else changed.

## 14. Edge probe on the production domains (P-4)

`curl -s https://api.askansari.ai/api/v2/_diag/client-ip` and the same on `api-35.ansari.chat`,
over IPv4 and IPv6 where reachable.

**Check:** each shows your own address as the single `x_real_ip`, and a forged
`X-Forwarded-For` / `X-Real-IP` sent with the request is not echoed back.
**Abort (no rollback):** if the IP is not trustworthy, set `AUTH_RATE_LIMIT_MODE=email` on `auth`
and redeploy it. It can only move to `email` here, never to `ip`.

## 15. Attach `auth.askansari.ai`

Attach the public domain to the `auth` service, targeting **`PORT` (3100) only**.

**Check:** `curl -fsS https://auth.askansari.ai/health` returns 200;
`curl -s https://auth.askansari.ai/__diag/client-ip` shows your own IP;
`curl -s -o /dev/null -w '%{http_code}' https://auth.askansari.ai/internal/users/00000000-0000-0000-0000-000000000000/profile`
prints `404` (the internal routes are not on the public listener).
**Abort:** detach the domain; follow [`rollback.md`](rollback.md).

## 16. Public smoke tests (scenario 31)

On the production web app, in a private window: open the app (a guest is provisioned), sign
up a throwaway account, sign out, sign in, ask one question. Request a password reset for it
and complete the reset from the email. Delete the account at `/delete-account`.

**Check:** each succeeds; the reset email's link has the shape
`https://<web domain>/reset-password?token=…` and opens the reset page.
**Abort:** follow [`rollback.md`](rollback.md).

## 17. Re-enable alerting and close the record

Un-silence the alerts from step 2. Complete the release record: the merge commit, each
applied file with its commit, `cutover_at`, the rollback deadline (`cutover_at` + 24 hours),
and every check's output.

**Check:** the record is complete and posted. **Abort:** n/a.

## What users and operators will notice

- **Everyone signs in once more.** Old JWTs and refresh tokens are dead.
- **Users signed in to a real account before the cutover** open the new web app signed out,
  on their device's guest. Their account is unchanged; they sign in with the same email and
  password. Say this in the release note and the maintenance notice.
- **Key rotation is not revocation.** A rotated signing key does not invalidate existing JWTs
  until `apps/api`'s cached key set expires (10 minutes, plus a 15-minute grace while
  `apps/auth` is unreachable) or `apps/api` restarts. To cut a user off, ban them
  (`ban-user.ts`, which deletes their sessions); their JWT still verifies until it expires
  (15 minutes).
- **Reset links in access logs.** `GET /reset-password?token=…` is logged by the web host on
  every click. The token is single-use and expires after an hour. Changing the link shape is
  with the owner.

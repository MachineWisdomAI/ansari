# Cutover rehearsal on staging (spec 300, plan phase 13)

**Owner amendment R-2 (2026-10-17).** The branch is never deployed to staging. After the
cutover PR merges to `develop` (frozen from then on), the whole window runbook
([`better-auth-cutover.md`](better-auth-cutover.md), its "Staging rehearsal" section gives the
differences) and the rollback ([`rollback.md`](rollback.md)) run on staging from that merge
commit. This file holds the procedure and, filled in by the docs-only evidence PR, the results.
`develop` is not promoted until that PR merges.

Who does what:
- the owner operates Railway (`railway ssh`, `copy.sh`, `0009`–`0011`, `grant-admin.ts`, the
  rollback script)
- the main architect prepares the filled-in staging command sheet and checks outputs
- the builder runs the client-side checks (Parts C and D, and the edge probes)

**What is recorded here.** Counts, checksums, timings, exit codes and pass/fail only. Never a row,
an email address, a password, a hash, or a URL with credentials. The preflight also prints the
legacy admins' ids and addresses: that inventory stays with the owner and is not copied here.

## The data: staging users, not a production clone (owner amendment, 2026-10-17)

The plan called for a clone of the production app database (C-3). **The owner amended this:** the
rehearsal runs on the users already in the staging app database, with no production restore. The
security architect accepted the amendment with the mitigations below.

A clone would have shown two things that staging cannot:

- **Production's data shape**: case collisions, NULL timestamps, hash formats, legacy admins and
  system rows. Covered instead by:
  1. The owner runs the read-only `apps/auth/scripts/cutover/00-preflight-app.sql` against
     production. They run it for B-1 and B-4 anyway, and it flags every blocking class ahead of
     the window.
  2. Part A below seeds staging with one row per class, so each of the copy's guards is shown to
     fire in the real environment.
- **Real-size timings**: covered by the scaling rule in Part B.

## Environment

- Staging, isolated from production. Each service is deployed **by hand from the cutover PR's
  merge commit on `develop`**, with auto-deploy off (set before the merge), and
  `auth-staging.askansari.ai` attached at step 15.
- Postgres 18 on both the staging app and auth servers. `psql --version` in the auth image reports
  18 (the window's step 1 precondition, rehearsed).
- The operator environment is the window's, in staging:
  `railway ssh --service auth --environment staging`, then `cd /repo`, with `AUTH_DATABASE_URL`
  set to the service's `DATABASE_URL` and `APP_DATABASE_URL` typed in the session only.

## Un-rehearsed residuals

- **The production web swap (window step 16).** Staging web already serves `apps/frontend`
  (title Ansari, built against `api-staging`). So on staging, step 16 rehearses only the rebuild
  with `EXPO_PUBLIC_AUTH_URL` and the domain checks. Production's change of the web service's
  Dockerfile path, from legacy web to `apps/frontend`, is not rehearsed. Its rollback,
  [`rollback.md`](rollback.md) step 4 (restore the previous legacy web deployment), is unchanged.

## Part A: the guards fire (runbook steps 6 to 8)

In the operator environment, after runbook step 6 and before step 7, seed the staging app
database. The existing staging users and system rows stay. Every `rehearsal-anomalies.ts`
command is piped straight into psql. The script refuses outside the auth image, outside Railway's
`staging` environment, or onto a terminal:

```bash
SEED="./apps/auth/node_modules/.bin/tsx apps/auth/scripts/cutover/rehearsal-anomalies.ts"
read -rs REHEARSAL_PASSWORD && export REHEARSAL_PASSWORD   # typed, ≥ 12 characters; kept for Part B's sign-ins
$SEED seed | psql "$APP_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 --single-transaction
```

Expected: no output and exit 0. Run it a second time and it must fail with
`rehearsal rows already exist; run remove first`.

The seed is seven rows:
- a collision pair: two emails that normalize to one
- a NULL `updated_at`
- a mixed-case email with a `$2a$` hash
- a `$2b$` hash
- a legacy `is_admin` row
- a guest-shaped row (`guest_` + 10 characters, Welcome Guest)

1. Run the preflight:
   `psql "$APP_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f apps/auth/scripts/cutover/00-preflight-app.sql`.
   On top of the staging users' own numbers, it must show the seed:
   - one more collision group (of 2 rows)
   - `not_normalized` up by 2
   - `null_updated_at` = 1
   - `$2a$`/60 ≥ 1
   - `not_bcrypt` = 0
   - guests up by 1
   - one more legacy admin

   Record counts only; the admin inventory stays with the owner.
2. Apply the auth baseline (runbook step 7), then run step 8's `apps/auth/scripts/cutover/copy.sh`.
   **It must exit non-zero** with
   `cutover copy: 1 normalized email(s) are held by more than one row`. Then:
   - `psql "$AUTH_DATABASE_URL" -X -At -c "select (select count(*) from auth.users) + (select count(*) from auth.account)"` prints `0`
   - `psql "$AUTH_DATABASE_URL" -X -At -c "select count(*) from pg_class where relname = 'import_users'"` prints `0`
3. `$SEED resolve-collision | psql "$APP_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 --single-transaction`,
   then `copy.sh` again. **It must exit non-zero** with
   `cutover copy: 1 row(s) have a NULL created_at or updated_at`, and both checks above print `0`.
4. `$SEED resolve-null | psql "$APP_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 --single-transaction`,
   then `copy.sh` a third time. It must print `copy.sh: audit OK`. The runbook continues at
   step 9 (Part B).

| Step | Expected | Exit code | Auth rows after | TEMP table left | Result |
|---|---|---|---|---|---|
| A1 preflight | every class counted | | n/a | n/a | |
| A2 copy with the collision | aborts naming a count | | | | |
| A3 copy with the NULL timestamp | aborts naming a count | | | | |

## Part B: the pass run, timed

Follow the window runbook step by step, as written. For each step, record the start, the end, and
the **Check:** output (counts and checksums only).

After the copy, sign each seeded user in against the staging auth service with
`REHEARSAL_PASSWORD`, once its public domain is attached (step 15) or on the private network in
step 11. Each must return the seeded id (the `e0300000-…` ids in the script):
- The mixed-case row signs in with its address in **upper case**.
- The `$2a$` and `$2b$` rows both sign in.
- The legacy admin holds `role = 'admin'` after `grant-admin.ts`, and `05` lists it.
- The guest signs in with its stored session (Part D).
- System rows are absent from `auth.users` (`system_domain_rows|0`).

| Step | Measured on staging | Scaled? | Production estimate | Check output |
|---|---|---|---|---|
| 1 Preconditions | | no | | |
| 2 Comms and alert silencing | | no | | |
| 3 `apps/api` offline | | no | | |
| 4 Promote `develop` to `main` | | no | | |
| 5 Snapshots | | no | | |
| 6 Deploy `apps/auth` privately | | no | | |
| 7 The auth baseline | | no | | |
| 8 The copy and the audits | | **yes** | | |
| 9 The app window migration | | no | | |
| 10 Admin roles | | no | | |
| 11 Private-network smoke tests | | no | | |
| 12 Deploy `apps/api` and `apps/frontend` | | no | | |
| 13 Re-attach `apps/api`'s domains | | no | | |
| 14 Edge probe | | no | | |
| 15 Attach the auth domain | | no | | |
| 16 Replace legacy web | | no | | |
| 17 Public smoke tests | | no | | |
| 18 Re-enable alerting | | no | | |

**Scaling rule.**
- Only step 8 (the copy and the audits) is scaled, by `production to_copy ÷ staging to_copy`. Both
  counts come from the preflight's "Rows to copy".
- Deploys, snapshots, DNS and the smoke tests are recorded as measured.
- The window's **comms allowance is three times the scaled total.**

| Value | |
|---|---|
| staging `to_copy` | |
| production `to_copy` (the owner's preflight) | |
| scale factor | |
| step 8 measured → scaled | |
| scaled total (all steps) | |
| comms allowance (3 × the scaled total) | |

The audits, both sides (`copy.sh` output):

| Line | App | Auth |
|---|---|---|
| `rows` | | |
| `id_checksum` | | |
| `email_checksum` | | |
| `hash_checksum` | | |
| `credentials` | | |
| `system_domain_rows` | | |

## Part C: unmodified clients against staging

| Client | Login | Bearer call | 401 after 15 min | Refresh | Retry |
|---|---|---|---|---|---|
| Released mobile build (or the same build pointed at staging) | | | | | |
| Admin analytics login | | n/a | n/a | n/a | n/a |

`legacy/frontend-web` is retired at go-live and is not run.

## Part D: stored-guest sign-in (G-5)

A guest created on the legacy stack **before** the copy signs in from the phase 10 client after
it. It must get the same id and the same threads, with **no** new sign-up.

| Check | Result |
|---|---|
| same id (yes/no) | |
| thread count before → after | |
| new sign-ups during the sign-in | |

## Part E: rollback rehearsal (scenario 9k)

Follow [`rollback.md`](rollback.md) as written:
1. Remove the post-cutover users: the dry-run count, then `confirm=yes`.
2. Redeploy the previous image.
3. A migrated user signs in with the legacy password through the legacy code.
4. Check that no post-cutover user remains.

| Check | Result |
|---|---|
| dry-run count | |
| deleted | |
| post-cutover users left | |
| legacy sign-in of a migrated user | |
| time, rollback step 1 to step 6 | |

## Part F: the second forward run, and clean-up

After the rollback, follow rollback.md's restart procedure (empty the auth database, restart from
window step 7), so staging ends on `develop`. Then:
1. Run `$SEED remove | psql "$APP_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 --single-transaction`.
2. Turn auto-deploy back on.

`develop` is frozen, so there is no re-run after a later merge: the merge commit below is what
production receives.

| Run | `develop` merge commit | Result |
|---|---|---|
| forward run (Parts A–D) | | |
| rollback (Part E) | | |
| second forward run | | |

## Verdicts

**Staging edge verdict:** _pending_

The verdict is recorded only after both paths are measured. It records the `AUTH_RATE_LIMIT_MODE`
production ships in, with the measured shapes copied into `edge-header-shapes.json`.

# Cutover rehearsal on staging (spec 300, plan phase 13)

The full window runbook ([`better-auth-cutover.md`](better-auth-cutover.md)) and the rollback
([`rollback.md`](rollback.md)) are rehearsed on staging before the PR merges. This file holds the
method and the recorded results.

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

- Staging, isolated from production, each service deployed from the branch, with
  `auth-staging.askansari.ai` attached.
- Postgres 18 on both the staging app and auth servers. `psql --version` in the auth image reports
  18 (the window's step 1 precondition, rehearsed).
- The operator environment is the window's, in staging:
  `railway ssh --service auth --environment staging`, then `cd /repo`, with `AUTH_DATABASE_URL`
  set to the service's `DATABASE_URL` and `APP_DATABASE_URL` typed in the session only.

## Part A: the guards fire (before the pass run)

Seed the staging app database. The existing staging users and system rows stay. Every
`rehearsal-anomalies.ts` command is piped straight into psql:

```bash
REHEARSAL_PASSWORD=<typed, ≥ 12 characters> ./apps/auth/node_modules/.bin/tsx apps/auth/scripts/cutover/rehearsal-anomalies.ts seed \
  | psql "$APP_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 --single-transaction
```

The seed is seven rows:
- a collision pair: two emails that normalize to one
- a NULL `updated_at`
- a mixed-case email with a `$2a$` hash
- a `$2b$` hash
- a legacy `is_admin` row
- a guest-shaped row (`guest_` + 10 characters, Welcome Guest)

1. Run `00-preflight-app.sql`. Record the counts per class: collision groups, `not_normalized`,
   `null_updated_at`, hash formats, `not_bcrypt`, guests, and the number of legacy admins.
2. Apply the auth baseline (window step 7), then run `copy.sh`. **It must abort on the
   collision.** Afterwards `auth.users` and `auth.account` hold 0 rows, and no `import_users`
   table is left.
3. Run `rehearsal-anomalies.ts resolve-collision | psql …`, then `copy.sh` again. **It must abort
   on the NULL timestamp**, with the same empty-target checks.
4. Run `rehearsal-anomalies.ts resolve-null | psql …`. The pass run (Part B) follows.

| Step | Expected | Exit code | Auth rows after | TEMP table left | Result |
|---|---|---|---|---|---|
| A1 preflight | every class counted | | n/a | n/a | |
| A2 copy with the collision | aborts naming a count | | | | |
| A3 copy with the NULL timestamp | aborts naming a count | | | | |

## Part B: the pass run, timed

Follow the window runbook step by step, as written. For each step, record the start, the end, and
the **Check:** output (counts and checksums only).

After the copy:
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

Then clean up: run `rehearsal-anomalies.ts remove | psql …`, and empty the staging auth database
before any re-run.

## Part F: re-run after the last `develop` merge

| Run | Branch commit | Parts A–E all pass |
|---|---|---|
| first | | |
| after the last `develop` merge | | |

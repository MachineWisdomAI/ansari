# Review: Better Auth migration

> Started during implementation (phase 8) to record decisions as they are accepted. The review
> phase completes the remaining sections.

## Accepted behaviour changes on the legacy surface (phase 8)

The `/v2/users/*` compatibility layer passes the phase 1 contract suite unedited; its fixtures
and assertions are pinned by SHA-256 to phase 1's commit `60b1118`
(`apps/api/tests/contract/contract-frozen.test.ts`; main accepted the pin in place of a CI diff
step). The security architect accepted five responses the legacy surface did not give before the
cutover (2026-10-16). None is pinned by the contract; each has a test in
`apps/api/tests/auth/layer.test.ts`. The spec records them under "Departures and their costs".

1. **429 passthrough.** `login`, `register`, `request_password_reset` and `reset_password` answer
   429 `{detail: 'Too many requests. Please try again later.'}` with `Retry-After` when
   `apps/auth`'s limiter refuses, so the shared database-backed budget holds through the layer.
2. **503 on an `apps/auth` outage.** `{detail: 'Authentication service unavailable'}`, never a
   credentials error, on the layer routes, first-use app-row creation and admin role checks.
3. **8-character minimum on reset.** Better Auth's `minPasswordLength` refuses a strong
   7-character password the legacy route accepted; the answer is the legacy weak-password detail.
4. **`register` refuses any `public.users` holder** of the address with the identical 409 (the
   plan said `system_key` rows only), so the app insert cannot fail after `apps/auth` has created
   the user.
5. **System-account `DELETE /v2/users/me`** answers 403 `{detail: 'System accounts cannot be
   deleted'}` before anything is touched ("Two databases" rule 5, step 1).

## Source scans and CORS (phase 9)

The scans live in `apps/api/tests/source-scan/` and read code through the TypeScript parser, so a
name in a comment never counts. Each is proven on planted known-bad lines and near-misses in the
same suite, and asserts a file floor so an empty walk cannot pass. Hit counts on the tree at phase 9:

| Scan | Files scanned | Hits |
|---|---|---|
| 1. `password_hash`, `is_admin`, `session_version`, the `tokens` table, or `SELECT *` on `users`, in a string or template literal (raw SQL) in `apps/api` runtime code | 77 | 0 |
| 2. `APP_DATABASE_URL` / `AUTH_DATABASE_URL` named in code, or a literal `postgres://` URL, in `apps/api` and `apps/auth` runtime code (`packages/auth/src` included; `apps/auth/scripts/cutover/` excluded by path, and a test proves only that directory) | 102 | 0 |
| 3. A `better-auth`, `@better-auth/*` or `@ansari/auth` import in `apps/api` runtime code | 77 | 0 |
| 3. The same packages in `apps/api/package.json`'s dependency maps | 1 | 0 |

Scan 1 guards raw SQL only. The Drizzle query builder can no longer name the legacy columns or
`tokens` because they left `db/schema`, which the typecheck enforces; the legacy helpers that used
them were query-builder code, so scan 1 would not have flagged them before phase 9 either.

**CORS on `apps/api` (scenario 28, amended).** The security architect chose a static
`Allow-Origin: *` with `Allow-Credentials` removed over a per-environment allowlist (spec,
"Departures and their costs"). `apps/api/tests/cors/cors.test.ts` boots a real Next.js server over
a temporary copy of `apps/api` (the real `next.config.ts`), sweeps all 23 route files × every
exported method, preflight and actual request (69 tests), and judges each response by the Fetch
standard's CORS check: a bearer request from any origin passes, a credentialed one is refused, and
no response carries `Allow-Credentials`.

**Removal/plant demonstration (phase 9): 20 of 20 as expected**, one at a time, each file
restored: CORS (credentials planted, Authorization / X-Ansari-Client / PATCH dropped, origin
pinned to one site); boot env check (instrumentation call removed, never runs, runs during
`next build`, validation removed; production no longer requiring `AUTH_*`); scan 1 (legacy column,
`tokens` table, `SELECT *` on users planted in `lib/db/users.ts`); scan 2 (`AUTH_DATABASE_URL` in
apps/auth src, a `postgres://` literal in packages/auth src, `APP_DATABASE_URL` in an apps/auth
script, the exclusion widened to all scripts; control: the same line under `scripts/cutover/`
passes); scan 3 (a `better-auth` re-export in apps/api lib, an `@ansari/auth` dependency).

## Phase 13 evidence (owner amendments R-1, R-2)

**Pre-merge, done in phase 13:**
- the anomaly seed `apps/auth/scripts/cutover/rehearsal-anomalies.ts`, with its abort/pass order
  tested in pglite
- the copy's refusal of non-bcrypt hashes, and the preflight's hash-format counts
- Postgres 18 everywhere, proven end to end in the rebuilt auth image against a `postgres:18`
  container (the thread has the counts)
- the edge probe on both paths, with the extended probe fields
- the provisional edge-shape fixtures, read by both services' tests, with a guard that keeps them
  from shipping as evidence
- the runbook's Staging rehearsal section
- `rehearsal.md` (the procedure)
- B-1 to B-4 in `docs/cutover/baselines.md`, before the merge (G-4), with any `limits.ts`
  amendment in the cutover PR: _pending, owner_

**Filled in by the docs-only evidence PR after the staging rehearsal** (R-2: the branch is never
deployed; staging runs the window from the cutover PR's `develop` merge commit). Counts, checksums
and timings only:

| Evidence | Where it is recorded | Result |
|---|---|---|
| `develop` merge commit rehearsed | `docs/cutover/rehearsal.md` Part F | _pending_ |
| Guards fire: collision abort, NULL abort, then the pass | `rehearsal.md` Part A | _pending_ |
| Audits, both sides (six lines) | `rehearsal.md` Part B | _pending_ |
| Step timings; the scaled copy; comms allowance (3×) | `rehearsal.md` Part B | _pending_ |
| Unmodified clients (released mobile build, admin analytics) | `rehearsal.md` Part C | _pending_ |
| Stored-guest sign-in: same id, same threads, no sign-up (G-5) | `rehearsal.md` Part D | _pending_ |
| Rollback rehearsal (scenario 9k) | `rehearsal.md` Part E | _pending_ |
| Edge check, both paths, two networks; staging verdict | `docs/cutover/edge-check.md`; `rehearsal.md` Verdicts | _pending_ |
| Measured shapes replace the provisional fixture | `docs/cutover/edge-header-shapes.json` | _pending_ |

## Flaky Tests

Found during phase 9's full `npm test` runs. Before the fixes: 2 of 4 runs red with the new CORS
suite, and 1 of 3 red with it excluded (the same hook timeouts), so they predate it. After the
fixes: 3 of 3 green.

- `packages/auth/tests/migration/auth-journal-parity.test.ts` and
  `packages/auth/tests/schema/auth-schema.test.ts`: their hooks carried a hard-coded 20 s timeout
  that overrode the package's 30 s (#292 rationale) and timed out under the full turbo run.
  The overrides were removed.
- `apps/api/tests/auth/resolve-user.test.ts` (one `ECONNRESET` in six runs): fetch reused a pooled
  keep-alive socket just as the in-process apps/auth test server closed it at Node's 5 s default.
  The test service (`apps/auth/tests/helpers/service.ts`) now keeps idle sockets for 30 s.

No test was skipped.

## Consultation coverage

From phase 8 iteration 2 onward the Gemini consult lane failed (the agy lane was out of quota
until about 2026-10-22; consult records the failure as a COMMENT/LOW verdict with exit 0, and
porch counts the round). Those rounds are **Codex-only**: no Gemini skip is counted as a review
anywhere in this project. Per main's rule, a REQUEST_CHANGES fix is accepted as reviewed only
once Codex has seen it. Phase 8: iteration 1 had both lanes (Gemini APPROVE, Codex
REQUEST_CHANGES); iterations 2 and 3 were Codex-only; Codex approved the final state in
iteration 3. Phase 7's last fix (583b045, `apps/api/lib/auth/resolve-user.ts`, the first-use insert and
tombstone re-check in one transaction): **security spot-check, no own consult round** (porch's
3-iteration ceiling force-advanced). Its code was in the tree Codex approved in phase 8
iteration 3. The PR's integration review should take a deliberate look at `resolve-user.ts`.

Later phases, all Codex-only (Gemini skipped every round):

| Phase | Rounds | Outcome |
|---|---|---|
| 9 | 1 | Codex COMMENT, one README item fixed (README/comment-only follow-up not re-seen) |
| 10 | 2 | iter1: the app architect's acceptance pending (no code issue); iter2 APPROVE, including the app architect's three required fixes |
| 11 | 2 | iter1: env templates (deferred to the owner by the security architect) and a CONTRIBUTING fix; iter2 APPROVE |
| 12 | 3 | iter1 four issues, iter2 one, iter3 one, all accepted |

Phase 12's last fix (68aef71, `apps/auth/scripts/cutover/02-import-auth.sql`: a NULL legacy
timestamp blocks the copy instead of becoming `now()`): **security spot-check, no own consult
round** (porch's 3-iteration ceiling force-advanced), as for 583b045. The stacked frontend PRs
(#309, #311, #312) were each reviewed by the app architect with a real-path run on the iOS
Simulator, and approved on the PR before their merge commits.

## Lessons for the lessons-learned pass

- **A rule that exists only in production needs a production-mode test** (phase 8, found by the
  Codex consult; security asked for it to be recorded). apps/auth refuses any `/api/auth/*`
  request with no usable client IP, but only when `NODE_ENV=production`. Every suite ran apps/auth
  in test mode, so all of them passed while apps/api's JWKS fetch, which carries no end-user IP,
  would have been refused in production and every switched route would have answered 401 on the
  first cold-cache request. The fix served the internal JWKS ahead of that rule; the permanent
  guard is a suite that runs the whole legacy cycle against a production-mode apps/auth from a
  cold JWKS cache (`apps/api/tests/auth/layer.test.ts`, "against apps/auth in production mode"),
  plus production-mode JWKS cases in `apps/auth/tests/client-ip.test.ts`. Removing the fix makes
  both fail.
- **A restart policy with a retry cap turns a recoverable fault into a permanent outage**
  (phase 11, found by the Docker boot test; security asked for it to be recorded). apps/auth's pg
  pool had no `'error'` listener. When Postgres dropped an idle connection (a restart, failover or
  maintenance: `57P01 terminating connection`), node-postgres emitted `'error'` on the pool, the
  process died, and it did not come back when the database did. Railway restarts the service
  `ON_FAILURE` at most 3 times, so three database blips over the service's life would have left
  auth down for good, with every sign-in and every apps/api request behind it failing. No suite
  could see it: they run on pglite, and none stops a database under a running process. The fix
  (`packages/auth/src/db.ts`, commit 9d7371b) listens for the pool's `'error'` and logs only
  `{name, code}`; the pool already discards the dead client and the next query reconnects.
  Proof, in the rebuilt image against a postgres:17 container in production mode: `/health` 200,
  503 with the database stopped, 200 when it returned, the process alive throughout (restart count
  0). The unit test (`packages/auth/tests/unit/db.test.ts`) fails without the listener. The general
  rule: any long-lived client that emits `'error'` needs a listener, and a stop-the-dependency
  check belongs in the boot test of every service. apps/api's pool has the same missing listener
  and is in production today; security took it to main.

## Deviations recorded during implementation

See `codev/state/spir-300_thread.md` (one section per phase) for the full list with reasons. The
review phase summarizes them here.

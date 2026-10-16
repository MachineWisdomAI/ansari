# Plan: Better Auth Migration

**Specification**: [codev/specs/300-better-auth-migration.md](../specs/300-better-auth-migration.md)
(approved by the owner, 2026-10-16, at `da1ad81`)

**Evidence base**: `codev/plans/60-better-auth-migration-reference.md` (not edited). Where this
plan departs from it, the departure comes from the approved spec, which records its reasons. Two
points depart from the **spec** itself, and both are put to the gate rather than assumed: G-2
(when the production domains are edge-checked) and G-3 (a fourth internal endpoint). The questions
for the plan-approval gate are listed at the end.

## Executive Summary

This plan follows the spec's **Approach 1**:

- Better Auth runs as its own service, `apps/auth`, with its own **auth database**.
- `apps/api` verifies EdDSA JWTs against `apps/auth`'s JWKS, statelessly.
- The `/v2/users/*` layer and the two password-reset routes stay on `apps/api` and are an HTTP
  client of `apps/auth`.
- `apps/frontend` signs in directly at `apps/auth`.

The work ships as **two PRs**, as the spec's Phasing section says:

1. **The cutover PR.** It carries implementation phases 1 to 13 below, one git commit each, and is
   built and kept on `builder/spir-300`. It merges **at the window**, never before. Phase 13 (staging
   verification and rehearsal) is a hard gate on that merge.
2. **The contract PR.** It merges in the first release after the 24-hour rollback deadline has
   passed. It is not a porch implementation phase, because it cannot exist before the window. It is
   built and merged during this project's **verify** phase (see "After merge"). Its content is fixed
   here so that it is reviewed now.

The order of the phases has three rules:

- **Contract tests first.** They are written against today's implementation and pass before any
  auth code changes (spec: "Contract tests land first").
- **Each service's foundations before the other service's calls into them.** The auth-database
  schema, then the Better Auth config, then the `apps/auth` HTTP surface, then the `apps/api`
  verifier, then the layer.
- **Destructive removal of legacy code late** (phase 9), so every earlier phase keeps the whole
  test suite green against a codebase that still has both.

Until phase 9, `apps/api` keeps compiling and passing with the legacy code present. Phase 7 builds
the verifier without wiring it to any route. Phase 8 switches every route and the layer in **one
commit**, so no intermediate commit mixes legacy-issued tokens with JWT-verified routes. The legacy
JWT modules remain until phase 9 deletes them.

## Decisions this plan makes (the spec delegated them)

These are the items the spec left to the plan, and the security architect's plan-phase notes. Each
is final for implementation unless the gate overturns it.

### P-1. Transport of the layer's sign-in hop: Railway's private network

**`apps/auth` runs two listeners** (security review of `11608c4`, amendment A):

| Listener | Port | Reachable from | Mounts | Forwarded-IP header |
|---|---|---|---|---|
| **Public** | `PORT` | the public domain (`auth.askansari.ai`) | `/api/auth/*`, `/health`, the diag route | **always stripped**. `/internal/*` is never mounted (404) |
| **Internal** | `INTERNAL_PORT` | Railway's private network only. No public domain routes to it | `/internal/*`, the credentialed `/api/auth/*` hop for the layer, and `/api/auth/jwks` | honoured **only** with a valid credential |

Both listeners share one `createAuth()` instance and one database, so the rate-limit budget is the
same on both paths. The internal listener still requires the credential on every request.

Every `apps/api` → `apps/auth` call uses **`AUTH_INTERNAL_URL`**
(`http://<auth service>.railway.internal:<INTERNAL_PORT>`). That covers the layer's sign-in,
sign-up, token exchange, sign-out and reset calls, the internal endpoints, and the JWKS fetch. None
of them uses the public domain.

**Why a second listener.** In the first draft, `auth.askansari.ai/internal/*` was reachable from
the internet, protected by the credential alone. Its **global** 600/min limit also meant anyone on
the internet could exhaust it, which would turn admin routes into 503 (fail closed) and block new
users' first requests. On a private-only listener, the global limit can be exhausted only from
inside the environment. `INTERNAL_PORT` is a new variable for `apps/auth`'s env schema and
`turbo.json` `globalEnv`, which is a main-architect hunk.

- **Why not the public domain.** The edge would overwrite the forwarded client IP with `apps/api`'s
  egress IP. `apps/auth` would then have to trust a forwarded header arriving *through* the public
  edge, where anyone on the internet can send it. That leaves the credential as the only defence,
  on a path that is internet-reachable.
- **What the private network costs.** It skips the edge, so no `X-Real-IP` is stamped and any
  service in the Railway environment could send one. The spec's requirement covers this: the
  forwarded IP (`X-Ansari-Forwarded-Client-IP`) is used **only** on the internal listener, and
  only when `X-Ansari-Internal-Auth` verifies in constant time **and** the value passes
  `net.isIP` (amendment B). Anything else is treated as absent, and the header is deleted before
  Better Auth sees the request.
- **One more rule this plan adds (hardening, not a spec change).** In production, a request to
  Better Auth's router that carries **neither** a verified forwarded IP **nor** an `X-Real-IP` is
  refused with 400 before `toNodeHandler`. So no request can reach better-auth's shared
  `no-trusted-ip|<path>` bucket (`dist/api/rate-limiter/index.mjs:236-248`). Development and test
  are exempt.
- **Residual, documented:** an uncredentialed private-network peer can still send its own
  `X-Real-IP`. Today the only peers in the environment are `backend`, the web `frontend` and the two
  Postgres services, and none of them originates requests to `apps/auth`. This **peer inventory**
  goes into `arch.md`.
- **Residual, documented (amendment D):** `apps/api` fetches the JWKS over plain `http` on the
  private network. A private-network peer able to impersonate the auth service's internal hostname
  could serve its own keys, and `apps/api` would then accept JWTs that peer forged. The mitigation
  is the same peer inventory in `arch.md`. **The escalation, if the inventory ever grows** to
  include a service that is not fully trusted: move the JWKS fetch to `https` on the public domain
  (`https://auth.askansari.ai/api/auth/jwks`), which the edge's TLS authenticates. This is
  recorded in `arch.md` beside the inventory, so whoever adds a service sees it.

### P-2. The numbers the spec delegated

These are proposals, with the reasoning for each. **Production baselines B-1 to B-4 (below) are
measured before plan approval, or at the latest before phase 13 is signed off.** If a baseline
contradicts a number, the number is amended in this file before the merge, never at the window.
The test suite reads every number from one constants module (`packages/auth/src/limits.ts`), so
amending a number does not touch any test.

| Limit | Key | Counts | Proposed | Reasoning |
|---|---|---|---|---|
| Sign-in (decided) | client IP | every request | 5 / 60 s | Issue decision |
| Sign-up (decided) | client IP | every request | 3 / 60 s | Issue decision. Guest accounts are sign-ups (`apps/frontend/lib/auth/guest.ts`), so B-1 counts guests too |
| Password-reset request | client IP | **every** request | **5 / 15 min** | A person resets a few times at most. CGNAT can put several users behind one IP, so the limit is not tighter |
| Password-reset request | normalized email (`lower(trim())`), stored hashed | **every** request, unknown emails included | **3 / 60 min** | The mail-bombing bound: at most 3 emails per hour to any address, whoever asks |
| Password-reset request (better-auth router) | client IP | every request | 3 / 60 s (its built-in rule, kept) | A burst cap underneath the two above |
| Reset consume (`/reset-password`) | client IP | every request | 5 / 15 min | Tokens are random and single-use. This only stops hammering |
| Session → JWT exchange (`/token`, `/get-session`) | client IP | every request | 60 / 60 s | Clients exchange about once per 15 minutes per device. The released mobile client refreshes concurrently with no single-flight guard (`legacy/frontend-app/src/services/ApiService.ts:101-128`), so bursts must pass |
| Internal endpoints (profile, role, delete, revoke-sessions) | per endpoint, global | every request | 600 / 60 s | Profile is called once per new user, role once per admin request, delete once per deletion. B-4 sizes peak first requests. They are reachable only on the private-network listener (P-1), so the global budget cannot be exhausted from the internet |
| Global default (better-auth `window`/`max`) | client IP | every request | 100 / 60 s | Unchanged from the reference |
| **Fallback only:** sign-in | normalized email | **failed** attempts only | 5 / 60 s, locks the email for the rest of the window | Spec |
| **Fallback only:** sign-up | normalized email | every request | 3 / 60 s | Spec |
| **Fallback only:** sign-up global ceiling | none (global) | every request | **max(30 / 60 s, 10 × B-1 peak per minute)** | The ceiling must never bind on real traffic, guests included |
| **Fallback only:** list-walk alert | distinct emails hitting a per-email limit | – | **≥ 20 distinct emails in 10 min** → one Sentry event per 10 min | Legacy has no per-email limit, so there is no history. 20 is far above the expected rate of real users mistyping a password five times in a minute. B-2 confirms |

**Baselines.** Each is a read-only query on the production **app** database, or the Resend
dashboard. The operator runs them, and the results go into this file, amended before merge.

- **B-1, sign-up rate.** Peak and p99 sign-ups per minute and per hour over 90 days, from
  `public.users.created_at`, shown separately for guest-shaped emails. It sizes the fallback
  sign-up ceiling, and it tests the decided 3/60s per-IP limit against any IP that registers many
  accounts.
- **B-2, sign-in failure rate.** There is no history, because legacy logs no failed logins. This
  plan uses Railway HTTP logs of `POST /api/v2/users/login` with status 401, as counts per minute
  over 14 days. That is the only source of distinct-email failure rates.
- **B-3, reset volume.** Reset tokens are swept on expiry (`lib/db/users.ts:318`), so the database
  has no history. This plan uses the Resend dashboard: reset emails per day, and per peak hour,
  over 90 days.
- **B-4, sign-in and refresh rate.** Counts per minute of `token_type IN ('access','refresh')`
  rows by `created_at`, inside the retention window. It sizes the internal-endpoint and `/token`
  limits.

### P-3. The IP fallback is built in, switched by one variable (gate question G-1)

The spec makes the fallback conditional on the edge check failing. But the edge check can only
observe the **production** domains once the cutover code serves them, which is at the window (see
P-4). If the fallback were written only after a failed check, a failure in the window would mean
writing security code at the window.

So phase 4 builds both modes behind **`AUTH_RATE_LIMIT_MODE`** (`ip` | `email`, Zod enum,
**default `email`**). A missing variable then fails safe into the mode that cannot collapse into a
global cap. The verdict of the edge check sets the value, and the review records it. Tests cover
both modes.

This costs a fifth `AUTH_*` variable in `turbo.json` `globalEnv`, which is a main-architect hunk.
**If the gate rejects the switch**, phase 4 ships `ip` mode only, and the fallback code is written
only on a failed staging check, as the spec has it.

### P-4. How the edge check reaches every domain (gate question G-2)

Both services get a diagnostic route, removed by the contract PR:

- `GET /__diag/client-ip` on `apps/auth`
- `GET /api/v2/_diag/client-ip` on `apps/api`

Each returns only the **caller's own** observed `X-Real-IP` and the number of `X-Forwarded-For`
entries, never their values, and sets no-store. Telling a caller its own address is not a
disclosure.

- **Before the merge** (phase 13): the staging branch deployments are probed through
  `api-staging.askansari.ai`, `auth-staging.askansari.ai` and both `*.up.railway.app` domains, over
  IPv4 and over IPv6 where reachable, for both properties.
- **Production domains** (`api.askansari.ai`, `api-35.ansari.chat`, `auth.askansari.ai`) cannot be
  probed before the merge without shipping project code to production, which the spec forbids. They
  are probed **in the window**:
  - over each `*.up.railway.app` production domain, after the deploy
  - over the custom domains, as the first step after they are re-attached

  A failure there flips `AUTH_RATE_LIMIT_MODE` to `email` and redeploys `apps/auth`, with no code
  change.
- **A pre-merge passive check of each production domain** (security, on G-2), with no code
  deployed. It records:
  - the `dig` CNAME chain, to confirm that each production domain terminates at Railway's edge,
    as the staging domains do
  - the response headers from a plain `curl -sI`, to confirm the same edge and proxy chain (the
    `server`, `via` and `x-railway-*` style headers that are present)

  Both go into `edge-check.md`, beside the staging probes.
- **Production ships in the staging-verdict mode.** `AUTH_RATE_LIMIT_MODE` in production is set to
  whatever the staging edge check decided. The in-window probe can only move it to `email`, never
  to `ip`.

The spec says "both production domains … before the PR merges". This is the one place the plan
cannot meet that literally, and it is put to the gate.

### P-5. Where the reviewable runbooks and operator SQL live

- `docs/cutover/better-auth-cutover.md` holds the window runbook. `docs/cutover/rollback.md` holds
  the rollback runbook. `docs/cutover/edge-check.md` holds the method and the recorded
  observations. `docs/cutover/baselines.md` holds B-1 to B-4.
- `apps/auth/scripts/cutover/` holds the operator SQL and the copy script. They are run from a
  Railway shell and are never imported by runtime code. The source scan in phase 9 excludes this
  directory, and only this directory, by path.

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "phase_1", "title": "Legacy contract tests pinned against today's implementation"},
    {"id": "phase_2", "title": "Auth database schema, fresh journal and parity guard"},
    {"id": "phase_3", "title": "Better Auth configuration: UUIDs, dual verify, sessions, JWT, admin columns"},
    {"id": "phase_4", "title": "apps/auth HTTP perimeter: blocked surfaces, client IP, rate limits, CORS"},
    {"id": "phase_5", "title": "apps/auth internal endpoints, reset email, role script and boot assertion"},
    {"id": "phase_6", "title": "App database migrations: scaffold cleanup, tombstones, window migration"},
    {"id": "phase_7", "title": "apps/api JWT verifier, user resolution and auth-service client"},
    {"id": "phase_8", "title": "Route switch and compatibility layer over apps/auth"},
    {"id": "phase_9", "title": "Legacy auth removal, CORS fix and source scans"},
    {"id": "phase_10", "title": "apps/frontend signs in at apps/auth"},
    {"id": "phase_11", "title": "apps/auth deployment: Dockerfile, Railway service, CI and env"},
    {"id": "phase_12", "title": "Cutover tooling: copy, audits, rollback SQL and runbooks"},
    {"id": "phase_13", "title": "Staging verification: edge check, unmodified clients, full rehearsal"}
  ]
}
```

## Phase Breakdown

Every phase's commit message is `[Spec 300][Phase: <id>] …`. Every phase ends with this command
green for the packages it touches:

```
pnpm exec turbo run lint typecheck test build --filter <pkg>...
```

### Phase 1: Legacy contract tests pinned against today's implementation

**Dependencies**: None

#### Objective

Freeze the wire contract of the legacy surface **before** anything changes, so the layer in phase 8
is judged by tests that were green against the old code.

#### Files to Create / Modify

- `apps/api/tests/contract/legacy-users-contract.test.ts` (new): the shared scenario table.
- `apps/api/tests/contract/harness.ts` (new): drives the real route handlers. Its `AuthBackend`
  seam is `legacy` today and `better-auth` from phase 8. The seam swaps setup only (how a user is
  seeded, how time is advanced). **Assertions are never forked.**
- `apps/api/tests/contract/fixtures/` (new): the frozen response skeletons, as key sets, types and
  `detail` strings.

#### Deliverables

- [ ] For `register`, `login`, `refresh_token`, `logout`, `me` GET, `me` DELETE,
  `request_password_reset` and `reset_password`, pin:
  - status codes
  - exact key sets, with presence and absence (`refresh_token` has no `status`)
  - value types, and `token_type: 'bearer'`
  - error `detail` strings
  - the 401, 409 and 422 semantics
  - the identical response for an unknown email on reset
  - the reserved-address 409, identical to the taken-email 409
  - the register guard order: validation → reserved/taken → strength → create
- [ ] `login` with null names returns exactly what it returns today (scenario 7).
- [ ] The two client flows recorded as sequences: the released mobile cycle (login → bearer call →
  401 → refresh → retry, and refresh non-OK → logout) and the admin analytics login (reads
  `access_token`).
- [ ] The source of `legacy/frontend-app/src/services/ApiService.ts`, `legacy/frontend-web/src/services/ApiService.ts`
  and `authSlice.ts` read and recorded in the thread. The finding to check: the mobile client
  retries once and has no single-flight guard (`:101-128`), and non-OK refresh logs out (`:81-86`).
  The phase-8 refresh therefore must never rotate the session token. It does not.

#### Acceptance Criteria

- [ ] The suite passes against today's `apps/api`, unchanged.
- [ ] Each pinned field is negative-tested once: a deliberately renamed field in a scratch copy
  makes the suite fail. The hit is recorded in the thread.

#### Test Plan

Contract tests on pglite with the legacy DDL. No mocks of `lib/db`.

### Phase 2: Auth database schema, fresh journal and parity guard

**Dependencies**: None (parallel to phase 1)

#### Objective

Give the auth database its final shape: all six Better Auth tables on `pgSchema('auth')`, with UUID
ids, and a journal that a drift guard covers.

#### Files to Create / Modify

- `packages/auth/src/schema.ts`: rewritten. `auth.users` (via `modelName: 'users'`),
  `auth.session`, `auth.account`, `auth.verification`, `auth.rate_limit` and `auth.jwks`. Ids are
  `uuid`, timestamps are `timestamptz`, and `account` has `unique(user_id, provider_id)`.
  **`auth.session.user_id` and `auth.account.user_id` reference `auth.users.id` with `ON DELETE
  CASCADE`** (amendment C), and the generated SQL is checked for both. `auth.verification` has no
  user reference in better-auth 1.7.7 (it is keyed by `identifier`), which is confirmed from the
  generated SQL. If it does have one, it cascades too.
  `auth.users` gains the additional fields `first_name`, `last_name` and `registered_via`, plus the
  admin columns `role`, `banned`, `ban_reason` and `ban_expires`. `auth.session` gains
  `impersonated_by`. There is no `system_key` and no `source`.
- `packages/auth/drizzle/0000_better_auth_init.sql` and `meta/` are **deleted**.
  `packages/auth/drizzle/0000_<generated>.sql` and `meta/` are new, from `drizzle-kit generate`.
  The SQL is reviewed; `db:push` is never run.
- `packages/auth/tests/migration/auth-journal-parity.test.ts` (new): builds the database from the
  `packages/auth` journal only, in `_journal.json` order. It checks every column the Drizzle schema
  declares, and it carries **`AUTH_DEPLOYED_THROUGH`** (owner: main architect). Its value is `null`
  until the window: nothing is deployed yet, so the deployed-state half is skipped, **loudly**,
  with a test that fails if `null` is left after the cutover PR's release notes record the apply.
- `packages/auth/README.md`: the auth schema, UUIDs, timestamptz, and the local reset for
  developers who ran the old `0000`.

#### Deliverables

- [ ] Column names taken from the generated SQL, not assumed. The spec's success-criterion names
  are checked against it.
- [ ] A UUID round-trip through the Drizzle adapter: a UUID written by better-auth reads back
  unchanged from a `uuid` column (pglite).
- [ ] A timestamp round-trip: microseconds and a DST-boundary value survive an insert and a read
  (scenario 12).
- [ ] The parity test, and its negative test: a column added to the schema but not to the journal
  fails it.
- [ ] The cascade test (amendment C): deleting an `auth.users` row by plain SQL, as
  `04-complete-tombstones.sql` does, leaves no `auth.session` and no `auth.account` row for that
  user. Phase 12's copy suite repeats it against the real script.

#### Acceptance Criteria

- [ ] `drizzle-kit generate` on a clean checkout emits no diff after the commit.
- [ ] The parity test is green. The negative test is demonstrated once and recorded.

#### Test Plan

pglite: apply the journal, introspect `information_schema`, and compare with `getTableConfig` on
each table.

### Phase 3: Better Auth configuration: UUIDs, dual verify, sessions, JWT, admin columns

**Dependencies**: Phase 2

#### Objective

Lock in every `createAuth()` behaviour that the cutover depends on, each one pinned by a test that
fails when the setting is removed.

#### Files to Create / Modify

- `packages/auth/src/index.ts`: `createAuth()`.
- `packages/auth/src/password.ts` (new): dual verify. `$2a$`/`$2b$` hashes go to `bcrypt`, with
  the 72-byte truncation copied from `apps/api/lib/auth/password.ts`. Everything else goes to
  better-auth's scrypt. New hashes use scrypt.
- `packages/auth/src/env.ts`: adds `AUTH_JWT_ISSUER`, `AUTH_JWT_AUDIENCE`, `AUTH_INTERNAL_SECRET`
  (min 32), `RESEND_API_KEY` (min 20), `FRONTEND_URL`, `ADMIN_EMAILS` and `AUTH_RATE_LIMIT_MODE`
  (P-3).
- `packages/auth/src/limits.ts` (new): the P-2 numbers, the only source.
- `packages/auth/src/reserved.ts` (new): `isReservedAddress`, ported from
  `apps/api/lib/auth/reserved.ts` and `system-accounts.ts`. It reserves **both** the
  `ADMIN_EMAILS` entries and the `@system.ansari.chat` domain, exactly as today
  (`reserved.ts:15-20`).
- `packages/auth/src/newsletter.ts` (new): the fire-and-forget `MARKETMAKER_URL` subscribe, ported
  from `apps/api/lib/newsletter.ts`. It is called from a `hooks.after` on `/sign-up/email` when the
  body carries `register_to_mail_list: true`, so `apps/frontend` registrations keep the opt-in
  after phase 10. `MARKETMAKER_URL` (already in `globalEnv`) joins `apps/auth`'s env.
- `packages/types/src/attribution.ts` (new): the pure `X-Ansari-Client` parser, moved from
  `apps/api/lib/attribution.ts` (the pattern and normalisation only; the Sentry wrapper stays in
  `apps/api`). Both services import it, so neither copy can drift, and `apps/api` still never
  imports `better-auth`.
- `packages/auth/package.json`: `bcrypt` (`^6.0.0`, already resolved through `apps/api`; a native
  module, so phase 11's Dockerfile builds it) and `resend` (`^6.9.3`, as in `apps/api`). This is a
  lockfile hunk for the main architect.
- `packages/auth/tests/*.test.ts`: new and extended.

#### Deliverables

- [ ] `advanced.database.generateId: 'uuid'`.
- [ ] `emailAndPassword`: `password: { hash, verify }` from `password.ts`,
  `revokeSessionsOnPasswordReset: true`, and `requireEmailVerification` left unset.
- [ ] `session: { expiresIn: 30 days, updateAge: 1 day }`.
- [ ] Plugins:
  - `expo()`
  - `bearer()`, with `requireSignature` **unset**
  - `jwt({ jwks: { keyPairConfig: { alg: 'EdDSA' } }, jwt: { issuer, audience, expirationTime: '15m', definePayload: ({ user, session }) => ({ sub: user.id, sid: session.id }) } })`
  - `admin()`
- [ ] `user.additionalFields`: `first_name`, `last_name`, and `registered_via` (`input: false`).
- [ ] **The sign-up guard order, kept as today** (`register/route.ts`; no oracle). A
  `hooks.before` on `/sign-up/email` runs, in order:
  1. a reserved address (`isReservedAddress`) or an existing user
     (`internalAdapter.findUserByEmail`) → the **identical 409**
  2. `checkPasswordStrength` → 400 with the legacy `detail`

  Before step 1 the hook applies the email and length checks itself, so validation stays first
  whether or not better-auth's body validation runs before `hooks.before`. Phase 3 pins that
  order with the reserved-address, weak-password case.
  `databaseHooks.user.create.before` repeats the reservation as defence in depth, and also:
  - sets `registered_via` from `X-Ansari-Client` through the shared parser
  - derives `name`, when the client sent none, by the spec's rule
- [ ] **The reset-consume order, kept as today** (`reset_password/route.ts:38-57`). A
  `hooks.before` on `/reset-password` first looks the token up
  (`internalAdapter.findVerificationValue('reset-password:<token>')`): missing or expired gives 400
  `Invalid or expired reset token`. Only then does it run `checkPasswordStrength`.
- [ ] `emailVerification.sendOnSignUp: false` and no `sendVerificationEmail`, so no copied user is
  ever emailed (scenario 9i).
- [ ] `user.changeEmail.enabled: false`, and `deleteUser` left disabled.
- [ ] `rateLimit`: `enabled: true`, `storage: 'database'`, and `customRules` from `limits.ts`.
  `advanced.ipAddress: { ipAddressHeaders: ['x-real-ip'] }`, with `trustedProxies` unset.

#### Acceptance Criteria

Each of these tests exists, and the review records a demonstration that it fails when its
setting is removed:

- [ ] Removing the bcrypt branch fails the legacy-hash sign-in test.
- [ ] Removing `revokeSessionsOnPasswordReset` fails the reset test (after a reset, `/token` with
  the old session gets 401).
- [ ] Turning on `requireSignature` fails the raw-session-token test.
- [ ] The JWT payload's key set is exactly `{sub, sid, iss, aud, exp, iat}`, plus `jti` if
  better-auth adds it (asserted from the real output).
- [ ] The JWT's `exp − iat` is 900 seconds.
- [ ] A session created on day 0 is extended by `/token` after `updateAge`. This is better-auth
  1.7.7 behaviour: `getSessionFromCtx` calls `getSession`, which refreshes
  (`dist/api/routes/session.mjs:179-207,246-263`). The 30-day expiry and the slide are both pinned.
- [ ] A bcrypt row longer than 72 bytes verifies truncated (scenario 8).
- [ ] A mixed-case sign-in finds a lowercase row (scenario 13).

#### Test Plan

`packages/auth/tests/auth.integration.test.ts` and new suites, against the phase-2 journal on
pglite, driven through `auth.handler(new Request(...))`, so the router and its rate limiter run.

### Phase 4: apps/auth HTTP perimeter: blocked surfaces, client IP, rate limits, CORS

**Dependencies**: Phase 3

#### Objective

Make the public face of `apps/auth` safe. No admin or profile-changing endpoint answers, the
client IP cannot be forged or collapsed, and every limit holds across both modes.

#### Files to Create / Modify

- `apps/auth/src/app.ts` (new): `createPublicApp(auth)` and `createInternalApp(auth)`, which build
  the two Express apps (P-1), so tests drive them without listening. `apps/auth/src/index.ts`
  only listens, on `PORT` and on `INTERNAL_PORT`.
- `apps/auth/src/middleware/blocked-paths.ts` (new): runs before `toNodeHandler`. It decodes the
  path, lowercases it and strips trailing slashes, then refuses `/api/auth/admin/*`,
  `/api/auth/change-email` and `/api/auth/update-user` with one block response (404, empty body).
  It is paired with `disabledPaths` in `createAuth()`.
- `apps/auth/src/middleware/client-ip.ts` (new).
  - **Public listener:** it always deletes `X-Ansari-Forwarded-Client-IP`.
  - **Internal listener:** it runs the credential check (`crypto.timingSafeEqual` over SHA-256
    digests, so lengths never leak). With a valid credential **and** a value that passes
    `net.isIP` (amendment B), it sets `x-real-ip` from the forwarded header. Otherwise it treats
    the forwarded IP as absent and deletes the header.
  - **Both listeners, in production:** a request with no IP source gets 400 (P-1).
- `apps/auth/src/limits/email-limiter.ts` (new): the per-email reset limiter and the fallback
  sign-in and sign-up limiters. It uses an atomic `INSERT … ON CONFLICT … DO UPDATE … RETURNING`
  on `auth.rate_limit`, with keys `email:<sha256(normalized)>|<path>`, so instances share one
  budget and no raw email is stored. The fallback's "failed attempts only" uses a better-auth
  `hooks.after` on `/sign-in/email`, counting non-2xx responses only.
- `apps/auth/src/alerts.ts` (new): the list-walk alert through Sentry (`@sentry/node`). It sends
  counts and 8-character hash prefixes, never an email. This adds `@sentry/node` and `SENTRY_DSN`
  to `apps/auth`; `SENTRY_DSN` is already in `globalEnv`.
- `apps/auth/src/routes/diag.ts` (new): the P-4 route.
- `apps/auth/src/routes/health.ts` (new): `GET /health` answers 200 only after `select 1` on the
  auth database succeeds.
- CORS: `origin` is an exact allowlist (the `apps/frontend` web origins from `CORS_ORIGIN`, now a
  comma list), `credentials: false`, `allowedHeaders: ['Content-Type', 'Authorization', 'X-Ansari-Client']`
  (the attribution header must pass the browser preflight), and
  `exposedHeaders: ['set-auth-token', 'set-auth-jwt']`.
  `trustedOrigins` uses the same list plus the native schemes.
- `apps/auth/tests/` (new directory), with `apps/auth/vitest.config.ts`, a `test` script in
  `apps/auth/package.json`, and dev dependencies `vitest` and `@electric-sql/pglite` (as in
  `packages/auth`). It also adds `@sentry/node` (already resolved at 10.69.0). These are lockfile
  hunks. CI hookup is in phase 11.
- `packages/auth/tests/auth.http.test.ts`: #266. The origin test sets `advanced.disableOriginCheck: false`
  explicitly under `NODE_ENV=test` (`dist/context/create-context.mjs:211`) and asserts that a wrong
  origin is **rejected**. A negative test proves it fails if the check is bypassed.

#### Deliverables

- [ ] **The admin surface is blocked.**
  - A test **enumerates the admin plugin's endpoints from the installed package**: it walks
    `auth.api` for `admin`'s endpoint paths.
  - With a valid admin session, it asserts that each path, and each of its case, trailing-slash
    and percent-encoded variants, gets the block response.
  - `change-email` and `update-user` get the same variants.
- [ ] **The listener split (amendment A).** On the public listener, every `/internal/*` path and
  its case, trailing-slash and percent-encoded variants gets 404. A forwarded-IP header sent with
  a **valid** credential to the public listener is stripped and never becomes the bucket key. The
  internal listener refuses `/internal/*` without the credential.
- [ ] **Forwarded-IP validation (amendment B).** With a valid credential, a forwarded value that is
  not an IP (empty, `1.2.3.4, 5.6.7.8`, `::ffff:` garbage, a hostname, too long) is treated as
  absent: the request falls back to `X-Real-IP` or gets the production 400, and never lands in a
  bucket named after the forged value.
- [ ] **The IP tests (both modes where they apply).**
  - Scenario 21: six sign-ins from one `X-Real-IP` give 429 on the sixth. A forged two-entry
    `X-Forwarded-For` does not change the bucket. Distinct `X-Real-IP`s are separate.
  - Scenario 22: the forwarded IP is ignored without the credential and honoured with it. Two
    forwarded IPs land in two buckets.
  - The production 400 is returned when neither IP source is present.
- [ ] **The reset limits.**
  - The per-email cap holds across two IPs.
  - The IP cap holds across many emails.
  - An unknown email draws the same budget and gets the same response.
- [ ] **The fallback (`email` mode), scenario 32.**
  - Five wrong passwords then the right one give 429.
  - The right password succeeds after the window.
  - Ten correct sign-ins are never limited.
  - The sign-up global ceiling holds.
  - The list-walk alert fires, and a Sentry transport spy shows no raw email.
- [ ] **CORS, scenario 28.** A disallowed origin gets no allow headers, and the exposed headers are
  present for allowed origins.

#### Acceptance Criteria

- [ ] All of the above are green against pglite.
- [ ] The regression test fails when one admin path is removed from the middleware. This is
  demonstrated once and recorded.

#### Test Plan

`createPublicApp` and `createInternalApp` over `createAuth(pgliteDb)`, each listening on an ephemeral port, driven with `fetch` (no new test
dependency). Time is advanced with fake timers, or by
writing `rate_limit.last_request` directly.

### Phase 5: apps/auth internal endpoints, reset email, role script and boot assertion

**Dependencies**: Phase 4

#### Objective

Give `apps/api` the three cross-service facts it needs (profile, role, delete) and move admin
tooling to the auth database.

#### Files to Create / Modify

- `apps/auth/src/routes/internal.ts` (new). It is mounted at `/internal/*` **on the internal
  listener only** (P-1), outside `/api/auth/*`, behind the credential middleware, and rate-limited
  (P-2). It has three routes:
  - `GET /internal/users/:id/profile` returns `{id, email, first_name, last_name, registered_via}`,
    or 404.
  - `GET /internal/users/:id/role` returns `{role, banned}`, or 404.
  - `DELETE /internal/users/:id` requires `Authorization: Bearer <subject JWT>`, verified with
    `jose` against the service's **own** JWKS, with `alg`, `iss`, `aud` and `exp` pinned, and
    refuses unless `sub === :id`. It then calls `internalAdapter.deleteUser(id)`, which deletes
    the sessions, accounts and user (`dist/db/internal-adapter.mjs:232`). "Not found" returns 204.
  - **`POST /internal/users/:id/revoke-sessions`** (**G-3**, built here if the gate approves). It
    is bound to the subject's JWT exactly like delete, has the same rate limit, and calls
    `internalAdapter.deleteSessions(id)`. The legacy logout needs it, because the legacy client
    sends only the JWT, never the session token, and logout must revoke every session. It adds no
    capability to the internal credential alone. **If the gate rejects it**, the layer's logout
    calls `POST /api/auth/revoke-sessions` with the session token, which the legacy client never
    sends to logout, so legacy logout would revoke nothing. That is not acceptable, so a rejection
    goes back to the owner.
- `packages/auth/src/index.ts`: the reset email. `sendResetPassword` builds
  `${FRONTEND_URL}/reset-password?token=<token>` (`dist/api/routes/password.mjs:82-85`). It sends
  through Resend with the same sender as `apps/api/lib/email.ts`.
  - System addresses never reach it, because they have no auth row, so better-auth answers the
    same as for an unknown email (`password.mjs:59-70`).
  - The domain is also refused before sending.
- `apps/auth/scripts/grant-admin.ts` (moved from `apps/api/scripts/`, same name): sets
  `auth.users.role` by email, against the auth database's `DATABASE_URL`. It never sets a password
  and never touches the app database. `--list` prints the current admin set for the audit. The old
  file is deleted in phase 9.
- `apps/auth/scripts/ban-user.ts` (new). The admin HTTP surface is blocked, so a ban is an operator
  script, like roles. `--ban <email> [--reason]` sets `banned`, `ban_reason` and `ban_expires`, and
  deletes the user's sessions in the same transaction. `--unban` clears them. Better-auth's admin
  plugin refuses sign-in for a banned user, and the role endpoint reports `banned`, so admin
  routes refuse at once. Everywhere else, the user's issued JWTs last until `exp`, which is the
  accepted window.
- `apps/auth/package.json`: `jose` as a direct dependency (already resolved at 6.2.9), for the
  subject-JWT check. This is a lockfile hunk.
- `apps/auth/src/startup-checks.ts` (new): `assertConfiguredAdminsExist`, which checks that every
  `ADMIN_EMAILS` entry exists with `role = 'admin'`, gated by a port of
  `shouldRunAdminStartupCheck`.
- `apps/auth/tests/internal.test.ts` and `apps/auth/tests/grant-admin.test.ts` (new).

#### Deliverables

- [ ] Each internal route returns 401 without the credential, and the comparison is constant-time
  (a unit test covers the comparison helper).
- [ ] Scenario 9g: the delete refuses with no JWT, with another user's JWT, and with a forged JWT,
  and the account remains.
- [ ] Delete is idempotent.
- [ ] `revoke-sessions` has the same refusal matrix as delete, and afterwards no session of the
  user can mint a JWT (if G-3 is approved).
- [ ] A ban kills every session, refuses sign-in, and makes the role endpoint report `banned`.
- [ ] Profile never returns a system account, because none exists.
- [ ] The reset link has the legacy shape, the reset kills sessions, and `checkPasswordStrength`
  runs before register and before reset. Better-auth enforces only length, so a strength hook sits
  in `hooks.before` for `/sign-up/email` and `/reset-password`, ported from
  `apps/api/lib/auth/password.ts:23`.
- [ ] The boot assertion fails when an `ADMIN_EMAILS` entry is missing or not an admin, and passes
  when it is.
- [ ] `RESEND_API_KEY` and `AUTH_INTERNAL_SECRET` appear in no log line or error body. A test greps
  captured stdout and stderr and every response body.

#### Acceptance Criteria

All green on pglite. The delete endpoint is proven bound to the subject.

#### Test Plan

The same ephemeral-port harness, with a real JWT minted by the same `createAuth()` instance.

### Phase 6: App database migrations: scaffold cleanup, tombstones, window migration

**Dependencies**: None (parallel to phases 2 to 5). Merged with `develop` before numbering.

#### Objective

Produce the three `apps/api` migrations the spec names. Each is guarded, each is reviewed SQL, and
each is numbered by the rule.

#### Files to Create / Modify

- `apps/api/drizzle/0009_better_auth_scaffold_cleanup.sql`: `DROP TABLE IF EXISTS` on `public."user"`,
  `session`, `account` and `verification`, behind a `DO $$ … RAISE EXCEPTION` guard that aborts if
  any of them holds a row. This migration is **kept even if the owner's `psql \dt` finds no
  scaffold tables**, because it is a no-op there and the guard documents the assumption.
- `apps/api/drizzle/0010_deleted_users.sql`: `public.deleted_users (id uuid primary key, deleted_at timestamptz not null default now(), auth_deleted_at timestamptz)`.
  It is additive.
- `apps/api/drizzle/0011_better_auth_window.sql`: one transaction that does exactly two things.
  1. A guard that aborts on any `lower(trim(email))` collision, then `UPDATE users SET email = lower(trim(email)) WHERE email <> lower(trim(email))`.
  2. `ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL`.
- `apps/api/db/schema/deleted-users.ts` (new). `apps/api/db/schema/users.ts` is **not** changed
  here; phase 9 removes the legacy columns from the Drizzle schema.
- `apps/api/tests/migration/migration-schema-parity.test.ts`: `DEPLOYED_THROUGH` stays at `0008`
  in this phase. **The owner bumps it to `0011`** in the cutover PR, as a separate, labelled commit
  just before the merge (spec). The full-journal half covers `0009` to `0011` now.
- `apps/api/tests/migration/window-migration.test.ts` (new).

The numbers 0009 to 0011 are this branch's current guess. The **numbering rule** applies after
every `develop` merge: merge, run generate, rename the `.sql` file and its journal tag by hand,
leave the snapshot named by index, and re-check. The thread records each re-check.

#### Deliverables

- [ ] Scenario 15: the cleanup aborts with one row in `public.account` and changes nothing. It
  succeeds against empty tables and against no tables.
- [ ] Scenario 14 (app half): the window migration aborts on `Bob@x.com` + `bob@x.com` with no
  changes.
- [ ] A padded mixed-case email is normalized.
- [ ] After the window migration, the legacy `apps/api` code (this branch at phase 6, before the
  switch) still passes its suite: the migration is backward-compatible.
- [ ] The foreign keys from `threads`, `preferences` and `feedback` are unchanged, by
  `information_schema` comparison before and after.

#### Acceptance Criteria

The parity test is green on the full journal. The guards are demonstrated to abort.

#### Test Plan

pglite: apply the journal through `0008`, seed, apply the new migrations, and assert.

### Phase 7: apps/api JWT verifier, user resolution and auth-service client

**Dependencies**: Phases 5 and 6

#### Objective

Build, and test in isolation, everything `apps/api` needs to authenticate against `apps/auth`:
JWT verification against the JWKS, user resolution in the app database, the admin role call, and
the HTTP client. **No route is rewired in this phase.** Login still issues legacy HS256 tokens
until phase 8, so switching the routes here would break the legacy flow between the two commits
(Codex, plan review iteration 1). Phase 8 rewires the routes and the layer together.

#### Files to Create / Modify

- `apps/api/lib/auth/verify-jwt.ts` (new): `jose` `createRemoteJWKSet(new URL('/api/auth/jwks', AUTH_INTERNAL_URL))`,
  fetched from the internal listener (P-1, including the residual recorded under amendment D).
  - The settings are `cooldownDuration: 30_000` (at most one re-fetch per 30 s per instance for an
    unknown `kid`, which is the amplification bound) and `cacheMaxAge: 600_000`.
  - `jwtVerify` uses `algorithms: ['EdDSA']`, the configured `issuer` and `audience`, and
    `requiredClaims: ['exp', 'sub', 'sid']`.
  - Any failure gives 401 `{detail: 'Invalid or expired token'}`.
  - `jose` becomes a direct dependency of `apps/api`. It is already resolved at 6.2.9; this is a
    lockfile hunk.
- `apps/api/lib/auth-service/client.ts` (new): the one HTTP client for `apps/auth`. It sets the
  internal credential header and the forwarded IP, has a timeout of 3 s, and never logs a body or
  a header.
- `apps/api/lib/auth/resolve-user.ts` (new): `sub` → `public.users`, in this order.
  1. A tombstone → retry the pending auth delete, then 401.
  2. A row → the user.
  3. No row → profile → `INSERT … ON CONFLICT (id) DO NOTHING`. Any of these gives 401, no row, an
     ids-only log and a Sentry alert: a `users_email_unique` conflict, a reserved domain, or an
     email held by a `system_key` row.
  4. Profile 404 → 401.
- `apps/api/lib/auth/require-user.ts` (new): the drop-in for `authenticateRequest`, returning the
  same `{user} | {error}` shape, so phase 8's route diffs are mechanical.
- `apps/api/lib/auth/require-admin-role.ts` (new): the successor to `requireAdmin`. It calls the
  role endpoint on each request. A non-admin or banned user gets 403, and an unreachable or 5xx
  `apps/auth` gets 503. The existing `admin.ts` stays until phase 8 switches its one caller.
- `apps/api/lib/rate-limit.ts`: `getClientIp` reads `X-Real-IP` only. `tests/rate-limit.test.ts`
  is inverted to match. N-2 is decided **no /64 grouping**: `mcp-complete`'s limiter keeps exact
  addresses, and the change is recorded.
- `apps/api/src/app/api/v2/_diag/client-ip/route.ts` (new, P-4).
- `apps/api/lib/config.ts`: adds `AUTH_INTERNAL_URL`, `AUTH_JWT_ISSUER`, `AUTH_JWT_AUDIENCE` and
  `AUTH_INTERNAL_SECRET` (min 32). The `JWT_*` variables stay until phase 9.
- `apps/api/tests/auth/`: the new suites. The test JWKS comes from a real Ed25519 key pair served
  by an in-process handler, not a mocked `jose`.

#### Deliverables

- [ ] Scenario 23, the rejection matrix, each a 401: `alg: none`, HS256, RS256, a wrong `iss`, a
  wrong `aud`, an expired token, a bad signature, an unknown key, and a legacy token minted by
  today's `jwt.ts`.
- [ ] Scenario 24: a flood of random `kid`s causes at most one JWKS fetch per cooldown, measured by
  counting requests at the test JWKS server.
- [ ] Scenario 17: rotation is picked up without a restart.
- [ ] Scenario 18: with the JWKS server stopped, a cached key still verifies.
- [ ] Scenarios 9a, 9c and 9f: first-request row creation (two concurrent requests create one row),
  an unknown `sub` gives 401, the email-conflict, reserved-domain and system-email cases give 401
  with an ids-only log, and a tombstone triggers a delete retry then 401.
- [ ] `require-admin-role` in isolation: admin, non-admin, banned, a demotion seen on the next
  call, and 503 when `apps/auth` is unreachable.
- [ ] Scenario 33: the steady state makes no network call, so the test JWKS server counts zero
  fetches after warm-up.

#### Acceptance Criteria

The full `apps/api` suite is green, with **every route still on the legacy path**. Phase 1's
contract suite is green in `legacy` mode.

#### Test Plan

Unit and integration tests of the new modules, called directly. pglite for the app database, a real
`apps/auth` (`createInternalApp` over pglite) for the internal endpoints, and a local JWKS handler for the
matrix.

### Phase 8: Route switch and compatibility layer over apps/auth

**Dependencies**: Phases 1, 5 and 7

#### Objective

In one commit, so no intermediate state mixes token kinds:

- switch every authenticated route to phase 7's verifier
- re-implement the legacy routes as HTTP clients of `apps/auth`

The result is judged by phase 1's tests in `better-auth` mode, **unchanged**.

#### Files to Create / Modify

- Every route file that calls `authenticateRequest` or `requireAdmin`, **re-grepped** at the start
  of the phase (`grep -rln "authenticateRequest\|requireAdmin" apps/api/src`; twelve today), moved
  to `require-user` and `require-admin-role`.
- The route files under `apps/api/src/app/api/v2/users/`, plus `v2/request_password_reset` and
  `v2/reset_password`.
- `apps/api/lib/auth-service/legacy.ts` (new): the translations from `apps/auth` responses to the
  legacy `detail` strings and status codes.

| Route | Call to `apps/auth` (private network, credential, forwarded IP) | Legacy response |
|---|---|---|
| `register` | zod (as today) → an email held by a `system_key` row in `public.users` → 409 → `POST /api/auth/sign-up/email` with `X-Ansari-Client` and `register_to_mail_list` forwarded. `apps/auth` enforces reserved/taken (409) **then** strength (400), the legacy order (phase 3), and the layer maps both to the legacy `detail` → `GET /api/auth/token` → insert `public.users` (same id, email, names, `registered_via`). The newsletter call moves into `apps/auth` (phase 3), so both registration paths share it | `{status, access_token: JWT, refresh_token: session token, token_type}` |
| `login` | `POST /api/auth/sign-in/email` → `/token` → `first_name`/`last_name` from `public.users` (resolving the row through phase 7's path if it is missing) | the frozen shape |
| `refresh_token` | `GET /api/auth/token` with `Authorization: Bearer <refresh_token>`. 401 → 401. **The same session token is returned** | `{access_token, refresh_token, token_type}` |
| `logout` | JWT verified → `POST /internal/users/:id/revoke-sessions` (phase 5, G-3), with the user's JWT | `{message}` |
| `me` GET | JWT → `public.users` | the frozen shape |
| `me` DELETE | the spec's rule 5: refuse a system account → app transaction (delete row, write tombstone) → internal delete with the user's JWT → set `auth_deleted_at` | unchanged |
| `request_password_reset` | `POST /api/auth/request-password-reset` | identical for every email |
| `reset_password` | `POST /api/auth/reset-password`. `apps/auth` checks the token **then** strength, the legacy order (phase 3) | unchanged |

#### Deliverables

- [ ] Phase 1's contract suite passes in `better-auth` mode with **no assertion edits**. A diff
  check in CI proves the fixtures are unchanged since phase 1.
- [ ] Scenario 1: a migrated legacy row logs in through the layer, `me` returns the same id, and
  threads list.
- [ ] Scenario 3: register through the layer gives a scrypt hash, rows in both databases, and
  logout and login again work.
- [ ] Scenario 4: the full mobile cycle, including the 15-minute expiry, done with fake time
  against the real `apps/auth`. Concurrent refreshes with one session token all succeed.
- [ ] Scenario 9: delete with a 25-hour-old session succeeds and cascades, and the JWT then gets
  401. Scenario 9b: a system account is refused.
- [ ] Scenario 19: the identical 409 on both paths.
- [ ] Scenario 20: a system address reset sends nothing (a Resend spy) and creates nothing.
- [ ] Scenario 21 through the layer: one budget shared with direct sign-in.
- [ ] Scenario 22: two layer clients land in two buckets.
- [ ] Scenario 5, through the real route: admin 200, non-admin 403, unauthenticated 401, a demoted
  admin 403 on the next request, and 503 with `apps/auth` unreachable.
- [ ] Scenario 25: ownership is unchanged. The existing IDOR suites run against the switched routes.
- [ ] **The machine callers, both directions.** A user JWT on `/api/v1/chat/completions` gets 401 and
  is never parsed as a JWT. `LEADERBOARD_API_KEY` on every JWT route gets 401. `mcp-complete` is
  unchanged. A test asserts that `apps/api/src/middleware.ts` does not exist.
- [ ] **The revocation window, one table-driven test**, the spec's "revocation window is pinned"
  criterion. It covers four causes: logout through the layer, a password reset, a ban (the phase 5
  script), and deletion. For each cause:
  - the session token can no longer mint a JWT at `/token` (401)
  - a JWT issued just before still verifies at `apps/api` until its `exp`, and is rejected after
    it, using fake time
  - the measured window is ≤ 900 s

  Deletion is the one exception: there the JWT gets 401 at once on data routes, through the
  tombstone. The test asserts that too.
- [ ] Register guard order through the layer: a reserved address with a weak password gets 409,
  not 400. Reset order: an invalid token with a weak password gets `Invalid or expired reset
  token`.
- [ ] The layer has no import of `better-auth` or `@ansari/auth`. A test pins it.

#### Acceptance Criteria

The contract suite is green unchanged. The integration scenarios are green against
`createInternalApp(createAuth(pglite))` (the layer's target) running in-process on a port, with `createPublicApp` alongside for the direct-path scenarios.

#### Test Plan

Integration: `apps/api` handlers → a real `apps/auth` over HTTP on localhost → pglite. Two pglite
instances stand in for the two databases.

### Phase 9: Legacy auth removal, CORS fix and source scans

**Dependencies**: Phase 8

#### Objective

Remove the legacy auth model from the code (the database objects stay until the contract PR) and
pin the separation with scans.

#### Files to Create / Modify

- **Deleted:**
  - `apps/api/lib/auth/jwt.ts`
  - the JWT paths of `middleware.ts`, with the file deleted if nothing remains
  - `lib/auth/startup-checks.ts` (it moves to `apps/auth`)
  - `apps/api/scripts/grant-admin.ts`
  - the token, session-version and is-admin helpers in `lib/db/users.ts`
  - `lib/auth/admin.ts` and `lib/auth/reserved.ts` (now in `apps/auth`), and
    `lib/newsletter.ts`, if nothing in `apps/api` still calls it
- **Deleted as now-meaningless tests:** `token-grace`, `session-version-reuse`, `issue-token-pair`,
  `refresh-token-route` (the legacy one) and similar. The list is re-derived by grep and recorded.
- `apps/api/db/schema/users.ts`: no `passwordHash`, `isAdmin` or `sessionVersion`.
  `apps/api/db/schema/tokens.ts` and its export are deleted. The **tables stay**.
- `apps/api/lib/config.ts`, `.env.example`, `.env.ci`, `docs/self-hosting.md` and `turbo.json`:
  `JWT_SECRET`, `ACCESS_TOKEN_EXPIRY_HOURS` and `REFRESH_TOKEN_EXPIRY_HOURS` are removed, and
  `ADMIN_EMAILS` leaves `apps/api`. The four `AUTH_*` names (five with P-3) are added, by the
  four-way derivation.
- `apps/api/next.config.ts`: no `Allow-Credentials`. `Allow-Origin` is the allowlist.
- `apps/api/tests/source-scan/` (new): the scans, each reporting **hit counts**, each with a planted
  known-bad line and a near-miss.
  - Runtime code in `apps/api` names no `password_hash`, `is_admin`, `session_version` or `tokens`
    in raw SQL, and has no `SELECT *` on `users`.
  - No runtime code in either service names `APP_DATABASE_URL` or `AUTH_DATABASE_URL`, or holds a
    literal `postgres://` fallback. A plain `DATABASE_URL` is ignored (the near-miss).
  - `apps/api` has no `better-auth` or `@ansari/auth` import or dependency.
  - `apps/auth/scripts/cutover/` is excluded by path, and a test proves the exclusion covers that
    directory only.
- pglite DDL in `apps/api` tests: updated where the new code no longer needs `tokens` or the legacy
  columns. The rest wait for the contract PR. Coordinated with #292, whose status is checked at
  phase start.

#### Deliverables

- [ ] Every scan fails on its planted line and passes on its near-miss, and the hit counts are
  recorded in the review.
- [ ] Scenario 28 (the `apps/api` half): a credentialed CORS preflight from a disallowed origin gets
  no allow response.
- [ ] `grep -rn "jsonwebtoken" apps/api` returns no hits, and the dependency is removed from
  `apps/api/package.json` (a lockfile hunk).

#### Acceptance Criteria

The full suite is green with the legacy code gone. Phase 1's contract suite is green
(`better-auth` mode is now the only mode, and the `legacy` setup is deleted with the code it
drove).

#### Test Plan

The whole `apps/api` suite, and the scans.

### Phase 10: apps/frontend signs in at apps/auth

**Dependencies**: Phases 4 and 7. **Blocked on the app architect's agreement** (spec I-6), which is
sought at plan approval with this phase's design.

#### Objective

`apps/frontend` signs in, signs up (guests included), resets passwords and signs out through
`apps/auth`. It sends the JWT to `apps/api` and refreshes the JWT from the session, with no
third-party cookies on the web.

#### Files to Create / Modify

- `apps/frontend/package.json`: `better-auth` and `@better-auth/expo` at **1.7.7** (pinned, as
  in `packages/auth`). Neither is a dependency today. This is a lockfile hunk, and #265's stale
  `expo-router` peer is re-checked here.
- `apps/frontend/lib/auth/api.ts`: replaces the `/v2/users/*` calls with `better-auth/react`
  `createAuthClient`, with `bearer` handling: the token from `set-auth-token` is stored where
  `store.ts` keeps it today (SecureStore on native, `localStorage` on web). On native it adds the
  `@better-auth/expo` client.
- JWT acquisition: `GET /api/auth/token` with the session bearer. The existing single-flight
  refresh on 401 is kept, and it now calls `/token`.
- Registration sends `register_to_mail_list` in the sign-up body, and `apps/auth`'s hook
  subscribes (phase 3), so the opt-in is kept. Every call to `apps/auth` sends `X-Ansari-Client`,
  which the phase 4 CORS config allows.
- `apps/frontend/lib/auth/guest.ts`: guest sign-up goes to `/api/auth/sign-up/email` with the same
  shape.
- Reset screens call `request-password-reset` and `reset-password` at `apps/auth`, and keep the
  `?token=` link shape.
- Env: `EXPO_PUBLIC_AUTH_URL` (`auth.askansari.ai`, `auth-staging.askansari.ai`, localhost). It
  goes through `turbo.json` by the four-way rule.
- The existing tests (`context.test.tsx`, `store.test.ts`, `guest.test.ts`) are updated, plus new
  ones for the refresh and expiry cycle.

#### Deliverables

- [ ] Web: sign-in, a bearer call, expiry, `/token`, retry. There are no cookies in the flow; a
  test asserts that `credentials` is `omit`.
- [ ] Native: the Expo client stores the session in SecureStore.
- [ ] Sign-out calls `/sign-out` and clears storage.
- [ ] A native release decision recorded with the app architect (I-6): whether any native build
  pointing at `apps/auth` ships before the rollback deadline. The default proposed is **no**.

#### Acceptance Criteria

Frontend tests are green, plus a manual run on iOS Simulator and web against a local `apps/auth`
and `apps/api` (lessons: verify the real user path).

#### Test Plan

Unit tests with a fetch double for the client. Manual end-to-end against local services.

### Phase 11: apps/auth deployment: Dockerfile, Railway service, CI and env

**Dependencies**: Phase 5. **Main-architect hunks throughout.**

#### Objective

Make `apps/auth` deployable as its own Railway service with its own Postgres, and keep CI covering
it.

#### Files to Create / Modify

- `apps/auth/Dockerfile` (new): mirrors `apps/api/Dockerfile`'s structure (pnpm fetch, workspace
  copy including `packages/`, a production stage, `NODE_ENV=production`, a non-root user).
- `apps/auth/railway.toml` (new; the reviewable record): `watchPatterns` include `apps/auth/**`,
  `packages/**`, and the lockfile and workspace files. The healthcheck is `/health`.
  It records the two ports (P-1): the public domain targets `PORT`, and **no domain targets
  `INTERNAL_PORT`**. The Dockerfile exposes both. A phase 13 check proves the internal port is
  unreachable from the public internet, and reachable from `backend` over the private network.
- `.github/workflows/ci.yml`: the `auth` job also runs `apps/auth`'s new tests. If the main
  architect prefers, the copy-script tests (phase 12) run there too.
- `apps/auth/.env.example`, `apps/auth/.env.ci`: every new variable, with
  `placeholder-not-a-real-*` values for secrets.
- `turbo.json` `globalEnv`: the additions from phases 3, 7 and 10, by the four-way derivation,
  recorded in the commit message.
- `CONTRIBUTING.md`: dev and CI use **two local databases** (for example `ansari` and
  `ansari_auth`) with owner URLs, and developers who ran the old `packages/auth` `0000` must drop
  and recreate their local auth database.
- `RELEASE.md`: the "Railway service configuration" block gains the `auth` service and the auth
  Postgres (with backups or PITR before its first real row; C-4).

#### Deliverables

- [ ] `docker build -f apps/auth/Dockerfile .` succeeds locally. The container boots against a
  local Postgres, `/health` answers, and `/health` fails when the database is stopped.
- [ ] A `turbo run build --filter ansari-auth...` cache-key check: changing an `AUTH_*` value
  changes the hash. This is the arch-critical strict-env lesson, proven to fail when the name is
  omitted.

#### Acceptance Criteria

CI is green with the new job steps. The Docker image boots.

#### Test Plan

Local Docker run. The CI run on the branch.

### Phase 12: Cutover tooling: copy, audits, rollback SQL and runbooks

**Dependencies**: Phases 2, 6 and 9

#### Objective

Turn the spec's cutover data copy, audits and rollback into reviewable, tested files, so the window
runs scripts, not typed SQL.

#### Files to Create / Modify

- `apps/auth/scripts/cutover/`. This directory is excluded from the runtime scans by path.
  - `00-preflight-app.sql`: read-only.
    - The case audit: a count of `email <> lower(trim(email))`, and every case-insensitive
      duplicate group.
    - The guest count by the exact shape (informational).
    - The admin inventory: `is_admin = true`, compared with `ADMIN_EMAILS`.
    - The system-account list.
    - The B-1 and B-4 baseline queries.
  - `01-export-app.sql`: the `\copy (SELECT id, lower(trim(email)), first_name, last_name, password_hash, registered_via, created_at, updated_at FROM public.users WHERE system_key IS NULL) TO STDOUT`
    statement.
  - `02-import-auth.sql`, which runs as one session. It creates a `TEMP` import table, runs
    `\copy … FROM STDIN`, then `BEGIN`. Guards abort unless `auth.users` and `auth.account` are
    empty, the import is non-empty, and the normalized emails are unique. It then inserts:
    - `auth.users`, with the same `id`, the derived `name`, `email_verified = true`,
      `role = 'user'`, and `created_at` and `updated_at` copied exactly
    - one `auth.account` per row: `id = gen_random_uuid()`, `provider_id = 'credential'`,
      `account_id = user id`, `password = hash`, the same timestamps, and
      `ON CONFLICT (user_id, provider_id) DO NOTHING`, so the account backfill can be re-run on its
      own (scenario 10)

    It then `COMMIT`s. The temp table goes with the session.
  - `03-audit-app.sql` and `03-audit-auth.sql`: the row count, the ordered id checksum
    `md5(string_agg(id::text, ',' ORDER BY id))`, the hash checksum, the credential count, "no
    system account in the auth database" (by the system-address domain), and the admin set.
  - `copy.sh`. It refuses to run unless `RAILWAY_ENVIRONMENT` is set (that is, inside a Railway
    shell), and unless both `APP_DATABASE_URL` and `AUTH_DATABASE_URL` are set **and differ**.
  - It runs `set +o history` and uses no temporary files.
  - It runs `psql "$APP_DATABASE_URL" -f 01… | psql "$AUTH_DATABASE_URL" -f 02…`. `02` reads the
    pipe through `\copy … FROM STDIN` within the same session.
  - It then runs both audits and **diffs** them. It exits non-zero on any difference, and prints
    counts and checksums only.
  - `04-complete-tombstones.sql`, the operator's completion script. It lists pending
    `public.deleted_users` (from the app database), and the operator deletes those ids directly in
    the auth database (`DELETE FROM auth.users WHERE id = ANY(:ids)`). The cascade removes
    sessions and accounts (amendment C). It never calls the endpoint.
  - `rollback-remove-post-cutover-users.sql`: `DELETE FROM public.users WHERE created_at >= :cutover_at AND system_key IS NULL`,
    with a dry-run `SELECT count(*)` first. `:cutover_at` is the recorded window time.
  - `README.md`: what each file does and the order. It points to the runbook.
- `apps/auth/tests/cutover/copy.test.ts` (new). It runs the real SQL files against **two pglite
  instances**, with the pipe emulated through pglite's `COPY … TO/FROM` device. It covers:
  - Scenario 10: a re-run inserts nothing, and a non-empty target aborts with no changes.
  - Scenario 12: timestamps survive exactly.
  - Scenario 13: mixed case is normalized, and the user signs in afterwards through `createAuth`.
  - Scenario 14: the collision abort.
  - Scenario 9h: one altered hash in transit fails the hash audit, and a failure in step 2 leaves
    no import table.
  - Scenario 7: name derivation.
  - Amendment C: after `04-complete-tombstones.sql`, no orphan `auth.session` or `auth.account` row
    is left.
  - Scenario 16: the admin list.
  - Scenario 20: system rows are never copied.
  - Scenario 9i: `email_verified = true`, and no email is sent.
- `docs/cutover/better-auth-cutover.md`, the window runbook, in this order. Each step names its
  file, the commit on `develop` it is applied from, its success check and its abort action.
  1. Preconditions: the rehearsal is signed off, baselines are in, the admin list is approved, and
     collisions are decided.
  2. Comms and alert silencing.
  3. `apps/api` offline, by the mechanism chosen in the rehearsal.
  4. Snapshots or PITR marks of both databases.
  5. The auth baseline `0000`, applied to the empty auth database.
  6. The copy and the audits.
  7. The app window migration `0011` (`0009` and `0010` before it, if they are not yet applied).
  8. `grant-admin.ts` for the approved list, then the admin audit.
  9. Deploy `apps/auth` (private only).
  10. The private-network smoke tests.
  11. Deploy `apps/api` and `apps/frontend`.
  12. Re-attach `apps/api`'s domains.
  13. The edge probe on the production domains (P-4).
  14. Attach `auth.askansari.ai`.
  15. The public smoke tests (scenario 31).
  16. Re-enable alerting, and record `cutover_at`.
- `docs/cutover/rollback.md`, the rollback runbook. It is valid until `cutover_at + 24h`.
  1. `apps/api` offline.
  2. Remove the post-cutover users (dry run, then the delete).
  3. Redeploy the previous `apps/api` and `apps/frontend` deployments.
  4. Detach `auth.askansari.ai`.
  5. Smoke-test a legacy login.
  6. Record it.
  It also gives the restart procedure: empty the auth database, then re-run from step 5. After the
  deadline, the runbook says to fix forward.
- `RELEASE.md`:
  - the auth database and its window steps, with each `psql` step naming `APP_DATABASE_URL` or
    `AUTH_DATABASE_URL`
  - the schema freeze, from the merge to the end of the window
  - the smoke test and the admin bootstrap rewritten for Better Auth (closes #33)
  - every applied SQL recorded with its `develop` commit
- `codev/resources/arch-critical.md`, `arch.md` and `packages/auth/README.md`: the spec's delta
  table, applied, and every stale statement fixed wherever it appears. Found by grep for
  `is_admin`, `session_version`, `JWT_SECRET`, `tokens` and `grant-admin` across `codev/resources`,
  `docs` and the READMEs. The P-1 residual and the `X-Real-IP` dependency go into `arch.md`.

#### Deliverables

- [ ] All the copy tests are green.
- [ ] Every runbook step names a file that exists and a check that is mechanical.
- [ ] `release-doc.test.ts` and `self-hosting-docs.test.ts` are updated for the new steps.

#### Acceptance Criteria

The copy suite is green. A runbook dry read by the security architect is part of the PR review.

#### Test Plan

pglite pair. The real `psql` pipe is exercised in phase 13.

### Phase 13: Staging verification: edge check, unmodified clients, full rehearsal

**Dependencies**: Phases 1 to 12. **External prerequisites:** C-3 (a staging database separate from
production, which a production clone can be restored into), C-4 (the auth Postgres on Railway in
staging), and an operator with Railway access (I-4). This phase **cannot complete without them**;
if they are not available, the builder reports that and stops.

#### Objective

Produce the evidence the spec requires before the merge, and commit it.

#### Files to Create / Modify

- `docs/cutover/edge-check.md`: the pre-merge passive production check (`dig` CNAME chains and
  plain `curl -sI` headers per production domain; P-4); the method (probe commands, networks used, IPv4 and IPv6), the raw
  observations per domain, and the verdict for both properties. The verdict sets
  `AUTH_RATE_LIMIT_MODE` (P-3).
- `docs/cutover/baselines.md`: B-1 to B-4, with the P-2 numbers confirmed or amended. Amendments go
  into `packages/auth/src/limits.ts` in the same commit.
- `docs/cutover/rehearsal.md`: each runbook step's timing (scenario 34), the audit outputs (counts
  and checksums only), the downtime mechanism chosen, and the rollback rehearsal result
  (scenario 9k).
- `codev/reviews/300-better-auth-migration.md`: started here with the evidence, and finished in
  the review phase.

#### Deliverables

- [ ] Staging deployments of `apps/auth`, `apps/api` and `apps/frontend` from the branch, with
  `auth-staging.askansari.ai`.
- [ ] The edge check, both properties, on every staging domain.
- [ ] The **unmodified** clients run against staging:
  - the released mobile build (or its build pointed at staging): login, bearer call, the 401
    after 15 minutes, refresh, retry
  - the admin analytics login
  - `legacy/frontend-web`, with the same cycle
- [ ] The full rehearsal on a **clone of production** plus a fresh auth database, following the
  runbook exactly: all audits pass, and both services boot on the rehearsed databases and pass the
  smoke tests. Then the **rollback**: post-cutover users are removed, the previous image is
  redeployed, a migrated user signs in with the legacy password through the legacy code, and no
  post-cutover user remains.
- [ ] The rehearsal is re-run after the last `develop` merge before the window.

#### Acceptance Criteria

Every item above is recorded. The security architect has the verdicts before the PR proceeds (spec:
"the security architect is told before the PR proceeds").

#### Test Plan

The rehearsal itself is the test. Results are counts and checksums, never raw rows or emails.

## After merge: the window, the verify phase, and the contract PR

- **The window** (spec "The window" row): the operator runs `docs/cutover/better-auth-cutover.md`.
  The PR merges and is promoted as step 0 of it, and the owner's `DEPLOYED_THROUGH` bump is
  already in the PR. The builder records `porch done 300 --merged <N>` and enters **verify**.
- **Verify**: the smoke tests, the 24-hour watch (sign-in success rate, 401/429 rates on the
  layer, `apps/auth` errors), and the rollback deadline passing. Then the follow-up issues are
  filed (the layer's removal with I-3's metric, the profile sync design, guest cleanup), and #16
  and #49 are closed with the post-cutover behaviour.
- **The contract PR** (the first release after the deadline passes; a new branch from
  `origin/develop`):
  - `apps/api/drizzle/00NN_better_auth_contract.sql`: drop `password_hash`, `is_admin` and
    `session_version`, and drop `tokens`. It is numbered by the rule and has **its own
    `DEPLOYED_THROUGH` bump**.
  - The remaining pglite DDL naming those objects, coordinated with #292.
  - The P-4 diagnostic routes are removed.
  - `RELEASE.md` names this migration as **the one exception** to the backward-compatible rule.
  - The parity test proves that the full journal matches the Drizzle schema without the columns.
  - Its runbook step is applied from `develop` at a recorded commit, after confirming the deadline
    has passed and no rollback is open.

## Risks and Mitigation

The spec's risk table stands. These are the risks this plan adds or sharpens.

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| C-3, C-4 or the operator are unavailable, so phase 13 cannot run | Medium | High (no merge) | Phases 1 to 12 do not depend on them. Raised at plan approval; phase 13 stops and reports rather than guessing |
| Production domains behave differently from staging at the edge | Low | High | P-4 probe in the window; `AUTH_RATE_LIMIT_MODE` flips to `email` without code (P-3) |
| The phase 1 contract suite is weakened during phase 8 to pass | Low | High | CI diff check on the fixtures; assertions are never forked between modes |
| Copy tests on pglite miss a `psql` pipe behaviour | Medium | Medium | The real pipe is rehearsed in phase 13 on a production clone, with checksums |
| The private-network peer residual (P-1) | Low | Medium | Recorded in `arch.md`; the production 400 rule removes the shared bucket |
| Rate-limit numbers are wrong for real traffic | Medium | Medium | B-1 to B-4 before merge; one constants module; the fallback ceiling floor |
| A long-lived branch drifts; migration numbering collides | Medium | Medium | `develop` merges at each phase boundary; the numbering re-check is recorded in the thread every time |
| The app architect does not agree to the phase 10 design in time | Medium | High | Sought at plan approval; phase 10 depends only on 4 and 7, so it can move without blocking 11 and 12 |
| Logout needs the fourth internal route (G-3) | Certain | Low | Subject-bound like delete; built in phase 5; the gate decides, and a rejection goes back to the owner |
| Guest provisioning hits the decided sign-up limit (G-5) | Medium | Medium | B-1 measures it; owner decision with data before merge |

## Documentation Updates

- `docs/cutover/` (new): the runbook, rollback, edge check, baselines and rehearsal.
- `RELEASE.md`: the auth service and database, the window steps, the schema freeze, the contract
  exception, the smoke test and the admin bootstrap (closes #33).
- `CONTRIBUTING.md`: two local databases, and resetting the local auth database.
- `docs/self-hosting.md`, `apps/api/.env.example`, `apps/auth/.env.example`: the env changes.
- `packages/auth/README.md`: the schema, UUIDs, dual verify, sessions, JWT, rate limits and client
  IP.
- `codev/resources/arch-critical.md` and `arch.md`: the spec's delta table, plus P-1.
  `lessons-learned.md` is written in the review phase.

## Questions for the plan-approval gate

- **G-1 (P-3).** Build the IP fallback now, behind `AUTH_RATE_LIMIT_MODE` (default `email`), rather
  than only after a failed check? Recommended: yes.
- **G-2 (P-4). This needs an owner amendment to the spec, not only a gate answer** (Codex). The
  spec requires production-domain verification before the merge, and also forbids deploying project
  code to production before the window. Both cannot hold. The proposal: probe the production
  domains in the window rather than before the merge, with
  diagnostic routes that echo only the caller's own IP? This is the one place the plan cannot meet
  the spec's "before the PR merges" literally.
- **G-3.** This changes the spec's three-endpoint internal surface. Add a fourth internal endpoint,
  `POST /internal/users/:id/revoke-sessions` (built in phase 5), which is
  subject-JWT bound, for legacy logout?
- **G-4.** The P-2 numbers, pending B-1 to B-4.
- **G-5 (an observation on a decided item; Gemini).** Sign-up 3/60s per IP is decided. But
  `apps/frontend` registers a **guest** on every cold launch with no stored session
  (`lib/auth/context.tsx`). So one person who launches, then registers with one retry, uses the
  whole budget, and three devices behind one NAT launching in the same minute hit it. The plan
  keeps the decided number. B-1 measures the real guest rate, and the owner decides with that
  data whether guest sign-ups need their own rule.
- **Still open from the spec:** C-3 (the staging database) and C-4 (the auth Postgres) block
  phase 13 only. I-4 (the operator and the window). I-6 (the app architect, for phase 10).

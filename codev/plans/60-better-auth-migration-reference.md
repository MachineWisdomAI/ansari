# Plan: Better Auth Migration (Custom JWT → Better Auth) — reference

> **Reference document.** Merged from PR #148 (author: @deeseeker) as-is, then updated by the
> security architect with the round-3 review decisions and a re-verification against the installed
> better-auth **1.7.7** (2026-10-14). Renamed from `60-better-auth-migration.md` so it does not collide
> with the plan the SPIR builder writes for the implementation issue. Treat it as the starting point
> and evidence base for that spec and plan, not as an approved plan. Every `dist/...` citation below
> is a line in the installed better-auth 1.7.7 package; re-check citations if the version moves.

## Metadata

- **ID**: plan-2026-09-17-better-auth-migration
- **Status**: reference (PR #148 rounds 1–2 addressed by the author; round 3 and 1.7.7 updates applied
  by the security architect)
- **Specification**: [codev/specs/60-better-auth-migration-reference.md](../specs/60-better-auth-migration-reference.md)
  — amended in PR #148 (legacy `/v2/users/*` layer, `first_name` / `last_name`, `emailVerified`) and
  updated with the round-3 decisions (`auth` schema, reset routes, rate limiting)
- **Source**: GitHub issue #60 (spec merged via PR #134)
- **Depends on**: #59 (`apps/auth` + `packages/auth` scaffold)
- **Created**: 2026-09-17

## Executive Summary

Replace `apps/api`'s custom JWT auth (`tokens`, `session_version`, JWT middleware) with **Better Auth**
as the only auth model, in a **single cutover**. All Better Auth tables live in a dedicated Postgres
schema, **`auth`**, created ahead of the window. User **UUIDs are preserved**: in the window, legacy
`public.users` is renamed to `users_legacy`, rows are copied into `auth.users`, FKs on `threads` /
`preferences` / `feedback` are repointed, and **`tokens` is dropped**.

`apps/api` validates requests with Better Auth's **bearer plugin** (`Authorization: Bearer <session
token>` → `auth.api.getSession`). The legacy **`/v2/users/*` endpoints stay**, reimplemented over
Better Auth, so the released mobile build keeps working without a store release. They are removed 90
days after cutover or at ≥ 95% new-client adoption, whichever comes first (owner: Amr).

Work is split into **Phases 0–4, plus optional Phase 5**. Each phase is revertible in git. **Phase 3 is
one coordinated window with `apps/api` fully offline**, rolled back by DB snapshot within 24 hours.
Phases 0–2 can ship across several PRs; **Phase 3 is its own reviewed release**.

Carried in from PR #134 approval (Amr, 2026-09-15):

1. **Admin boot assertion ordering** — roles are assigned at runbook step 8, before `apps/api` boots with
   the replacement assert at step 9.
2. **`emailVerified`** — decided: migrated rows get `true` (see Decisions).
3. **`tokens`** — dropped at runbook step 7, not "retired".

Carried in from PR #148 review (Amr, 2026-09-18 and round 2):

- Bearer plugin for `apps/api`; `revokeSessionsOnPasswordReset: true`.
- Full `apps/api` downtime during the window (Railway: remove public domains or pause `backend`).
- Admin plugin columns named in the migration.
- Legacy `/v2/users/*` kept as a compatibility layer; `first_name` / `last_name` retained.
- Rehearsal covers runbook steps 1–8 of **this plan** (includes `DROP TABLE tokens` and admin roles).
- Session lifetime, explicit rate limiting, system accounts excluded from `account` backfill, 24h
  rollback deadline.

Carried in from PR #148 review round 3 (2026-09-29) and the 1.7.7 re-verification (2026-10-14):

- Better Auth tables in a dedicated **`auth`** Postgres schema; the Better Auth migration runs before
  the window, in every environment.
- `me` DELETE goes through the internal adapter, not `auth.api.deleteUser` (see the layer section).
- Password-reset routes added to the layer, with the legacy link shape.
- Rate-limit values accepted; the client-IP source must be configured explicitly.
- better-auth is **1.7.7** on `develop` (83f31be); every version-sensitive claim was re-read there.

**Migration SQL** follows the **ported framework** from the legacy auth migration script (coordinate
with Waleed on location and idempotency helpers before Phase 2).

## Decisions

| Topic | Decision | Source |
|-------|----------|--------|
| How `apps/api` authenticates | Bearer plugin, `Authorization: Bearer`, `auth.api.getSession({ headers })` | PR #148 round 1 |
| Legacy `/v2/users/*` | Kept, reimplemented over Better Auth; frozen response shapes | PR #148 round 2 |
| `emailVerified` for migrated rows | `true` (grandfathered) | PR #148 round 2 |
| `first_name` / `last_name` | Retained as `additionalFields` next to `name`; never split `name` | PR #148 round 2 |
| Session lifetime | `expiresIn: 30d`, `updateAge: 1d` | PR #148 round 2 |
| Downtime mechanism | Railway: remove both public domains or pause the `backend` service | PR #148 round 2, `RELEASE.md` |
| Rollback deadline | 24 hours after `apps/api` comes back; after that, fix forward | PR #148 round 2 |
| Compatibility layer removal | 90 days after cutover or ≥ 95% new-client adoption, whichever first; **owner: Amr** | PR #148 round 2 |
| Rate limiting | Sign-in 5/60s, sign-up 3/60s, database storage, `enabled: true`; client IP configured explicitly | PR #148 round 3; 1.7.7 re-verification |
| Where Better Auth tables live | Dedicated Postgres schema `auth` (`pgSchema('auth')`), migrated before the window | PR #148 round 3 |
| `me` DELETE | Internal adapter delete; `freshAge` left at its default | PR #148 round 3; 1.7.7 re-verification |
| Password-reset routes | Added to the layer; legacy link shape; `checkPasswordStrength` kept | PR #148 round 3 |

## How `apps/api` authenticates after cutover

`apps/auth` and `apps/api` are separate hosts. Session cookies set by `apps/auth` are host-only (no
cookie `domain` in `packages/auth`, `crossSubDomainCookies` off), so `apps/api` never receives them.
Native clients are not a cookie jar either.

Flow with the bearer plugin:

1. Client signs in (new clients: `apps/auth` `/api/auth/*`; released builds: `/v2/users/login`).
2. The session token comes back — in the `set-auth-token` header from `apps/auth`, or as
   `access_token` / `refresh_token` from the legacy endpoint.
3. Client stores it (SecureStore on native).
4. Every `apps/api` request sends `Authorization: Bearer <token>`.
5. The bearer before-hook verifies the token's HMAC against `BETTER_AUTH_SECRET` and injects it as the
   session cookie; `auth.api.getSession({ headers })` then does a session-row read. Same cost class as
   today's `findToken` → `users` join.

`apps/api` needs the **same `BETTER_AUTH_SECRET`** as `apps/auth` and the `DATABASE_URL` it already has.

**Out of scope for bearer conversion:** `/api/v1/chat/completions` compares its Bearer value to
`LEADERBOARD_API_KEY` in constant time — no user, no session. It keeps that check. `/api/v2/mcp-complete`
is public by design (IP rate limit, `ai-skill` system account) and is unaffected. **Do not add a global
`apps/api` `middleware.ts`**, so a blanket session check can't sweep either of these in.

## Legacy `/v2/users/*` compatibility layer

The released iOS/Android build posts to `{API_V2}/users/login`, and on any failed call posts to
`/users/refresh_token`. A non-OK response there wipes stored tokens and logs the user out
(`legacy/frontend-app/src/services/ApiService.ts`). Keeping these routes turns a forced store release
into an ordinary re-login. The old client already sends `Authorization: Bearer` on every other call,
which is exactly what `getSession` validates after cutover.

No JWT, no `tokens`, no `session_version` — each route calls Better Auth and translates to the legacy
JSON shape. Files stay under `apps/api/src/app/api/v2/users/`.

| Route | Method | Behavior after cutover |
|-------|--------|------------------------|
| `login` | POST | `auth.api.signInEmail` → `session.token` returned as both `access_token` **and** `refresh_token` (client requires both non-empty) |
| `register` | POST | Better Auth sign-up; same response shape |
| `refresh_token` | POST | Read `refresh_token` from the body, validate it as a session, return the same token again; 401 when revoked |
| `logout` | POST | Revoke the session |
| `me` | GET | User fields from the session |
| `me` | DELETE | Delete the user through Better Auth's internal adapter (below) |
| `/v2/request_password_reset` | POST | `auth.api.requestPasswordReset`; same response shape |
| `/v2/reset_password` | POST | `auth.api.resetPassword`; same response shape |

**`me` DELETE — do not call `auth.api.deleteUser`.** On 1.7.7 that endpoint returns 404 unless
`user.deleteUser.enabled` is set (`dist/api/routes/update-user.mjs:278-281`). Without a `password` in
the body it also rejects any session older than `session.freshAge`, default 24h
(`update-user.mjs:320-323`, `dist/context/create-context.mjs:149`). The legacy route takes no password
and mobile sessions are routinely days old. Setting `freshAge: 0` would also remove the freshness
requirement from `/list-sessions` and `/unlink-account` (`dist/api/routes/session.mjs:350`,
`account.mjs:263`). Instead, the route calls `(await auth.$context).internalAdapter.deleteUser(userId)`
(`dist/db/internal-adapter.mjs:232`), which deletes the user's sessions, accounts and user row; user
data on `threads` / `preferences` / `feedback` goes by the existing `ON DELETE CASCADE`. **Contract
test:** delete succeeds with a session created more than 24h earlier, and the token is dead afterwards.

**Password-reset routes (decided in round 3).** The released app calls both
(`legacy/frontend-app/src/services/UserService.ts:22,48`), and so does the legacy web reset page. Both
routes read and write `tokens` and sign with `JWT_SECRET` today, so they break at step 7. In the layer:

- `sendResetPassword` builds the **legacy** link shape, `${FRONTEND_URL}/reset-password?token=<BA token>`
  (`apps/api/lib/email.ts:21`), not Better Auth's `url`. The mobile deep link and the web page both read
  `?token=`. The hook receives the raw token (`dist/api/routes/password.mjs:82-85`).
- `reset_password` passes that token straight to `auth.api.resetPassword({ body: { newPassword, token } })`;
  no callback redirect.
- Run `checkPasswordStrength` before the call, as `register` does. Better Auth enforces only min/max
  length.
- `requestPasswordReset` answers identically for unknown emails (`password.mjs:59-70`), preserving
  the legacy anti-oracle behavior.
- **Refuse system accounts.** `resetPassword` creates a `credential` account when the user has none
  (`password.mjs:161`), and system accounts deliberately have none. `sendResetPassword` must send
  nothing for a user with a `system_key`, and a test pins it.
- Reset links emailed before cutover stop working; accepted at their 1-hour expiry.

**Frozen response contract** (contract tests pin each one):

- `login`: `status`, `access_token`, `refresh_token`, `token_type: 'bearer'`, `first_name`, `last_name`.
- `register`: `status`, `access_token`, `refresh_token`, `token_type: 'bearer'`.
- `me` GET: `id`, `email`, `first_name`, `last_name`, `source`, `created_at`, `updated_at`.
- Errors carry `detail` (the client reads it first); status codes unchanged (422 validation, 401 bad
  credentials, 409 taken/reserved email).

**`register` keeps today's guard order:** zod validation → reserved-address/taken check returning the
identical 409 → password-strength check → create. Newsletter opt-in still receives `first_name` /
`last_name` as sent. The same reserved-email and `system_key` guards also run in Better Auth sign-up
hooks, so the `apps/auth` path can't bypass them.

**Consumers that keep working unchanged:** the released mobile build; `apps/api/src/app/admin/analytics/page.tsx`
(posts to `/api/v2/users/login`, reads `access_token`) — covered by contract tests, not edited.

**Accepted cost:** two auth surfaces live at once (`/api/auth/*` on `apps/auth`, `/v2/users/*` on
`apps/api`). Not dual auth — one source of truth, Better Auth sessions — but it is code with tests and a
deletion date. Recorded in spec Q7.

**Removal trigger:** 90 days after cutover, or new-client adoption ≥ 95%, whichever comes first.
**Owner: Amr.** Tracked in Phase 4.

## Success Metrics

- [ ] All specification success criteria met, including the PR #148 amendment.
- [ ] Phase 0 exit criteria green (UUID round-trip, one bcrypt user login, timestamps documented,
  `(user_id, provider_id)` uniqueness + idempotent backfill).
- [ ] `revokeSessionsOnPasswordReset: true` configured; test fails if removed.
- [ ] Bearer plugin enabled; `apps/api` resolves a session from `Authorization: Bearer` in dev/staging.
- [ ] Contract tests pin every legacy `/v2/users/*` response shape.
- [ ] Staging rehearsal of **runbook steps 1–8 (this plan)** with row-count / PK-set audits — includes
  `DROP TABLE tokens` and admin role assignment.
- [ ] Production cutover: all users re-authenticate with existing passwords (no mass reset); released
  mobile builds keep working through the compatibility layer.
- [ ] Permanent dual hash verify (bcrypt + scrypt) with a **regression test that fails** if the bcrypt
  branch is removed while legacy hashes exist.
- [ ] `npm run typecheck && npm test && npm run build` green for affected packages at each phase
  boundary (at minimum `apps/api`, `packages/auth`, `apps/auth`, and any updated clients).
- [ ] `arch-critical.md` updated at Phase 4 per spec delta table.
- [ ] Deploy runbook executed and signed off (operator step for `users_legacy` drop).

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "phase_0", "title": "Spike, UUID schema, Better Auth config, #59 scaffold disposition"},
    {"id": "phase_1", "title": "Prepare: bearer middleware, compatibility layer, admin tooling, CORS, clients, env"},
    {"id": "phase_2", "title": "Staging rehearsal: idempotent SQL migration framework"},
    {"id": "phase_3", "title": "Production cutover window (apps/api offline)"},
    {"id": "phase_4", "title": "Decommission JWT, drop users_legacy, remove compatibility layer on trigger"},
    {"id": "phase_5", "title": "Optional: fold apps/auth into apps/api"}
  ]
}
```

## PR and Issue Strategy

- Open **one GitHub issue per phase** (or per phase group) linked to #60; reference this plan.
- **Recommended PR split:** Phase 0 → Phase 1 → Phase 2 (migrations + staging tests) → **Phase 3 alone**
  → Phase 4 → Phase 5 optional.
- Phase 3 PR must include: runbook, rollback snapshot instructions, and a sign-off checklist.

---

## Phase 0: Spike, UUID schema, Better Auth config, #59 scaffold disposition

**Dependencies:** #59 merged and runnable locally.

### Objectives

Prove Better Auth works with **UUID** ids and the cutover-shaped schema before any production data
moves, and lock in the `createAuth()` configuration the cutover depends on.

### Deliverables

- [ ] **`packages/auth` — `createAuth()` config**
  - `advanced.database.generateId = "uuid"`.
  - `user` model → table **`users`** via `modelName` (avoids quoting the reserved word `user`).
  - Every table declared on **`pgSchema('auth')`**. Pass `schemaName: 'auth'` to `drizzleAdapter` so
    the Better Auth CLI generates the same shape (1.7.7 option, `@better-auth/drizzle-adapter`
    `index.d.mts:59`). At runtime the adapter resolves each model through the table object it is
    given, so queries are emitted as `"auth"."users"`.
  - `additionalFields`: `system_key`, `source`, `registered_via`, `first_name`, `last_name`
    (`input: false` for `system_key`, `source`, `registered_via`).
  - `plugins`: `expo()`, **`bearer()`**, **`admin()`**.
  - `emailAndPassword`: permanent dual verify (below) plus **`revokeSessionsOnPasswordReset: true`**
    (still no default on 1.7.7, `dist/api/routes/password.mjs:169` — unset, reset leaves every session
    alive, a regression vs today).
  - **`session: { expiresIn: 60 * 60 * 24 * 30, updateAge: 60 * 60 * 24 }`** — 30 days, refreshed
    daily. Approximates the legacy refresh window; Better Auth's default would log mobile users out
    weekly.
  - **Rate limiting** — see proposal below.
  - Sign-up hooks: reserved-email check and `system_key` guard from spec 4 (identical 409, before the
    password-strength check).
- [ ] **Regenerate Drizzle schema** in `packages/auth/src/schema.ts`: all tables in the `auth`
  schema; UUID PK/FKs on `users`, `session`, `account`, `verification`; **unique constraint on
  `account (user_id, provider_id)`**.
- [ ] **Admin plugin columns** present in the generated schema and migration SQL:
  - `users`: `role`, `banned`, `ban_reason`, `ban_expires`
  - `session`: `impersonated_by`

  The admin plugin schema is byte-identical between 1.6.27 and 1.7.7 (`dist/plugins/admin/schema.mjs`),
  but no `drizzle-kit generate` run has included it yet: the #59 scaffold has no admin plugin, so the
  "no drift on 1.7.7" result from 83f31be does not cover these columns. Verify exact names from
  `drizzle-kit generate` output. If `role` is missing, runbook step 8 fails with `apps/api` already
  offline.
- [ ] **`rate_limit` table** (Better Auth model `rateLimit`) if database storage is confirmed.
- [ ] **Migration** (human-reviewed, never `db:push`):
  - `DROP TABLE IF EXISTS` the #59 scaffold tables in `public` (`user`, `session`, `account`,
    `verification`).
  - `CREATE SCHEMA auth`, then the UUID-shaped Better Auth tables inside it.
  - **Where it runs:** dev/test databases in Phase 0; staging and production in Phase 2, **before** the
    window. `auth.users` coexists with legacy `public.users`, so no environment needs the window to
    make room. pglite supports schemas, so the test DDL sync still works.
- [ ] **Permanent dual password verify**: `$2a$` / `$2b$` → bcrypt (with the 72-byte truncation of
  `apps/api/lib/auth/password.ts`); otherwise scrypt.
- [ ] **Spike:** one legacy-format row → `INSERT` + `account` → sign-in via `apps/auth` with the
  unchanged password.
- [ ] **Timestamp mapping note** (`packages/auth/README`): how legacy `timestamptz` maps to Better Auth
  `timestamp`; switch to `timestamptz` only if the spike shows corruption.

### Rate limiting (accepted in round 3)

Today only `/api/v2/mcp-complete` is rate-limited (in-memory `Map`, `apps/api/lib/rate-limit.ts`);
login and register have none. Better Auth 1.7.7 defaults, unchanged from 1.6.27: enabled only in
production, memory storage, 100 requests / 10s (`dist/context/create-context.mjs:170-175`); sign-in
and sign-up 3 / 10s, password reset 3 / 60s (`dist/api/rate-limiter/index.mjs`, default special rules).

`createAuth()` config:

```ts
rateLimit: {
  enabled: true,
  storage: 'database',
  window: 60,
  max: 100,
  customRules: {
    '/sign-in/email': { window: 60, max: 5 },
    '/sign-up/email': { window: 60, max: 3 },
  },
},
```

- `enabled: true` explicitly, so it doesn't hinge on `NODE_ENV`.
- `storage: 'database'`: memory counters are per-instance, so N instances means N× the budget.
  Database storage avoids adding Redis. Needs the `auth.rate_limit` table (shape unchanged in 1.7.7).
  1.7.7 makes the atomic `consume` path mandatory and drops the non-atomic get/set fallback; database
  storage already implements it. A future `customStorage` must implement `consume`.
- Password reset keeps Better Auth's built-in 3 / 60s.

**Client IP must be configured explicitly — this is a hard Phase 0 requirement, not a check.** Better
Auth reads `advanced.ipAddress.ipAddressHeaders` (default `x-forwarded-for`). Without
`advanced.ipAddress.trustedProxies`, a header holding more than one address resolves to **no IP**
(`@better-auth/core` `dist/utils/ip.mjs:174-194`). Requests with no IP all share **one bucket per path**
(`dist/api/rate-limiter/index.mjs:236-247`). At 5 sign-ins per minute that bucket becomes a global
login limit for every affected user, and any client can force it by sending its own
`X-Forwarded-For`, which the proxy then appends to. Behavior is identical on 1.6.27. Deliverables:

- Determine which header Railway's edge sets and how it treats a client-supplied `X-Forwarded-For`.
- Either point `ipAddressHeaders` at a single-value header the edge overwrites, or set
  `trustedProxies` to Railway's proxy ranges so the right-most untrusted address is used.
- Test: a request with a two-entry `X-Forwarded-For` is limited under the client's own address, not a
  shared bucket. The layer's own limiter must resolve the IP the same way.

**The compatibility layer is not covered by this.** Better Auth rate-limits in its router's `onRequest`
(`dist/api/index.mjs:172` on 1.7.7), which only HTTP requests to its handler pass through. `/v2/users/login`
calling `auth.api.signInEmail(...)` server-side skips it. The layer needs its own limiter —
`lib/rate-limit.ts` at the same budgets (login 5 / 60s, register 3 / 60s per IP). That limiter is
in-memory, so the per-instance caveat applies there.

### Phase 0 exit criteria (spec — must be green)

1. UUID round-trip through the Drizzle adapter into UUID columns in the `auth` schema
   (better-auth@1.7.7; `generateId: "uuid"` handling is unchanged from 1.6.27,
   `@better-auth/core` `dist/db/adapter/get-id-field.mjs:12,28`). Not yet proven on any version.
2. One migrated test user: bcrypt login end-to-end via Better Auth.
3. Timestamps: documented mapping or schema fix; no silent corruption on `created_at` / `updated_at`.
4. `(user_id, provider_id)` unique + idempotent backfill re-run verified on a throwaway DB.

### Acceptance Criteria

- [ ] Local: `apps/auth` sign-up/sign-in works against the UUID schema (new user).
- [ ] Spike user (copied bcrypt hash) signs in.
- [ ] `drizzle-kit generate` output reviewed; migration committed, not applied by CI.

### Test Plan

- **Integration:** extend `packages/auth/tests/auth.integration.test.ts` for UUID ids and migrated
  bcrypt login.
- **Unit:** password verify dispatches on hash prefix; bcrypt truncation case mirrored from spec 4.
- **Integration:** password reset with a live session → session revoked; **fails if
  `revokeSessionsOnPasswordReset` is removed**.
- **Integration:** reserved-email sign-up returns the same 409 as a taken email.
- **Integration:** sign-in over the limit returns 429.
- **Integration:** two-entry `X-Forwarded-For` is limited per client, not in a shared bucket.
- **Integration:** UUID round-trip into `auth.users`, read back through the adapter.

### Rollback Strategy

Revert Phase 0 commits. Production is untouched (the `auth` schema migration reaches production in
Phase 2).

### Risks

| Risk | Mitigation |
|------|------------|
| Better Auth + Drizzle UUID mismatch | Exit criterion 1; pin better-auth@1.7.7 (exact, as on `develop`) until upgraded deliberately, re-verifying this plan's citations on each bump |
| Dropping #59 tables loses dev-only rows | Acceptable per spec; document in README |

---

## Phase 1: Prepare (bearer middleware, compatibility layer, admin tooling, CORS, clients, env)

**Dependencies:** Phase 0 complete.

### Objectives

Get the code ready for cutover without switching production: bearer validation on `apps/api`, the
compatibility layer, client token flow, CORS, env, and admin tooling. Production stays on JWT until
Phase 3.

### Deliverables

- [ ] **`apps/api` session helper:** import `@ansari/auth`, call `auth.api.getSession({ headers })`,
  return the same shape the 12 route files expect from `authenticateRequest` today. Feature-flagged
  until Phase 3. No global `middleware.ts`.
- [ ] **Compatibility layer** for `/v2/users/*` (see section above), built behind the same flag, with
  contract tests for every response shape and its own rate limiter.
- [ ] **Password-reset routes** in the layer (see section above), including the system-account refusal.
- [ ] **Admin assignment script** replacing `scripts/grant-admin.ts` (e.g. `scripts/assign-ba-admin.ts`):
  sets the admin plugin `role` by email; runs against the DB directly (works while `apps/api` is
  offline); does not touch `is_admin`.
- [ ] **Replacement startup assert** (`assertConfiguredBaAdminsExist` or similar): resolves
  `ADMIN_EMAILS`, checks Better Auth `role`. Keeps `shouldRunAdminStartupCheck` gating. Enabled in
  production only at step 9.
- [ ] **CORS:** fix `apps/api/next.config.ts` (wildcard origin with credentials); allowlist aligned with
  `trustedOrigins` for web origins. `trustedOrigins` is not a boundary for custom schemes (re-verified
  on 1.7.7: checked only when a cookie is present, and `expo-origin` is client-controlled) — no vacuous
  origin tests. See also #266: the existing HTTP origin test is vacuous because Better Auth skips the
  check when `NODE_ENV=test` unless `advanced.disableOriginCheck` is set
  (`dist/context/create-context.mjs:211`).
- [ ] **CORS on `apps/auth`:** `set-auth-token` exposed to browser clients that need it (bearer plugin
  adds it to `Access-Control-Expose-Headers` on sign-in — verify for our origins).
- [ ] **New frontend:** sign-in via `apps/auth`, store `set-auth-token`, send `Authorization: Bearer` to
  `apps/api`. Ships at cutover. `prototypes/ansari-expo`'s existing bearer wiring (`lib/api/`) can be
  repointed.
- [ ] **Env convergence:** `apps/api` production env gets `BETTER_AUTH_SECRET` (same value as
  `apps/auth`); documented in `.env.example`; new vars follow the `turbo.json` `globalEnv` rule in
  `arch-critical.md`. `JWT_*` removed in Phase 4.

### Acceptance Criteria

- [ ] Dev/staging: sign in via `apps/auth`, then a bearer-authenticated `apps/api` call succeeds.
- [ ] Dev/staging: legacy client flow (`/v2/users/login` → bearer call → `/v2/users/refresh_token`)
  works end to end against Better Auth.
- [ ] Admin assignment script works in dev.
- [ ] CORS preflight with credentials succeeds for allowed origins only.

### Test Plan

- **Contract:** each `/v2/users/*` response shape, including error `detail` and status codes.
- **Integration:** Better Auth E2E login; admin analytics login still reads `access_token`.
- **Regression:** reserved registration and `system_key` behavior on both sign-up paths.

### Rollback Strategy

Revert Phase 1; JWT remains the production path.

---

## Phase 2: Staging rehearsal and migration framework

**Dependencies:** Phase 0 schema; Phase 1 code; Waleed's migration framework available.

### Objectives

Port and harden the idempotent cutover SQL, then rehearse **runbook steps 1–8 of this plan** on a
staging clone. Steps 7 (`DROP TABLE tokens`) and 8 (admin roles) are the likeliest to fail live, so
they are in scope.

### Deliverables

- [ ] **Apply the `auth` schema migration** (Phase 0 output) to staging and then production, ahead of
  the window. Human-applied, never by CI. Production now carries empty `auth.*` tables beside legacy
  `public.users`.
- [ ] **Migration location** (agree with Waleed): e.g. `packages/auth/drizzle/` or
  `scripts/migrations/better-auth-cutover/`, containing:
  - Name derivation SQL (trim first + last → email local-part → `'User'`).
  - `INSERT … SELECT` into `auth.users`, columns: `id`, `email`, derived `name`, `first_name`, `last_name`, timestamps,
    `system_key`, `source`, `registered_via`, `email_verified = true`. Omit `is_admin`,
    `session_version`.
  - `account` backfill `WHERE system_key IS NULL` with `ON CONFLICT (user_id, provider_id) DO NOTHING`.
    System accounts (`ai-skill`, `leaderboard`) carry a `password_hash` (column is `NOT NULL`) but must
    stay non-login.
  - FK repoint for `threads`, `preferences`, `feedback` to `auth.users.id`.
  - `DROP TABLE tokens`.
- [ ] **Rehearsal runbook** for steps 1–8, on a clone of production data taken after the `auth`
  schema migration, so the rehearsal starts from the real pre-window state.
- [ ] **Audits:**
  - PK-set equality `users_legacy` vs `auth.users`.
  - `account` rows = non-system users.
  - **No system account has a `credential` row.**
  - Every `ADMIN_EMAILS` entry has `role = 'admin'` after step 8.
- [ ] **Test DDL sync** if pglite suites need the new `users` shape (spec 4 lesson: same commit).

### Acceptance Criteria

- [ ] Rehearsal of steps 1–8 completes on the clone with all audits passing.
- [ ] Backfill re-run produces zero duplicate `account` rows.
- [ ] Step 9 code boots against the rehearsed DB; no code path reads `users_legacy`.

### Test Plan

- **Integration:** migrated bcrypt users from the clone sign in through both `apps/auth` and
  `/v2/users/login`.
- **Automated:** bcrypt verify branch test (fails when the branch is deleted).

### Rollback Strategy

Drop the clone; no production impact.

### Risks

| Risk | Mitigation |
|------|------------|
| FK repoint typo | Rehearsal + constraint verification queries |
| `DROP TABLE tokens` blocked by an unexpected dependency | In rehearsal scope |
| Framework drift from spec | Checklist against runbook steps |

---

## Phase 3: Production cutover (`apps/api` offline)

**Dependencies:** Phase 2 rehearsal signed off; new frontend ready to ship; DB snapshot taken.

### Objectives

Run the runbook below in one window. After it, Better Auth is the only auth model; old mobile builds
work through the compatibility layer.

**Exception to `RELEASE.md`:** normal releases apply backward-compatible migrations while the previous
deployment keeps serving, and never roll back the database. This window does neither — `apps/api` is
offline, the schema change is not backward-compatible, and rollback is a snapshot restore (within 24h).

### Production runbook

This numbering is canonical. The spec's eight ordered operations map to it as: spec 1–6 → steps 1–6
(spec 6 split into 6 and 7), spec 7 → step 9, spec 8 → step 10. Step 8 is added by this plan.

**Preconditions**

- [ ] DB snapshot / PITR baseline recorded.
- [ ] New frontend build ready to ship at step 9.
- [ ] Operator and on-call assigned; maintenance comms sent.

**Steps**

1. **Take `apps/api` offline.** On Railway, either remove both public domains from the `backend`
   service (`api.askansari.ai`, `api-35.ansari.chat`) or pause the service. Pick one in rehearsal and
   use the same one here. The healthcheck will fail — **silence backend alerting (healthcheck, Sentry)
   for the window.**

   Why full downtime: step 2 breaks every query against `public.users`, not only auth —
   `getSystemUserId()` in `/api/v1/chat/completions` and `/api/v2/mcp-complete`, admin stats in
   `lib/db/stats.ts`. Any writes accepted while partly live are lost on snapshot restore.
   `MAINTENANCE_MODE` doesn't help: `/api/v2/app-check` only reports it to clients.
2. **`ALTER TABLE public.users RENAME TO users_legacy`.** FKs on `threads`, `preferences`, `feedback`,
   `tokens` now reference `users_legacy.id`. The rename no longer makes room for anything; it stops
   accidental reads of the archive.
3. **Verify the `auth` schema** (migrated in Phase 2): `auth.users` (with admin columns),
   `auth.session`, `auth.account`, `auth.verification`, `auth.rate_limit` exist, and `auth.users` and
   `auth.account` are empty. No DDL in the window.
4. **`INSERT … SELECT`** from `users_legacy` → `auth.users` (columns per Phase 2; `email_verified = true`).
5. **Backfill `auth.account`** `WHERE system_key IS NULL`, idempotent `ON CONFLICT`.
6. **Repoint FKs** on `threads`, `preferences`, `feedback` to `auth.users.id`.
7. **`DROP TABLE tokens`.** Required — otherwise it blocks `DROP TABLE users_legacy` later.
8. **Assign admin roles** for every `ADMIN_EMAILS` entry with the Phase 1 script. Must finish before
   step 9, because the replacement assert runs at boot.
9. **Deploy and bring `apps/api` back** (restore domains / unpause) with:
   - Session helper on all 12 route files below.
   - `/v2/users/*` serving the compatibility layer, plus the two reset routes.
   - Drizzle `users` model is the auth package's exported `auth.users` table object; no model for
     `users_legacy`; `tokens` callers removed
     from `lib/db/users.ts`.
   - Replacement admin assert enabled; `is_admin` reads removed (`lib/auth/startup-checks.ts`,
     `lib/auth/admin.ts`).
   - `/api/v1/chat/completions` untouched (`LEADERBOARD_API_KEY` check).
   - New frontend shipped.
10. **Legacy sessions are gone** — JWT validation removed, `tokens` dropped. Everyone signs in again
    with their existing password.
11. **Smoke tests:** migrated user via `apps/auth` and via `/v2/users/login`; `refresh_token` round
    trip; admin route; `system_key` endpoints; thread ownership. Re-enable alerting.

**Step 9 route checklist** — every file calling `authenticateRequest` / `requireAdmin` today
(12 on `develop` as of this revision; `v2/threads/[id]/documents` is new since the review):

- [ ] `v2/preferences`
- [ ] `v2/admin/stats`
- [ ] `v2/feedback`
- [ ] `v2/threads`
- [ ] `v2/threads/[id]`
- [ ] `v2/threads/[id]/chat`
- [ ] `v2/threads/[id]/documents`
- [ ] `v2/threads/[id]/name`
- [ ] `v2/threads/[id]/share`
- [ ] `v2/share/[id]`
- [ ] `v2/users/me`
- [ ] `v2/users/logout`

Re-run the grep before the Phase 3 PR in case more routes land.

**Post-window**

- [ ] Watch auth error rates. Mass login failure within 24h → rollback.
- [ ] Record cutover completion time — starts the 14-day `users_legacy` clock and the 90-day
  compatibility-layer clock.

### Admin boot assertion ordering

| | Order |
|---|---|
| Wrong | Deploy code that drops `is_admin` while the old assert still checks it |
| Wrong | Enable the new assert before Better Auth roles exist |
| **Required** | Step 8 assigns roles → step 9 deploys the new assert |

### Acceptance Criteria

- [ ] No JWT validation anywhere in production.
- [ ] Migrated users sign in with existing passwords on both paths.
- [ ] `ADMIN_EMAILS` accounts pass the startup assert.
- [ ] `users_legacy` exists and is unread by application code.

### Rollback Strategy

**Deadline: 24 hours** after `apps/api` comes back. Within it: take `apps/api` offline again, restore
the pre-step-2 snapshot, redeploy the previous version (Railway → Deployments → Redeploy). After 24
hours a restore would discard a day of new accounts and data, so fix forward instead.

---

## Phase 4: Decommission

**Dependencies:** Phase 3 stable.

### Objectives

Remove dead JWT code and env vars, drop `users_legacy` when its trigger fires, and remove the
compatibility layer when its trigger fires.

### Deliverables

- [ ] Remove JWT code: `lib/auth/jwt.ts`, JWT paths in `lib/auth/middleware.ts`, `tokens` schema and
  references, `session_version` usage, `scripts/grant-admin.ts`.
- [ ] Remove `JWT_SECRET` and token-expiry vars from config and `turbo.json`.
- [ ] Rewrite admin authz tests for the admin plugin.
- [ ] **Drop `users_legacy`** when all hold:
  1. ≥ 14 days since cutover.
  2. PK-set parity audit passes.
  3. No open rollback or incident needing the snapshot.
  4. Operator sign-off recorded.
- [ ] **Remove the compatibility layer** (`/v2/users/*` and the reset routes) at 90 days after
  cutover or ≥ 95% new-client adoption, whichever first. **Owner: Amr.** Suggested: bump
  `IOS_MINIMUM_BUILD_VERSION` / `ANDROID_MINIMUM_BUILD_VERSION` in the same release, so remaining old
  builds get the update prompt from `/v2/app-check` instead of failing on removed routes.
- [ ] Update `codev/resources/arch-critical.md` per the spec delta table.
- [ ] Close GitHub #16 with documented Better Auth session behavior.

### Acceptance Criteria

- [ ] No JWT verification path in the codebase.
- [ ] `users_legacy` dropped in a reviewed migration after its trigger.
- [ ] Compatibility layer removed after its trigger, with contract tests deleted alongside.
- [ ] CI green.

---

## Phase 5 (optional): Hosting consolidation

**Dependencies:** Phase 4 complete.

Mount Better Auth on `apps/api` via `toNextJsHandler` and retire `apps/auth` as a separate service.
Bearer validation doesn't change.

- [ ] Spike: `/api/auth/*` on `apps/api` (handler mount, CORS, exposed `set-auth-token`).
- [ ] DNS / proxy notes if the service count changes.
- [ ] Decommission the `apps/auth` deployment.

---

## Client compatibility checklist

| Client | Today | After cutover |
|--------|-------|---------------|
| Released iOS/Android build (`legacy/frontend-app`) | `/v2/users/*` + JWT bearer | Unchanged — compatibility layer; one re-login |
| New frontend | — | Signs in via `apps/auth`, sends `set-auth-token` as bearer; ships at cutover |
| `prototypes/ansari-expo` | `/v2/users/*` + JWT bearer | Either path works; repoint to `apps/auth` when convenient |
| Admin analytics (`apps/api/src/app/admin/analytics/page.tsx`) | `/v2/users/login` → `access_token` | Unchanged — covered by contract tests |

`*_MINIMUM_BUILD_VERSION` stays as-is at cutover. Rollback is no longer client-asymmetric: old builds
work on either side of it.

## Test suite matrix (spec §8)

| Category | Phase | Action |
|----------|-------|--------|
| JWT internals (`jwt.ts`, rotation, `session_version`) | 4 | Remove |
| `/v2/users/*` contract tests | 1 | Add; delete with the layer |
| Admin authz | 3–4 | Admin plugin |
| System / registration guards | 0–1 | Both sign-up paths; identical 409 |
| Feedback / ownership | 3+ | Keep |
| `bcrypt-compat.test.ts` | 0+ | Keep |
| `revokeSessionsOnPasswordReset` | 0 | Fails if flag removed |
| Rate limiting | 0–1 | 429 over limit on both paths; multi-entry `X-Forwarded-For` not collapsed into one bucket |
| `me` DELETE | 1 | Succeeds with a >24h-old session; token dead afterwards |
| Password reset | 1 | Legacy link shape; system accounts get no email; sessions revoked |
| System accounts non-login | 2 | Audit: no `credential` row |
| Bcrypt branch removal | 2+ | Fails if branch removed |
| Origin / `trustedOrigins` | 1 | Only if proven to reject wrong web origins |

## Validation checkpoints

1. **After Phase 0:** exit criteria green; migration reviewed; config (session, rate limit, plugins)
   in place.
2. **After Phase 1:** both client paths work in dev/staging; contract tests green.
3. **After Phase 2:** rehearsal of runbook steps 1–8 green with all audits.
4. **Before Phase 3:** downtime mechanism chosen and rehearsed; admin script dry-run; snapshot tested;
   comms sent.
5. **After Phase 3:** 24h login success rate; rollback deadline passes.
6. **Before `users_legacy` drop:** 14 days + parity + sign-off.
7. **Before compatibility-layer removal:** 90 days or ≥ 95% adoption; Amr signs off.

## Documentation updates required

- [ ] Cutover runbook in `docs/better-auth-cutover.md` (or `docs/self-hosting.md`), including the
  chosen Railway downtime step and alert silencing.
- [ ] `emailVerified = true` for migrated users recorded in the cutover SQL and `docs/self-hosting.md`.
- [ ] `.env.example` for `apps/auth` and `apps/api`; JWT vars marked deprecated, removed in Phase 4.
- [ ] `packages/auth/README`: UUID, `auth` schema, dual verify, session lifetime, rate-limit storage
  and client-IP source.
- [ ] `RELEASE.md`: note the one-off exception for this cutover; retire the `grant-admin.ts` bootstrap
  step in Phase 4.
- [ ] Update spec/plan/review status as phases complete.

## Post-implementation tasks

- [ ] Migrations committed and human-applied at deploy (never by CI).
- [ ] Security spot-check: reserved emails on both sign-up paths, `system_key` routing, admin never
  email-match, cross-user ownership, rate limits.
- [ ] Write the implementation review (the builder's `codev/reviews/<issue>-*.md`).

## Risk register

| Risk | Phase | Mitigation |
|------|-------|------------|
| Mass lockout | 0, 2, 3 | Spike; rehearsal; bcrypt dual verify; 24h rollback |
| Released mobile users stranded | 1, 3 | Compatibility layer + contract tests |
| Legacy password reset broken at cutover | 1 | Reset routes in the layer (decided round 3) |
| Reset gives a system account a password | 1 | `sendResetPassword` refuses `system_key` users + test |
| Rate limit collapses to a global login cap | 0 | Explicit client-IP source + multi-entry XFF test |
| `me` DELETE 404s or rejects old sessions | 1 | Internal adapter delete + >24h-session contract test |
| Admin boot crash-loop | 3 | Step 8 before step 9 |
| `role` column missing mid-window | 0, 2 | Admin columns in migration; rehearsal covers step 8 |
| `DROP TABLE tokens` fails live | 2 | Rehearsal covers step 7 |
| Partial API uptime during rename | 3 | `apps/api` offline at step 1 |
| System accounts become loginable | 2 | `WHERE system_key IS NULL` + audit |
| Credential stuffing on login | 0, 1 | Better Auth rate limit + separate limiter on the layer |
| Password reset leaves sessions alive | 0 | `revokeSessionsOnPasswordReset: true` + test |
| Compatibility layer never removed | 4 | Dated trigger; owner Amr |
| Duplicate `account` rows | 0, 2 | Unique constraint + `ON CONFLICT` |

## Open questions for review

1. Which header does Railway's edge set for the client IP, and does it overwrite or append to a
   client-supplied `X-Forwarded-For`? (Blocks the rate-limit config in Phase 0.)
2. Where does the migration SQL framework live? (Waleed; blocks Phase 2.)

## Approval

- [ ] Technical lead (Amr) — plan and spec amendment
- [ ] Waleed — migration SQL framework alignment
- [ ] Operator — cutover window, downtime mechanism, rollback

## Change Log

| Date | Change | Reason |
|------|--------|--------|
| 2026-09-17 | Initial plan | Implement spec #60 / PR #134 |
| 2026-09-21 | PR #148 review round 1 | Bearer auth, `revokeSessionsOnPasswordReset`, full downtime, admin columns |
| 2026-09-29 | PR #148 review round 2 | Compatibility layer, `first_name`/`last_name`, rehearsal scope, `emailVerified = true`, session lifetime, rate limiting, system accounts, route checklist, 24h rollback; Better Auth migration moved into the window in production |
| 2026-10-14 | PR #148 merged as-is; round 3 + 1.7.7 applied by the security architect; renamed to `-reference` | Dedicated `auth` schema (migration back out of the window), `me` DELETE via internal adapter, reset routes, rate-limit values and explicit client-IP source, system-account reset refusal, 1.7.7 citations, spec one-liners |

## Notes

- better-auth behavior was re-read from the installed **1.7.7** package on 2026-10-14 and diffed
  against 1.6.27: `deleteUser` and `freshAge`, rate-limit defaults and router-only limiting,
  `revokeSessionsOnPasswordReset`, client-IP resolution, admin schema, bearer plugin and
  `generateId: "uuid"` are unchanged apart from line numbers. Changed: custom-scheme origin matching
  (rewritten, same result for our entries), mandatory atomic rate-limit `consume`, and the new
  `schemaName` adapter option. Re-check on every upgrade.
- `system_key` lookup stays in `apps/api/lib/db/users.ts` (or its successor); the field is server-only.
- Phase 3 does not merge without rehearsal sign-off.

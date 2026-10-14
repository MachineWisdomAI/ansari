# Specification: Better Auth Migration

<!--
SPEC vs PLAN BOUNDARY:
This spec defines WHAT and WHY. The plan defines HOW and WHEN.
-->

> **Lineage.** This spec is written for issue #300. Its evidence base is the issue #60 reference
> spec and plan (`codev/specs/60-better-auth-migration-reference.md`,
> `codev/plans/60-better-auth-migration-reference.md`), updated in #299 against better-auth 1.7.7.
> Those documents are not edited here. This spec carries their decisions forward, except where a
> **Departure** note says otherwise and why. Where the two disagree, this spec wins.

## Problem Statement

Production authentication in Ansari is a custom JWT system inside `apps/api`. It is hardened
(spec 4) and well tested. Every capability beyond email and password, though, would be custom
security code: OAuth, 2FA, email verification, passkeys. Each would need its own review, and
token rotation would need the same again (#16, #34). Issue #59 added a Better Auth stack
(`packages/auth`, `apps/auth`) alongside it, but nothing in production uses that stack.

The goal is to make Better Auth the **only** auth model without locking anyone out:

- Existing users keep their passwords and their UUIDs. Their threads, preferences and feedback
  stay attached.
- Everyone signs in once more after the cutover. Nobody needs a password reset.
- The **released mobile build**, which cannot be changed without a store release, keeps working.
  It has `/v2/users/login` and `/v2/users/refresh_token` compiled in, and logs the user out
  whenever `refresh_token` returns non-OK.

The primary failure mode is **silent mass lockout**. Every irreversible step in this spec is
weighed against it. Secondary failure modes are a weakened security posture (rate limiting
collapsing into one global bucket, system accounts becoming loginable, revocation weakening) and
production releases frozen behind half-shipped cutover code.

**Affected:** every Ansari user (web, released iOS/Android build, new `apps/frontend`), admins, the
operator who runs the window, and every other developer whose releases share `develop`.

## Current State

Verified on this branch, `develop` at `2eb3fdc` plus the porch init commit.

**Legacy auth (`apps/api`), which serves production:**

- `lib/auth/jwt.ts`: HS256 access, refresh and reset tokens that embed `session_version`.
  `lib/auth/middleware.ts` `authenticateRequest` verifies the token, looks it up in `tokens`
  through `findToken`, and compares `session_version` against the user row.
- `lib/db/users.ts`:
  - `issueTokenPair`, `storeToken`, and `lookupRefreshToken` with reuse detection
  - `markTokenRotated`, with a 60-second grace window
  - `bumpSessionVersion`, which kills every session for a user
- `public.users` columns:
  - `id` (uuid), `email` (unique), `password_hash` (bcrypt, 12 rounds, `NOT NULL` even for
    system accounts), `first_name`, `last_name`
  - `source` (default `'web'`), `registered_via`, `is_admin`, `system_key` (unique), `session_version`
  - `created_at` and `updated_at`, both `timestamptz`
- Four tables reference `users.id` with `ON DELETE CASCADE`: `tokens`, `threads`, `preferences`
  and `feedback`. `shares`, `messages` and `tool_call_orphans` reach users only through `threads`.
- Twelve route files call `authenticateRequest` or `requireAdmin`, all under `src/app/api/v2/`:
  - `admin/stats`, `feedback`, `preferences`
  - `share/[id]`, `threads`, `threads/[id]`
  - `threads/[id]/chat`, `threads/[id]/documents`, `threads/[id]/name`, `threads/[id]/share`
  - `users/logout`, `users/me`

  The plan re-runs the grep before the switch.
- Legacy routes and their response shapes today, which the clients' wire schemas pin:
  - `POST /v2/users/register` → `{status, access_token, refresh_token, token_type}`
  - `POST /v2/users/login` → `{status, access_token, refresh_token, token_type, first_name, last_name}`
  - `POST /v2/users/refresh_token` → `{access_token, refresh_token, token_type?}` (no `status`)
  - `POST /v2/users/logout` → `{message}`. It bumps `session_version` and deletes **all** of the
    user's tokens, which logs the user out everywhere.
  - `GET /v2/users/me` → `{id, email, first_name, last_name, source, created_at, updated_at}`
  - `DELETE /v2/users/me` deletes the account.
  - `POST /v2/request_password_reset` sends a 1-hour reset JWT stored in `tokens`, and answers
    identically for unknown emails. `POST /v2/reset_password` consumes the token and kills every
    session.
  - Reset links use the shape `${FRONTEND_URL}/reset-password?token=…` (`lib/email.ts:21`).
- Admin is the `is_admin` flag, set out-of-band by `apps/api/scripts/grant-admin.ts`.
  `lib/auth/startup-checks.ts` asserts at production boot that every `ADMIN_EMAILS` entry is an admin.
- System accounts (`ai-skill`, `leaderboard`) are found by `system_key` and provisioned lazily.
  The `@system.ansari.chat` addresses are reserved at registration.
- `lib/rate-limit.ts` `getClientIp` takes the **first** `X-Forwarded-For` entry, then `X-Real-IP`.
  Its only caller is `/v2/mcp-complete`. Login and register have **no** rate limit.
- `next.config.ts` sends `Access-Control-Allow-Origin: *` together with
  `Access-Control-Allow-Credentials: true` for `/api/*`. Browsers reject that combination.

**Better Auth scaffold (#59), not used in production:**

- `packages/auth/src/schema.ts` has singular, text-id tables (`user`, `session`, `account`,
  `verification`) in `public`, with timestamps that have no time zone.
  - `account` has no unique `(user_id, provider_id)`.
  - There are no additional fields.
- `createAuth()` contains only `emailAndPassword: { enabled: true }`, `trustedOrigins` and the
  `expo()` plugin. It has:
  - no `bearer()`, `admin()` or `generateId`
  - no rate-limit config
  - no custom password verify
  - no `revokeSessionsOnPasswordReset`
- `packages/auth/drizzle/0000_better_auth_init.sql` has **no production apply step** in `RELEASE.md`.
- `apps/auth` (Express + `toNodeHandler`) has a CI job but **no Dockerfile and no Railway
  service**. Production deploys only `backend` (`apps/api`) and the web frontend.

**Clients:**

- **Released mobile build** (`legacy/frontend-app`): uses `/v2/users/*` with a JWT bearer, and logs
  out on any non-OK refresh.
- **`apps/frontend`**: also uses `/v2/users/*` (`lib/auth/api.ts`). Its refresh on 401 is
  single-flight, and it stores tokens in SecureStore on native and `localStorage` on web. It
  contains **no** Better Auth client.
- **Admin analytics page** (`apps/api/src/app/admin/analytics/page.tsx`): posts to
  `/v2/users/login` and reads `access_token`.
- `prototypes/ansari-expo`, which the reference documents name as a client, **does not exist** on
  this branch.

**Release mechanics:**

- `main` deploys automatically and is promoted **only by fast-forwarding** to a `develop` tip
  (`RELEASE.md`).
- Migrations are reviewed SQL, applied with `psql` before the deploy. They must be
  backward-compatible with the code still serving traffic, and are never rolled back.
- `apps/api/tests/migration/migration-schema-parity.test.ts` builds the database from the
  `apps/api` journal only (`DEPLOYED_THROUGH = '0008_model_provenance'`). It never reads
  `packages/auth/drizzle`.

**Migration framework:** the "ported SQL migration framework" that the reference plan defers to
(Waleed, "location and idempotency helpers") **does not exist anywhere in the repo**. A search finds
no idempotency helpers and no legacy auth migration script.

## Desired State

After the cutover:

1. **One auth model.** Better Auth sessions are the only session primitive. `tokens`,
   `session_version`, `is_admin` and JWT verification no longer exist in production.
2. **Same users, same passwords, same ids.** Every legacy user exists in `auth.users` under the same
   UUID and signs in with the existing password, through a permanent bcrypt + scrypt dual verify.
   Threads, preferences and feedback are untouched; only their FK targets move.
3. **All Better Auth tables live in the `auth` Postgres schema**: `auth.users`, `auth.session`,
   `auth.account`, `auth.verification` and `auth.rate_limit`. Legacy `public.users` survives only as
   the unread archive `public.users_legacy`, until a later, separately triggered drop.
4. **`apps/api` authenticates with the bearer plugin.** `Authorization: Bearer <session token>`
   resolves to a Better Auth session. `/api/v1/chat/completions` keeps its `LEADERBOARD_API_KEY`
   check, and `/api/v2/mcp-complete` stays public. There is no global `middleware.ts`.
5. **The `/v2/users/*` compatibility layer** and the two password-reset routes are reimplemented
   over Better Auth with **byte-compatible response shapes**. The released mobile build, the admin
   analytics page and `apps/frontend` all keep working, and their users sign in once more.
6. **Admins are identified by the admin plugin's `role`**, assigned by a script that replaces
   `grant-admin.ts`. Admin is never an email match. `ADMIN_EMAILS` keeps only its reservation role
   and the boot assertion, rewritten against `role`.
7. **System accounts are identified by `system_key`** (a server-only additional field). They have no
   `credential` account row and cannot sign in or reset a password.
8. **Rate limits are configured as decided:** sign-in 5/60s, sign-up 3/60s, database storage,
   `enabled: true`. They are keyed by the **real client IP**, which comes from `X-Real-IP` (see
   Client IP below). Login and register on the compatibility layer meet the same budgets.
9. **Revocation is at least as strong as today:**
   - Password reset revokes every session (`revokeSessionsOnPasswordReset: true`).
   - Logout on the layer revokes every session of the user, as today.
   - Account deletion leaves the token dead.
10. **Sessions** last 30 days and are refreshed daily (`expiresIn` 30d, `updateAge` 1d).
11. **Production releases are never blocked.** Until the window, every merged change is safe to
    promote while JWT still serves.

### Client IP for rate limiting (resolves an issue "must be resolved" item)

**Decision: read the client IP from `X-Real-IP` alone.** Better Auth gets
`advanced.ipAddress.ipAddressHeaders: ['x-real-ip']` with `trustedProxies` unset. The
compatibility layer's limiter and `lib/rate-limit.ts` `getClientIp` resolve the IP the same way,
from `X-Real-IP` only and never from `X-Forwarded-For`.

Evidence:

- **Railway's documentation** (Public Networking → Specs & Limits) names `X-Real-IP` as the header
  that identifies the client's remote IP. It does not mention `X-Forwarded-For`, publishes no proxy
  IP ranges, and says the specs may change.
- **Railway staff** said on Central Station in September and October 2026 that the edge overwrites
  `X-Real-IP` and `X-Forwarded-For` and does not append to a caller's values. They also said that a
  caller cannot forge `X-Real-IP` through the public edge, and that proxy CIDRs are not published
  and not stable. Community reports about whether `X-Forwarded-For` is overwritten or appended
  contradict each other, and one user saw extra hops.
- **better-auth 1.7.7** (`@better-auth/core` `dist/utils/ip.mjs`):
  - Without `trustedProxies`, any header holding more than one address resolves to **no IP**
    (`:190-193`).
  - Every request with no IP shares a single bucket per path, `no-trusted-ip|<path>`
    (`better-auth` `dist/api/rate-limiter/index.mjs:236-248`). At 5 sign-ins a minute, that bucket
    becomes a global login cap.
  - A single-valued `X-Real-IP` uses the one-value branch. IPv6 addresses are grouped to /64 by
    default.
- **Rejected:** `X-Forwarded-For` + `trustedProxies`. It needs proxy ranges that Railway says it
  will neither publish nor keep stable. **Also rejected:** plain `X-Forwarded-For`. It collapses
  into the shared bucket the moment Railway adds a hop. It is also what today's `getClientIp`
  trusts first, which lets a client pick its own bucket if the edge ever appends.

The documentation establishes only that the header exists. The overwrite guarantee is a staff
statement, so it **must be verified empirically on the deployed service before the cutover**
(Success Criteria). The test sends forged `X-Real-IP` and `X-Forwarded-For` values through each
public domain over IPv4, and over IPv6 where reachable. The forged values must never come back as
the observed client IP, and the result is recorded in the plan and review.

**Residual risk, accepted and documented:** a request that reaches `apps/api` over Railway's
private network (`*.railway.internal`) skips the edge and can set any `X-Real-IP`. No such caller
exists today.

### Hosting: Better Auth runs in-process in `apps/api` at cutover (Departure)

**Departure from reference spec Q5.** The reference spec hosts Better Auth on `apps/auth` through
the cutover, and has new clients call `/api/auth/*` there directly. That assumed `apps/auth` was a
deployed service, and it is not: it has no Dockerfile and no Railway service. Deploying it means a
new service, a new domain, cross-origin cookie and `set-auth-token` CORS work, and a client rewrite
of `apps/frontend`, all on the critical path of an already irreversible window.

This spec instead has `apps/api` import `@ansari/auth` and use Better Auth **in-process**, through
the bearer plugin for session validation and server-side calls for the compatibility layer.
**No Better Auth HTTP router (`/api/auth/*`) is exposed publicly in production by this project.**
Every production client, `apps/frontend` included, keeps calling `/v2/users/*` at cutover.

This keeps `apps/frontend` unchanged at cutover, so the app architect is not on the critical path.
It keeps one public auth surface instead of two. It also keeps the admin plugin's HTTP endpoints
(set-role, ban, **impersonate**) unreachable from the internet.

`apps/auth` stays the dev and CI harness for the shared config. #49, the extraction into
`apps/auth`, remains open and is not foreclosed. This is the "shared package that `apps/api`
imports" shape that #49 itself lists as an option.

Consequences carried forward:

- The decided Better Auth rate limits, database storage included, are **configured** and
  test-covered in `createAuth()`. Production login and register traffic reaches them only through
  the layer, so the layer must enforce the same budgets itself (Open Question I-2).
- The compatibility layer's removal trigger in the reference plan ("90 days or ≥ 95% new-client
  adoption") only becomes meaningful once a Better Auth-native client exists. Moving
  `apps/frontend` to a Better Auth client and exposing `/api/auth/*` (hosting decided then, for
  example on `apps/api` with `toNextJsHandler` or on a deployed `apps/auth`) is a **follow-up issue**.
  It must ship before the layer can be removed.

### Migration SQL location (resolves an issue "must be resolved" item)

**Decision: one migration journal, in `apps/api/drizzle/`.** The `auth` schema DDL and the cutover
migration are numbered migrations in that journal. `packages/auth/drizzle/` is retired: the #59
scaffold `0000` has never been applied to production. The window's read-only audits and the
admin-role script live next to the existing operator scripts under `apps/api/scripts/`.

**Departure from the reference plan.** The reference plan offered `packages/auth/drizzle/` or
`scripts/migrations/better-auth-cutover/`, pending a "ported framework" from Waleed. That framework
does not exist in the repo. A single journal is chosen for these reasons:

- **The FK repoint forces it.** After cutover, `threads`, `preferences` and `feedback` reference
  `auth.users`. For `drizzle-kit generate` in `apps/api` to emit and diff those constraints, the
  `apps/api` schema has to include the `auth` tables. Two journals that both own `auth.users` would
  fight over it.
- **The parity test then covers auth.** `migration-schema-parity.test.ts` and `DEPLOYED_THROUGH`
  apply to the `auth` schema and the cutover. Today `packages/auth/drizzle` sits outside every
  check, and that is the #165 outage class.
- **Fresh databases come out right in one pass.** The `RELEASE.md` smoke test (`pnpm db:migrate` on
  an empty Postgres) and the pglite suites build the post-cutover shape in a single run. On an empty
  database the cutover's data copy moves zero rows.
- **It fits the existing release practice:** reviewed SQL, applied with `psql`, never `db:push`,
  `inspect → apply → bootstrap → deploy`.

Every "idempotency helper" the reference plan expected is replaced by properties of the migration
itself:

- The cutover migration runs as **one transaction**, so a failure leaves nothing half-applied.
- The `account` backfill uses `ON CONFLICT (user_id, provider_id) DO NOTHING` on the unique
  constraint.
- **Precondition guards** abort the transaction unless `auth.users` and `auth.account` are empty and
  `public.users` exists.

This needs **Waleed's confirmation** at the spec-approval gate, which is Open Question C-1, and the
**main architect's review** for `apps/api/drizzle/` numbering and `DEPLOYED_THROUGH`.

### Phasing (resolves an issue "must be resolved" item)

The reference plan's Phases 0–5 map onto this project as **two PRs** inside one SPIR project.
`develop` fast-forwards into `main`, so the split point is chosen so that nothing merged early can
block a release.

| This project | Reference phases | Production-safe while JWT serves? |
|---|---|---|
| **PR A: Prepare** | 0, 1 and the code half of 2: `auth` schema migration, `createAuth()` config, dual verify, rate limiting and client IP, bearer session helper, compatibility layer, reset routes, admin script and assert, CORS fix, cutover migration SQL **drafted and rehearsed but not in the journal**, contract tests | **Yes.** The `auth` schema is additive (empty tables beside `public.users`), and the new code paths are not wired to production routes. PR A can merge and promote normally. |
| Staging rehearsal | 2 | Runs from PR B's branch on a clone of production taken after PR A's migration was applied. Does not touch production. |
| **PR B: Cutover** | 3, plus the code half of 4 | **No.** Merged to `develop` immediately before the window and promoted **in** the window. It holds the cutover migration (journaled), the route switch, the `users` model → `auth.users`, and removal of JWT, `tokens`, `session_version`, `is_admin`, `grant-admin.ts` and the `JWT_*` config. |
| Out of this project (follow-up issues) | 4 triggers, 5 | Drop `users_legacy` (14 days + parity + sign-off). Remove the layer (its trigger). Migrate `apps/frontend` to a Better Auth-native client and expose `/api/auth/*`. Fold `apps/auth`. |

PR B also removes the JWT code, which the reference plan defers to Phase 4. Rollback is a snapshot
restore plus a redeploy of the previous Railway deployment, never a code toggle, so dead JWT code
adds risk and buys nothing.

**Two PRs depart from the porch default of one PR per project**, so they need the architect's
explicit authorization (Open Question C-2). The fallback, one PR holding everything and merged at
the window, works too. It keeps a large branch alive across the rehearsal, and it delays the
production apply of the additive `auth` migration until the window, which the issue's decisions
rule out ("migrated before the window").

The **verify** phase of this project is the cutover itself: smoke tests, the 24-hour watch, and the
rollback deadline passing.

## Success Criteria

**Schema and data**

- [ ] All Better Auth tables are on `pgSchema('auth')`. `user` maps to `auth.users` through
  `modelName`. Ids are UUIDs (`generateId: "uuid"`), and a UUID written by the Drizzle adapter
  reads back unchanged in a UUID column, proven by a test against a real database (pglite or Postgres).
- [ ] `auth.users` carries `first_name`, `last_name`, `system_key` (unique), `source` and
  `registered_via` as additional fields. `system_key`, `source` and `registered_via` are
  `input: false`. It also carries the admin plugin columns (`role`, `banned`, `ban_reason`,
  `ban_expires`), and `auth.session` carries `impersonated_by`. The column names are confirmed from
  the reviewed `drizzle-kit generate` output.
- [ ] `auth.account` has a unique `(user_id, provider_id)`.
- [ ] Auth timestamps are `timestamptz`, or the mapping is documented with a test showing that
  `created_at` and `updated_at` survive the copy exactly. The legacy values are `timestamptz`.
- [ ] The cutover migration does all of the following in one transaction, guarded by its
  preconditions:
  - renames `public.users` to `users_legacy`
  - copies every row into `auth.users` (same `id`, derived `name`, `email_verified = true`, no
    `is_admin` or `session_version`)
  - backfills one `credential` account per **non-system** user with the bcrypt hash
  - repoints the FKs on `threads`, `preferences` and `feedback` to `auth.users.id`, keeping
    `ON DELETE CASCADE`
  - drops `tokens`
- [ ] Name derivation follows the reference rule:
  - `trim(first || ' ' || last)` when it is non-empty
  - otherwise the email local-part
  - otherwise `'User'`

  `name` is never split back into parts.
- [ ] Audits run after the migration and pass:
  - the primary-key set of `users_legacy` equals that of `auth.users`
  - the number of `credential` rows equals the number of non-system users
  - **no system account has a `credential` row**
  - every FK on `threads`, `preferences` and `feedback` targets `auth.users`
  - every `ADMIN_EMAILS` entry has `role = 'admin'` after the role script
- [ ] Re-running the backfill on its own creates zero duplicate `account` rows.
- [ ] The parity test covers the new migrations, and `DEPLOYED_THROUGH` is bumped in the PR that
  adds each one.

**Credentials and sessions**

- [ ] **Permanent dual verify:**
  - `$2a$` and `$2b$` hashes verify with bcrypt, keeping the 72-byte truncation of
    `lib/auth/password.ts`
  - anything else verifies with scrypt
  - new passwords hash with scrypt
  - a test **fails if the bcrypt branch is removed**
- [ ] A user migrated from a legacy-format row signs in with an unchanged password through the
  layer's `/v2/users/login`, end to end against a real database.
- [ ] `revokeSessionsOnPasswordReset: true`. A test proves that a reset kills a live session and
  **fails if the flag is removed**.
- [ ] Session lifetime is 30 days and is refreshed after 1 day, pinned by a test.
- [ ] After cutover no JWT verification path exists in `apps/api`. `tokens`, `session_version`,
  `is_admin` and `grant-admin.ts` are gone from code and schema.

**`apps/api` authentication**

- [ ] Every route that used `authenticateRequest` or `requireAdmin` resolves its user from a Better
  Auth bearer session. The route set comes from a grep at PR B time, not from this list.
  - **Ownership checks are unchanged:** a user cannot read another user's thread.
  - Admin routes require `role = 'admin'` and return the same 401 and 403 codes as today.
- [ ] `/api/v1/chat/completions` (`LEADERBOARD_API_KEY`) and `/api/v2/mcp-complete` behave as today.
  There is no global `middleware.ts`.
- [ ] The production boot assertion checks that every `ADMIN_EMAILS` entry exists with
  `role = 'admin'`, under the existing `shouldRunAdminStartupCheck` gating.

**Compatibility layer: frozen contract**

- [ ] **Contract tests land first, written against today's JWT implementation**, and pass
  **unchanged** against the Better Auth implementation. They pin status codes, field names, field
  presence (for example, `refresh_token` has no `status`), error `detail`, and the 401, 409 and 422
  semantics of `register`, `login`, `refresh_token`, `logout`, `me` (GET and DELETE),
  `request_password_reset` and `reset_password`.
- [ ] `login` and `register` return the session token as both `access_token` and `refresh_token`,
  with `token_type: 'bearer'`.
- [ ] `refresh_token` returns the same token while the session is live, and 401 once it is revoked
  or expired.
- [ ] `logout` revokes **all** of the user's sessions, as today.
- [ ] `DELETE me` succeeds with a session created more than 24 hours earlier, and afterwards the
  token is dead and the user's threads are gone (cascade).
- [ ] Password reset:
  - The emailed link has the legacy shape `${FRONTEND_URL}/reset-password?token=<token>`.
  - Unknown emails get the identical response.
  - A system account receives no email and cannot gain a credential.
  - `checkPasswordStrength` runs before reset and before register.
- [ ] Reserved addresses (`@system.ansari.chat`) and the `system_key` guards return the same 409 as
  a taken email, on the layer **and** in Better Auth's own sign-up hooks. The guard order in
  `register` is unchanged: validation → reserved/taken → strength → create.
- [ ] `register` still records `registered_via` from `X-Ansari-Client`, and still passes
  `first_name` and `last_name` to the newsletter opt-in.
- [ ] Clients run unmodified:
  - the released mobile flow: login, then a bearer call, then refresh on 401
  - `apps/frontend`'s flow (`lib/auth/api.ts`)
  - the admin analytics login

  Each works against the Better Auth-backed layer in staging.

**Rate limiting and client IP**

- [ ] `createAuth()` sets `rateLimit` to `enabled: true`, `storage: 'database'`, sign-in 5/60s and
  sign-up 3/60s, and sets `advanced.ipAddress.ipAddressHeaders: ['x-real-ip']`.
- [ ] Sign-in over the limit returns 429 on the layer's `/v2/users/login` and in Better Auth's own
  handler. The same holds for register and sign-up.
- [ ] A request carrying a two-entry `X-Forwarded-For` and a distinct `X-Real-IP` is limited under
  its `X-Real-IP`, not in a shared bucket. Forging `X-Forwarded-For` does not let a client switch
  buckets. The test covers both limiters.
- [ ] `getClientIp` reads `X-Real-IP` only. `tests/rate-limit.test.ts`, which asserts the opposite
  preference today, is updated.
- [ ] **Empirical edge verification is recorded before the window.** Forged `X-Real-IP` and
  `X-Forwarded-For` values sent through each production domain (`api.askansari.ai`,
  `api-35.ansari.chat`) and the `*.up.railway.app` domain never appear as the observed client IP.
  The verification uses a temporary echo route or equivalent, removed afterwards.

**CORS**

- [ ] `apps/api/next.config.ts` no longer sends `Allow-Origin: *` together with
  `Allow-Credentials: true`. Authentication is by bearer, so credentials are not needed for
  `/api/*`. Any allowlist matches the web origins in `trustedOrigins`.
- [ ] No origin test is vacuous. #266's test is made to fail on a wrong origin, or the limitation is
  documented in the test.

**Cutover and operations**

- [ ] A cutover runbook exists covering:
  - the downtime mechanism (remove both public domains from `backend`, or pause it, chosen in the
    rehearsal)
  - alert silencing
  - the snapshot and PITR baseline
  - migration apply, admin roles, deploy, smoke tests
  - the **24-hour rollback deadline**: snapshot restore plus a redeploy of the previous Railway
    deployment, and fix-forward after it
- [ ] The staging rehearsal of the full runbook passes all audits, then boots PR B's code against
  the rehearsed database and passes the smoke tests.
- [ ] `RELEASE.md` records the one-off exception for this window. Its smoke test and admin-bootstrap
  step are rewritten for Better Auth, which closes #33.
- [ ] After cutover, migrated users sign in with existing passwords through the layer, the released
  mobile build works without a store release, and no mass password reset happens.
- [ ] `codev/resources/arch-critical.md`, `arch.md` and `packages/auth/README` are updated to match
  (see the Constraints delta), and every stale statement is fixed everywhere it appears.
- [ ] Issues are filed for each item outside this project: the `users_legacy` drop, layer removal,
  the `apps/frontend` Better Auth client plus public `/api/auth/*`, and #49. #16 is closed with the
  documented Better Auth session behaviour.

## Constraints

### Decisions already taken (from issue #300, carried forward)

The issue has no section titled "Baked Decisions". Its "Decisions already taken (carry forward
unless the spec argues otherwise)" section is treated with the same weight. It is copied here
verbatim:

> - Single cutover with `apps/api` fully offline; no dual-run serving; 24h snapshot rollback.
> - All Better Auth tables in a dedicated `auth` Postgres schema, migrated before the window.
> - UUIDs preserved via `INSERT … SELECT`; FKs on `threads`, `preferences`, `feedback` repointed to `auth.users.id`; `tokens` dropped.
> - `apps/api` authenticates with the bearer plugin; `/v2/users/*` and the two password-reset routes stay as a compatibility layer over Better Auth with frozen response shapes.
> - Permanent bcrypt + scrypt dual verify; migrated users get `emailVerified = true`; system accounts get no credential row.
> - Admin via the admin plugin; `is_admin` and `session_version` dropped.
> - `revokeSessionsOnPasswordReset: true`; sessions 30 days, refreshed daily.
> - Rate limits: sign-in 5/60s, sign-up 3/60s, database storage, `enabled: true`.

This spec departs from none of them. Two of its decisions sit next to them and are flagged:

- **In-process hosting** is not on the list. The reference spec's Q5 chose `apps/auth`, and this
  spec departs from that.
- **The rate limits** stay exactly as decided. With no public Better Auth router in production,
  though, they bind production traffic only through the layer's limiter, which must match them.

### Ownership and review boundaries (from the issue)

- The security architect reviews; every PR is in the high-risk review tier.
- Hunks touching `turbo.json`, the lockfile, `.github/`, Dockerfiles, Railway config, or
  `apps/api/drizzle/` numbering and `DEPLOYED_THROUGH` need the main architect's review.
- Any change to the `apps/frontend` auth client is agreed with the app architect first. This spec's
  hosting decision means none is needed at cutover.
- Schema changes: `drizzle-kit generate`, review the SQL, apply by hand at deploy. Never `db:push`.

### Invariants that survive

- System accounts are resolved by `system_key`, never by email, and `@system.ansari.chat` stays reserved.
- Admin is never an email match.
- Never log a raw driver or database error; log only `{name, code}`.
- Auth config is read through validated config (`@ansari/auth` `getEnv()`), never through raw
  `process.env`.
- New env vars follow the four-way `turbo.json` `globalEnv` derivation.
- Atomic auth operations are tested against a real database, not mocks.
- The mobile contract is frozen.

### Release mechanics

- `main` is promoted only by fast-forward from `develop`.
- Normal migrations must be backward-compatible with the code serving traffic. The cutover
  migration is the one documented exception, applied with `apps/api` offline.

### Pinned dependency

- better-auth and `@better-auth/expo` stay pinned at **1.7.7**. Every behavioural claim here is
  cited against 1.7.7, and any upgrade re-verifies those claims first.

### `arch-critical.md` delta (applied at PR B)

| Current | After |
|---|---|
| Admin = `users.is_admin` | Admin = admin-plugin `role` on `auth.users`. `ADMIN_EMAILS` = reservation + boot assertion only |
| `session_version` = the "kill all sessions" primitive | Deleting a user's Better Auth session rows is the primitive. Reset, logout and admin actions use it |
| JWT config through `config` | Better Auth secret and URL through `@ansari/auth` `getEnv()` |
| Token rotation in `db.transaction` with `exec` | Retired with `tokens`. The cutover migration is one transaction |
| Users in `public.users` | All auth tables in the `auth` schema. `users_legacy` is unread |
| (new) | Client IP comes from `X-Real-IP` only. Never from `X-Forwarded-For` |
| (new) | No public Better Auth router in production. Its admin endpoints stay unreachable |

## Assumptions

- The production database has **no real identities** in the #59 scaffold tables in `public`, and
  may not have them at all. Dropping them with `IF EXISTS` loses nothing. The plan verifies this
  against production before the drop ships.
- A **staging environment** exists, or can be created, that can hold a clone of production data and
  run `apps/api` at PR B's revision. If it cannot, see C-3.
- The operator can take a database snapshot, or use PITR, and restore it within the 24-hour deadline.
- Railway's `X-Real-IP` behaviour as stated by staff holds on our domains. It is verified before the
  window, not assumed.
- better-auth 1.7.7's in-process `auth.api.*` calls and bearer plugin work inside the Next.js
  `apps/api` server runtime, in the same process as Drizzle on `pg`. The plan spikes this first.
- Released mobile builds send `Authorization: Bearer` on every authenticated call, and treat
  `access_token` and `refresh_token` as opaque strings. Nothing in the legacy client decodes the JWT.
  The plan verifies this by reading the legacy client source.

## Solution Approaches

The fixed decisions settle most of the space. Two dimensions are still open: **hosting** and
**PR shape**. Migration location follows from the FK constraint above.

### Approach 1: In-process Better Auth in `apps/api`, prepare then cutover in two PRs (recommended)

As described in Desired State.

- **Pros:**
  - Fewest moving parts in the irreversible window: no new service, no new domain, no client rewrite.
  - One public auth surface, and the admin plugin's impersonation and role endpoints are not exposed.
  - Additive work ships and is applied to production early, so the window holds only the
    irreversible step.
  - No release freeze on `develop`.
  - Rollback is symmetric for every client.
- **Cons:**
  - The compatibility layer becomes the **only** production auth surface for now, and its removal
    waits on a follow-up client migration.
  - The decided Better Auth rate limits bind production only through the layer's limiter.
  - Two PRs need authorization.
- **Risk:** medium. The cutover itself carries the risk, and rehearsal and the snapshot mitigate it.

### Approach 2: Reference shape, with `apps/auth` deployed as a service and `apps/frontend` on a Better Auth client at cutover

- **Pros:**
  - It is what the reference documents describe.
  - The Better Auth router's rate limiting and database storage apply directly to new clients.
  - The layer's removal trigger is meaningful from day one.
- **Cons:**
  - New Railway service, domain, Dockerfile and CORS work (main-architect hunks).
  - An `apps/frontend` client rewrite agreed with the app architect and shipped **inside** the window.
  - Two public auth surfaces.
  - Admin plugin endpoints are exposed unless they are separately locked down.
  - Rollback becomes client-asymmetric again: a new frontend build talks to an `apps/auth` that a
    snapshot restore leaves without users.
- **Risk:** high. Several independent deployments must land in one window.

### Approach 3: Approach 1 as a single PR merged at the window

- **Pros:** porch's default shape, and one review.
- **Cons:**
  - The additive `auth` migration cannot reach production before the window, contradicting
    "migrated before the window".
  - A very large, long-lived branch spans the rehearsal.
  - The review is harder to slice for the security architect.
- **Risk:** medium-high.

**Recommendation: Approach 1.** It meets every decided item. It moves all reversible work out of
the irreversible window. And it removes two deployments and a client rewrite from the critical path
of the failure mode that matters most, mass lockout.

## Open Questions

**Critical (blocks progress)**

- **C-1: Migration SQL location (Waleed).** This spec places the `auth` DDL and the cutover
  migration in the single `apps/api/drizzle/` journal, and retires `packages/auth/drizzle/`. The
  "ported framework" referenced in #60 is not in the repo. Is there such a framework, or a
  preference, that should override this? This needs Waleed's confirmation, and the main
  architect's review on numbering.
- **C-2: Two PRs.** May this project ship PR A (prepare) and PR B (cutover) instead of the porch
  default of one PR?
- **C-3: Staging.** Is there a Railway staging environment where a production clone can be restored
  and PR B's code run? If not, who provisions one? The rehearsal is a hard prerequisite for PR B.

**Important (shapes design)**

- **I-1: In-process hosting.** Does the architect accept the departure from reference Q5, which
  means no public `/api/auth/*` in production for now and `apps/frontend` staying on `/v2/users/*`?
- **I-2: Layer rate-limit storage.** The decided limits use database storage so the budget is not
  multiplied by the instance count. Must the layer's limiter also be shared across instances, for
  example by routing the layer's sign-in and sign-up through Better Auth's in-process handler so
  its database limiter applies? Or is the in-memory `lib/rate-limit.ts` acceptable, given how many
  `backend` replicas Railway runs today? The plan proposes a mechanism either way. The spec
  requires only the budgets and the IP source.
- **I-3: Layer removal trigger.** Re-scope the trigger to "90 days after cutover **and** the
  `apps/frontend` Better Auth client has shipped, or ≥ 95% of the released mobile builds are past
  `*_MINIMUM_BUILD_VERSION`"? Owner: Amr. This only affects the follow-up issue.
- **I-4: Cutover timing.** Who is the operator, and what is the window? This is needed for the
  runbook, not for PR A.

**Nice-to-know**

- **N-1:** Opportunistic rehash from bcrypt to scrypt on login is allowed, but not required. It is
  deferred unless the plan finds it cheap.
- **N-2:** Should `getClientIp` group IPv6 addresses to /64 like Better Auth does, so the two
  limiters agree on IPv6 clients?

## Test Scenarios

**Happy paths**

1. A legacy user (bcrypt hash, `first_name` and `last_name` set) is migrated, logs in through
   `/v2/users/login`, and gets a token. `GET /v2/users/me` with the bearer returns the frozen shape
   with the same `id`. Their threads list unchanged.
2. A new user registers through `/v2/users/register`. The password is stored as scrypt. They log
   out and log back in.
3. The legacy mobile flow: login, then a 401 on an expired session, then `refresh_token` returns
   401, then the client logs the user out. On a live session, `refresh_token` returns the same token.
4. An admin assigned by the role script reaches `v2/admin/stats`. A non-admin gets 403. An
   unauthenticated request gets 401.
5. Password reset: the request emails a legacy-shaped link. The reset succeeds with a strong
   password, and every prior session for the user is dead.

**Edge cases**

6. A user with null first and last names, and a user with an empty email local-part, get the
   derived `name` (local-part, or `'User'`). `first_name` and `last_name` copy as null, and
   `login`'s response matches today's handling of null names.
7. A password longer than 72 bytes on a bcrypt hash verifies exactly as it does today, truncated.
8. `DELETE /v2/users/me` with a session 25 hours old succeeds. The token is dead, and cascades
   remove threads, preferences and feedback.
9. The backfill re-run inserts zero `account` rows. The cutover migration run against a non-empty
   `auth.users` aborts with no changes.
10. A fresh empty database migrated through the full journal produces the post-cutover schema, and
    the parity test passes.
11. A timestamp at a DST boundary or carrying microseconds is identical after the copy.

**Error and security conditions**

12. Registering `x@system.ansari.chat`, or a taken email, returns the identical 409, on the layer
    and on Better Auth's sign-up path.
13. A system account cannot log in, has no `credential` row, and a reset request for it sends no
    email and creates no credential.
14. Six sign-ins from one `X-Real-IP` in 60 seconds: the sixth gets 429. Six sign-ins with six
    different forged `X-Forwarded-For` values and one `X-Real-IP`: the sixth still gets 429.
    Requests with distinct `X-Real-IP` values don't share a bucket.
15. A tampered bearer token (bad signature), an expired session, and a session revoked by logout
    elsewhere each get 401.
16. A user cannot read, rename, share or delete another user's thread through the bearer path.
17. `/api/v1/chat/completions` without the right `LEADERBOARD_API_KEY` gets 401, unchanged.
    `/api/v2/mcp-complete` keeps its IP limit, now keyed by `X-Real-IP`.
18. Removing the bcrypt branch, or `revokeSessionsOnPasswordReset`, makes a named test fail. The
    builder demonstrates this once and records it in the review.
19. A credentialed CORS preflight from a disallowed origin does not get an allow response.

**Non-functional**

20. Bearer session resolution costs one session-row read per request, the same cost class as
    today's `findToken` join. No added network hop.
21. Cutover migration runtime on the production-sized clone is measured in the rehearsal and fits
    the window.

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Mass lockout after cutover | Low | Critical | Dual verify with a removal-detecting test; legacy-row login test; full staging rehearsal; 24-hour snapshot rollback |
| Released mobile users stranded | Low | High | Contract tests written against today's implementation pass unchanged against the layer; unmodified-client run in staging |
| Rate limit collapses into one global login bucket | Medium without the fix | High | `X-Real-IP` only; multi-entry XFF test on both limiters; empirical edge verification |
| Railway changes `X-Real-IP` semantics later | Low | Medium | Documented header; re-verify on any Railway networking change; an arch-critical fact makes the dependency visible |
| Private-network caller forges `X-Real-IP` | Low (no such caller) | Medium | Documented in arch docs; revisit if a `*.railway.internal` caller is added |
| Cutover code merged early freezes releases | Medium under one PR | High | Two-PR split; PR A is production-safe by construction |
| FK repoint or `DROP tokens` fails mid-window | Low | High | One transaction with precondition guards; rehearsed on a clone |
| Admin boot assertion crash-loops | Low | High | Role script runs before the deploy; the assertion is checked in the rehearsal |
| System accounts become loginable or resettable | Low | High | Backfill `WHERE system_key IS NULL`; audit; reset refusal test |
| Logout semantics weaken (one session instead of all) | Medium if overlooked | Medium | Explicit criterion: layer `logout` revokes all sessions |
| Two migration journals drift (`packages/auth/drizzle` vs `apps/api/drizzle`) | Medium if both kept | High | Single journal; retire the scaffold journal |
| better-auth behaviour differs from the 1.7.7 citations | Low | High | Pin 1.7.7; tests pin each relied-on behaviour |
| In-process Better Auth misbehaves in Next.js | Low | Medium | Spike first in PR A, before building on it |
| Layer limiter's budget multiplied by instance count | Medium | Low–Medium | I-2: database-backed or handler-routed limiting if replicas exceed one |
| Layer never removed | Medium | Low | Follow-up issue with a dated trigger and owner |

## References

- Issue #300. Reference spec and plan:
  `codev/specs/60-better-auth-migration-reference.md`,
  `codev/plans/60-better-auth-migration-reference.md` (#60, PR #134, PR #148, #299).
- #59 review: `codev/reviews/59-build-better-auth-in-apps-auth.md`. Spec 4:
  `codev/specs/4-auth-hardening-admin-roles-in-.md`.
- Related issues: #16 (refresh reuse, closes), #33 (RELEASE smoke admin bootstrap), #49 (apps/auth
  extraction, left open), #265 (stale expo-router peer, out of scope), #266 (vacuous origin test).
- `RELEASE.md` (deployment model, migration runbook); `codev/resources/arch.md` (Authentication,
  Monorepo layout and deploy).
- Railway: Public Networking → Specs & Limits,
  https://docs.railway.com/networking/public-networking/specs-and-limits. Central Station staff
  answers on client-IP trust (2026-09-12, 2026-10-04, 2026-10-05).
- better-auth 1.7.7 sources: `@better-auth/core` `dist/utils/ip.mjs:174-218`; `better-auth`
  `dist/api/rate-limiter/index.mjs:236-248`; `dist/api/routes/password.mjs`;
  `dist/api/routes/update-user.mjs`; `dist/db/internal-adapter.mjs`.
- Better Auth docs: Database (UUIDs), Email & Password (custom hash/verify), Admin plugin, Bearer plugin.

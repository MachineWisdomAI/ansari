# Specification: Better Auth Migration

<!--
SPEC vs PLAN BOUNDARY:
This spec defines WHAT and WHY. The plan defines HOW and WHEN.
-->

> **Owner decisions, 2026-10-15** (at the spec-approval gate). Better Auth runs as its **own
> service, `apps/auth`**, and **never inside `apps/api`**. `apps/api` verifies **JWTs against
> `apps/auth`'s JWKS**, statelessly. The `/v2/users/*` compatibility layer stays on `apps/api` and
> **calls `apps/auth` over HTTP**. `apps/frontend` signs in **directly against `apps/auth`** from the
> cutover. The first decision follows reference spec Q5. The second overrides the issue's decided
> item "apps/api authenticates with the bearer plugin", and its revocation cost is stated in Desired
> State item 11.
>
> **Owner decisions, 2026-10-16.** Better Auth has **its own database from the start**. Only
> `apps/auth` can reach it. `apps/api` keeps the existing database, where `public.users` stays for
> referential integrity with its auth-only columns removed. See "Two databases from the start".
> Also: **one PR** (C-2), merged at the window; the JWT lifetime is **Better Auth's default, 15
> minutes**; `apps/api` uses **plain JWKS validation with no per-request session check** (I-7).
>
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

**Migration framework:** the reference plan defers the SQL to a "ported migration framework"
(attributed to Waleed). It **does not exist anywhere in the repo**, and the owner confirmed none is
needed: Waleed is not involved in auth, and the cutover is a plain `INSERT … SELECT` from the old
tables to the new ones while the system is in maintenance mode.

## Desired State

After the cutover:

1. **One auth model, one auth service.** Better Auth, running as the **`apps/auth` service**, is the
   only place that signs users in, signs them up, resets passwords or manages sessions. Better Auth
   sessions are the only session primitive. `tokens`, `session_version`, `is_admin` and the legacy
   HS256 JWT code no longer exist. `apps/api` contains **no sign-in, sign-up or session logic**, and
   does not import `better-auth`.
2. **Same users, same passwords, same ids.** Every legacy user exists in the auth database's
   `auth.users` under the same UUID and signs in with the existing password, through a permanent
   bcrypt + scrypt dual verify. `public.users` stays in the app database under the same ids, so
   threads, preferences and feedback and their foreign keys are untouched.
   **Guest accounts are migrated as-is (owner decision, 2026-10-15).** Guests are ordinary user
   rows with no flag: `guest_` followed by 10 alphanumeric characters, at `askansari.ai` (legacy
   app) or `ansari.chat` (`apps/frontend`), named "Welcome Guest". They are deliberately **not
   filtered**, so their threads, feedback and preferences stay attached.
   Cleaning them up is a follow-up.
3. **Two databases.** All Better Auth tables live in the `auth` schema of a **separate auth
   database** that only `apps/auth` can reach: `auth.users`, `auth.session`, `auth.account`,
   `auth.verification`, `auth.rate_limit` and `auth.jwks`. The app database keeps `public.users`
   without `password_hash`, `is_admin` or `session_version`, and `apps/api` reaches only the app
   database.
4. **`apps/api` authenticates by verifying a JWT.**
   - Each request carries `Authorization: Bearer <JWT>`, issued by `apps/auth` through Better
     Auth's JWT plugin.
   - `apps/api` verifies it **statelessly** against the public keys `apps/auth` publishes at its JWKS
     endpoint: signature, `alg`, `iss`, `aud` and `exp`. There is no shared secret and no per-request
     session lookup. Keys are cached, and an unknown `kid` causes a re-fetch.
   - The user's identity is the `sub` claim, which is the user's UUID.
   - `/api/v1/chat/completions` keeps its `LEADERBOARD_API_KEY` check, and `/api/v2/mcp-complete`
     stays public. There is no global `middleware.ts`.
5. **Two token kinds.** The JWT is a short-lived **access token**. The Better Auth **session token**
   is the long-lived credential: it can be exchanged at `apps/auth`'s `GET /api/auth/token` for a
   fresh JWT, and it is what logout and reset revoke. This maps directly onto the legacy pair.
6. **The `/v2/users/*` compatibility layer** and the two password-reset routes stay **on `apps/api`**
   at their current URLs.
   - Each route **calls `apps/auth` over HTTP** and translates the result into the legacy JSON.
     `login` and `register` return `access_token` = JWT and `refresh_token` = session token.
     `refresh_token` exchanges the session token for a new JWT.
   - Responses are **wire-contract-compatible** with today's: same status codes, field names, field
     presence and types. Dynamic values such as tokens and timestamps naturally differ.
   - The released mobile build and the admin analytics page keep working, and their users sign in
     once more.
7. **`apps/frontend` signs in directly against `apps/auth`** with a Better Auth client from the
   cutover, and sends the JWT to `apps/api`. This change is agreed with the app architect first.
8. **Admins are identified by the admin plugin's `role`** in the auth database, assigned by
   `grant-admin.ts`, which moves to `apps/auth/scripts/` (same name, one script) and runs as the
   auth database's migrator. Admin is never an email match. `ADMIN_EMAILS` moves to `apps/auth` and
   keeps only its reservation role and the boot assertion, rewritten against `role`. **Admin routes
   on `apps/api` ask `apps/auth` for the role on each request** rather than trusting a claim, so a
   demotion takes effect immediately, and they fail closed when `apps/auth` is unreachable.
9. **System accounts are identified by `system_key`** on `public.users`, and exist **only in the app
   database**. They have no auth-database row and no credential, so they cannot sign in or reset a
   password. `getOrCreateSystemUser` (`apps/api/lib/db/users.ts:54`) keeps provisioning them lazily,
   as today, because `apps/api` writes its own database.
10. **Rate limits are configured as decided:** sign-in 5/60s, sign-up 3/60s, database storage,
    `enabled: true`.
    - They are enforced by `apps/auth`'s Better Auth router, and are keyed by the **real client
      IP**, which comes from `X-Real-IP` (see Client IP below).
    - Calls from the compatibility layer reach that same router, so one database-backed limiter
      covers both paths. The client IP is forwarded over an authenticated hop.
11. **Revocation is bounded by the JWT lifetime. This is the accepted cost of the owner's JWT
    decision.**
    - Today, a revoked session is rejected on its very next request, because every request checks
      `session_version`.
    - After cutover, password reset (`revokeSessionsOnPasswordReset: true`), logout (all of the
      user's sessions, as today), a ban, and account deletion each kill the **session token** at
      once, so no new JWT can be minted from it.
    - A JWT already issued stays valid at `apps/api` **until it expires**. The access-token lifetime
      therefore *is* the revocation window: Better Auth's default of **15 minutes** (owner,
      2026-10-16; `sign.mjs:81`). There is **no per-request session check** (owner, on the security
      architect's recommendation), because with two databases it would be an HTTP call on every
      request and a hard dependency of all of `apps/api` on `apps/auth`.
    - Two kinds of request close that window: admin authorization, which asks `apps/auth` (item 8),
      and any request whose `sub` has no `public.users` row or is tombstoned (deletion).
12. **Sessions** last 30 days and are refreshed daily (`expiresIn` 30d, `updateAge` 1d), as the
    issue decided and the owner confirmed on 2026-10-16. Better Auth 1.7.7's own defaults are 7 days (`internal-adapter.mjs:23`) and 1 day
    (`create-context.mjs:147`). The session is what keeps a user signed in: the client exchanges it
    for a fresh JWT whenever the JWT expires, and each exchange after `updateAge` slides the
    session's expiry forward. A user is asked to sign in again only after 30 days without using the
    app, or after a logout, password reset, ban or deletion.
13. **Production releases are never blocked.** Nothing from this project merges before the window
    (one PR), so every other change keeps promoting normally. `apps/auth` is **not deployed to
    production before the window**.

### Client IP for rate limiting (resolves an issue "must be resolved" item)

**Decision: read the client IP from `X-Real-IP` alone.** Better Auth gets
`advanced.ipAddress.ipAddressHeaders: ['x-real-ip']` with `trustedProxies` unset. The
apps/api's `lib/rate-limit.ts` `getClientIp` resolves the IP the same way, from `X-Real-IP` only
and never from `X-Forwarded-For`. The layer forwards that value to `apps/auth` over the
authenticated hop described below.

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
statement, staff answers on the forum conflict, and Help Station threads report `X-Real-IP`
sometimes carrying **Railway infrastructure IPs** instead of the client's. So the header **must be
verified empirically on a deployed service before the PR merges** (staging, deployed from the
branch), not left until the window. The check passes only if it proves both properties:

1. **Overwrite.** Forged `X-Real-IP` and `X-Forwarded-For` values sent through each public domain
   (both production domains and the `*.up.railway.app` domain), over IPv4 and over IPv6 where
   reachable, never come back as the observed `X-Real-IP`.
2. **Distinctness.** Two clients on different networks (for example a home connection and a mobile
   hotspot, or two cloud hosts in different regions) observe two different `X-Real-IP` values, each
   equal to that client's own public address, across repeated requests. A value that is the same
   for both clients, or that falls in a non-public range, fails the check.

The method, raw observations and verdict are recorded in the plan and the review. Until the check
passes, the PR does not merge.

**Fallback if the check fails** (either property). Per-IP limiting is then not trustworthy: it is
either spoofable or collapses into a shared bucket. The fallback changes how the layer keys and
counts its sign-in limit.

- **Sign-in is keyed by the normalized target email, and only failed attempts count.**
  - Five failed sign-ins for one email within 60 seconds lock that email for the rest of the
    window. While the lock lasts, every sign-in for it is rejected with 429, including one with the
    correct password.
  - A successful sign-in never consumes budget, so legitimate users do not burn their own allowance.
  - A sign-in that fails while locked does not extend the lock.
- **Sign-up** keeps a per-email limit (3/60s) plus a **global ceiling** sized from current
  production sign-up volume. A misattributed IP can therefore never become a global cap.
- **Per-IP limiting** remains only as an *additional* key where the IP is trustworthy, and never as
  the only key.
- **Alert on list-walking.** When per-email limit hits span many distinct emails in a short period
  (the threshold is set in the plan from production baselines), an alert fires through the existing
  Sentry path. It logs counts and hashed or truncated identifiers only, never raw emails. This is
  the signature of an attacker walking an email list, which nothing else caps once per-IP is
  untrusted.
- **Accepted residual risk, stated explicitly:** anyone who knows a user's email can lock that user
  out of sign-in.
  - Bound: one 60-second window per burst of five failures. A sustained lockout needs a sustained
    five failures per minute against that email, and the list-walk alert surfaces it.
  - Existing sessions are unaffected. Password reset stays available, under its own limit.
- The fallback is implemented in `apps/auth`. Every sign-in, direct or through the layer, passes
  through it. The IP finding is written into `arch.md`.
- The security architect is told before the PR proceeds, and the fallback is the configuration the
  PR ships with.

**The layer-to-`apps/auth` hop carries the client IP, so that hop must be authenticated.** When a
`/v2/users/*` route calls `apps/auth`, the TCP peer is `apps/api`, not the user. If the route went
over the public domain, the edge would stamp `apps/api`'s egress IP as `X-Real-IP`, and every
legacy-client login would share one bucket, which is exactly the global login cap this section
exists to prevent. If it went over Railway's private network (`*.railway.internal`), it would skip
the edge, and any service in the environment could claim any IP. Requirements:

- `apps/api` forwards the end user's `X-Real-IP`, as it received it from the edge, in a dedicated
  header, together with a **shared internal credential** (a secret only `apps/api` and `apps/auth`
  hold, validated through `getEnv()`).
- `apps/auth` uses the forwarded IP **only** when the credential verifies, in constant time. On
  every other request it strips any such header, and Better Auth reads the edge's `X-Real-IP` as
  usual.
- The credential also identifies the internal-only endpoints (profile, role, delete; see "Two
  databases" rule 8). No other caller can reach those, and delete also requires the subject's own
  JWT.
- A test proves that a forged forwarded-IP header without the credential is ignored, and that two
  legacy clients behind the layer land in different buckets.

**Residual risk, accepted and documented:** whoever holds the internal credential can choose the
rate-limit key and read any user's profile and role by id. It cannot delete an account without that
user's JWT. It lives only in the two services' environments, and it is rotated with them.

### Hosting and token model (owner decisions, 2026-10-15)

**Hosting: `apps/auth` is its own production service.** This follows reference spec Q5. It also
fixes the gap this spec found: `apps/auth` has no Dockerfile and no Railway service today. So this
project adds:

- A Dockerfile and a Railway service for `apps/auth`. Both are main-architect hunks.
- **Its own public domain** (owner, I-5): **`auth.askansari.ai`** in production and
  **`auth-staging.askansari.ai`** in staging. Each environment's JWT `iss` is that origin, and the
  edge check covers both domains.
- Production config through `@ansari/auth` `getEnv()`, with any new variables added to `turbo.json`
  `globalEnv` by the four-way rule.

**Not in production before the window.** With one PR, `apps/auth`'s code, Dockerfile and service
reach production only when the PR merges, at the window. Its auth database is created empty ahead
of time, and nothing reads it. In the window, `apps/auth` is deployed after the copy and its
audits, and its **public domain is attached last**, after the smoke tests on the private network. A
reachable `apps/auth` before the copy would accept sign-ups into `auth.users`, which the copy's
emptiness guard would then refuse. The edge check and the rehearsal use staging deployments from
the branch.

**Token model: JWT via JWKS** (Better Auth's `jwt` plugin on `apps/auth`), alongside `bearer()` so
native and web clients can carry the session token without third-party cookies. Verified on the
installed 1.7.7:

- `GET /api/auth/token` exchanges a live session for a JWT (`dist/plugins/jwt/index.mjs:141`).
  Calling `get-session` also returns one, in the `set-auth-jwt` header (`:194-207`).
- The JWKS is served at `/api/auth/jwks` (`:26,45`). Keys live in the `jwks` table, in the auth
  database's baseline migration. Private keys are encrypted at rest with the secret.
- Defaults are EdDSA (Ed25519, `sign.mjs:32`) and a lifetime of `15m` (`sign.mjs:81`). `iss` and
  `aud` default to the base URL origin (`:86-88`), and this project sets both explicitly.
- **By default the payload is the whole user object** (`sign.mjs:119`), which would put email,
  names and `system_key` into every token. `definePayload` restricts it to what `apps/api` needs:
  `sub`, plus the session id. `role` is asked of `apps/auth` on admin requests (Desired State
  item 8).

`apps/api` verifies tokens with a standard JOSE library against the cached JWKS. It pins `alg` to
the configured algorithm, rejects `none` and every other algorithm, and requires `iss`, `aud` and
`exp`. When `apps/auth` is down, tokens already issued still verify from the cache, so existing
users keep working until their JWT expires. Sign-in and refresh do need `apps/auth`.

**The whole admin HTTP surface on `apps/auth` is disabled** (security review, 2026-10-15).

- **Why.** With `apps/auth` public, the admin plugin would expose impersonation and 13 more
  endpoints behind a single admin session:
  - set-user-password, set-role, create-user, remove-user, update-user
  - ban-user, unban-user
  - list-users, get-user, list-user-sessions
  - revoke-user-session(s), has-permission

  A stolen admin token, or XSS on the frontend, would then mean takeover of any account. Nothing
  needs these endpoints, because roles come from the role script. `change-email` and `update-user`
  are blocked the same way, so the profile copy in the app database cannot drift.
- **The plugin stays.** It is kept only for its `role` column (and the related columns).
- **`disabledPaths` alone is not enough.** It matches only the exact normalized path
  (`dist/api/index.mjs:166-168`). So `apps/auth` also blocks the admin prefix case-insensitively in
  an Express middleware placed **before** `toNodeHandler`, and it covers trailing-slash and
  percent-encoded variants.
- **Re-enabling.** The owner can re-enable specific endpoints later, by explicit decision.

**`trustedOrigins` matters again.** `apps/frontend` on the web now talks to `apps/auth` directly.
Its web origin is allowlisted, `trustedOrigins` is still not treated as a boundary for custom
schemes (re-verified on 1.7.7), and #266's vacuous origin test is fixed so that it fails on a
wrong origin.

**Departures and their costs, recorded:**

| Decision | Departs from | Cost accepted by the owner |
|---|---|---|
| JWT via JWKS in `apps/api` | Issue decided item "apps/api authenticates with the bearer plugin"; reference plan "How apps/api authenticates" | Revocation lags by up to the JWT lifetime (Desired State item 11). Key management (`auth.jwks`, rotation). An extra token exchange on every refresh |
| Layer calls `apps/auth` over HTTP | Reference plan's in-process `auth.api.*` calls | An authenticated internal hop that carries the client IP. A network dependency on `apps/auth` for every legacy sign-in |
| `apps/frontend` on `apps/auth` at cutover | (none; matches the reference) | An app-architect-agreed client change ships inside the window (I-6) |
| Separate auth database from the start (2026-10-16) | Issue decided item "FKs on `threads`, `preferences`, `feedback` repointed to `auth.users.id`"; the reference's single database | A second Railway Postgres with its own backups; a cross-database copy that is ordered and gated, not atomic; app rows created on first use; deletion through a tombstone; admin role over HTTP |

`apps/auth` is now the extraction that #49 describes, so #49 can be closed by this project once the
cutover lands.

### Two databases from the start (owner decision, 2026-10-16)

**Decision.** Better Auth gets **its own Postgres database** (the **auth database**), a new Railway
Postgres service. **Only `apps/auth` holds its credential.** `apps/api` keeps the **existing
database** (the **app database**) and has **no access to the auth database**. This supersedes the
earlier "one database now, split later" design (388371b to 70ddc4e): there is no later split.

**What stays in the app database.** `public.users` stays, under the same UUIDs, so `threads`,
`preferences` and `feedback` keep their foreign keys and `ON DELETE CASCADE` **unchanged**. The
cutover removes only what is auth-specific:

- the columns `password_hash`, `is_admin` and `session_version`
- the `tokens` table

What remains is `id`, `email`, `first_name`, `last_name`, `source`, `registered_via`, `system_key`,
`created_at` and `updated_at`.

**What lives in the auth database.** All Better Auth tables, in an `auth` schema (this keeps the
issue's dedicated-schema decision): `auth.users`, `auth.session`, `auth.account`,
`auth.verification`, `auth.rate_limit` and `auth.jwks`. `auth.users` carries `first_name`,
`last_name` and `registered_via` as additional fields, plus the admin plugin's columns. It carries
**no `system_key` and no `source`**, because system accounts are app-only identities (rule 7).

**How the two databases stay linked.**

1. **One id.** A user's id is the same UUID in both databases. `apps/auth` generates it
   (`generateId: "uuid"`), and the JWT's `sub` carries it.
2. **Creating the app row.**
   - **Through the layer** (`/v2/users/register`): after `apps/auth` creates the user, the layer
     inserts the `public.users` row with the same id, email, names and `registered_via`.
   - **Directly at `apps/auth`** (`apps/frontend`): on the first `apps/api` request whose verified
     `sub` has no `public.users` row, `apps/api` fetches the user's profile from an internal-only
     `apps/auth` endpoint (internal credential) and inserts the row with
     `ON CONFLICT (id) DO NOTHING`. If `apps/auth` answers that the user does not exist, the request
     gets 401.
   - The same path repairs a layer registration whose insert failed.
   - **An email held under another id.** `ON CONFLICT (id)` does not cover `users_email_unique`
     (`apps/api/drizzle/0000_baseline.sql:10`). If another `public.users` row already holds the
     email (an uncopied legacy row, a system row, a leftover from a resolved collision), the
     request gets **401**, no row is written, and there is **no 500**. The pair of ids is logged,
     by id only, and an alert fires through the existing Sentry path.
   - **Defence in depth behind `apps/auth`'s sign-up hook:** this path also refuses any email on a
     reserved domain (`@system.ansari.chat`) and any email held by a `system_key` row, with the
     same 401, log and alert.
3. **Existence on each request.** `apps/api` reads `public.users` by `sub` in its own database, as
   it reads the user row today. A missing row that `apps/auth` does not know, or a tombstoned id
   (rule 5), gets 401.
4. **The profile copy cannot drift.** Email and names are copied once, when the app row is created.
   Better Auth's `change-email` and `update-user` endpoints are **blocked** on `apps/auth`, in the
   same way as the admin surface. Nothing uses them today, and the legacy API has no such route.
   Enabling them later needs a sync design, which is a follow-up.
5. **Deletion** (`DELETE /v2/users/me`) runs in this order:
   1. `apps/api` verifies the JWT, and refuses a **system account** before touching anything.
   2. In one app-database transaction, it deletes the `public.users` row (cascading threads,
      preferences and feedback) and writes a **tombstone** (`public.deleted_users`: `id`,
      `deleted_at`, `auth_deleted_at` null). The tombstone holds the id only, no personal data.
   3. It calls `apps/auth`'s internal delete endpoint, which removes the sessions and the auth user.
      "Not found" counts as done, so the call is idempotent. Then it sets `auth_deleted_at`.

   **The delete endpoint is bound to the subject.** It requires the internal credential **and** the
   user's own JWT. `apps/auth` verifies that JWT against its own JWKS and refuses the call when the
   JWT's `sub` differs from the target id. The internal secret alone can therefore delete no
   account.

   The profile path in rule 2 **never re-creates a tombstoned id**. If step 3 fails, any later
   request carrying that `sub` (and so that user's JWT), or the user's retry of `DELETE me`,
   retries step 3 before answering 401. The operator's completion script lists pending tombstones
   and deletes those auth users **directly as the auth database's migrator**; it never uses the
   endpoint. A failure therefore leaves an account that `apps/api` refuses, and never app data
   without a user.
6. **Admin role.** `role` lives only in the auth database. On **each admin request**, `apps/api`
   asks an internal-only `apps/auth` endpoint for the user's role, so a demotion still takes effect
   immediately. If `apps/auth` is unreachable, the admin route **fails closed** (503) and never
   grants access. The only admin route is `admin/stats`, so the traffic is small.
   - `ADMIN_EMAILS` (the reservation and the boot assertion) moves to `apps/auth`.
   - `grant-admin.ts` moves to `apps/auth/scripts/`, keeps its name, sets `auth.users.role`, and
     runs as the auth database's migrator.
7. **System accounts stay app-only.** `ai-skill` and `leaderboard` are `public.users` rows with
   `system_key`. They have no auth-database row and no credential, so they cannot sign in or reset
   a password. `getOrCreateSystemUser` keeps working as today, including its guard against a
   non-system row holding the address, because `apps/api` writes its own database.
   `@system.ansari.chat` stays reserved in `apps/auth`'s sign-up hooks and on the layer.
8. **No query crosses databases.** `apps/api` holds no auth-database credential, and `apps/auth`
   holds no app-database credential. Every cross-service fact goes over the internal credential,
   through three internal-only `apps/auth` endpoints (profile, role, delete). A source scan pins
   that neither service's runtime code names the other database's connection.

   **The internal endpoints are high-value.** The profile endpoint returns any user's personal data
   by id, so the internal credential's impact is High. Requirements:
   - the credential is compared in constant time
   - the internal routes are mounted **outside** Better Auth's handler path
   - they are rate-limited
   - delete is bound to the subject's JWT (rule 5)
   - `apps/api` reaches profile, role and delete through `AUTH_INTERNAL_URL` over **Railway's private
     network**, never the public domain. The layer's sign-in hop, which forwards the client IP,
     stays as specified under Client IP.
9. **No per-request session check** (owner, I-7). `apps/api` validates the JWT against the JWKS
   only. A check would be an HTTP call to `apps/auth` on every request and a hard dependency of all
   of `apps/api` on `apps/auth`.

**Database principals** (security review of 388371b, carried over per database). Each database has
a **migrator** (its owner) and **one runtime role**:

- **App database.** The existing owner becomes the migrator and is **not** re-owned
  (`ALTER … OWNER` on production tables is avoidable risk; the owner confirms ownership with
  `\dt public.*` and `\du`). The `apps/api` runtime role gets DML on `public` and no DDL. Today's
  `apps/api` `DATABASE_URL` **is** the migrator credential, so there is a **re-point step**. It is
  **operations-only and runs ahead of the window** (security review of 52cff7a): it has no code
  dependency, because `apps/api` already works under any DML-capable role (it runs no DDL or
  `migrate()` at runtime, and its lazy pool from bugfix-260 is on `develop`, `aa20376`). Order: the
  app database's provisioning SQL (reviewed in the PR, High tier) is applied as the migrator, then
  `apps/api` moves to the runtime role, on staging first with a soak and then on production with its
  own soak. The step ends with the migrator URL **in no service environment** and the migrator
  password **rotated**. Rollback is restoring the old URL in Railway. The PR's runtime-role boot
  check simply starts passing on a database that is already re-pointed.
- **Auth database.** It is new, and its default user is the migrator. The `apps/auth` runtime role
  gets DML on `auth.*` and no DDL. `apps/auth` never receives the migrator URL.
- **Provisioning, not migrations.** Roles and grants live in reviewed provisioning SQL outside both
  journals, under the operator scripts. It sets `ALTER DEFAULT PRIVILEGES FOR ROLE <migrator>` on
  tables and sequences, in `public` for the app database and in `auth` for the auth database, so a
  later migration's table is usable without a new `GRANT` (otherwise it fails with `42501`, which
  is the #165 outage class). The deploy order is written into `RELEASE.md`: **roles SQL → migration →
  grants → boot**. Every `psql` apply uses the operator-held migrator URL of that database. **No
  runtime code path falls back to a migrator URL.**
- **Proof.**
  - A pglite test per database, under `SET ROLE`, shows: runtime-role DDL is denied with `42501`;
    a table the migrator creates after provisioning is usable by the runtime role; and the same
    case fails with `42501` when the default privileges are omitted. pglite 0.5.4 supports this
    (probe, 2026-10-16). If that stops holding, the test moves to a CI Postgres service and is never
    skipped.
  - A loud **boot check in each service, on staging and production**, under the same gate as the
    admin startup check (`NODE_ENV=production`, Node runtime, not `next build`; `apps/api/Dockerfile:40`
    sets it, the new `apps/auth` Dockerfile sets it, and the plan confirms that staging's Railway
    variables do not override it). The runtime role must **not** have `CREATE` on its schema
    (`has_schema_privilege`). If it does, boot fails with a message naming the grant.
  - **Local dev and CI** keep one owner URL per database, and contributors never create roles.
    `CONTRIBUTING.md` says so. There, the pglite test is the proof.
- Column-level grants, the cross-schema cascade test and the no-join scan of the earlier design
  are no longer needed, because nothing references across databases.

### Migration SQL location (resolves an issue "must be resolved" item)

**Decision: two journals, one per database.** No foreign key crosses databases, so the two journals
need no ordering between them. The main architect's seven conditions (issue #300, 2026-10-14 03:40Z)
were written for a single journal and **need re-review** (C-1). Conditions 1 to 4 and 7 carry over
to the app journal with the new content below. Condition 5 (`apps/api`'s config sees the `auth`
schema) is dropped. Condition 6 (retire the `packages/auth` journal) is reversed.

**Auth database journal: `packages/auth/drizzle/`.** It is kept, not retired. Its
`drizzle.config.ts` is already scoped to Better Auth's schema and cannot emit DDL against
`apps/api`'s tables.

- Its baseline is regenerated for the new shape: the `auth` schema, UUID ids, `jwks`,
  `rate_limit`, the additional fields and the admin columns. No auth database exists yet, so no
  environment has recorded the old `0000_better_auth_init.sql` against it.
- **A drift guard covers it.** An auth-journal parity test, like
  `migration-schema-parity.test.ts`, with its own deployed-through marker, so the auth journal is
  never outside every check (the #165 outage class). The main architect owns the marker.
- It is applied in the window, first, to the empty auth database. With one PR, nothing of this
  project is applied to production before the window.

**App database journal: `apps/api/drizzle/`.**

- **Scaffold cleanup.** If the #59 scaffold tables (`public.user`, `session`, `account`,
  `verification`) were ever applied to the app database (a `psql \dt` question for the owner), a
  migration drops them with `IF EXISTS`, behind an **in-migration guard that aborts if any of them
  holds a row**.
- **Tombstones (additive).** `public.deleted_users`.
- **Cutover (applied in the offline window).** In one transaction, with guards:
  - normalize `email` to `lower(trim(email))`, aborting on any collision (the same guard as the
    copy below)
  - drop `password_hash`, `is_admin` and `session_version`
  - drop `tokens`

  It is **not** backward-compatible, so it is the one named exception to `RELEASE.md`'s rule. A
  **schema freeze** runs from the PR's merge to the end of the window, and **the owner** bumps
  `DEPLOYED_THROUGH`.
- **Numbering rule** (main architect's option (a)), unchanged: merge `develop`, run `drizzle-kit
  generate`, rename the `.sql` file and its journal tag by hand to the next real number, leave the
  snapshot named by index, and re-check after every `develop` merge. The dry run of 2026-10-14
  showed generate emitting `0008_*`, which collides with `0008_model_provenance.sql`.
- **pglite DDL.** More than twenty test files hand-write `users` or `tokens` DDL. The PR updates the
  ones that touch the dropped columns and `tokens`, coordinated with #292.

**The cutover data copy** (owner: "a plain SQL query selecting from the old database into the new
one, while the system is in maintenance mode"). The operator runs it, holding both migrator URLs.
Neither URL is stored in either database.

1. **Export from the app database into the auth database.** `\copy (SELECT id, lower(trim(email)),
   first_name, last_name, password_hash, registered_via, created_at, updated_at FROM public.users
   WHERE system_key IS NULL) TO STDOUT`, piped into a `\copy … FROM STDIN` on an import table in the
   auth database. The **pipe never touches a file**. The import table is a temporary table created
   **in the same auth-database session** as step 2, so it is dropped on every failure path and a
   failed step 2 never leaves bcrypt hashes in a stray table.
2. **One auth-database transaction**, with guards that abort unless `auth.users` and `auth.account`
   are empty, the import is non-empty, and no two rows collide on the normalized email. Then:
   - `INSERT … SELECT` into `auth.users`: same `id`, derived `name`, `email_verified = true`. This
     is a **deliberate grant**: the legacy system never verified emails, and the issue decided to
     treat migrated users as verified. **No copied user is sent a verification email**, at the copy
     or later.
   - one `credential` account per row, with the bcrypt hash
   - drop the import table
3. **Cross-database audits** before step 4. The operator's script computes, on each side, over
   non-system users, and the two sides must match:
   - the row count
   - an ordered id checksum
   - a **hash checksum**: `md5(string_agg(password_hash, '' ORDER BY id))` on `public.users`,
     against the same over the `credential` rows' password column in `auth.account`, ordered by
     `user_id`. A corrupted or truncated copy is caught before the app migration.
4. **Apply the app-database cutover migration.**

The copy is **not atomic across the two databases**, so ordering and gates replace atomicity. A
failure in step 2 changes nothing. A failure in step 4 rolls back its own transaction and is
retried, with `apps/auth` not yet deployed. Rolling back within 24 hours means restoring the app
database's pre-window snapshot, returning the auth database to its pre-window state (empty), and
redeploying the previous services. That snapshot is the only post-window copy of the legacy
password hashes, and nothing is restored from it after the deadline.

**Rejected:** `dblink` or `postgres_fdw`. Both store a cross-database credential inside a database,
and both need an extension.

**Every "idempotency helper"** the reference plan expected is replaced by these properties: each
step runs in one transaction, the guards refuse a non-empty target, and a re-run of the `account`
backfill inserts nothing, because of the unique `(user_id, provider_id)`.

**Environment per service** (names approved by the main architect on #300; the auth database is new):

| Principal | Database credential | Other variables |
|---|---|---|
| app migrator | operator-held URL of the app database's owner, used for `psql` applies, provisioning and audits; **never in any service's environment** | none |
| auth migrator | operator-held URL of the auth database's owner, used for its journal, provisioning, `grant-admin.ts` and audits; **never in any service's environment** | none |
| `apps/auth` | `DATABASE_URL` = **auth database**, runtime role | `AUTH_INTERNAL_SECRET`, `AUTH_JWT_ISSUER`, `AUTH_JWT_AUDIENCE`, `ADMIN_EMAILS` (moved), plus the existing `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `CORS_ORIGIN` |
| `apps/api` | `DATABASE_URL` = **app database**, re-pointed to the runtime role | `AUTH_INTERNAL_URL`, `AUTH_JWT_ISSUER`, `AUTH_JWT_AUDIENCE`, `AUTH_INTERNAL_SECRET`. The PR removes `JWT_SECRET`, `ACCESS_TOKEN_EXPIRY_HOURS`, `REFRESH_TOKEN_EXPIRY_HOURS` and `ADMIN_EMAILS` |

`DATABASE_URL` keeps one name, with a different database per Railway service, so `turbo.json`
gains no database variable. The four `AUTH_*` names go into `globalEnv`, and the three `JWT_*`
names leave it in the PR. `AUTH_INTERNAL_SECRET` is a secret: it has a Zod minimum length, is never
logged, and uses the placeholder-not-a-real-* convention in `.env.ci`. Local development uses two
databases on one local Postgres, both with owner URLs.

**Reviewers.** The main architect reviews both journals, their numbering and markers, the new
Railway Postgres service, the provisioning SQL (High tier), the lockfile, `turbo.json` and CI. The
security architect reviews everything. The migration and copy SQL are High tier.

### Phasing (resolves an issue "must be resolved" item; owner decision, 2026-10-16: one PR)

**One PR**, merged to `develop` and promoted to `main` **in the window**. It is the porch default.
Nothing from this project reaches production before the window, so no other release is ever
blocked by half-shipped cutover code.

| Stage | Reference phases | What happens |
|---|---|---|
| **Build, on the branch** | 0 to 2 (code) | All of it: the `apps/auth` config (UUIDs, `auth` schema, dual verify, `bearer()`, `jwt()`, `admin()` kept for its columns with its whole HTTP surface blocked, `change-email` and `update-user` blocked, rate limiting and client IP, the internal hop and endpoints), its Dockerfile and service; the `packages/auth` baseline; the app migrations (scaffold cleanup, `public.deleted_users`, the cutover); the provisioning SQL; the copy script and audits; the `apps/api` JWKS verification, app-row creation, tombstoned deletion, role calls and compatibility layer; the CORS fix; contract tests written first against today's implementation; the pglite DDL update; removal of the legacy JWT code, `tokens`, `session_version`, `is_admin`, `password_hash`, the `JWT_*` config (and their `globalEnv` names), with `grant-admin.ts` and `ADMIN_EMAILS` moving to `apps/auth`; the `apps/frontend` switch to `apps/auth` (agreed with the app architect); `RELEASE.md` and `CONTRIBUTING.md` |
| **Before the window: no production code changes** | 2 | Staging deployments from the branch: the empirical edge check and the **rehearsal** on a clone of the production app database plus a fresh auth database. **Operations-only:** the app database's provisioning SQL and the `apps/api` **re-point**, staging then production, each with a soak, ending with the migrator URL in no service environment and its password rotated. The empty production auth database is created on Railway (C-4). The branch is kept current with `develop`, with the numbering re-checked after every merge, and the rehearsal is re-run after the last rebase |
| **The window** | 3, plus 4's code removal | Merge and promote, with `apps/api` offline: snapshots, the auth database's baseline and provisioning, the copy and its audits, the app cutover migration, admin roles, deploy `apps/auth`, `apps/api` and `apps/frontend`, smoke tests, then `apps/auth`'s public domain |
| Out of this project (follow-up issues) | 4 triggers, 5 | Remove the layer (its trigger). A profile sync design before `change-email` or `update-user` is enabled |

**Why not a feature flag.** The cutover migration cannot sit in the journal on `develop` ahead of
the window:

- Everything in the `apps/api` journal on `develop` is, by `RELEASE.md` practice and the
  `DEPLOYED_THROUGH` assertion, applied to production before the next promote. The cutover
  migration drops `password_hash`, `is_admin`, `session_version` and `tokens`, which breaks the
  legacy code still serving.
- The Drizzle schema in `apps/api` either has the legacy auth columns or does not.

So the migration and the code that depends on it land together, at the window. The PR also removes
the legacy JWT code, which the reference plan defers to Phase 4. Rollback is a snapshot restore
plus a redeploy of the previous Railway deployments, never a code toggle.

**Costs of one PR, accepted by the owner.**

- A long-lived branch must be kept current with `develop`. The numbering rule's re-check after
  every merge applies, and the rehearsal is re-run after the last rebase.
- The issue's "migrated before the window" for the `auth` tables no longer holds. The auth database
  is created empty beforehand, and its tables are created in the window's first step, which is
  quick on an empty database.
- `develop` must be releasable at the window, because promotion fast-forwards `main` to a `develop`
  tip that includes everything merged before this PR.

The **verify** phase of this project is the cutover itself: smoke tests, the 24-hour watch, and the
rollback deadline passing.

## Success Criteria

**Schema and data**

- [ ] All Better Auth tables, `auth.jwks` included, are on `pgSchema('auth')` **in the auth
  database**. `user` maps to `auth.users` through `modelName`. Ids are UUIDs (`generateId: "uuid"`),
  and a UUID written by the Drizzle adapter reads back unchanged in a UUID column, proven by a test
  against a real database (pglite or Postgres).
- [ ] `auth.users` carries the additional fields `first_name`, `last_name` and `registered_via`
  (`registered_via` is `input: false`), plus the admin plugin columns (`role`, `banned`,
  `ban_reason`, `ban_expires`). `auth.session` carries `impersonated_by`. There is no `system_key`
  or `source` in the auth database. Column names are confirmed from the reviewed `drizzle-kit
  generate` output.
- [ ] `auth.account` has a unique `(user_id, provider_id)`.
- [ ] The `packages/auth` journal is the auth database's only journal, regenerated as its baseline,
  and an auth-journal parity test with its own deployed-through marker covers it.
- [ ] In the app database, the scaffold cleanup drops the #59 tables only when they are empty. Its
  guard aborts if any of them holds a row, and a test proves the abort.
- [ ] Auth timestamps are `timestamptz`, or the mapping is documented with a test showing that
  `created_at` and `updated_at` survive the copy exactly. The legacy values are `timestamptz`.
- [ ] **The cross-database copy** (Two databases section) runs as ordered, gated steps:
  - the export selects only non-system users, with **`email = lower(trim(email))`**
  - one auth-database transaction aborts unless the targets are empty and the import is non-empty,
    and **aborts if any two rows collide on the normalized email**
  - it inserts `auth.users` (same `id`, derived `name`, `email_verified = true`) and one
    `credential` account per user with the bcrypt hash
  - the cross-database audits pass before the app cutover migration runs
  - no cross-database credential is stored in either database, the pipe writes no file, and the
    import table is a temporary table in the step-2 session
- [ ] The app cutover migration, in one transaction with guards, normalizes `public.users.email`
  (aborting on a collision), drops `password_hash`, `is_admin` and `session_version`, and drops
  `tokens`. The foreign keys from `threads`, `preferences` and `feedback` to `public.users` are
  unchanged.
- [ ] Name derivation follows the reference rule:
  - `trim(first || ' ' || last)` when it is non-empty
  - otherwise the email local-part
  - otherwise `'User'`

  `name` is never split back into parts.
- [ ] A rehearsal audit reports the number of guest accounts matching the exact guest shape
  (`^guest_[A-Za-z0-9]{10}@(askansari\.ai|ansari\.chat)$`, name "Welcome Guest"). It is
  informational only and never blocks the cutover.
- [ ] Audits run after the copy and pass:
  - the row count and ordered id checksum of non-system `public.users` equal those of `auth.users`
  - the ordered password-hash checksum of non-system `public.users` equals that of the `credential`
    rows in `auth.account`
  - the number of `credential` rows equals the number of non-system users
  - **no system account exists in the auth database**
  - every `ADMIN_EMAILS` entry has `role = 'admin'` after the role script
  - the set of `role = 'admin'` users equals the owner-approved inventory
- [ ] Re-running the `account` backfill on its own creates zero duplicate rows.
- [ ] **Email case is normalized, and collisions are decided before the window.**
  - Why: better-auth 1.7.7 lowercases the email on every lookup (`dist/db/internal-adapter.mjs:572`,
    `dist/api/routes/sign-in.mjs:318`, `dist/api/routes/sign-up.mjs:158`), while
    `auth.users.email` is unique case-sensitively. Legacy code lowercases on write
    (`lib/db/users.ts:106`), but that only covers rows written since the monorepo move. Older rows
    are unverified. A mixed-case row copied as-is could never be found, which is a silent lockout.
    The user would then re-register as a second user with a new UUID, detached from their threads.
  - A **read-only pre-window audit** counts rows where `email <> lower(trim(email))`, and lists every
    case-insensitive duplicate group. It runs in the rehearsal and again by the operator before the
    window.
  - The **owner decides every collision before the window**. The guards then find none.
- [ ] `DEPLOYED_THROUGH` moves once per app migration, the cutover bump by the owner, in the PR. Every
  app migration follows the numbering rule (merge `develop`, run generate, rename the `.sql` file
  and its journal tag by hand, keep the snapshot's index name, re-check after every `develop` merge).
- [ ] The pglite DDL in `apps/api` tests that names the dropped columns or `tokens` is updated,
  coordinated with #292.
- [ ] **Two databases, enforced.** `apps/api` has no auth-database credential, and `apps/auth` has
  no app-database credential. A source scan pins it, negative-tested against a planted line.

**App rows, deletion and system accounts (`apps/api`)**

- [ ] A user created through the layer gets a `public.users` row with the same id at registration.
  A user created directly at `apps/auth` gets it on the first `apps/api` request, from the
  internal profile endpoint, with `ON CONFLICT (id) DO NOTHING`. Concurrent first requests create
  one row.
- [ ] A `sub` unknown to `apps/auth`, or tombstoned, gets 401 and never gets a row.
- [ ] A profile whose email is held under another id, is on a reserved domain, or is held by a
  `system_key` row gets 401, no row and no 500. The pair of ids is logged by id only, and an alert
  fires.
- [ ] The internal delete endpoint refuses a call without the subject's JWT, with an invalid JWT,
  or with a JWT whose `sub` differs from the target id. The operator completion script deletes as
  the auth migrator and never calls it.
- [ ] Internal routes compare the credential in constant time, are mounted outside the Better Auth
  handler path, are rate-limited, and are reached over the private network.
- [ ] `DELETE me` refuses a system account before deleting anything. Otherwise it deletes the app
  row (cascading) and writes the tombstone in one transaction, then deletes the auth user through
  the internal endpoint and marks the tombstone done. A failure after the first transaction is
  completed by the next request carrying that `sub`, by a retry, or by the operator script.
- [ ] System accounts are created lazily in the app database as today, and never appear in the
  auth database.
- [ ] `change-email` and `update-user` are blocked on `apps/auth`, with the same variant tests as
  the admin surface.

**Database principals**

- [ ] Each database has a migrator and one runtime role. Provisioning SQL, outside both journals,
  sets default privileges on tables and sequences (`public` in the app database, `auth` in the auth
  database).
- [ ] A pglite test per database under `SET ROLE`: runtime DDL fails with `42501`; a table the
  migrator creates later is usable by the runtime role; without the default privileges it fails
  with `42501`.
- [ ] The boot check in each service, on staging and production, fails boot if the runtime role
  has `CREATE` on its schema.

**Credentials and sessions (`apps/auth`)**

- [ ] **Permanent dual verify:**
  - `$2a$` and `$2b$` hashes verify with bcrypt, keeping the 72-byte truncation of
    `lib/auth/password.ts`
  - anything else verifies with scrypt
  - new passwords hash with scrypt
  - a test **fails if the bcrypt branch is removed**
- [ ] A user migrated from a legacy-format row signs in with an unchanged password, both directly at
  `apps/auth` and through the layer's `/v2/users/login`, end to end against a real database.
- [ ] `revokeSessionsOnPasswordReset: true`. A test proves that a reset kills a live session (no new
  JWT can be minted from it) and **fails if the flag is removed**.
- [ ] Session lifetime is 30 days and is refreshed after 1 day, pinned by a test. Exchanging a
  session for a JWT slides its expiry once `updateAge` has passed, so a client that refreshes
  regularly is never logged out at the 30-day mark.
- [ ] After cutover no legacy HS256 JWT code exists. `tokens`, `session_version`, `is_admin` and
  `password_hash` are gone from code and schema, and `grant-admin.ts` lives in `apps/auth/scripts/`
  and sets `role`. `apps/api` has no `better-auth` dependency.
- [ ] **No admin plugin endpoint answers on `apps/auth`.** Every admin path, impersonation
  included, is listed in `disabledPaths` **and** blocked by an Express middleware placed before
  `toNodeHandler`, which matches the admin prefix case-insensitively. Tests cover:
  - exact paths, case variants, trailing slashes and percent-encoded variants
  - a **regression test that enumerates the admin plugin's endpoints from the installed package
    and fails if any of them answers** with anything other than the block response, even with a
    valid admin session

  The plugin stays configured for its `role` column. Re-enabling an endpoint requires an explicit
  owner decision.

**JWT issuance and verification**

- [ ] `apps/auth` issues EdDSA JWTs with:
  - an explicit `iss` (the `apps/auth` origin: `https://auth.askansari.ai`, or
    `https://auth-staging.askansari.ai` in staging) and an explicit `aud` (the `apps/api` audience)
  - a lifetime of **15 minutes**, Better Auth's default (owner), pinned by a test
  - a payload restricted by `definePayload` to `sub` (user UUID) and the session id

  No email, names, `system_key` or role go in the payload, and a test pins its exact key set.
- [ ] `apps/api` verifies every token against the cached JWKS. It pins the algorithm and requires
  `iss`, `aud` and `exp`, and each of the following is rejected with 401, by a test:
  - `alg: none` and any other `alg`
  - a wrong `iss` or a wrong `aud`
  - an expired token
  - a bad signature
  - a token signed by an unknown key
  - a legacy HS256 token
- [ ] An unknown `kid` triggers at most one JWKS re-fetch, rate-limited so that tokens carrying
  random `kid`s cannot turn `apps/api` into a request amplifier against `apps/auth`. A key rotation
  on `apps/auth` is picked up without restarting `apps/api`.
- [ ] With `apps/auth` unreachable, a valid unexpired JWT still verifies from the cache.
- [ ] A JWT whose `sub` has no `public.users` row and is unknown to `apps/auth`, or is tombstoned,
  gets 401 on any route that touches the user's data, never a 500 caused by a foreign-key error.
- [ ] **The revocation window is pinned.** After logout, reset, ban or deletion, a test shows:
  - the session token can no longer mint a JWT
  - an already-issued JWT is rejected once it expires
  - that window is at most the configured lifetime

  The review records the window as an accepted cost.

**`apps/api` authorization**

- [ ] Every route that used `authenticateRequest` or `requireAdmin` resolves its user from a
  verified JWT. The route set comes from a grep before merge, not from this list.
  - **Ownership checks are unchanged:** a user cannot read another user's thread.
  - Admin routes ask `apps/auth`'s internal role endpoint **on each request**, and return the same
    401 and 403 codes as today. When `apps/auth` is unreachable they return 503 and never grant.
- [ ] `/api/v1/chat/completions` (`LEADERBOARD_API_KEY`) and `/api/v2/mcp-complete` behave as today.
  There is no global `middleware.ts`.
- [ ] **Existing admins are preserved deliberately.**
  - Before the window, the operator produces an inventory of every `is_admin = true` user and
    compares it with `ADMIN_EMAILS`.
  - The owner approves the post-cutover admin list.
  - The role script assigns `role = 'admin'` to exactly that list.
  - An audit checks that the set of `role = 'admin'` users equals the list.
- [ ] `apps/auth`'s production boot assertion checks that every `ADMIN_EMAILS` entry exists with
  `role = 'admin'`, gated like today's `shouldRunAdminStartupCheck`.

**Compatibility layer on `apps/api`: frozen contract**

- [ ] **Contract tests land first, written against today's implementation**, and pass **unchanged**
  against the new one. They pin, for `register`, `login`, `refresh_token`, `logout`, `me` (GET and
  DELETE), `request_password_reset` and `reset_password`:
  - status codes
  - field names and field presence (for example, `refresh_token` has no `status`)
  - error `detail`
  - the 401, 409 and 422 semantics
- [ ] Every layer route reaches Better Auth **only by calling `apps/auth` over HTTP**. It has no
  access to the auth database.
- [ ] Token mapping:
  - `login` and `register` return `access_token` = JWT, `refresh_token` = session token, and
    `token_type: 'bearer'`.
  - `refresh_token` exchanges the session token at `apps/auth` for a new JWT, and returns the same
    session token as `refresh_token`. It returns 401 once the session is revoked or expired.
- [ ] `apps/auth`'s bearer plugin keeps `requireSignature` **unset**, because the layer holds the
  raw session token and better-auth 1.7.7 accepts an unsigned bearer only in that case
  (`dist/plugins/bearer/index.mjs:34-37`). A test pins it: a raw session token from `login` mints a
  JWT, a tampered signed token is rejected, and the test fails if `requireSignature` is turned on.
- [ ] `logout` revokes **all** of the user's sessions, as today. The remaining JWT lifetime is the
  accepted window.
- [ ] `DELETE me` succeeds with a session created more than 24 hours earlier. It goes through an
  internal-only `apps/auth` endpoint that requires the internal credential and deletes the user
  through Better Auth's internal adapter. `auth.api.deleteUser` is not used, because it 404s unless
  enabled and enforces `freshAge`. The order is the one in "Two databases" rule 5: app row and
  tombstone first, then the auth user. Afterwards the session is dead and the user's threads,
  preferences and feedback are gone.
- [ ] Password reset:
  - The emailed link has the legacy shape `${FRONTEND_URL}/reset-password?token=<token>`.
  - Unknown emails get the identical response.
  - A system account receives no email and cannot gain a credential.
  - `checkPasswordStrength` runs before reset and before register.
- [ ] Reserved addresses (`@system.ansari.chat`) and the `system_key` guards return the same 409 as
  a taken email, on the layer **and** in `apps/auth`'s own sign-up hooks. The guard order in
  `register` is unchanged: validation → reserved/taken → strength → create.
- [ ] `register` still records `registered_via` from `X-Ansari-Client` (in both databases), and still
  passes `first_name` and `last_name` to the newsletter opt-in. `login` returns `first_name` and
  `last_name` from `public.users`.
- [ ] Clients run unmodified against the new layer in staging:
  - the released mobile flow: login, then a bearer call, then a 401 when the JWT expires, then
    refresh, then a retry
  - the admin analytics login

**`apps/frontend` and `apps/auth` deployment**

- [ ] `apps/frontend` signs in, signs up, resets passwords and signs out through `apps/auth`. It
  sends the JWT to `apps/api`, and refreshes it from the session. On the web it does not depend on
  third-party cookies. The change is agreed with the app architect before it is built.
- [ ] `apps/auth` has a Dockerfile and a Railway service, with its own Railway Postgres (snapshot or
  PITR enabled). Its watch paths include `packages/**`, and its healthcheck answers only when the
  auth database answers.
- [ ] `apps/auth` is not deployed to production before the window. In the window its public domain
  is attached only after the copy, the audits and the smoke tests. Before that, a check proves it
  is unreachable from the public internet.
- [ ] `apps/auth` CORS allowlists exactly the `apps/frontend` web origins, and exposes
  `set-auth-token` and `set-auth-jwt` to them. `trustedOrigins` matches. #266's origin test is made
  to fail on a wrong origin.

**Rate limiting and client IP**

- [ ] `apps/auth`'s `createAuth()` sets:
  - `rateLimit`: `enabled: true`, `storage: 'database'`, sign-in 5/60s, sign-up 3/60s
  - `advanced.ipAddress.ipAddressHeaders: ['x-real-ip']`
- [ ] Sign-in over the limit returns 429 directly at `apps/auth` **and** through `/v2/users/login`.
  Both paths draw from the same database-backed budget, shared across instances. The same holds for
  sign-up and register.
- [ ] A request carrying a two-entry `X-Forwarded-For` and a distinct `X-Real-IP` is limited under
  its `X-Real-IP`, not in a shared bucket. Forging `X-Forwarded-For` does not let a client switch
  buckets.
- [ ] **The internal hop.** Two legacy clients with different IPs, calling through the layer, land
  in different buckets, so the layer's own egress IP never becomes the key. A forwarded-IP header
  without a valid internal credential is ignored.
- [ ] `apps/api`'s `getClientIp` (used by `mcp-complete`, and by the layer to forward) reads
  `X-Real-IP` only. `tests/rate-limit.test.ts`, which asserts the opposite preference today, is
  updated.
- [ ] **Empirical edge verification is done before the PR merges and recorded** (method, raw
  observations, verdict). It covers each production domain, `apps/auth`'s domain once attached, and
  the `*.up.railway.app` domains, and proves both properties from the Client IP section:
  - forged `X-Real-IP` and `X-Forwarded-For` values never appear as the observed `X-Real-IP`
  - two clients on different networks see distinct `X-Real-IP` values equal to their own public
    addresses, never a Railway or private-range address
- [ ] If either property fails, the PR ships the documented fallback in `apps/auth`, and tests pin
  each part:
  - sign-in is keyed by email and counts failures only
  - a correct password is rejected while the email is locked
  - a successful sign-in consumes no budget
  - sign-up has a per-email limit plus a global ceiling
  - per-IP is used only as an additional key
  - the list-walk alert fires and logs no raw email

**CORS on `apps/api`**

- [ ] `apps/api/next.config.ts` no longer sends `Allow-Origin: *` together with
  `Allow-Credentials: true`. Authentication is a bearer JWT, so credentials are not needed for
  `/api/*`. Any allowlist matches the `apps/frontend` web origins.

**Cutover and operations**

- [ ] A cutover runbook exists. It covers:
  - the downtime mechanism (remove both public domains from `backend`, or pause it, chosen in the
    rehearsal)
  - deploying `apps/auth` only after the copy and audits, and attaching its domain last
  - alert silencing and the snapshot or PITR baseline **of both databases**
  - the cross-database copy, its audits, the app cutover migration, admin roles, and attaching
    `apps/auth`'s domain
  - deploying `apps/api` and `apps/frontend`, then the smoke tests
  - the **24-hour rollback deadline**: restore the app database's snapshot, return the auth
    database to its pre-window state, redeploy the previous `apps/api` and `apps/frontend`
    deployments, and detach `apps/auth`'s public domain. After the deadline, fix forward.
- [ ] The rehearsal of the full runbook runs on a clone of the production app database and a fresh
  auth database, never a database production uses. It passes all audits, then boots the PR's
  `apps/api` and `apps/auth` against the rehearsed databases and passes the smoke tests.
- [ ] The PR amends `RELEASE.md` with the auth database, the provisioning step and the deploy order
  **roles SQL → migration → grants → boot** for each database. The order is written as two stages.
  **Ahead of the window**, for the app database: provisioning, then the re-point and its soak, then
  rotation. **In the window**, for the auth database: roles, baseline, grants, then the copy, before
  the `apps/auth` deploy. Every `psql` apply, the smoke test and the admin
  bootstrap step use the operator-held migrator URL of the right database; `CONTRIBUTING.md` states
  that dev and CI use one owner URL per database, on two local databases.
- [ ] The **re-point** is an operations-only step **ahead of the window**: the app database's
  provisioning SQL, then staging with a soak, then production with its own soak. The window holds
  no re-point. It ends
  with the migrator URL in no service environment (checked on every Railway service) and the
  migrator password rotated. A source scan finds no fallback connection string in runtime code.
- [ ] The PR also amends `RELEASE.md`:
  - it names the cutover migration as the one exception to the backward-compatible rule, applied
    only in the offline window
  - it records the schema freeze
  - it adds the `apps/auth` service
  - its smoke test and admin-bootstrap step are rewritten for Better Auth, which closes #33
- [ ] After cutover:
  - migrated users sign in with existing passwords through `apps/auth` and through the layer
  - the released mobile build works without a store release
  - no mass password reset happens
- [ ] `codev/resources/arch-critical.md`, `arch.md` and `packages/auth/README` are updated to match
  (see the Constraints delta), and every stale statement is fixed everywhere it appears.
- [ ] Follow-up issues are filed for:
  - the layer's removal
  - a profile sync design, before `change-email` or `update-user` is enabled
  - **guest cleanup after cutover**. Deleting a guest cascades its threads, so that issue must
    decide whether feedback is retained and what happens to shared links that point at guest
    threads.

  Separately, #16 and #49 are closed with the documented post-cutover behaviour.

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

**Owner override, 2026-10-15.** The first half of the fourth item, "`apps/api` authenticates with
the bearer plugin", is replaced by the owner's decision: **`apps/api` verifies JWTs issued by
`apps/auth` against its JWKS.** The second half stands, with the layer calling `apps/auth` over
HTTP. **Owner override, 2026-10-16.** In the third item, "FKs on `threads`, `preferences`, `feedback`
repointed to `auth.users.id`" is replaced: the auth tables live in **their own database**, and the
foreign keys stay on `public.users`, which keeps the same UUIDs. "A dedicated `auth` Postgres schema,
migrated before the window" stands, inside the auth database. "`is_admin` and `session_version`
dropped" stands, together with `password_hash`. Under the owner's one-PR decision, "migrated
before the window" no longer holds for the auth tables: they are created in the window's first
step, in the empty auth database.

Every other item is carried forward unchanged. Under the owner's hosting decision, the
decided rate limits apply to every production sign-in, because all of them pass through `apps/auth`.

### Ownership and review boundaries (from the issue)

- The security architect reviews; every PR is in the high-risk review tier.
- Hunks touching `turbo.json`, the lockfile, `.github/`, Dockerfiles, Railway config, or either
  journal's numbering and markers (`apps/api/drizzle/`, `packages/auth/drizzle/`) need the main
  architect's review. This now includes `apps/auth`'s new Dockerfile, service and database.
- The `apps/frontend` auth client change is agreed with the app architect first (I-6).
- Schema changes: `drizzle-kit generate`, review the SQL, apply by hand at deploy. Never `db:push`.

### Invariants that survive

- System accounts are resolved by `system_key`, never by email, and `@system.ansari.chat` stays
  reserved.
- Admin is never an email match.
- Never log a raw driver or database error; log only `{name, code}`. Never log a token.
- Auth config is read through validated config (`@ansari/auth` `getEnv()` in `apps/auth`;
  `apps/api`'s `config` for the JWKS URL, issuer and audience), never through raw `process.env`.
- New env vars follow the four-way `turbo.json` `globalEnv` derivation.
- Atomic auth operations are tested against a real database, not mocks.
- The mobile contract is frozen.

### Release mechanics

- `main` is promoted only by fast-forward from `develop`.
- Normal migrations must be backward-compatible with the code serving traffic. The cutover
  migration is the one documented exception, applied with `apps/api` offline and `apps/auth` not yet deployed,
  after the cross-database copy and its audits.

### Pinned dependency

- better-auth and `@better-auth/expo` stay pinned at **1.7.7**. Every behavioural claim here is
  cited against 1.7.7, and any upgrade re-verifies those claims first.

### `arch-critical.md` delta (applied in the PR)

| Current | After |
|---|---|
| Admin = `users.is_admin` | Admin = admin-plugin `role` on `auth.users` in the auth database, asked of `apps/auth` on each admin request (fail closed), never from a token claim. `ADMIN_EMAILS` (in `apps/auth`) = reservation + boot assertion only |
| `session_version` = the "kill all sessions" primitive | Deleting a user's Better Auth session rows is the primitive. Already-issued JWTs live until `exp` (15 minutes, Better Auth's default), which is the documented revocation window. No per-request session check |
| JWT config through `config` | `apps/auth` is the only issuer (EdDSA, `auth.jwks`). `apps/api` only verifies, against the JWKS, with `alg`, `iss`, `aud` and `exp` pinned. `apps/api` never imports `better-auth` |
| Token rotation in `db.transaction` with `exec` | Retired with `tokens`. Each cutover step is one transaction |
| Users in `public.users` | Two databases: the auth database (only `apps/auth`) holds every Better Auth table; the app database keeps `public.users` (same UUIDs, no auth columns) for referential integrity. No service holds the other's credential |
| System accounts by `system_key` | Unchanged, and app-only: never in the auth database |
| (new) | Client IP comes from `X-Real-IP` only. The layer-to-`apps/auth` hop forwards it only with the internal credential |
| (new) | Sign-in, sign-up, reset and session logic live only in `apps/auth`. The `/v2/users/*` layer is an HTTP client of it |
| (new) | The admin plugin's HTTP endpoints are blocked on `apps/auth` (the plugin is used for `role` only). Roles change only through the role script |

## Assumptions

- The production database has **no real identities** in the #59 scaffold tables in `public`, and
  may not have them at all. Whether they exist on staging or production is a `psql \dt` question for
  the owner (main's condition 6). Either way, the scaffold cleanup's guard refuses to drop a
  non-empty table.
- The rehearsal runs against a **clone of production data**, whatever host it runs on.
  `api-staging.askansari.ai` exists (plan 124), but it is unconfirmed whether it has its own
  database separate from production; the security architect is asking the owner (C-3). The
  rehearsal must never run against a database that production also uses. It needs an `apps/auth`
  instance and its own auth database too.
- The operator can take a database snapshot, or use PITR, of **both** databases, and restore the
  app database within the 24-hour deadline. Railway can host a second Postgres for `apps/auth`
  (C-4).
- Railway's `X-Real-IP` behaviour as stated by staff holds on our domains. It is verified during
  before the PR merges, not assumed, and the spec carries a fallback if it does not hold.
- `apps/api` can reach `apps/auth` reliably, over the public domain or the private network (the plan
  chooses). The internal credential protects either.
- Released mobile builds send `Authorization: Bearer` on every authenticated call, treat
  `access_token` and `refresh_token` as opaque strings, and refresh and retry on a 401. So a
  15-minute access token only adds periodic refreshes, and nothing in the legacy client decodes the
  token. The plan verifies this by reading the legacy client source (`ApiService.ts`
  `fetchWithAuthRetry`), including how concurrent 401s behave with no single-flight guard.

## Solution Approaches

The owner settled hosting and the token model at the spec-approval gate on 2026-10-15. The
approaches below record what was considered and why. The PR shape is one PR (C-2, owner).

### Approach 1: Separate `apps/auth` service, JWT/JWKS verification in `apps/api`, layer as an HTTP client (chosen by the owner)

As described in Desired State, with the auth tables in their own database (owner, 2026-10-16).

- **Pros:**
  - Auth is a separate deployable, as #49 intended. `apps/api` holds no auth logic and no auth
    secret, only public keys.
  - Per-request verification is stateless: no database read, no network hop, and it keeps working
    from the cached JWKS while `apps/auth` is down.
  - One limiter, database-backed, covers every sign-in path.
  - `apps/frontend` uses Better Auth natively, so the layer's removal trigger becomes meaningful.
- **Cons:**
  - The **revocation window** equals the JWT lifetime (15 minutes, Better Auth's default).
  - A new service, domain and Dockerfile.
  - Key management (`auth.jwks`, rotation, caching).
  - An authenticated internal hop for the layer, which also carries profile, role and delete.
  - A second database: a cross-database copy, app rows created on first use, deletion through a
    tombstone.
  - A client change for `apps/frontend` inside the window.
- **Risk:** medium-high. More moving parts land in the window. Staging deployments from the
  branch, a full rehearsal with both services, and the snapshot rollback mitigate it.

### Approach 2: Separate `apps/auth`, with `apps/api` validating Better Auth session tokens through the bearer plugin

`apps/api` would hold the shared `BETTER_AUTH_SECRET` and read `auth.session` on every request.

- **Pros:**
  - Instant revocation, which matches today.
  - Matches the issue's original decided item.
- **Cons:**
  - `apps/api` would import `better-auth`, hold the session-signing secret, and read the session
    table, so auth logic would remain inside it.
- **Not chosen:** the owner ruled that `apps/api` uses JWT verification.

### Approach 3: Better Auth in-process inside `apps/api`, with no public `/api/auth/*`

This was the first draft's proposal.

- **Pros:** the fewest moving parts in the window.
- **Cons:** auth stays inside `apps/api`.
- **Not chosen:** rejected by the owner.

**PR shape (independent of the above):** one PR, merged at the window (owner, C-2).

## Open Questions

**Critical (blocks progress)**

- **C-1: Migration SQL location (reopened by the two-database decision).** Two journals, one per
  database: `packages/auth/drizzle/` for the auth database and `apps/api/drizzle/` for the app
  database. The main architect's seven conditions were written for a single journal and need
  re-review; the spec states which carry over. No external migration framework is needed and
  Waleed is not a reviewer (owner).
- **C-2 (resolved, owner, 2026-10-16):** one PR, merged at the window. See Phasing.
- **C-4: The auth database on Railway** (owner and main architect). A new Railway Postgres service
  for `apps/auth` in staging and production, with snapshots or PITR, and its cost.
- **C-3: Staging database.** `api-staging.askansari.ai` exists (plan 124). Does it have its own
  database that a production clone can be restored into, with room for an `apps/auth` staging
  instance? If not, who provisions one? The rehearsal is a hard prerequisite for merging.

**Important (shapes design)**

- **I-1 (resolved, owner, 2026-10-15):** `apps/auth` is a separate service, and `apps/api` uses JWT
  verification.
- **I-2 (resolved):** every sign-in passes through `apps/auth`'s database-backed limiter, so the
  layer needs no limiter of its own.
- **I-3: Layer removal trigger.** "90 days after cutover or ≥ 95% new-client adoption, whichever
  first", owner Amr, carried from the reference. Is it measured by `/v2/users/*` traffic share or by
  released build versions? This affects only the follow-up issue.
- **I-4: Cutover timing.** Who is the operator, and what is the window? This is needed for the
  runbook.
- **I-5 (resolved, owner, 2026-10-16):** `auth.askansari.ai` (production) and
  `auth-staging.askansari.ai` (staging). `apps/api` reaches the profile, role and delete endpoints
  over Railway's private network (security). The transport of the layer's sign-in hop, which
  forwards the client IP with the internal credential, is chosen in the plan.
- **I-6: `apps/frontend` change and release timing** (app architect).
  - The web build ships in the window.
  - If a native `apps/frontend` build pointed at `apps/auth` is released to the stores, a snapshot
    rollback leaves it talking to an `apps/auth` with fewer users.
  - Does any native `apps/frontend` build ship before the rollback deadline passes?
- **I-7 (resolved, owner, 2026-10-16):** the JWT lifetime is Better Auth's default, 15 minutes.
  `apps/api` uses plain JWKS validation with no per-request session check. Sessions stay at the
  issue's 30 days, refreshed daily.

**Nice-to-know**

- **N-1:** Opportunistic rehash from bcrypt to scrypt on login is allowed, but not required. It is
  deferred unless the plan finds it cheap.
- **N-2:** Should `apps/api`'s `getClientIp` group IPv6 addresses to /64 like Better Auth does?
- **N-3:** JWKS key rotation cadence. The plugin manages keys, and the review documents the cadence
  and a manual rotation procedure.

## Test Scenarios

**Happy paths**

1. A legacy user (bcrypt hash, `first_name` and `last_name` set) is migrated, logs in through
   `/v2/users/login`, and gets a JWT and a session token. `GET /v2/users/me` with the JWT returns
   the frozen shape with the same `id`. Their threads list unchanged.
2. The same user signs in directly at `apps/auth` (as `apps/frontend` does), exchanges the session
   for a JWT, and calls `apps/api` with it.
3. A new user registers through `/v2/users/register`, and another directly at `apps/auth`. Both
   passwords are stored as scrypt. Both users log out and log back in.
4. The legacy mobile flow:
   - Login, then calls with the JWT.
   - After 15 minutes the JWT expires, the call gets 401, `refresh_token` returns a new JWT, and
     the retry succeeds.
   - After logout elsewhere, `refresh_token` returns 401 and the client logs the user out.
5. An admin assigned by the role script reaches `v2/admin/stats`. A non-admin gets 403. An
   unauthenticated request gets 401. A demoted admin gets 403 on the very next request, while their
   JWT is still valid. With `apps/auth` unreachable, an admin gets 503, never 200.
6. Password reset: the request emails a legacy-shaped link. The reset succeeds with a strong
   password, and no prior session can mint a new JWT.

**Edge cases**

7. A user with null first and last names, and a user with an empty email local-part, get the
   derived `name` (local-part, or `'User'`). `first_name` and `last_name` copy as null, and
   `login`'s response matches today's handling of null names.
8. A password longer than 72 bytes on a bcrypt hash verifies exactly as it does today, truncated.
9. `DELETE /v2/users/me` with a session 25 hours old succeeds. The session is dead, threads,
   preferences and feedback are gone through the `public.users` cascade, a tombstone is written,
   and the user's unexpired JWT gets 401 on data routes.
9a. With `apps/auth` failing after the app transaction, `DELETE me` leaves a tombstone pending. The
   next request carrying that `sub` completes the auth deletion and gets 401, and the profile path
   never re-creates the row.
9b. A system account's `DELETE /v2/users/me` is refused before any data is deleted, and all its
   threads, preferences and feedback remain.
9c. A user who signs up directly at `apps/auth` gets a `public.users` row on the first `apps/api`
   request, with the same id, email and names. Two concurrent first requests create one row. A
   `sub` that `apps/auth` does not know gets 401 and no row.
9d. Provisioning, in pglite under `SET ROLE`, for each database: runtime DDL fails with `42501`; a
   table the migrator creates later is usable by the runtime role, and fails with `42501` when the
   default privileges are omitted.
9e. The source scan finds no auth-database connection in `apps/api` and no app-database connection
   in `apps/auth`, and fails on a planted one.
9f. A user created at `apps/auth` whose email is already held in `public.users` under another id
   (a legacy row, a system row) gets 401 on the first request; no row is written, the log carries
   both ids and no email, and the alert fires. The same holds for an `@system.ansari.chat` address.
9g. With the internal credential but no JWT, with another user's JWT, or with a forged JWT, the
   delete endpoint refuses and the target account remains.
9h. The copy with one password hash altered in transit fails the hash audit, and the app cutover
   migration is not run. A step 2 failure leaves no import table behind.
9i. No verification email is sent to any copied user, and every copied user has
   `email_verified = true`.
10. Re-running the `account` backfill inserts zero rows. The auth-database copy transaction run
    against a non-empty `auth.users` aborts with no changes.
11. A fresh empty app database migrated through the full `apps/api` journal, and a fresh auth
    database through the `packages/auth` journal, each produce the post-cutover schema, and both
    parity tests pass.
12. A timestamp at a DST boundary or carrying microseconds is identical after the copy.
13. A legacy row stored as `  Alice@Example.COM` (mixed case, padded) is migrated as
    `alice@example.com`. It signs in with `ALICE@example.com` and its unchanged password, keeping
    the same UUID and threads. Registering `alice@example.com` returns the taken-email 409.
14. The copy transaction, and the app cutover migration, each run against two legacy rows
    `Bob@x.com` and `bob@x.com`, abort with no changes, and the pre-window audit reports that pair.
15. The scaffold cleanup run against a `public.account` scaffold table holding one row aborts and
    changes nothing. Against empty scaffold tables, or none, it succeeds.
16. Admin inventory: a legacy admin missing from `ADMIN_EMAILS` but on the owner-approved list holds
    `role = 'admin'` after the role script. A legacy admin left off the list does not.
17. A JWKS key rotation on `apps/auth`: new tokens carry the new `kid`, `apps/api` re-fetches once
    and accepts them, and old unexpired tokens still verify while their key is published.
18. With `apps/auth` stopped, an unexpired JWT still works on `apps/api`, and sign-in and refresh
    fail cleanly.

**Error and security conditions**

19. Registering `x@system.ansari.chat`, or a taken email, returns the identical 409, on the layer
    and directly at `apps/auth`.
20. A system account cannot log in, does not exist in the auth database, and a reset request for
    its address sends no email and creates nothing.
21. Six sign-ins from one `X-Real-IP` in 60 seconds get 429 on the sixth, directly and through the
    layer, from one shared budget. Forged `X-Forwarded-For` values don't change the bucket.
    Distinct `X-Real-IP` values don't share one.
22. Through the layer, two clients with different IPs land in different buckets. A forwarded-IP
    header sent to `apps/auth` without the internal credential is ignored, and an internal-only
    endpoint called without it gets 401 or 403.
23. JWT rejection matrix, each case a 401:
    - `alg: none`, an HS256 token, an RS256 token
    - a wrong `iss`, a wrong `aud`
    - an expired token
    - a bad signature, an unknown key
    - a legacy JWT from before the cutover
24. A flood of tokens carrying random `kid`s causes at most the rate-limited number of JWKS fetches.
25. A user cannot read, rename, share or delete another user's thread.
26. `/api/v1/chat/completions` without the right `LEADERBOARD_API_KEY` gets 401, unchanged.
    `/api/v2/mcp-complete` keeps its IP limit, now keyed by `X-Real-IP`.
27. Removing the bcrypt branch, or `revokeSessionsOnPasswordReset`, makes a named test fail. The
    builder demonstrates this once and records it in the review.
28. A credentialed CORS request from a disallowed origin to `apps/auth` or `apps/api` gets no allow
    response. With a valid admin session, every admin plugin endpoint (`/admin/set-role`,
    `/ADMIN/set-role`, `/admin/set-role/`, `/%61dmin/set-role`, impersonation included) gets the
    block response.
29. A raw session token from `/v2/users/login` mints a JWT at `apps/auth`. Turning on
    `requireSignature: true` makes that test fail.
30. The JWT payload contains exactly the pinned claims, and no email, names, `system_key` or role.
31. In the window, before its domain is attached, `apps/auth` is unreachable from the public
    internet, and after the domain is attached, sign-up and sign-in work.
32. IP fallback (only if the edge check fails):
    - Five wrong passwords for one email within 60 seconds, then the right password: 429.
    - After the window ends, the right password succeeds.
    - Ten correct sign-ins in a row are never limited.
    - Lockouts across many distinct emails fire the list-walk alert, which contains no raw email.

**Non-functional**

33. JWT verification on `apps/api` adds no network hop per request in steady state (JWKS cached),
    and no read beyond the `public.users` row it already reads today. Admin requests add one
    internal call.
34. The runtime of the copy, the audits and the app cutover migration on the production-sized
    clone is measured in the rehearsal and fits the window.

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Mass lockout after cutover | Low | Critical | Dual verify with a removal-detecting test; legacy-row login test on both paths; full rehearsal with both services; 24-hour snapshot rollback |
| Released mobile users stranded | Low | High | Contract tests written against today's implementation pass unchanged; unmodified-client run in staging, including the expire-refresh-retry cycle |
| Revoked user keeps access until JWT `exp` | Certain (by design) | Medium | 15 minutes, Better Auth's default (I-7, owner); admin role asked of `apps/auth` per request; deleted `sub` rejected through the tombstone; window documented in arch-critical |
| JWT verification misconfigured (alg confusion, missing `aud` or `iss` check) | Low | Critical | Pinned `alg`, `iss`, `aud`, `exp`; rejection-matrix tests |
| Token payload leaks PII | Medium if the default is kept | Medium | `definePayload` restricted to `sub` and the session id; key-set test |
| `apps/auth` outage blocks sign-in and refresh | Medium | High | Cached JWKS keeps issued tokens working; healthcheck and alerting on `apps/auth`; rollback runbook |
| JWKS fetch amplification via random `kid` | Low | Medium | Rate-limited re-fetch; test |
| `apps/auth` reachable before the copy, accepting sign-ups | Low | High | Not deployed to production before the window; deployed after the copy; domain attached last; the copy guard aborts on a non-empty `auth.users` |
| Rate limit collapses into one global login bucket (edge or internal hop) | Medium without the fix | High | `X-Real-IP` only; authenticated forwarded IP on the hop; multi-entry XFF and two-client tests; empirical edge verification |
| Internal credential leaked | Low | High (any user's profile and role readable by id; rate-limit key chosen) | Constant-time compare; internal routes outside the Better Auth handler path; rate-limited; delete bound to the subject's JWT; profile, role and delete only over the private network; held in two service environments, rotated with them, never logged |
| Railway changes `X-Real-IP` semantics later | Low | Medium | Documented header; re-verify on any Railway networking change; an arch-critical fact makes the dependency visible |
| Admin HTTP surface abused (stolen admin token or frontend XSS leads to account takeover) | Low | Critical | Whole admin surface blocked: `disabledPaths` plus a case-insensitive prefix middleware before `toNodeHandler`; variant tests; enumerating regression test |
| `apps/frontend` client change slips or breaks in the window | Medium | High | Agreed with the app architect up front; rehearsed; web rollback by redeploy; native release timing decided (I-6) |
| Long-lived branch drifts from `develop` | Medium | Medium | Regular `develop` merges; numbering re-check after each; rehearsal re-run after the last rebase; nothing merges early, so releases never freeze |
| More lands in one window | Medium | High | Full rehearsal on a production clone; ordered, gated runbook; 24-hour snapshot rollback |
| Cross-database copy half-done (auth database filled, app migration failed) | Low | High | Ordered, gated steps; each step one transaction; audits before the app migration; `apps/auth` not deployed until both succeed; rehearsed on a clone |
| App row and auth user drift apart (missing row, orphan, resurrected deleted user) | Medium if unguarded | High | Same UUID; app row created on first use from the profile endpoint; tombstone blocks re-creation; pending deletions completed on access and by an operator script; profile-changing endpoints blocked |
| `apps/auth` outage blocks admin routes and first requests of new users | Medium | Medium | Admin fails closed (503); existing users unaffected (their row exists); alerting on `apps/auth` |
| Admin boot assertion crash-loops | Low | High | Role script runs before the deploy; the assertion is checked in the rehearsal |
| System accounts become loginable or resettable | Low | High | Never copied to the auth database (`WHERE system_key IS NULL`); audit; reset refusal test |
| Legacy admin silently dropped or added | Medium if overlooked | High | Owner-approved inventory; role-set audit |
| Mixed-case legacy email becomes unfindable | Unknown (older rows unverified) | High | Copy `lower(trim(email))`; in-transaction collision guard; pre-window audit with owner decisions; mixed-case sign-in test |
| A journal drifts from its database | Medium | High | One journal per database, each with a parity test and its own marker |
| Migrator credential left in a service environment | Medium if overlooked | High | Re-point step ends with every service checked and the password rotated; no runtime fallback (scan) |
| Migration numbering collides after a concurrent merge | Medium | Medium | Numbering rule: merge `develop`, run generate, rename, re-check after every merge; schema freeze from the PR's merge to window close |
| #59 scaffold tables hold data at drop time | Low | Medium | In-migration guard aborts on any row |
| Targeted sign-in lockout under the IP fallback | Medium (fallback only) | Low | Failed-only counting, bounded to one 60s window per five failures; list-walk alert; reset unaffected |
| better-auth behaviour differs from the 1.7.7 citations | Low | High | Pin 1.7.7; tests pin each relied-on behaviour |
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
- better-auth 1.7.7 JWT plugin: `dist/plugins/jwt/index.mjs` (`/token` :141, `/jwks` :26,45, `set-auth-jwt` :194-207), `sign.mjs` (EdDSA :32, `15m` :81, `iss`/`aud` :86-88, payload :119), `schema.mjs` (`jwks`).
- Better Auth docs: Database (UUIDs), Email & Password (custom hash/verify), Admin plugin, Bearer plugin, JWT plugin.

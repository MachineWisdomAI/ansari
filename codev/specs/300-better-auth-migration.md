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
> State item 9.
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
2. **Same users, same passwords, same ids.** Every legacy user exists in `auth.users` under the same
   UUID and signs in with the existing password, through a permanent bcrypt + scrypt dual verify.
   Threads, preferences and feedback are untouched; only their FK targets move.
   **Guest accounts are migrated as-is (owner decision, 2026-10-15).** Guests are ordinary user
   rows with no flag: `guest_` followed by 10 alphanumeric characters, at `askansari.ai` (legacy
   app) or `ansari.chat` (`apps/frontend`), named "Welcome Guest". They are deliberately **not
   filtered**, so their threads, feedback and preferences stay attached through the FK repoint.
   Cleaning them up is a follow-up.
3. **All Better Auth tables live in the `auth` Postgres schema**: `auth.users`, `auth.session`,
   `auth.account`, `auth.verification`, `auth.rate_limit` and `auth.jwks`. Legacy `public.users`
   survives only as the unread archive `public.users_legacy`, until a later, separately triggered
   drop. Both services use the same database.
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
8. **Admins are identified by the admin plugin's `role`**, assigned by a script that replaces
   `grant-admin.ts`. Admin is never an email match. `ADMIN_EMAILS` keeps only its reservation role
   and the boot assertion, rewritten against `role`. **Admin routes on `apps/api` read `role` from
   `auth.users` on each request** rather than trusting a claim, so a demotion takes effect
   immediately.
9. **System accounts are identified by `system_key`** (a server-only additional field). They have no
   `credential` account row and cannot sign in or reset a password.
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
      therefore *is* the revocation window: the plugin default of **15 minutes**, which the plan may
      only lower.
    - Two kinds of request close that window by reading the database: admin authorization (item 8),
      and any request whose `sub` no longer exists in `auth.users`.
12. **Sessions** last 30 days and are refreshed daily (`expiresIn` 30d, `updateAge` 1d).
13. **Production releases are never blocked.** Until the window, every merged change is safe to
    promote while the legacy JWT code still serves. In particular, `apps/auth` is deployed with **no
    public sign-up or sign-in reachable** before the window.

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
verified empirically on the deployed service, as part of PR A's work** — not left until the
window. The check passes only if it proves both properties:

1. **Overwrite.** Forged `X-Real-IP` and `X-Forwarded-For` values sent through each public domain
   (both production domains and the `*.up.railway.app` domain), over IPv4 and over IPv6 where
   reachable, never come back as the observed `X-Real-IP`.
2. **Distinctness.** Two clients on different networks (for example a home connection and a mobile
   hotspot, or two cloud hosts in different regions) observe two different `X-Real-IP` values, each
   equal to that client's own public address, across repeated requests. A value that is the same
   for both clients, or that falls in a non-public range, fails the check.

The method, raw observations and verdict are recorded in the plan and the review. Until the check
passes, PR B does not merge.

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
- The security architect is told before PR B proceeds, and the fallback is the configuration PR B
  ships with.

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
- The credential also identifies the layer's internal-only calls (for example account deletion
  without a fresh session, below). No other caller can reach those.
- A test proves that a forged forwarded-IP header without the credential is ignored, and that two
  legacy clients behind the layer land in different buckets.

**Residual risk, accepted and documented:** whoever holds the internal credential can choose the
rate-limit key. It lives only in the two services' environments, and it is rotated with them.

### Hosting and token model (owner decisions, 2026-10-15)

**Hosting: `apps/auth` is its own production service.** This follows reference spec Q5. It also
fixes the gap this spec found: `apps/auth` has no Dockerfile and no Railway service today. So this
project adds:

- A Dockerfile and a Railway service for `apps/auth`. Both are main-architect hunks.
- **Its own public domain**, chosen by the owner (Open Question I-5).
- Production config through `@ansari/auth` `getEnv()`, with any new variables added to `turbo.json`
  `globalEnv` by the four-way rule.

**Dark until the window.** The `auth` tables exist in production ahead of the window, so a reachable
`apps/auth` would accept sign-ups into `auth.users`. That would break the cutover's emptiness guard
and create identities that the legacy system cannot see. Before the window, `apps/auth` therefore
runs in production with **no public domain attached, or with sign-in and sign-up refusing**. The
plan chooses which, and a check proves it. The domain is attached in the window, after the cutover
migration.

**Token model: JWT via JWKS** (Better Auth's `jwt` plugin on `apps/auth`), alongside `bearer()` so
native and web clients can carry the session token without third-party cookies. Verified on the
installed 1.7.7:

- `GET /api/auth/token` exchanges a live session for a JWT (`dist/plugins/jwt/index.mjs:141`).
  Calling `get-session` also returns one, in the `set-auth-jwt` header (`:194-207`).
- The JWKS is served at `/api/auth/jwks` (`:26,45`). Keys live in the `jwks` table, which goes in
  the `auth` schema and the additive migration. Private keys are encrypted at rest with the secret.
- Defaults are EdDSA (Ed25519, `sign.mjs:32`) and a lifetime of `15m` (`sign.mjs:81`). `iss` and
  `aud` default to the base URL origin (`:86-88`), and this project sets both explicitly.
- **By default the payload is the whole user object** (`sign.mjs:119`), which would put email,
  names and `system_key` into every token. `definePayload` restricts it to what `apps/api` needs:
  `sub`, plus the session id. `role` is read from the database (Desired State item 8).

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
  needs these endpoints, because roles come from the role script.
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

`apps/auth` is now the extraction that #49 describes, so #49 can be closed by this project once the
cutover lands.

### Migration SQL location (resolves an issue "must be resolved" item)

**Decision: one migration journal, in `apps/api/drizzle/`.** The main architect, who owns that
journal, its numbering and the `DEPLOYED_THROUGH` contract, agreed on issue #300 (comment of
2026-10-14 03:40Z) under seven conditions. Each one is a requirement of this spec and is listed
below. The window's read-only audits and the admin-role script live next to the existing operator
scripts under `apps/api/scripts/`.

**Departure from the reference plan.** The reference plan offered `packages/auth/drizzle/` or
`scripts/migrations/better-auth-cutover/`, pending a "ported framework" coordinated with Waleed. The
owner ruled that out (no framework; Waleed is not involved in auth). A single journal is chosen for
these reasons:

- **The FK repoint forces it.** After cutover, `threads`, `preferences` and `feedback` reference
  `auth.users`. The auth DDL and the cutover depend on `apps/api`'s tables, and two journals would
  need a cross-journal ordering that nothing enforces.
- **The parity test then covers auth.** `migration-schema-parity.test.ts` builds its database from
  this journal only, so putting auth there is what puts it under the drift guard. Today
  `packages/auth/drizzle` sits outside every check, and that is the #165 outage class.
- **Fresh databases come out right in one pass.** The `RELEASE.md` smoke test (`pnpm db:migrate` on
  an empty Postgres) builds the full shape in a single run. On an empty database the cutover's data
  copy moves zero rows.
- **It fits the existing release practice.** The journal is the ordering and test source, not a
  runner. Production applies reviewed SQL with `psql` and never `db:push`.

**The seven conditions (main architect):**

1. **Two migrations, not one.**
   - The **additive** migration holds `CREATE SCHEMA auth` and the Better Auth tables. It is
     backward-compatible with the deployed code, ships in PR A, and is applied ahead of the window
     like any other migration.
   - The **cutover** migration holds the rename of `public.users`, the `INSERT … SELECT`, the
     `auth.account` backfill, the repoint of the three FKs, and `DROP TABLE tokens`. It is **not**
     backward-compatible. It is the **one named exception** to `RELEASE.md`'s rule that every
     migration must be, it is applied only inside the offline window, and **PR B amends
     `RELEASE.md` to say so**.
2. **The journal is linear, so the cutover file lands last.** A migration generated after the
   cutover could not be applied before it. The cutover migration merges in the PR that ships the
   window (PR B). From PR B's merge until the window closes there is a **schema freeze**: no other
   PR may add a migration.
3. **`DEPLOYED_THROUGH` moves once per migration**, and each bump is a human assertion, not proof.
   - The additive bump is made when the additive migration is applied on staging and production.
   - The cutover bump is made **by the owner**, in PR B.

   The parity test runs at two markers:
   - **At the pre-cutover marker** (`DEPLOYED_THROUGH` = the additive migration), the
     deployed-state test exercises the code paths production serves: the JWT auth helpers, threads,
     messages, shares. Before PR B, it also exercises the new Better Auth helpers that read and
     write only `auth.*` tables, such as user and account creation, session lookup and role
     assignment.
   - **Against the full journal,** every column the Drizzle schema declares must exist.
   - `develop` carries PR A's unwired Better Auth code before the window. Any PR A test that needs
     the post-cutover shape (for example an FK cascade from `auth.users` to `threads`) builds its
     database from the journal **plus the staged cutover SQL**, never from the journal alone. It is
     not a parity-test path until PR B journals that SQL.
4. **Numbering rule (main architect's ruling, option (a), posted on issue #300).** Numbers are
   never chosen independently. For each migration:
   1. Merge `develop` into the branch.
   2. Run `drizzle-kit generate`.
   3. Rename the generated `.sql` file **and** its `_journal.json` tag by hand to the next real
      number: **`0009_*`** for the additive migration, then **`0010_*`** for the cutover.
   4. Leave the snapshot file **named by journal index**, as drizzle writes it (`meta/0008_snapshot.json`
      for the additive migration).
   5. **Re-check the numbering after every `develop` merge**, because a concurrent migration shifts
      both the index and the real number.

   The cutover's data steps (rename instead of drop, the copy, the backfill, the guards, the
   transaction) are hand-edited into the **body** of its generated file. Its snapshot stays
   drizzle's, and the parity test proves that the edited SQL yields the snapshot's schema.
   The rule is needed because generate emits the journal index as the prefix: the dry run below
   produced `0008_*`, which collides with `0008_model_provenance.sql`. The idx-5 gap is never
   absorbed.
5. **`apps/api/drizzle.config.ts` must see the `auth` schema.** Its `schema` is
   `./db/schema/index.ts`, so the Better Auth tables are re-exported from `@ansari/auth` there. Only the Drizzle table
   definitions are re-exported (`@ansari/auth/schema`), so `apps/api` still never loads the
   `better-auth` runtime. A test or lint rule pins that.
   **Dry run, 2026-10-14:**
   - Setup: drizzle-kit 0.31.10 and drizzle-orm 0.45.2, run on a scratch copy of `apps/api/drizzle`.
     The schema was `db/schema/index.ts` plus a `pgSchema('auth')` pair (`users`, plus `account`
     with an FK to it and a unique `(user_id, provider_id)`). The scratch directory has been deleted.
   - It emitted `CREATE SCHEMA "auth";`, `CREATE TABLE "auth"."users"`, `CREATE TABLE
     "auth"."account"` and `REFERENCES "auth"."users"("id") ON DELETE cascade`. Nothing in `public`
     was touched.
   - **`schemaFilter` is not needed for `generate`.** It only scopes `push`, `pull` and
     introspection, and this project uses none of them.
   - **The same run named the file `0008_spike.sql`, journal index 8 and tag `0008_spike`.** That
     collides with the existing `0008_model_provenance.sql`, so the numbering rule in condition 4
     applies. The rename also corrects `arch.md`'s note, which says "the next generate emits
     `0008_*`; name it `0009_*`". That note was written before `0008` existed, and is fixed
     wherever else it is repeated.
6. **Retire the `packages/auth` journal explicitly.**
   - Delete `packages/auth/drizzle/` (its `0000_better_auth_init.sql` and `_journal.json`), and
     remove the `out` and migrate scripts from `packages/auth/drizzle.config.ts` and its
     `package.json`.
   - **Establish whether the #59 scaffold tables were ever applied** to staging or production
     (`public.user`, `session`, `account`, `verification`). This is a `psql \dt` question for the
     owner.
   - If they exist, the additive migration drops them with `IF EXISTS`, but only behind an
     **in-migration guard that aborts if any of them holds a row**. The operator's empty-check is
     not enough on its own.
7. **Hand-written pglite DDL.** More than twenty `apps/api` test files hand-write `users` or
   `tokens` DDL. The plan has a phase that moves the auth-touching ones to the new tables (in PR B,
   with the schema switch), **coordinated with #292**, which is changing the setup of the same files.

Every "idempotency helper" the reference plan expected is replaced by properties of the migration
itself:

- The cutover migration runs as **one transaction**, so a failure leaves nothing half-applied.
- The `account` backfill uses `ON CONFLICT (user_id, provider_id) DO NOTHING` on the unique
  constraint.
- **Precondition guards** abort the transaction unless `public.users` exists and `auth.users` and
  `auth.account` are empty.

**Reviewers.** The main architect reviews every hunk touching the journal, its numbering and
`DEPLOYED_THROUGH`, as well as lockfile, `turbo.json` and CI hunks. Adding `@ansari/auth` (schema only)
and a JOSE verification library to `apps/api` changes the lockfile in PR A. The migration SQL is
High tier and is reviewed by the main architect and the security architect. The reference plan's
Waleed review is dropped by the owner's decision.

### One database now, a separate auth database later (owner decision, 2026-10-16)

**Decision.** The `auth` schema lives in the existing Postgres database for this project. The
long-term plan is to move the auth tables into their own database. This project does not do the
split, but it must not make the split harder. The aim is that the split later is a data move plus
connection-string changes, not a rewrite.

**Split-readiness rules (requirements of this project):**

1. **Separate database logins now.** `apps/auth` connects with its own Postgres role, which owns
   the `auth` schema. `apps/api` connects with a role that can only `SELECT` the auth columns it
   needs (`auth.users`: `id`, `role`, existence; `auth.session` only if the per-request session
   check is chosen). It has no access to `auth.account` (password hashes), `auth.verification` or
   `auth.jwks`. `apps/auth` has no access to `public`. A test or boot check proves each grant
   boundary. At the split, each role's connection string points at its own database.
2. **No SQL joins between `auth` and `public` tables.** Today no `apps/api` query joins `users` to
   app tables except through `tokens`, which is dropped (`lib/db/users.ts:227,283`). A source-scan
   test, negative-tested against a known-bad line and a near-miss, keeps it that way.
3. **One accessor for identity reads in `apps/api`.** Every read of `auth.*` (admin `role`, user
   existence, system accounts by `system_key`, the admin user counts in `lib/db/stats.ts`) goes
   through one module. At the split, that module becomes an HTTP call to `apps/auth` or a read on
   the auth database, and nothing else changes. It uses bugfix-260's lazy pool accessor.
4. **App tables store only the user id.** `threads`, `preferences` and `feedback` keep `user_id`
   and copy no email, name or role from `auth.users`. Anything displayed about a user is read
   through the accessor.
5. **Foreign keys stay for now; behaviour does not depend on them.** The FKs from `threads`,
   `preferences` and `feedback` to `auth.users` keep integrity while there is one database, and
   are dropped at the split. So account deletion is explicit: the layer deletes the user's app
   data in `apps/api`, then deletes the user through `apps/auth`'s internal endpoint, and the
   cascade is only a backstop. A test runs the deletion path with the FKs removed and finds no
   orphaned rows. A failure between the two steps is retried, and leaves a user without data, never
   data without a user.
6. **Auth migrations touch only the `auth` schema.** The additive migration and every later auth
   migration contain no `public` DDL. The cutover migration is the one exception and runs once. At
   the split, the auth DDL moves to its own journal.
7. **Per-request database reads are counted as a split cost.** Each read from `apps/api` into
   `auth.*` on every request (admin `role`, user existence, and the session check if chosen)
   becomes a cross-database or HTTP call after the split. The plan keeps them behind the accessor
   so caching can be added there.

**What the split itself will need (out of scope, recorded for that project):** a data copy of
`auth.*` during a short maintenance window, dropping the cross-schema FKs, a separate backup and
point-in-time recovery for each database (they can no longer be restored to one consistent
moment), and the user counts in admin stats served by `apps/auth`.

### Phasing (resolves an issue "must be resolved" item; proposal — owner decides at spec-approval)

The reference plan's Phases 0–5 map onto this project as **two PRs** inside one SPIR project.
`develop` fast-forwards into `main`, so the split point is chosen so that nothing merged early can
block a release.

| This project | Reference phases | Production-safe while legacy JWT serves? |
|---|---|---|
| **PR A: Prepare** | 0, 1 and the code half of 2. **Database:** the **additive** migration (generated; condition 1) with `auth.jwks`, and retirement of the `packages/auth` journal. **`apps/auth`:** `createAuth()` config (UUIDs, `auth` schema, dual verify, `bearer()`, `jwt()`, `admin()` kept for its columns with its whole HTTP surface blocked, rate limiting and client IP, the authenticated internal hop), its Dockerfile and Railway service, deployed **dark**. **`apps/api`:** the JWKS verifier (unwired), the compatibility layer as an HTTP client of `apps/auth` (unwired), the admin script and assert, the CORS fix, contract tests. **Cutover:** the cutover SQL, **staged and rehearsed outside the journal** | **Yes.** The `auth` schema is additive (empty tables beside `public.users`). `apps/auth` runs with no public sign-in. The new `apps/api` code is not wired to production routes. PR A can merge and promote normally. |
| Rehearsal (production-data clone) | 2 | Runs from PR B's branch on a clone of production, taken after PR A's migration was applied, with `apps/auth` and `apps/api` both pointed at the clone. Does not touch production. |
| **PR B: Cutover** | 3, plus the code half of 4 | **No.** Merged to `develop` immediately before the window and promoted **in** the window. It holds the cutover migration (generated last in the journal; schema freeze from merge to window close), the owner's `DEPLOYED_THROUGH` bump, the `RELEASE.md` exception, the pglite DDL move, the route switch to JWT verification, the `users` model → `auth.users`, the `apps/frontend` switch to `apps/auth` (agreed with the app architect), and removal of the legacy JWT code, `tokens`, `session_version`, `is_admin`, `grant-admin.ts` and the `JWT_*` config. |
| Out of this project (follow-up issues) | 4 triggers, 5 | Drop `users_legacy` (14 days + parity + sign-off). Remove the layer (its trigger). |

**Why a feature flag cannot replace PR B.** The obvious alternative is to merge the cutover code
behind a flag and flip it in the window. It does not work here, because **the cutover migration
cannot sit in the journal on `develop`**:

- Everything in the `apps/api` journal on `develop` is, by `RELEASE.md` practice and the
  `DEPLOYED_THROUGH` assertion, applied to production before the next promote. The cutover
  migration renames `public.users`, drops `tokens` and repoints FKs. Applying it ahead of the window
  breaks the legacy code still serving, and it is not backward-compatible by design.
- A fresh `pnpm db:migrate` (the `RELEASE.md` smoke test, pglite suites, the parity test) would
  build the post-cutover schema, which flag-off code cannot run against.
- The Drizzle schema in `apps/api` can describe `users` as `public.users` or as `auth.users`, not
  both. Flag-off and flag-on code need different models and different FK targets.

So the migration has to land on `develop` at the window, and the code that depends on it has to
land with it. That is PR B. A flag could at most gate PR A's new, unwired code paths, which do not
need one.

PR B also removes the legacy JWT code, which the reference plan defers to Phase 4. Rollback is a
snapshot restore plus a redeploy of the previous Railway deployments, never a code toggle, so dead
code adds risk and buys nothing.

**Two PRs depart from the porch default of one PR per project**, so they need the owner's explicit
decision at spec-approval (Open Question C-2). The fallback is one PR holding everything, merged at
the window. It also works, but it keeps a large branch alive across the rehearsal, and it delays
the production apply of the additive `auth` migration until the window. The issue's decisions rule
that out ("migrated before the window").

The **verify** phase of this project is the cutover itself: smoke tests, the 24-hour watch, and the
rollback deadline passing.

## Success Criteria

**Schema and data**

- [ ] All Better Auth tables, `auth.jwks` included, are on `pgSchema('auth')`. `user` maps to
  `auth.users` through `modelName`. Ids are UUIDs (`generateId: "uuid"`), and a UUID written by the
  Drizzle adapter reads back unchanged in a UUID column, proven by a test against a real database
  (pglite or Postgres).
- [ ] `auth.users` carries these additional fields:
  - `first_name`, `last_name`
  - `system_key` (unique)
  - `source`, `registered_via`

  `system_key`, `source` and `registered_via` are `input: false`. `auth.users` also carries the
  admin plugin columns (`role`, `banned`, `ban_reason`, `ban_expires`), and `auth.session` carries
  `impersonated_by`. The column names are confirmed from the reviewed `drizzle-kit generate` output.
- [ ] `auth.account` has a unique `(user_id, provider_id)`.
- [ ] The additive migration drops the #59 scaffold tables in `public` only when they are empty.
  Its guard aborts the migration if any of them holds a row, and a test proves the abort.
- [ ] `packages/auth/drizzle/` is deleted, and no second journal creates `auth` tables.
- [ ] Auth timestamps are `timestamptz`, or the mapping is documented with a test showing that
  `created_at` and `updated_at` survive the copy exactly. The legacy values are `timestamptz`.
- [ ] The cutover migration does all of the following in one transaction, guarded by its
  preconditions:
  - renames `public.users` to `users_legacy`
  - copies every row into `auth.users` (same `id`, **`email = lower(trim(email))`**, derived
    `name`, `email_verified = true`, no `is_admin` or `session_version`)
  - **aborts if any two `public.users` rows collide on `lower(trim(email))`.** The guard runs
    inside the transaction, before the copy.
  - backfills one `credential` account per **non-system** user with the bcrypt hash
  - repoints the FKs on `threads`, `preferences` and `feedback` to `auth.users.id`, keeping
    `ON DELETE CASCADE`
  - drops `tokens`
- [ ] Name derivation follows the reference rule:
  - `trim(first || ' ' || last)` when it is non-empty
  - otherwise the email local-part
  - otherwise `'User'`

  `name` is never split back into parts.
- [ ] A rehearsal audit reports the number of guest accounts matching the exact guest shape
  (`^guest_[A-Za-z0-9]{10}@(askansari\.ai|ansari\.chat)$`, name "Welcome Guest"). It is
  informational only and never blocks the cutover.
- [ ] Audits run after the migration and pass:
  - the primary-key set of `users_legacy` equals that of `auth.users`
  - the number of `credential` rows equals the number of non-system users
  - **no system account has a `credential` row**
  - every FK on `threads`, `preferences` and `feedback` targets `auth.users`
  - every `ADMIN_EMAILS` entry has `role = 'admin'` after the role script
  - the set of `role = 'admin'` users equals the owner-approved inventory
- [ ] Re-running the backfill on its own creates zero duplicate `account` rows.
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
  - The **owner decides every collision before the window**. The cutover's guard then finds none.
- [ ] The parity test covers both new migrations at the two markers described under Migration SQL
  location. `DEPLOYED_THROUGH` moves once per migration: the additive bump when that migration is
  applied on staging and production, and the cutover bump by the owner in PR B.
- [ ] Both migration files follow the numbering rule:
  - merge `develop`, run generate, then rename the `.sql` file and its journal tag by hand
    (`0009_*` additive, `0010_*` cutover)
  - the snapshot keeps drizzle's index name
  - the numbering is re-checked after every `develop` merge

  A generate dry run with the real `apps/api` config shows `CREATE SCHEMA "auth"` and
  `"auth".`-qualified tables.
- [ ] The auth-touching pglite DDL in `apps/api` tests is moved to the new tables, coordinated with
  #292.

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
  `grant-admin.ts` are gone from code and schema. `apps/api` has no `better-auth` dependency.
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
  - an explicit `iss` (the `apps/auth` origin) and an explicit `aud` (the `apps/api` audience)
  - a lifetime of **15 minutes or less**
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
- [ ] A JWT whose `sub` no longer exists in `auth.users` gets 401 on any route that touches the
  user's data, never a 500 caused by a foreign-key error.
- [ ] **The revocation window is pinned.** After logout, reset, ban or deletion, a test shows:
  - the session token can no longer mint a JWT
  - an already-issued JWT is rejected once it expires
  - that window is at most the configured lifetime

  The review records the window as an accepted cost.

**`apps/api` authorization**

- [ ] Every route that used `authenticateRequest` or `requireAdmin` resolves its user from a
  verified JWT. The route set comes from a grep at PR B time, not from this list.
  - **Ownership checks are unchanged:** a user cannot read another user's thread.
  - Admin routes check `role = 'admin'` **in `auth.users` on each request**, and return the same
    401 and 403 codes as today.
- [ ] `/api/v1/chat/completions` (`LEADERBOARD_API_KEY`) and `/api/v2/mcp-complete` behave as today.
  There is no global `middleware.ts`.
- [ ] **Existing admins are preserved deliberately.**
  - Before the window, the operator produces an inventory of every `is_admin = true` user and
    compares it with `ADMIN_EMAILS`.
  - The owner approves the post-cutover admin list.
  - The role script assigns `role = 'admin'` to exactly that list.
  - An audit checks that the set of `role = 'admin'` users equals the list.
- [ ] The production boot assertion checks that every `ADMIN_EMAILS` entry exists with
  `role = 'admin'`, under the existing `shouldRunAdminStartupCheck` gating.

**Compatibility layer on `apps/api`: frozen contract**

- [ ] **Contract tests land first, written against today's implementation**, and pass **unchanged**
  against the new one. They pin, for `register`, `login`, `refresh_token`, `logout`, `me` (GET and
  DELETE), `request_password_reset` and `reset_password`:
  - status codes
  - field names and field presence (for example, `refresh_token` has no `status`)
  - error `detail`
  - the 401, 409 and 422 semantics
- [ ] Every layer route reaches Better Auth **only by calling `apps/auth` over HTTP**. It does not
  read the auth tables for sign-in or session state.
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
  enabled and enforces `freshAge`. The layer deletes the user's app data first, explicitly, so the
  cascade is only a backstop (split-readiness rule 5). Afterwards the session is dead and the
  user's threads, preferences and feedback are gone.
- [ ] Password reset:
  - The emailed link has the legacy shape `${FRONTEND_URL}/reset-password?token=<token>`.
  - Unknown emails get the identical response.
  - A system account receives no email and cannot gain a credential.
  - `checkPasswordStrength` runs before reset and before register.
- [ ] Reserved addresses (`@system.ansari.chat`) and the `system_key` guards return the same 409 as
  a taken email, on the layer **and** in `apps/auth`'s own sign-up hooks. The guard order in
  `register` is unchanged: validation → reserved/taken → strength → create.
- [ ] `register` still records `registered_via` from `X-Ansari-Client`, and still passes
  `first_name` and `last_name` to the newsletter opt-in.
- [ ] Clients run unmodified against the new layer in staging:
  - the released mobile flow: login, then a bearer call, then a 401 when the JWT expires, then
    refresh, then a retry
  - the admin analytics login

**`apps/frontend` and `apps/auth` deployment**

- [ ] `apps/frontend` signs in, signs up, resets passwords and signs out through `apps/auth`. It
  sends the JWT to `apps/api`, and refreshes it from the session. On the web it does not depend on
  third-party cookies. The change is agreed with the app architect before it is built.
- [ ] `apps/auth` has a Dockerfile and a Railway service. Its watch paths include `packages/**`, and
  its healthcheck answers only when the database answers.
- [ ] Before the window, a check against production proves that `apps/auth` accepts no public
  sign-up or sign-in.
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
- [ ] **Empirical edge verification is done during PR A's work and recorded** (method, raw
  observations, verdict). It covers each production domain, `apps/auth`'s domain once attached, and
  the `*.up.railway.app` domains, and proves both properties from the Client IP section:
  - forged `X-Real-IP` and `X-Forwarded-For` values never appear as the observed `X-Real-IP`
  - two clients on different networks see distinct `X-Real-IP` values equal to their own public
    addresses, never a Railway or private-range address
- [ ] If either property fails, PR B ships the documented fallback in `apps/auth`, and tests pin
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
  - keeping `apps/auth` dark until after the migration
  - alert silencing and the snapshot or PITR baseline
  - migration apply, admin roles, and attaching `apps/auth`'s domain
  - deploying `apps/api` and `apps/frontend`, then the smoke tests
  - the **24-hour rollback deadline**: snapshot restore, a redeploy of the previous `apps/api` and
    `apps/frontend` deployments, and `apps/auth` taken dark again. After the deadline, fix forward.
- [ ] The rehearsal of the full runbook runs on a clone of production data, never a database
  production uses. It passes all audits, then boots PR B's `apps/api` and `apps/auth` against the
  rehearsed database and passes the smoke tests.
- [ ] PR B amends `RELEASE.md`:
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
  - the `users_legacy` drop
  - the layer's removal
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
HTTP. Every other item is carried forward unchanged. Under the owner's hosting decision, the
decided rate limits apply to every production sign-in, because all of them pass through `apps/auth`.

### Ownership and review boundaries (from the issue)

- The security architect reviews; every PR is in the high-risk review tier.
- Hunks touching `turbo.json`, the lockfile, `.github/`, Dockerfiles, Railway config, or
  `apps/api/drizzle/` numbering and `DEPLOYED_THROUGH` need the main architect's review. This now
  includes `apps/auth`'s new Dockerfile and service.
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
  migration is the one documented exception, applied with `apps/api` offline and `apps/auth` dark.

### Pinned dependency

- better-auth and `@better-auth/expo` stay pinned at **1.7.7**. Every behavioural claim here is
  cited against 1.7.7, and any upgrade re-verifies those claims first.

### `arch-critical.md` delta (applied at PR B)

| Current | After |
|---|---|
| Admin = `users.is_admin` | Admin = admin-plugin `role` on `auth.users`, read from the database on each admin request, never from a token claim. `ADMIN_EMAILS` = reservation + boot assertion only |
| `session_version` = the "kill all sessions" primitive | Deleting a user's Better Auth session rows is the primitive. Already-issued JWTs live until `exp` (15 minutes or less), which is the documented revocation window |
| JWT config through `config` | `apps/auth` is the only issuer (EdDSA, `auth.jwks`). `apps/api` only verifies, against the JWKS, with `alg`, `iss`, `aud` and `exp` pinned. `apps/api` never imports `better-auth` |
| Token rotation in `db.transaction` with `exec` | Retired with `tokens`. The cutover migration is one transaction |
| Users in `public.users` | All auth tables in the `auth` schema. `users_legacy` is unread |
| (new) | Client IP comes from `X-Real-IP` only. The layer-to-`apps/auth` hop forwards it only with the internal credential |
| (new) | Sign-in, sign-up, reset and session logic live only in `apps/auth`. The `/v2/users/*` layer is an HTTP client of it |
| (new) | The admin plugin's HTTP endpoints are blocked on `apps/auth` (the plugin is used for `role` only). Roles change only through the role script |

## Assumptions

- The production database has **no real identities** in the #59 scaffold tables in `public`, and
  may not have them at all. Whether they exist on staging or production is a `psql \dt` question for
  the owner (main's condition 6). Either way, the additive migration's guard refuses to drop a
  non-empty table.
- The rehearsal runs against a **clone of production data**, whatever host it runs on.
  `api-staging.askansari.ai` exists (plan 124), but it is unconfirmed whether it has its own
  database separate from production; the security architect is asking the owner (C-3). The
  rehearsal must never run against a database that production also uses. It needs an `apps/auth`
  instance too.
- The operator can take a database snapshot, or use PITR, and restore it within the 24-hour
  deadline.
- Railway's `X-Real-IP` behaviour as stated by staff holds on our domains. It is verified during
  PR A's work, not assumed, and the spec carries a fallback if it does not hold.
- `apps/api` can reach `apps/auth` reliably, over the public domain or the private network (the plan
  chooses). The internal credential protects either.
- Released mobile builds send `Authorization: Bearer` on every authenticated call, treat
  `access_token` and `refresh_token` as opaque strings, and refresh and retry on a 401. So a
  15-minute access token only adds periodic refreshes, and nothing in the legacy client decodes the
  token. The plan verifies this by reading the legacy client source (`ApiService.ts`
  `fetchWithAuthRetry`), including how concurrent 401s behave with no single-flight guard.

## Solution Approaches

The owner settled hosting and the token model at the spec-approval gate on 2026-10-15. The
approaches below record what was considered and why. The PR shape (C-2) is still open.

### Approach 1: Separate `apps/auth` service, JWT/JWKS verification in `apps/api`, layer as an HTTP client (chosen by the owner)

As described in Desired State.

- **Pros:**
  - Auth is a separate deployable, as #49 intended. `apps/api` holds no auth logic and no auth
    secret, only public keys.
  - Per-request verification is stateless: no database read, no network hop, and it keeps working
    from the cached JWKS while `apps/auth` is down.
  - One limiter, database-backed, covers every sign-in path.
  - `apps/frontend` uses Better Auth natively, so the layer's removal trigger becomes meaningful.
- **Cons:**
  - The **revocation window** equals the JWT lifetime (15 minutes or less).
  - A new service, domain and Dockerfile.
  - Key management (`auth.jwks`, rotation, caching).
  - An authenticated internal hop for the layer.
  - A client change for `apps/frontend` inside the window.
- **Risk:** medium-high. More moving parts land in the window. The dark pre-deployment of
  `apps/auth`, a full rehearsal with both services, and the snapshot rollback mitigate it.

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

**PR shape (independent of the above):** two PRs (recommended; see Phasing), or a single PR merged
at the window.

## Open Questions

**Critical (blocks progress)**

- **C-1: Migration SQL location.** This spec places the `auth` DDL and the cutover migration in the
  single `apps/api/drizzle/` journal, and retires `packages/auth/drizzle/`. The main architect agreed
  under seven conditions, all included above. **Resolved:** the owner confirmed no external
  migration framework is needed and Waleed is not a reviewer; the cutover is a plain
  `INSERT … SELECT` in the offline window.
- **C-2: Two PRs (owner, at spec-approval).** May this project ship PR A (prepare) and PR B
  (cutover) instead of the porch default of one PR? The reasons, including why a feature flag
  cannot replace PR B, are in Phasing.
- **C-3: Staging database.** `api-staging.askansari.ai` exists (plan 124). Does it have its own
  database that a production clone can be restored into, with room for an `apps/auth` staging
  instance? If not, who provisions one? The rehearsal is a hard prerequisite for PR B.

**Important (shapes design)**

- **I-1 (resolved, owner, 2026-10-15):** `apps/auth` is a separate service, and `apps/api` uses JWT
  verification.
- **I-2 (resolved):** every sign-in passes through `apps/auth`'s database-backed limiter, so the
  layer needs no limiter of its own.
- **I-3: Layer removal trigger.** "90 days after cutover or ≥ 95% new-client adoption, whichever
  first", owner Amr, carried from the reference. Is it measured by `/v2/users/*` traffic share or by
  released build versions? This affects only the follow-up issue.
- **I-4: Cutover timing.** Who is the operator, and what is the window? This is needed for the
  runbook, not for PR A.
- **I-5: `apps/auth` domain** (owner and main architect), for example `auth.askansari.ai`. Should
  `apps/api` reach it over that domain or over Railway's private network?
- **I-6: `apps/frontend` change and release timing** (app architect).
  - The web build ships in the window.
  - If a native `apps/frontend` build pointed at `apps/auth` is released to the stores, a snapshot
    rollback leaves it talking to an `apps/auth` with fewer users.
  - Does any native `apps/frontend` build ship before the rollback deadline passes?
- **I-7: JWT lifetime.** 15 minutes, the default and the ceiling this spec allows, or shorter? It
  trades the revocation window against refresh traffic to `apps/auth`.

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
   JWT is still valid.
6. Password reset: the request emails a legacy-shaped link. The reset succeeds with a strong
   password, and no prior session can mint a new JWT.

**Edge cases**

7. A user with null first and last names, and a user with an empty email local-part, get the
   derived `name` (local-part, or `'User'`). `first_name` and `last_name` copy as null, and
   `login`'s response matches today's handling of null names.
8. A password longer than 72 bytes on a bcrypt hash verifies exactly as it does today, truncated.
9. `DELETE /v2/users/me` with a session 25 hours old succeeds. The session is dead, the layer's
   explicit delete removes threads, preferences and feedback (the same test passes with the FKs
   dropped), and the user's unexpired JWT gets 401 on data routes.
9a. Split readiness: `apps/api`'s database role cannot read `auth.account`, `auth.verification` or
   `auth.jwks`; `apps/auth`'s role cannot read `public`; the source scan finds no join between
   `auth` and `public` tables and fails on a planted one.
10. Re-running the backfill inserts zero `account` rows. The cutover migration run against a
    non-empty `auth.users` aborts with no changes.
11. A fresh empty database migrated through the full journal produces the post-cutover schema, and
    the parity test passes.
12. A timestamp at a DST boundary or carrying microseconds is identical after the copy.
13. A legacy row stored as `  Alice@Example.COM` (mixed case, padded) is migrated as
    `alice@example.com`. It signs in with `ALICE@example.com` and its unchanged password, keeping
    the same UUID and threads. Registering `alice@example.com` returns the taken-email 409.
14. The cutover migration run against two legacy rows `Bob@x.com` and `bob@x.com` aborts with no
    changes, and the pre-window audit reports that pair.
15. The additive migration run against a `public.account` scaffold table holding one row aborts and
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
20. A system account cannot log in, has no `credential` row, and a reset request for it sends no
    email and creates no credential.
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
31. Before the window, production `apps/auth` refuses public sign-up and sign-in.
32. IP fallback (only if the edge check fails):
    - Five wrong passwords for one email within 60 seconds, then the right password: 429.
    - After the window ends, the right password succeeds.
    - Ten correct sign-ins in a row are never limited.
    - Lockouts across many distinct emails fire the list-walk alert, which contains no raw email.

**Non-functional**

33. JWT verification on `apps/api` adds no database read and no network hop per request in steady
    state (JWKS cached).
34. Cutover migration runtime on the production-sized clone is measured in the rehearsal and fits
    the window.

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Mass lockout after cutover | Low | Critical | Dual verify with a removal-detecting test; legacy-row login test on both paths; full rehearsal with both services; 24-hour snapshot rollback |
| Released mobile users stranded | Low | High | Contract tests written against today's implementation pass unchanged; unmodified-client run in staging, including the expire-refresh-retry cycle |
| Revoked user keeps access until JWT `exp` | Certain (by design) | Medium | 15 minutes or less (I-7); admin role read from the database; deleted `sub` rejected; window documented in arch-critical |
| JWT verification misconfigured (alg confusion, missing `aud` or `iss` check) | Low | Critical | Pinned `alg`, `iss`, `aud`, `exp`; rejection-matrix tests |
| Token payload leaks PII | Medium if the default is kept | Medium | `definePayload` restricted to `sub` and the session id; key-set test |
| `apps/auth` outage blocks sign-in and refresh | Medium | High | Cached JWKS keeps issued tokens working; healthcheck and alerting on `apps/auth`; rollback runbook |
| JWKS fetch amplification via random `kid` | Low | Medium | Rate-limited re-fetch; test |
| `apps/auth` reachable before the window, accepting sign-ups | Medium if overlooked | High | Deployed dark; production check before the window; cutover guard aborts on a non-empty `auth.users` |
| Rate limit collapses into one global login bucket (edge or internal hop) | Medium without the fix | High | `X-Real-IP` only; authenticated forwarded IP on the hop; multi-entry XFF and two-client tests; empirical edge verification |
| Internal credential leaked | Low | Medium | It only selects a rate-limit key and reaches internal-only endpoints; held in two service environments; rotated with them; never logged |
| Railway changes `X-Real-IP` semantics later | Low | Medium | Documented header; re-verify on any Railway networking change; an arch-critical fact makes the dependency visible |
| Admin HTTP surface abused (stolen admin token or frontend XSS leads to account takeover) | Low | Critical | Whole admin surface blocked: `disabledPaths` plus a case-insensitive prefix middleware before `toNodeHandler`; variant tests; enumerating regression test |
| `apps/frontend` client change slips or breaks in the window | Medium | High | Agreed with the app architect up front; rehearsed; web rollback by redeploy; native release timing decided (I-6) |
| Cutover code merged early freezes releases | Medium under one PR | High | Two-PR split; PR A is production-safe by construction |
| FK repoint or `DROP tokens` fails mid-window | Low | High | One transaction with precondition guards; rehearsed on a clone |
| Admin boot assertion crash-loops | Low | High | Role script runs before the deploy; the assertion is checked in the rehearsal |
| System accounts become loginable or resettable | Low | High | Backfill `WHERE system_key IS NULL`; audit; reset refusal test |
| Legacy admin silently dropped or added | Medium if overlooked | High | Owner-approved inventory; role-set audit |
| Mixed-case legacy email becomes unfindable | Unknown (older rows unverified) | High | Copy `lower(trim(email))`; in-transaction collision guard; pre-window audit with owner decisions; mixed-case sign-in test |
| Two migration journals drift | Medium if both kept | High | Single journal; retire the scaffold journal |
| Migration numbering collides after a concurrent merge | Medium | Medium | Numbering rule: merge `develop`, run generate, rename, re-check after every merge; schema freeze from PR B's merge to window close |
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

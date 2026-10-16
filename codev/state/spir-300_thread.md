# spir-300 thread — Better Auth migration (issue #300)

## 2026-10-14 — specify, iteration 1
- Spawned strict SPIR. No spec 300 existed; writing it fresh from the #60 reference spec/plan
  (`codev/specs|plans/60-better-auth-migration-reference.md`, left untouched per security architect).
- Security architect is the reviewer; owner rule: no AI attribution in commits/PRs/comments.
- Three must-resolve items from the issue: client-IP source on Railway, migration SQL location
  (Waleed), phasing. Researching Railway header behaviour and the repo's migration tooling first.
- Findings that shaped the spec: `apps/auth` has no Dockerfile/Railway service (never deployed);
  the "ported migration framework" (Waleed) does not exist in the repo; `main` is ff-only from
  `develop`, so cutover code merged early would freeze releases; `apps/frontend` also uses `/v2/users/*`.
- Spec draft decisions: client IP = `X-Real-IP` only (Railway docs + staff; verify empirically
  pre-window); single migration journal in `apps/api/drizzle/` (FK repoint forces it); Better Auth
  in-process in `apps/api` with no public `/api/auth/*` at cutover (departure from ref Q5); two PRs
  (A prepare = prod-safe, B cutover = merged at window) — needs architect authorization (C-2).
- Security architect review applied (60ca04d): IP check moved into PR A work (overwrite + distinctness),
  with a fallback; hosting and the two-PR split recast as owner proposals; added why a flag can't replace PR B.
- Main architect agreed to the single `apps/api` journal with 7 conditions (issue #300 comment
  03:40Z), all folded in. Generate dry run (drizzle-kit 0.31.10): `CREATE SCHEMA "auth"` + qualified
  tables OK, no schemaFilter needed, but the prefix = journal idx → `0008_*` collides. Main ruled:
  generate then hand-rename sql + journal tag (0009 additive, 0010 cutover), snapshot keeps the idx
  name, re-check after every develop merge.
- Consult iter1: Gemini APPROVE; Codex REQUEST_CHANGES (DB-backed layer limiter, admin inventory,
  scaffold-drop guard, "byte-compatible" wording) — all applied. Security: IP fallback counts
  failed attempts only per email, accepted 60s-window lockout risk, list-walk alert.
- Security amendment pre-approval: email lower(trim()) copy + in-tx collision guard + pre-window case audit (owner decides collisions) + mixed-case test; bearer requireSignature pinned unset (released clients hold raw tokens).

## 2026-10-15 — owner decisions at spec-approval
- Owner: Better Auth runs as its own service `apps/auth` (never inside `apps/api`); `apps/api`
  verifies JWTs via `apps/auth`'s JWKS (overrides the issue's "bearer plugin" decided item);
  `/v2/users/*` stays on `apps/api` as an HTTP client of `apps/auth`; `apps/frontend` signs in at
  `apps/auth` from cutover.
- Spec reworked: revocation window = JWT lifetime (≤15m, accepted cost); admin role read from DB per
  request; `definePayload` limited to sub + session id (default payload is the whole user object);
  `apps/auth` deployed dark pre-window (else sign-ups break the cutover guard); authenticated
  api→auth hop carrying the client IP (else the layer's egress IP becomes one global bucket);
  impersonation disabled; one DB-backed limiter covers every sign-in.
- Owner: guests migrated as-is (no filter); informational rehearsal audit; follow-up issue for
  guest cleanup (feedback retention, shared links).
- Security review 166761a: whole admin HTTP surface blocked on apps/auth (disabledPaths is exact-match only, api/index.mjs:166-168 → also a case-insensitive prefix middleware before toNodeHandler); plugin kept for role column. Pending owner via security: per-request session-id check in apps/api (would close the 15m window) — not changed yet.
- FYI (main via security): builder-bugfix-260 is making the apps/api db pool lazy (apps/api/lib/db/index.ts only). Plan: use its db accessor for auth.users/auth.session reads, don't reshape lib/db/index.ts, expect a small rebase.

- 2026-10-16: Owner: Waleed is not involved in auth; no migration framework needed — cutover is a plain INSERT … SELECT from old to new tables in maintenance mode. Removed Waleed as reviewer, C-1 resolved. No comment to Waleed was ever posted on #300.
- 2026-10-16: Owner: one database now, auth tables split to a separate DB later. Added split-readiness rules to spec (separate DB roles/grants, no auth↔public joins, single identity accessor in apps/api, app tables store only user_id, explicit delete with FK as backstop, auth-only migrations). DB roles mean a new env/connection for apps/auth and changed grants — main architect owns env/Railway.
- 2026-10-16: Security review of 388371b applied: three principals (migrator owns both schemas; runtime roles no DDL), roles/grants in provisioning SQL outside the journal with ALTER DEFAULT PRIVILEGES, deploy order roles SQL -> migration -> grants -> boot in RELEASE.md (PR A), apps/api reads = all auth.users + auth.session(id,user_id,expires_at) never token, boot check expects 42501, DELETE me refuses system accounts first + idempotent app-data delete, no accessor cache. Probed pglite 0.5.4: CREATE ROLE, column GRANT, ALTER DEFAULT PRIVILEGES, SET ROLE all work; denials return 42501.
- 2026-10-16: Main ruling on #300 (roles) applied: system accounts provisioned as migrator, runtime find-only (loud error); grant-admin.ts rewritten in PR B, same name, runs as migrator; pglite proves cross-schema cascade + default privileges both schemas; boot denial check on staging+prod (Dockerfile sets NODE_ENV=production), dev/CI single-owner; RELEASE/CONTRIBUTING psql on migrator URL; 4 AUTH_* names in globalEnv. Security adds: existing owner = migrator, so current apps/api DATABASE_URL is the migrator credential; re-point step ends with it removed from all service envs + password rotated; no runtime fallback to migrator URL.
- 2026-10-16: OWNER DECISION: separate auth database from the start. Only apps/auth reaches it; apps/api keeps the app DB, public.users stays (same UUIDs, FKs unchanged) minus password_hash/is_admin/session_version; tokens dropped. Spec reworked: two journals (packages/auth kept as auth DB journal, with own parity test), cross-DB copy via operator \copy pipe + gated auth-DB transaction + cross-DB audits, app rows created on first use via internal profile endpoint, deletion via tombstone (public.deleted_users), admin role via internal apps/auth call per admin request (fail closed), system accounts app-only (getOrCreateSystemUser unchanged), change-email/update-user blocked. Supersedes split-readiness section and main ruling condition A. C-1 reopened (main must re-review journal conditions), new C-4 (auth DB on Railway).
- 2026-10-16: Security review of 102d59f applied: profile insert handles users_email_unique conflict / reserved / system email (401, ids-only log, alert); internal delete bound to subject JWT (sub must match), operator completion deletes as auth migrator; internal routes constant-time, outside BA handler, rate-limited, private network; credential-leak risk now High; copy import table is TEMP in step-2 session, no file, + password-hash checksum audit; email_verified=true is a deliberate grant, no verification emails; I-7 text records the hard-dependency cost. I-5 overlap: internal endpoints now private-network by requirement.
- 2026-10-16: OWNER DECISIONS: C-2 one PR (merged at the window); I-7 JWT lifetime = Better Auth default 15m; plain JWKS validation, no per-request session check. Sessions kept at issue-decided 30d/1d (BA defaults are 7d/1d: internal-adapter.mjs:23, create-context.mjs:147) — told owner. Spec: phasing rewritten for one PR; apps/auth not deployed to prod before window (domain attached last); auth DB created empty beforehand, baseline applied in window (overrides "migrated before the window"); prod re-point in window, staging re-point/edge check/rehearsal from branch.
- 2026-10-16: Security on 52cff7a: re-point moved AHEAD of the window as ops-only (app provisioning SQL, staging soak, prod soak, rotation); no code dependency (no runtime DDL in apps/api; lazy pool aa20376 on develop). Window = auth baseline/provisioning, copy, audits, app cutover, roles, deploys, domain.
- 2026-10-16: OWNER: I-5 = auth.askansari.ai (prod), auth-staging.askansari.ai (staging); sessions stay 30d/1d (confirmed). Remaining before approval: owner spec approval only (plus C-1 main re-review, C-3, C-4 as open questions).
- 2026-10-16: Main re-review on #300 + security conditions applied: legacy columns/tokens NOT dropped in window (window migration = email normalize + password_hash DROP NOT NULL only); runtime role column-level SELECT without password_hash during rollback window (42501 test); contract migration drops them in the first release after the 24h deadline (own DEPLOYED_THROUGH); rollback = re-grant + remove post-cutover users by created_at + redeploy (owner-accepted costs recorded); packages/auth fresh 0000 (locals recreate DB), main owns 2nd marker; APP_/AUTH_MIGRATOR_DATABASE_URL shell-only, scan + release check; copy from Railway shell only; provisioning PR first (no unmerged SQL on deployed DBs). CONFLICT: owner said one PR; architects now imply 3 PRs (provisioning, cutover, contract) — flagged as C-2 for owner.
- 2026-10-16: OWNER: no DB logins provisioned; each service uses its own DB Railway default account. Removed three-principal design, provisioning PR, re-point/rotation, runtime boot check, column grants, SET ROLE tests. Owner-accepted costs recorded (service DDL on own DB; apps/api account can read legacy hashes until contract migration; mitigated by schema+scan). Operator copy URLs renamed APP_DATABASE_URL/AUTH_DATABASE_URL (Railway shell only). Contract PR still pending owner (C-2).
- 2026-10-16: OWNER: C-2 resolved = cutover PR + contract PR after 24h deadline.
- 2026-10-16: Owner asked about API-key/header callers. Audit: leaderboard (/api/v1/chat/completions, Bearer LEADERBOARD_API_KEY, constant-time) and mcp-complete (no credential, IP-limited) unchanged; X-Ansari-Client attribution only. Gaps fixed in spec: legacy/frontend-web is also a /v2/users client (missing from Current State); apps/auth needs RESEND_API_KEY + FRONTEND_URL for reset emails; added test that leaderboard key and user JWT (same Authorization header) cannot be confused.
- 2026-10-16: Security on c19f247: added password-reset rate limit (per X-Real-IP AND per normalized email, every request counts, unknown emails same response + same budget, numbers in plan; test per-email cap across two IPs); RESEND_API_KEY + AUTH_INTERNAL_SECRET Zod minimums, never logged.
- 2026-10-16: OWNER: legacy/frontend-web is in production (same coverage as mobile build); no outside service uses user tokens.
- 2026-10-16: SPEC APPROVED by the owner (relayed by security architect). porch approve 300 spec-approval run. Entering plan phase. Security plan-phase notes: plan sets numbers for sign-in fallback + reset-request limits from production baselines, confirms layer sign-in hop transport, carries Railway-shell copy runbook + rollback runbook as reviewable files. Security reviews plan at its gate.

## 2026-10-16 — plan, iteration 1
- Plan drafted (a9b4a6c): 13 implementation phases as commits in the cutover PR; the contract PR is a verify-phase deliverable (it cannot exist before the window).
- Plan decisions the spec delegated: P-1 layer hop over the private network (AUTH_INTERNAL_URL) with the credential, plus a production 400 for requests with no IP source, so nothing reaches better-auth's shared no-trusted-ip bucket; P-2 limit numbers proposed (reset 5/15min per IP and 3/60min per hashed email; fallback ceiling max(30/min, 10× B-1 peak); list-walk alert ≥20 distinct emails in 10 min), pending production baselines B-1 to B-4; P-5 runbooks in docs/cutover/, operator SQL in apps/auth/scripts/cutover/.
- Gate questions: G-1 build the IP fallback now behind AUTH_RATE_LIMIT_MODE (default email); G-2 the production domains can only be probed in the window, without shipping code early; G-3 a fourth internal endpoint, revoke-sessions, for legacy logout (the layer holds only the JWT); G-4 the numbers.
- Verified on 1.7.7: GET /api/auth/token slides the session (getSessionFromCtx → getSession refresh, session.mjs:179-207,246-263). The legacy mobile client retries a 401 once with no single-flight guard, so the layer's refresh must never rotate the session token (it doesn't).
- 2026-10-16: Plan consult iter1: Codex REQUEST_CHANGES, Gemini COMMENT. All points accepted (11608c4).
  - Phase 7 now only builds the verifier (no route rewiring); phase 8 switches every route plus the layer in one commit (otherwise HS256 login + JWT routes).
  - G-2 needs an owner spec amendment.
  - The apps/frontend, apps/auth and packages/auth deps are assigned to phases.
  - Ban via apps/auth/scripts/ban-user.ts, plus a table-driven revocation-window test (logout/reset/ban/delete).
  - revoke-sessions is specified in phase 5.
  - The reservation includes ADMIN_EMAILS; apps/auth hooks keep 409-before-400 on sign-up and token-before-strength on reset.
  - CORS allows X-Ansari-Client; the newsletter moves to an apps/auth sign-up hook.
  - Copy SQL: provider_id/gen_random_uuid/ON CONFLICT.
  - G-5: guest-on-cold-launch vs the 3/60s sign-up limit.
  At the plan-approval gate.
- 2026-10-16: Security review of plan 11608c4 (High tier): shape approved, amendments A-D applied (0283177).
  - A: apps/auth gets two listeners. PUBLIC (PORT) never mounts /internal/* and always strips the forwarded-IP header. INTERNAL (INTERNAL_PORT, private only, no domain) carries /internal/*, the credentialed hop and the JWKS; AUTH_INTERNAL_URL points at it. Reason: the global 600/min internal limit was exhaustible from the internet, which would 503 admin routes and new users.
  - B: net.isIP on the forwarded IP.
  - C: ON DELETE CASCADE on session/account user_id, with an orphan test for 04-complete-tombstones.
  - D: residual recorded: the JWKS goes over plain http on the private network; escalation is https on the public domain if the peer inventory grows.
  - Security's positions for the owner: G-1 yes (default email); G-2 the in-window probe plus a pre-merge dig/curl passive check, with prod in the staging-verdict mode (added to the plan); G-3 yes; G-4 OK pending baselines; G-5 a separate, higher guest per-IP rule, decided with B-1.
- 2026-10-16: App architect AGREED phase 10 (issue #300 comment, 00:48Z) with four changes, applied in 7f8407e.
  - G-5 restated: the client signs in with its stored guest and signs up only when none is stored. The real issue is the bare catch, which turns 429/5xx/network errors into new guests; phase 10 narrows it to auth failure only. B-1 reports guest counts; the rehearsal adds a stored-guest sign-in.
  - No reset screens in apps/frontend: they're out of scope, filed as #304 (consumes ?token= unchanged).
  - One bearer transport on all platforms; @better-auth/expo is for storage and scheme only.
  - EXPO_PUBLIC_AUTH_URL needs no turbo edit, defaults to staging like the API URL, and is set in the Railway dashboard for the web service.
  - Phase 10 is a STACKED PR: base builder/spir-300 at a commit carrying phases 4 and 7. The app architect runs the real path on web and iOS Simulator and approves; the builder merges it into builder/spir-300. The cutover PR is still the only PR to develop.
- 2026-10-16: Owner resolved C-3 (staging is isolated and has its own DB; the prod clone is restored into the staging app DB), C-4 (the owner provisions the auth Postgres), and I-4 (the owner operates the window), in 0d85c88. Owner approved G-1 to G-5; G-2 is recorded in the spec as an owner amendment (in-window prod probe, pre-merge passive dig/curl check, staging-verdict mode). PLAN APPROVED by the human (83c5b76); ran porch approve 300 plan-approval. Entering implement, phase_1 (legacy contract tests).

## 2026-10-16 — implement, phase 1 (legacy contract tests)
- Added apps/api/tests/contract/: harness.ts (AuthBackend seam, `legacy` today), legacy-users-contract.test.ts (58 scenarios), fixtures/legacy-users.json (frozen key sets, types, literals, details). Green against today's apps/api, unchanged.
- Setup choices:
  - The app DB is built from the REAL drizzle journal (the legacy DDL exactly), not hand DDL.
  - Only two module mocks: `@/lib/db/index` (the handle points at pglite) and `resend` (records email). There is also a stand-in for the JSX email template, which this vitest config cannot load; lib/email and render stay real.
  - Real config via env, no config mock. Only Date is faked; `call` ticks 1s per request because legacy JWTs have no jti (same-second tokens are byte-identical).
- What is deliberately NOT pinned, because it cannot hold in phase 8 without forking assertions:
  - which legacy 401 detail a refresh or bearer failure carries (the status and the set are pinned, as `detailOneOf`)
  - access-token death after logout or reset (the accepted JWT window)
  - refresh-token reuse past grace
  - a stale session_version on a bearer
  - system-address reset sending an email (scenario 20 changes it)
- Pinned besides the fields:
  - malformed JSON (register/login/refresh → 500 generic; reset routes → 422 "Invalid request body")
  - zod's default missing-field message
  - the ADMIN_EMAILS-reserved 409, identical to the taken 409, case-insensitive
  - registered_via
  - the delete cascade (threads/preferences/feedback)
  - re-register after delete
- Client flows as sequences:
  - mobile login → bearer → expiry 401 → refresh → retry
  - concurrent refreshes with one refresh token both succeed
  - a revoked session → non-OK refresh
  - admin analytics login → admin/stats 200, non-admin 403
- Negative test (mutation script in scratch, run in place, each file restored): in the 9 legacy files, rename every response key, alter every 'success'/'bearer' literal and every detail/zod string, and bump every status code; run the suite each time. Run 1: 108 mutations, 83 caught. It exposed a real gap (refresh token used as bearer) and the missing ADMIN_EMAILS case, both added. Run 2: 108 mutations, 86 caught, 22 missed. Every response KEY rename is caught, except the error-path ones below. The 22 misses:
  - 1 is a comment
  - the reuse-past-grace and stale-session_version paths, unpinned on purpose (above)
  - race-only branches: the refresh recheck in its tx, the concurrent reset consume, the reset-request catch
  - 500 DB-fault paths (logout, me GET/DELETE, reset)
- Client source read (deliverable):
  - legacy/frontend-app ApiService.ts:101-128: fetchWithAuthRetry retries once (skipRefresh), with no single-flight.
  - :81-86: a non-OK refresh removes the tokens and calls resetAuth. The types only need access_token/refresh_token.
  - legacy/frontend-web ApiService.ts:12-28,127-149: a module-level single-flight promise. BUT :110-112 throw unless refresh returns status==='success', which apps/api never sends, so legacy web logs out at every access expiry today.
  - Owner decision (a): the frozen shape is kept and legacy web is RETIRED at go-live. Spec Current State, plan phase 13 and both runbooks are updated (new window step 13, rollback step 4).
- Consequence, path A (owner): apps/frontend must serve the pages live links use.
  - Plan phases 10b (#304: forgot-password, plus /reset-password?token= in the exact legacy shape) and 10c (#306: /delete-account, DELETE me with the JWT only, then discard both tokens) are stacked PRs after phase 10, and window preconditions (runbook step 1).
  - Porch cannot add phases mid-implement (only a rollback to plan, which was declined). So 10b/10c are gated by the APP architect's PR approval after the real-path run, plus the runbook check. The machine-readable JSON is unchanged.
  - Send the app architect each stacked PR number as it opens. #307 (share page) is not on this stack.
- Phase 1 consult iter1: Codex REQUEST_CHANGES (detailOneOf too broad), Gemini APPROVE. Partly accepted: exact fixtures for a garbage or expired bearer (`Invalid or expired token`), a deleted account's bearer (`Token not found or expired`; phase 8's tombstone path MUST return this string) and a garbage refresh (`Invalid or expired refresh token`). detailOneOf remains only for refresh 401s that phase 8 sees as a bare /token 401, and for a refresh token used as the bearer. Rebuttal: codev/projects/300-better-auth-migration/300-phase_1-iter1-rebuttals.md.

## Phase 2: auth database schema, fresh journal, parity guard (2026-10-16)

- `packages/auth/src/schema.ts` rewritten on `pgSchema('auth')`: users (modelName 'users'), session, account, verification, rate_limit, jwks. Shapes were taken from better-auth 1.7.7's own Drizzle generator, run with this config (uuid, jwt, admin, bearer, database rate limit, the additional fields). There are three departures: the `auth` schema, timestamptz everywhere, and `unique(user_id, provider_id)` on account.
- Old `0000_better_auth_init` and `meta/` deleted. Fresh `0000_auth_schema.sql` generated with `drizzle-kit generate`, and a re-run reports "No schema changes". Reviewed SQL: both user_id FKs are `ON DELETE cascade`, `verification` has NO user FK (confirmed), `impersonated_by` is text (as better-auth generates it).
- Ids: the pg adapter reports supportsUUIDs, so with `generateId: 'uuid'` better-auth OMITS the id and the DB default `gen_random_uuid()` makes it. Its forceAllowId regex accepts only UUID versions 1 to 5, but that path is irrelevant to the copy (SQL inserts). A test proves a SQL-inserted v4 and a v7-shaped UUID both sign in under the same id.
- Deviation (small): `createAuth()` gains `user.modelName: 'users'` and `advanced.database.generateId: 'uuid'` NOW, because without them the existing HTTP and integration tests cannot write to the new tables. Phase 3 still owns pinning the full config with removal-fails tests.
- `AUTH_DEPLOYED_THROUGH = null` in tests/migration/auth-journal-parity.test.ts. The deployed-state test is `skipIf(null)` with "SKIPPED until the cutover" in its title plus a console.warn. The "release notes record the apply" trigger is a canonical line, `auth-journal-applied: <tag>`, in RELEASE.md or any docs/**/*.md. While the marker is null, any such line fails the suite. **Phase 12/13 runbook must tell the operator to write that line.**
- Negative tests demonstrated once:
  1. Adding `drift_col` to users without regenerating fails parity with `expected ['auth.users.drift_col'] to deeply equal []`.
  2. Setting the marker to '0000_auth_schema' ran the deployed test (it passed) and failed the record test, since nothing was recorded.
  3. A docs/ file carrying the record line, with the marker null, failed with "the cutover recorded an auth journal apply; set AUTH_DEPLOYED_THROUGH to it".
  The parity test also carries automated negatives: a drifted table, a table outside the auth schema, and regex near-misses.
- Flaky (pre-existing, NOT mine): apps/api tests/thread-get-contract.test.ts "thread GET keeps today's exact keys…" fails 2 of 6 runs. Two messages tie on created_at=now(), and getThreadWithMessages orders by (created_at, id) with a random uuid id, so messages[1] is sometimes the user message. Skipped with a FLAKY annotation. It goes in the review under Flaky Tests. The fix is distinct created_at values.
- arch.md's Better Auth paragraph had the old table list (`user`/session/account/verification in the shared DB). Only that sentence is fixed now; the full arch rewrite stays in the documentation phase.
- packages/auth/turbo.json: the `test` inputs gain `$TURBO_ROOT$/RELEASE.md` and `$TURBO_ROOT$/docs/**/*.md`, because the parity test reads them. Without these inputs a warm cache would replay the null-marker guard after a record line lands. Verified: the dry-run hash changes when a docs/*.md file changes. This is a turbo hunk, so it needs the main architect's review.

### Phase 2 follow-ups (security architect, 06:11Z to 06:12Z)
- The flaky-test skip is WITHDRAWN. Main says develop already fixed thread-get-contract.test.ts (PR 301, merge 9862798, issue 292: explicit increasing createdAt). I merged origin/develop (d9ea8ac) into builder/spir-300 at abeabf2. The only conflict was that file, resolved to develop's version (identical to origin/develop, no skip). The merge also brings PR 302's lazy db handle (apps/api/lib/db/index.ts).
- After the merge: full suite green (api 934 passed + 3 pre-existing skips, frontend 624, auth 31 + 1 deliberate skip). thread-get-contract.test.ts passed 10 of 10 runs. No new flake.
- Numbering-rule re-check after this develop merge: develop added NO app migrations. The app journal still ends at 0008_model_provenance, and `drizzle-kit generate` in apps/api reports "No schema changes". This branch has no app migration yet (phase 6), so its next number stays 0009, and the plan's 0009 to 0011 still hold.
- Turbo inputs hunk: APPROVED by main. Cache-bust proof for `turbo run test --filter=@ansari/auth`:
  1. Run 1: cache miss (c4abafb2a6ee4b17; inputs changed by the merge).
  2. Run 2, warm: cache HIT, replaying c4abafb2a6ee4b17.
  3. Run 3, after appending a comment to RELEASE.md: cache MISS, executing cfaec60275ce2a6d.
  4. Bonus: with RELEASE.md restored, run 4 HIT c4abafb2a6ee4b17 again.
- Phase 2 consult iter1: Gemini APPROVE. Codex REQUEST_CHANGES, whose single issue was the it.skip on thread-get-contract, now resolved by the develop merge (develop's deterministic fix, no skip). Both reports carry a "repository moved" banner: that is my merge (0dbdb7a to abeabf2) landing during the review, not a consultant commit.
- Phase 2 consult iter2: Codex APPROVE, Gemini APPROVE (no issues).

## Phase 3: Better Auth configuration (2026-10-16)

- `createAuth()` now carries everything the cutover depends on, each piece pinned by a test:
  - `password: {hash, verify}` from `src/password.ts`: `$2a$`/`$2b$` go to bcrypt, the rest to scrypt, and new hashes are always scrypt. Legacy apps/api had no explicit 72-byte truncation; bcrypt itself ignores bytes past 72, and that is the behaviour ported and tested (scenario 8).
  - `revokeSessionsOnPasswordReset: true`. `requireEmailVerification` is unset. `emailVerification.sendOnSignUp: false`, with no sender.
  - `session` 30d / 1d.
  - Plugins: `expo`, `bearer()` (requireSignature unset), `jwt` (EdDSA, iss/aud from env, 15m, `definePayload` → `{sub, sid}`), `admin`.
  - `additionalFields` `first_name`/`last_name`/`registered_via` (`input: false`). The keys are the snake_case API names, with `fieldName` mapping to the Drizzle properties.
  - `changeEmail` and `deleteUser` are explicitly `enabled: false`.
  - `rateLimit` is enabled with database storage, `customRules` = `ROUTER_RULES` from `src/limits.ts` (every P-2 number lives there), and `advanced.ipAddress.ipAddressHeaders: ['x-real-ip']`.
- Hooks:
  - `hooks.before /sign-up/email`: email + length validation first, then reserved-or-taken (one 409, `An account with this email already exists`), then strength (400, the legacy detail). The hook also injects the derived `name` when it is missing or blank. That injection is required, not cosmetic: better-auth's body schema demands `name`, so without it a nameless sign-up is a 400.
  - `hooks.before /reset-password`: the token lookup comes first (400 `Invalid or expired reset token`), then strength. better-auth still consumes the token atomically afterwards.
  - `hooks.after /sign-up/email`: the newsletter, only on `register_to_mail_list === true` and a created session.
  - `databaseHooks.user.create.before`: the reservation again (defence in depth), `registered_via` through the shared parser, and the name if it is blank.
- Shared parser: `packages/types/src/attribution.ts` (`parseClientId`). apps/api's `lib/attribution.ts` is now a thin Sentry wrapper over it, and its attribution tests are unchanged and green. apps/api gains the `@ansari/types` workspace dependency and `transpilePackages`.
- Env (`src/env.ts`): `AUTH_JWT_ISSUER` (url), `AUTH_JWT_AUDIENCE`, `AUTH_INTERNAL_SECRET` (min 32), `RESEND_API_KEY` (min 20), `FRONTEND_URL` (url), `ADMIN_EMAILS` (normalized list), `AUTH_RATE_LIMIT_MODE` (`ip`|`email`, default `email`), and `MARKETMAKER_URL` (optional). The validation error names variables only, never values (tested). turbo `globalEnv` is untouched here: the plan puts the AUTH_* additions in phase 9. Four of the eight names already exist there: ADMIN_EMAILS, FRONTEND_URL, MARKETMAKER_URL and RESEND_API_KEY.
- NOT updated: `apps/auth/.env.example` and `.env.ci`. My permissions deny reads of `.env*` files, so I cannot edit them safely. `pnpm auth dev` now needs the new variables, and the error names them. This is flagged to the architect for phase 9 or 11.
- Newsletter departure (small): on failure it logs only the HTTP status or error name. Legacy logged the response body text, which can echo the email back.
- Dependencies (lockfile hunk, MAIN review):
  - packages/auth: `bcrypt ^6.0.0`, `resend ^6.9.3` (unused until phase 5's reset email, added here per the plan), `@ansari/types`, dev `@types/bcrypt`.
  - apps/api: `@ansari/types`.
  - apps/auth: `bcrypt ^6.0.0`.
  - pnpm also re-keyed some better-auth snapshots between `better-call(zod@4.4.3)` and `(zod@4.6.5)`, with no version changes. HEAD already had two better-auth@1.7.7 snapshot variants (differing in the `next` peer context), so packages/auth and apps/auth resolve different copies. That predates this phase and fits #265.
- FOUND AND FIXED a real deploy bug the new dependency would have caused: apps/auth's tsdown bundle inlined bcrypt's `node-gyp-build` loader, which resolves the native binding from `dist/` (and uses `__dirname` under ESM). The fix is `deps.neverBundle: ['bcrypt']` plus bcrypt as a direct apps/auth dependency. Verified: `dist/index.mjs` imports `bcrypt` externally, has 0 node-gyp-build copies, and the built service boots and listens.
- Test load: the root `turbo run test` hit vitest's 10s hookTimeout in packages/auth `beforeAll` (pglite cold start) in 2 of 5 full runs. Added `packages/auth/vitest.config.ts` (30s, the same remedy and rationale as apps/api #292/#290). Afterwards 4 of 4 forced full runs were green: auth 143 + 1 deliberate skip, api 934 + 3, frontend 624.
- Removal-fails demonstration (`scratchpad mutate.py`, one mutation at a time, the suites run, the file restored): 28 mutations, 28 caught. Highlights:
  - bcrypt branch removed → 17 fail (incl. $2a$/$2b$, >72 bytes, mixed case)
  - revokeSessionsOnPasswordReset removed → the reset test fails
  - requireSignature on → the raw-session-token test (and 11 more) fail
  - definePayload removed → the exact-key-set test fails
  - expirationTime 1h → the 900s test fails
  - expiresIn removed → 4 session tests fail; updateAge 3d → the slide test fails
  - ipAddressHeaders removed → 38 fail (everything collapses into the test-fallback bucket)
  - customRules removed / storage memory / enabled removed → the limit tests fail
  - each sign-up guard step removed or reordered → its order test fails
  - reset strength-before-token → 2 fail; reset strength removed → 1
  - registered_via, name injection, newsletter, generateId, modelName, changeEmail, deleteUser, sendOnSignUp, admin → each caught
- Limitation: `expirationTime` and `updateAge` equal better-auth's defaults (15m, 1d), so deleting them changes nothing observable. The tests pin the VALUES (a changed value fails), and the options test pins the explicit settings.
- Security (06:40Z): do NOT write apps/auth's env example or CI env files blind; they stay for phase 11. The keys to ADD there, with placeholders (names and constraints come from `packages/auth/src/env.ts`):
  - `AUTH_JWT_ISSUER=http://localhost:3100` (URL; prod `https://auth.askansari.ai`, staging `https://auth-staging.askansari.ai`)
  - `AUTH_JWT_AUDIENCE=ansari-api` (non-empty; must equal the audience apps/api verifies)
  - `AUTH_INTERNAL_SECRET=change-me-internal-secret-32-chars-min` (at least 32 chars; the same value goes in apps/api)
  - `RESEND_API_KEY=re_placeholder_key_20_chars` (at least 20 chars)
  - `FRONTEND_URL=http://localhost:8081` (URL; the base of the reset link)
  - `ADMIN_EMAILS=` (optional, comma-separated; empty is valid)
  - `AUTH_RATE_LIMIT_MODE=email` (`ip` | `email`; defaults to `email` when unset)
  - `MARKETMAKER_URL=` (optional URL; when unset, newsletter subscribe is disabled)
- Main (06:41Z, comment on #300) APPROVED: the lockfile, the package.json files, tsdown neverBundle and transpilePackages. One CONDITION, applied: `packages/types/src/**` is added to turbo.json `globalDependencies` (@ansari/types now carries runtime code, and a workspace:* dep does not enter the cache hash). Proof, by dry-run hash, with a `// cache-bust probe` line appended to packages/types/src/attribution.ts:
  - WITH the entry: ansari-api#typecheck a1db5b3b2ab3f85c → 9a1f4d0ccebd9902; ansari-api#test fbc1b4fc71a4045c → 07d89b44cc8db187; @ansari/auth#test ef47649d7cf9bde1 → 992621baa8ce8506; ansari-auth#typecheck 9b270b0e8ff20aa8 → d40d4da202429a48. All MOVE.
  - WITHOUT the entry: ansari-api#typecheck a8d8a96bb895d02d → a8d8a96bb895d02d; ansari-api#test 1938ea1d8bb94f0d → same; @ansari/auth#test d732dff7022d2b00 → same; ansari-auth#typecheck 65b80d5045ae75d1 → same. NONE move (a stale replay).
  - Real runs with the entry, ansari-api#typecheck: (1) miss a1db5b3b2ab3f85c; (2) warm HIT a1db5b3b2ab3f85c; (3) after the edit, MISS 9a1f4d0ccebd9902; (4) restored, HIT a1db5b3b2ab3f85c.
- Phase 11 deploy note (main): the apps/auth image is node:22-slim and keeps node_modules/bcrypt in the runtime stage.
- Phase 3 consult iter1: Codex APPROVE, Gemini APPROVE, no issues. Both reports carry "tree changed / repository moved" banners. Those are mine: the two consult run logs I redirected into the project dir (since deleted), and my commits 9b497be (thread env note) and c0fb40e (main's turbo condition), which landed during the review. No consultant wrote anything.

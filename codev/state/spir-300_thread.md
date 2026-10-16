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

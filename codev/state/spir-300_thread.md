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

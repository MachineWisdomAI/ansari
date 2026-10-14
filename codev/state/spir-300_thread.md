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

# air-34 — Issue forms + CONTRIBUTING.md (issue #34)

Protocol: AIR (strict). Docs + `.github/` config + one doc test. No spec/plan/review files.

## Startup
`porch init` had committed locally but its push failed: remote `builder/air-34` was a stale
orphan from an old run. Architect deleted it; I pushed the existing init commit (no re-init
needed — porch state was already intact).

## The issue was written against an older repo
Several premises in #34 no longer hold. I followed the repo, not the issue text:
- "no `.github/ISSUE_TEMPLATE/` and no CONTRIBUTING.md" — both existed (Markdown prose
  templates + a CONTRIBUTING.md covering setup/checks). So: templates REPLACED by YAML forms
  (the `.md` ones deleted, otherwise the chooser lists each twice); CONTRIBUTING.md EXTENDED.
- `backend/README`, `npm ci` in `backend/` — the app is `apps/api/` in a pnpm workspace.
  CONTRIBUTING points at `apps/api/README.md` and keeps the existing pnpm instructions.
- Required check "`backend`" — the job now emits `api (lint, typecheck, test, build)`
  (renamed in 046428f). CONTRIBUTING names that. I could not read branch protection (404, no
  admin), so "required" rests on the issue + RELEASE.md, with the name taken from ci.yml.
- "general questions → discussions or email" — Discussions is disabled on the repo, so the
  contact link is `mailto:info@iaser.ai` (the address SECURITY.md already publishes).

## Decisions
- Test parses the YAML for real, so added `yaml` as an apps/api devDependency (2.9.0 was
  already in the lockfile transitively). `pnpm add` churned unrelated lockfile lines; I reset
  it and added only the 3-line importer entry, verified with `pnpm install --frozen-lockfile`.
- Negative-tested the test: blank issues disabled, a broken link, and a stale check name each
  fail it; restored → 10/10 pass.

## Found, not fixed (out of scope)
- RELEASE.md still says the emitted check name is deliberately `backend (...)`; ci.yml emits
  `api (...)`. Stale since 046428f.
- `.github/PULL_REQUEST_TEMPLATE.md` says to run checks from `apps/api/`; CONTRIBUTING says
  repo root.

## PR
PR #257 opened against `develop`; `pr` gate requested, architect notified. CMAP skipped
(docs/config only). The branch base was ~120 commits behind `develop` and the PR came up
CONFLICTING on `pnpm-lock.yaml`; merged `develop`, took its lockfile, re-added the 3-line
`yaml` importer entry, re-verified frozen install + lint + typecheck + full test run.
Unverified until merge: how the forms render in GitHub's chooser (forms only render from the
default branch).

## Review round 1 (amrmelsayed, CHANGES_REQUESTED) — addressed
My first merge attempt was (rightly) blocked: a review landed while CI was pending.
1. Required checks: `develop` requires ALL FOUR (api, auth, frontend, gitleaks) — reviewer read
   branch protection, which I could not. CONTRIBUTING lists all four; the test now asserts the
   doc names every job `ci.yml` emits (and that there are exactly four), so a new/renamed job
   fails it. `ci.yml`'s "frontend not currently required" comment and RELEASE.md remain stale —
   reviewer flagged them to maintainers; still out of scope here.
2. New "Secret scanning" section (follow-up to #178). Each claim checked against
   `.github/scripts/gitleaks-scan.sh`, `.gitleaksignore`, `.gitleaks.toml` before writing.
3. `yaml` `^2.9.0` → `^2.9.1` to dedupe with vite's copy (non-blocking suggestion, taken).
One local `pnpm test` run failed in `@ansari/auth` `tests/auth.integration.test.ts` immediately
after a `pnpm install`; two runs either side of it passed (8/8). Not reproduced, untouched by
this PR — possible flake, noted for the PR.

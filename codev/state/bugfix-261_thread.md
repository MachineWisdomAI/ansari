# bugfix-261 thread

## Investigate (2026-10-12)

- Reproduced: `gh api graphql ... contactLinks` on iaser-ai/ansari (default branch `develop`
  @ a7134cb) returns only "Report a security vulnerability". The "General question" link is
  missing.
- Root cause: `.github/ISSUE_TEMPLATE/config.yml:8` uses `url: mailto:info@iaser.ai`. GitHub
  discards non-https contact links. The test in `apps/api/tests/contributor-docs.test.ts`
  only checked that a link named like "question" exists in the file, not its URL scheme.
- Surprise: the worktree was spawned from a stale base (75a75cf, 673 commits behind
  iaser-ai `develop`; the fork's `origin/develop` is stale too) and did not contain
  `config.yml` or the test at all. Merged iaser-ai `develop` (a7134cb) into the branch so
  the fix applies to the real files. No conflicts.
- Scope: two files, a few lines. Fits BUGFIX.
- Fix choice: point the link at
  `https://github.com/iaser-ai/ansari/blob/develop/CONTRIBUTING.md#filing-an-issue`, which
  already says to email `info@iaser.ai`. Enabling Discussions is a maintainer decision and
  was left alone.

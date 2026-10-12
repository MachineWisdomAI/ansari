# air-271 thread — remove HeroUI Native (keep Uniwind)

- Spawn left an unrelated pnpm-lock.yaml edit (dropped `catalogs`/`overrides`); restored to HEAD before starting.
- Full `pnpm install` after editing package.json re-resolved unrelated deps (better-call zod 4.6.5→4.4.3). Switched to `pnpm --filter ansari-frontend remove …` for a minimal diff. The remaining non-HeroUI lockfile lines: (a) `typescript-eslint` added to the lockfile `catalogs` block (it was already in pnpm-workspace.yaml; develop's lockfile simply lacked it, though `--frozen-lockfile` tolerated that), (b) `@typescript-eslint/{types,tsconfig-utils}@8.67.0` pruned as `project-service@8.66.0` deduped onto 8.70.1.
- My first README/arch wording said "HeroUI Native was removed in #271"; the issue requires 0 `heroui` hits in the live tree, so I dropped the mention. The history lives in git and the PR.
- Verified: grep 0 hits (probe-tested), lockfile 0 hits, expo install --check clean, gen:types runs, lint/typecheck/test(611)/build green with --force, headless web export renders home, no error boundary.

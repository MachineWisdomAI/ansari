# air-54 thread — issue #54 (packages/tsconfig exports map)

## 2026-10-10 — implement

Issue offers two fixes: add an `exports` map, or document why there is none. Chose
the map — it is what removes the sibling divergence; the README now documents the
one sharp edge it introduces.

- `packages/tsconfig/package.json`: `"exports": { "./base.json": "./base.json" }`.
  Key keeps the `.json` extension because all five consumers extend
  `@ansari/tsconfig/base.json` verbatim (apps/api, apps/auth, apps/frontend,
  packages/types, packages/auth). Plan 48 already warned that an exports map missing
  that exact entry silently breaks the extends chain.
- `packages/tsconfig/README.md`: new "Exports" section.

No test file added: the change is declarative, and every consumer's `typecheck` is
already the regression test. Proved that rather than assumed it — `tsc --showConfig`
across the five consumers:

- with the map: 5/5 exit 0
- without it (HEAD): 5/5 exit 0, output byte-identical to the above
- known-bad key `./base` (no extension): 0/5 exit 0, all `TS6053: File
  '@ansari/tsconfig/base.json' not found`

So the map is live (TypeScript does resolve through it) and a wrong key is loud.

Full run: typecheck 6/6, lint 5/5 (7 pre-existing api warnings, 0 errors), api tests
763 passed / 3 skipped, builds for api / auth / frontend all green (run sequentially
with the `.env.ci` dummy env, as CI does).

## 2026-10-10 — pr

PR #258 opened against `develop`; review is in the PR body. CMAP skipped (config-only
change). Porch `build` check needs `apps/api/.env.ci` loaded in the calling shell —
same worktree env gap air-57 and air-87 recorded. Waiting at the `pr` gate.

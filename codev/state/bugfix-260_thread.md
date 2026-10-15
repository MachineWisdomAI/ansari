# bugfix-260 thread

## 2026-10-15 — investigate + fix

Worked from the architect's re-scope comment on #260, not the original body: make the api
build env-free, rather than teaching porch to load `.env.ci`.

**Reproduced.** The worktree's `apps/api/.env` is a symlink to main's real env, and Next
loads `.env` itself. So for an env-less run I moved the symlink into the scratchpad and ran
`env -i PATH="$PATH" HOME="$HOME" pnpm --filter ansari-api build`. It failed with
`Environment validation failed` from `get database` and
`Failed to collect page data for /api/v2/preferences`.

**Root cause.** `apps/api/lib/db/index.ts` ran `drizzle(getPool(), …)` at module load.
`getPool()` reads `config.database.url`, which runs `getEnv()` and Zod-parses the whole schema.

**Fix.** `db` is now a Proxy over a drizzle instance that is created on first property
access. Its type is unchanged (`NodePgDatabase<schema> & { $client: Pool }`), so `Executor`
and the `vi.mock` factories still work as before. `closeDb()` also resets the instance.
`getEnv` and the schema are not touched.

**Audit.** I grepped for module-scope initialisers (`const x = call(` / `new X`) across
`lib` and `src`. The only hits were `envBudgetMs` in `agent.ts`, which reads raw
`process.env` with defaults and no Zod, and the new Proxy. The grep matches the old
`drizzle(getPool()` line, so it does catch this pattern. Empirically, the env-less build
passes with only the db change.

**Evidence.**
- Env-less api build: exit 0 with the fix. With the eager pool restored it exits 1 with
  `Environment validation failed`.
- Porch's actual check: env-less `npm run build -- --force` at the root gave 4/4 tasks,
  0 cached. apps/auth's tsdown build needs no env either.
- The new `tests/db-lazy-init.test.ts` fails on the eager pool and passes with the fix.
- Full api suite with `.env.ci`: 85 files, 875 passed. The first full run had one failure in
  `thread-get-contract.test.ts` while the root build was running alongside it. That file
  passed alone both with and without the fix, and a later unloaded full rerun was green.
  The failure was load-sensitive, not caused by this change.

**Docs.** Updated: CONTRIBUTING (Checks section and the Codev bullet from #291),
apps/api AGENTS.md and CLAUDE.md (twins), the PR template, the Dockerfile comment, and three
lessons-learned entries. I left the Dockerfile's `.env.ci` load in place on purpose, since it
is the deploy path and keeping it is harmless. Only its comment now says it is optional.

# bugfix-292 thread

## Investigate (2026-10-15)

Scope per architect: four mechanisms (#292 lists 3, architect added a 4th mid-investigation).

1. pglite `beforeAll` vs vitest 10s default hookTimeout — not yet reproduced (3 loaded runs, 14 busy loops / 14 cores); heavier run pending.
2. eslint-env-guard "real tree is clean" case runs under the 5s default — REPRODUCED under load: `Test timed out in 5000ms` (1 in 3 loaded runs).
3. `created_at` ties (pglite now() ms resolution, ORDER BY created_at, id with random uuid) — REPRODUCED idle: thread-get-contract.test.ts alone, **12/30 red** at :266 (issue measured 3/30). documents-endpoints.test.ts already seeds explicit `createdAt: at(n)` + fixed ids, so it is not affected.
4. Wall-clock facilitator budgets — REPRODUCED under load: facilitator-empty-final.test.ts:251 expected 3 calls got 2. Round 1 is setTimeout(100) vs soft deadline at 150ms; a late round 1 sends the next iteration's T2 check (agent.ts:681) straight to synthesis.
   Audit: race shape also in facilitator-toolcalls (T2 budget_skipped, 20ms soft window), facilitator-inkling-rung (rescue-skipped, catch must land <150ms), facilitator-budget (first tool must dispatch <150ms; terminal case asserts wall elapsed<600). model-provenance uses budget==reserve (soft deadline at t=0) — load-safe, leave alone.
   Architect direction: fake Date+setTimeout, drive with advanceTimersByTimeAsync; fall back to widening only if agent.ts won't cooperate.

Constraints from architect: keep DDL per file, minimal edits in pglite setup blocks (spir-300 will rewrite auth DDL later), no AI attribution.

### Heavy-load repro (28 busy loops / 14 cores, 5 api-suite runs): 5/5 red
- eslint-env-guard tree-lint: 5/5 `Test timed out in 5000ms`.
- grant-admin "promotes an existing account…": 2/5, 5s test timeout (real bcrypt cost 12 in the body).
- migration-schema-parity "work against the full migration journal": 2/5, 5s test timeout — its sibling "deployed on staging/production" already carries 20_000 with a comment saying exactly this; the full-journal case does not.
- facilitator-empty-final T2 synthesis: 2/5 (mechanism 4).
- No `beforeAll` hook timeout (10s) in 8 loaded runs on this 14-core box. The #290 reporter saw whole-file reds (hook-shaped) on their machine. So the deadline that trips here is the 5s TEST default, not (only) the hook default.

Root cause, mechanisms 1+2: vitest defaults (5s test / 10s hook) applied to bodies and hooks whose cost is CPU-bound and scales with machine load (pglite WASM cold start + migrations, ESLint cold config + tree lint, bcrypt). Fix plan: config-level testTimeout + hookTimeout in apps/api/vitest.config.ts with a comment naming #292/#290. No shared DB, no DDL edits.

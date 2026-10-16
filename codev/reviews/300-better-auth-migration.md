# Review: Better Auth migration

> Started during implementation (phase 8) to record decisions as they are accepted. The review
> phase completes the remaining sections.

## Accepted behaviour changes on the legacy surface (phase 8)

The `/v2/users/*` compatibility layer passes the phase 1 contract suite unedited; its fixtures
and assertions are pinned by SHA-256 to phase 1's commit `60b1118`
(`apps/api/tests/contract/contract-frozen.test.ts`; main accepted the pin in place of a CI diff
step). The security architect accepted five responses the legacy surface did not give before the
cutover (2026-10-16). None is pinned by the contract; each has a test in
`apps/api/tests/auth/layer.test.ts`. The spec records them under "Departures and their costs".

1. **429 passthrough.** `login`, `register`, `request_password_reset` and `reset_password` answer
   429 `{detail: 'Too many requests. Please try again later.'}` with `Retry-After` when
   `apps/auth`'s limiter refuses, so the shared database-backed budget holds through the layer.
2. **503 on an `apps/auth` outage.** `{detail: 'Authentication service unavailable'}`, never a
   credentials error, on the layer routes, first-use app-row creation and admin role checks.
3. **8-character minimum on reset.** Better Auth's `minPasswordLength` refuses a strong
   7-character password the legacy route accepted; the answer is the legacy weak-password detail.
4. **`register` refuses any `public.users` holder** of the address with the identical 409 (the
   plan said `system_key` rows only), so the app insert cannot fail after `apps/auth` has created
   the user.
5. **System-account `DELETE /v2/users/me`** answers 403 `{detail: 'System accounts cannot be
   deleted'}` before anything is touched ("Two databases" rule 5, step 1).

## Lessons for the lessons-learned pass

- **A rule that exists only in production needs a production-mode test** (phase 8, found by the
  Codex consult; security asked for it to be recorded). apps/auth refuses any `/api/auth/*`
  request with no usable client IP, but only when `NODE_ENV=production`. Every suite ran apps/auth
  in test mode, so all of them passed while apps/api's JWKS fetch, which carries no end-user IP,
  would have been refused in production and every switched route would have answered 401 on the
  first cold-cache request. The fix served the internal JWKS ahead of that rule; the permanent
  guard is a suite that runs the whole legacy cycle against a production-mode apps/auth from a
  cold JWKS cache (`apps/api/tests/auth/layer.test.ts`, "against apps/auth in production mode"),
  plus production-mode JWKS cases in `apps/auth/tests/client-ip.test.ts`. Removing the fix makes
  both fail.

## Deviations recorded during implementation

See `codev/state/spir-300_thread.md` (one section per phase) for the full list with reasons. The
review phase summarizes them here.

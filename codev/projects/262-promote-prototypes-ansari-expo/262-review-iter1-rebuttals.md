# PIR #262 — review iteration 1: responses

## Codex — REQUEST_CHANGES (HIGH)

**Finding:** `composerBottomPad` fixes a native worklet crash, but no test covers its required
`'worklet'` directive. The 606 tests would still pass if it were removed, and the cited AST scan
is uncommitted.

**Agreed; fixed in fe68dfc.** This is a native-only crash that web and every existing test are
blind to, so it needed a guard that runs in CI.

- `apps/frontend/lib/worklets.test.ts` commits the AST scan as a vitest test. It parses every
  non-test source in `app/ components/ hooks/ lib/ constants/` with the TypeScript compiler API.
  It asserts that every call inside a worklet body (callbacks passed to `useAnimatedStyle`,
  `useDerivedValue`, `useAnimatedProps`, `useAnimatedReaction`, `useFrameCallback`,
  `useAnimatedScrollHandler`, `runOnUI`, and any function whose body opens with `'worklet'`)
  targets a worklet-marked function (resolved across files), a closure declared inside the
  worklet, or a worklet-safe built-in. It also guards against passing vacuously (more than 50
  sources scanned).
- A second test pins `composerBottomPad` as a worklet.
- **Negative-tested:** with the directive removed, 2 tests fail with
  `app/chat/[id].tsx:300 composerBottomPad()` and `app/index.tsx:208 composerBottomPad()`;
  restored, 5/5 pass. Fixtures prove the scan flags a same-file and a cross-file plain call and
  passes a marked helper, an in-worklet closure and `Math.*` (the scratchpad version's `at()`
  false positive is gone).
- Full suite: 45 files / 611 tests; lint 0 errors; typecheck clean.

## Gemini — APPROVE (HIGH)

No key issues. Nothing to address.

## Note: "repository moved during the codex review"

HEAD moved 0543e4d → 2a927f0 while Codex ran. That was my own commit: a docs-only README change
the architect asked for (README EAS section → RELEASE.md pointer, plus one review-file line).
`git diff --stat 0543e4d 2a927f0` touches only `apps/frontend/README.md` and the review file. The
code Codex reviewed is unchanged by it.

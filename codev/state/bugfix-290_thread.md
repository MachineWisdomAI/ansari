# bugfix-290 thread — frontend jsdom tests flake under load

Scope (architect:app brief): apps/frontend half only. The api half is #292 (main); apps/api is untouched.

## Investigate (2026-10-13)

Baseline, `turbo run test --force --filter ansari-frontend --filter ansari-api` with `.env.ci`: 5/5 green.
The loaded symptom depends on machine load. The ambient load average here swung between 33 and 50 (other apps), and that alone moved
AmbientVideo's first test from 237ms to 3096ms. Under 14 busy-loop CPU hogs, the frontend suite ran 8 times: 7 green and 1 red with
the ScrollDismiss unhandled error.

Two independent causes, neither in component code:

1. **ScrollDismiss**: react-native-web's `ScrollViewBase.handleScroll` arms a 100ms scroll-end
   `setTimeout` and never clears it on unmount. With `keyboardDismissMode='on-drag'` it runs
   `ScrollView._handleScroll` → `dismissKeyboard` → `TextInputState.currentlyFocusedField` →
   `document.activeElement`. The error needs the timer to fire after jsdom teardown and before the
   next file's environment defines `document` again, so it shows only when that gap widens under load.
   The stack captured under stress matches the issue exactly.
2. **AmbientVideo**: there is no DOM leak. `advance()` walks fake time in 10ms `act` steps (about 6,100 commits for
   the 61s soak in the first test). Under load that crosses vitest's 5s default timeout. A timed-out
   test's async body keeps running: it keeps driving the shared fake clock and module-level `player`
   while the next tests render, so every test in the file fails. `--testTimeout=40` reproduces the
   issue's signature deterministically: 12/12 failed, with null `style`, `expected false to be true`, and timeouts.

Fix plan (test-only, small): ScrollDismiss uses fake timers and drains the scroll-end timer inside `act`
before cleanup. AmbientVideo declares a time budget sized to its simulated time, and guards
`advance` so a test that has been torn down stops driving the clock (one loud failure, no cascade).
The tests still assert exactly what they asserted before.

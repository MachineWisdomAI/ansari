# pir-262 thread — promote prototypes/ansari-expo → apps/frontend (SDK 57)

## 2026-10-11 — plan phase

- Ran the full port as a throwaway spike (git archive copy in scratchpad) to get evidence for the
  plan-gate upgrade-risk report. `expo install --check` clean; tsc 24 errors → 4 root causes;
  vitest 605/606 (44 files); web export OK; expo config resolves EAS identity.
- Surprise: typecheck/tests/export were all green while the web app rendered only an error
  boundary — expo-router 57 vendors react-navigation, so the prototype's direct
  `@react-navigation/native` imports hit a different context. Found only by loading dist/ in
  headless Chrome. Fix: import ThemeProvider/themes/useIsFocused from `expo-router`.
- Native-only breaks found by tsc: RN 0.86 removed `StyleSheet.absoluteFillObject` (web RNW still
  has it → web-green, native-broken), expo-navigation-bar 57 removed `setButtonStyleAsync`.
- Open at gate: app.json `name` ("Ask Ansari" per issue vs #238 test asserting "Ansari");
  global.css left unimported (Tailwind preflight); React Compiler lint rules → warn.
- Issue correction: RELEASE.md has no prototype references today.
- Gate feedback (owner): app name "Ansari"; identity from legacy/frontend-app/app.json → scheme ansarichat (not askansari). Version kept 4.0.0 pending confirmation.
- Owner confirmed version 4.0.0.
- Architect correction: packages/auth trustedOrigins hard-codes askansari:// (+ tests) — added to phase 2; grep now repo-wide.
- main agreed auth hunk ships here; conditions added: also reject askansari:// in tests; PR body 'Shared surfaces for main' heading.

## 2026-10-11 — implement phase

- Plan approved (owner, 07:06). Commits: move (430db88) → workspace join + app config (a5c090e)
  → 4 upgrade fixes (e51a7f6) → lint (fc78165) → auth scheme (0f33a14) → Dockerfile/CI (b679a56)
  → docs (39bc873).
- Identity per owner: legacy/frontend-app (name Ansari, scheme ansarichat), version 4.0.0.
  packages/auth trustedOrigins follows the scheme; main reviewed 0f33a14, no changes.
- Found while doing the auth hunk: the "accepts <scheme>:// over HTTP" test is vacuous under vitest
  (Better Auth skipOriginCheck = isTest()). Filed by main as #266; left as is here.
- Verified: expo install --check clean; turbo lint (0 err / 49 warn), typecheck, test (44 files,
  606 tests), build; expo config resolves legacy identity + 4 plugins; headless CDP walk of dist/
  and of the Docker image (/, /about, /terms, /privacy, /chat/:id, not-found) with no error
  boundary; ask flow streams from api-staging, 24 footnote markers — same count as staging (SDK 54).
- Not verifiable by me: native device behaviour (reanimated motion, keyboard-controller, glass/blur,
  Android nav bar) — dev-approval UX pass.
- Carried verbatim, worth noting: lib/auth/store.ts comment says guest credentials are stored the
  "throwaway prototype" way (plaintext guest password); now product code — candidate for #264.
- Owner at dev-approval: deleted the unused half of the vendored Replit client (ca965ea): generated/api.ts, the barrel, and the @workspace/api-client-react alias. custom-fetch.ts and api.schemas.ts are still live, so they go to #264. Correction to my earlier evidence: footnote-marker counts vary per model answer. The valid check is that the source section renders once the stream completes ('Ansari has answered'), which it does.
- Native crash at dev-approval: '[Worklets] Tried to synchronously call a Remote Function: composerBottomPad'. Pre-existing since #121 (the #245 lesson saw native abort at launch on SDK 54). Fixed with a 'worklet' directive (a83cba4). An AST scan of every worklet body (scratchpad worklet-scan.cjs) found no other unmarked calls. app.json/package.json edits from expo run:ios were left uncommitted.

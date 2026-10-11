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

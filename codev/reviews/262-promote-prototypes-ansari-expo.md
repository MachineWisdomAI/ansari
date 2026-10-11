# PIR Review: Promote prototypes/ansari-expo to apps/frontend (Expo SDK 57)

Fixes #262

## Summary

The product frontend — the Expo app that has lived outside the workspace as `prototypes/ansari-expo` since September — is now `apps/frontend`. It was moved with `git mv` (history follows) and brought **up** to the scaffold's dependency base at d676e30 (Expo ~57.0.27, RN 0.86.3, React 19.2.3, reanimated 4.5.1, worklets 0.10.1; nothing downgraded). It joins the pnpm workspace and Turborepo graph, its vitest suite (44 files / 606 tests) now runs in CI, `Dockerfile.web` builds it, and `prototypes/` is gone. Pages and components moved verbatim, except for five named fixes that the upgrade forced or exposed. Uniwind/HeroUI stay installed and wired, but unused.

## Problem

Every user-facing frontend change since September landed in `prototypes/ansari-expo`, which sat outside the pnpm workspace with its own `node_modules`, no committed lockfile, no eslint, and a test suite CI never ran. The required `frontend (lint, typecheck)` check guarded a 22-file scaffold nobody used. Staging built the prototype through a Railway Nixpacks override that bypassed the reviewed `apps/frontend/Dockerfile.web` path.

## Root cause

The prototype was imported as reference-only (#57) and kept there by the 2026-09-01 decision on #94. The owner reversed that on 2026-10-11 (decision (a): land on the scaffold's SDK 57 stack, do not downgrade).

## Fix

### The move and workspace join
- `git mv` of `app/ components/ constants/ hooks/ lib/ vendor/ public/ scripts/`, assets, and configs into `apps/frontend/`. The scaffold's two placeholder screens are deleted.
- `package.json`: the scaffold manifest is untouched at the d676e30 versions. The prototype's packages are added at the versions `npx expo install` picks for SDK 57 (`--check` clean; keyboard-controller lands at 1.21.9, Expo's pick). Runtime deps go in `dependencies`. Dropped: the `@expo/cli` pin, `@expo/ngrok`, `@babel/core`, `@react-navigation/native`, and (integration review) `expo-image-picker` and `expo-location`, which have zero imports. Package name `ansari-frontend` unchanged.
- `tsconfig.json`: scaffold `extends` + prototype `paths`; **no `baseUrl`**, because TS 6 rejects it (TS5101). `metro.config.js` keeps `withUniwindConfig`. `babel.config.js` drops `unstable_transformImportMeta`, which babel-preset-expo 57 no longer reads; the transform is on by default.
- `expo-env.d.ts` is untracked (both `.gitignore`s ignore it; the committed `types.d.ts` carries the reference).
- Root `prototype` script removed; root `pnpm-lock.yaml` is the only workspace lockfile; `pnpm -r list` still shows 7 packages.

### The five named fixes (exceptions to "verbatim")
1. **`StyleSheet.absoluteFillObject` → `absoluteFill`** (21 sites, 8 files). RN 0.86 removed it. On native it spread `undefined` and dropped absolute positioning. react-native-web 0.21 still has it, so web hid the break.
2. **`NavigationBar.setButtonStyleAsync` → `NavigationBar.setStyle`** (`app/_layout.tsx`). Removed in expo-navigation-bar 57; it would have thrown on every Android launch.
3. **`ThemeProvider` / `DarkTheme` / `DefaultTheme` / `Theme` / `useIsFocused` imported from `expo-router`** (`app/_layout.tsx`, `hooks/useScreenLandmark.ts`). expo-router 57 vendors react-navigation, so the separate package was a different React context. The web app rendered only its error boundary. Typecheck, tests and export were all green; a headless load of `dist/` found it.
4. **`Sidebar`'s `style` prop typed as `Animated.View`'s** (reanimated 4.5 typing; type-only).
5. **`composerBottomPad` marked `'worklet'`** (`constants/layout.ts`). Both screens call it inside `useAnimatedStyle`. On native: "[Worklets] Tried to synchronously call a Remote Function". This one was **pre-existing since #121**: the #245 lessons record native aborting at launch on SDK 54 with a UI-thread worklet throw, and worklets 0.10 now names it. An AST scan of every worklet body found no other unmarked calls.

### Identity decision (owner, at the plan gate)
`app.json` takes the **legacy store app's identity** from `legacy/frontend-app/app.json`: name **"Ansari"**, owner `ansari-project`, slug `ansari-chat`, **scheme `ansarichat`**, `chat.ansari.app`, EAS project `e2f465a7-…`, updates URL, fingerprint runtime policy, `extra.router.origin: false`. **Version `4.0.0`** (confirmed by the owner). Functional config comes from the prototype: `newArchEnabled`, light/dark splash, two-layer adaptive icon, `web.output: single`, plugins `expo-router`, `expo-font`, `expo-web-browser`, `expo-video` **plus `expo-secure-store`**, `experiments`. **This overrides the issue's "exactly four plugins":** the integration review requires the `expo-secure-store` config plugin for its Android backup-exclusion rules, so tokens and the guest password are not restored into another install from a device backup. `eas.json` unchanged. This overrides the issue's "f396356 verbatim" for `name` and `scheme`. Because Better Auth validates the native `expo-origin`, `packages/auth`'s `trustedOrigins` moves from `askansari://` to `ansarichat://`.

### Also
- **Lint**: `@ansari/eslint-config` + `eslint-config-expo` 57. 161 errors → 0 (49 warnings). 128 of those errors were a duplicated `export *` pair in the vendored barrel. Scoped override: the four react-hooks v7 React Compiler rules (`set-state-in-effect` 12, `refs` 9, `immutability` 3, `globals` 2) are set to `warn` with a comment pointing at #264.
- **Vendored Replit client** (owner request at dev-approval): the unused half is deleted (`generated/api.ts`, the barrel, the `@workspace/api-client-react` alias). `custom-fetch.ts` and `generated/api.schemas.ts` are still live, for #264.
- **Scripts** (owner request): `ios` / `android` run `expo run:ios|android`; `ios:device` / `android:device` added.
- **Docs**: the ported README is rewritten for the workspace (its fixes table lists all five fixes), and the arch/lessons "prototype" sections are renamed "frontend".
- **Native release path** (architect, from the #269 review): the README's EAS section no longer presents local `eas build` as the way to build. It points to RELEASE.md "Native builds and updates" (GitHub Actions → EAS, added by PR #269), keeps local `eas build` / `eas submit` labelled debugging-only, and keeps the warning that the production channel and `eas submit` reach real users. **The link resolves once #269 merges.**

## Shared surfaces for main

| Surface | Change |
|---|---|
| `packages/auth/src/index.ts`, `packages/auth/tests/auth.http.test.ts` | `trustedOrigins` `askansari://` → `ansarichat://` + comment; tests trust `ansarichat://` and reject both `ansari://` and `askansari://` (reviewed by main at 0f33a14). **New cross-config test:** reads `apps/frontend/app.json` by path and asserts `trustedOrigins` contains `${expo.scheme}://`. The vacuous HTTP origin test is #266 (main's), left as is. |
| `packages/auth/turbo.json` (new) | `extends: ["//"]`; `tasks.test.inputs` = `$TURBO_DEFAULT$`, `.env.ci`, `$TURBO_ROOT$/apps/frontend/app.json`, so a manifest-only change busts the auth test's cache. Cache evidence below. |
| `turbo.json` | **Not touched.** `test`, `gen:types` and its edges, `EXPO_PUBLIC_*` in `globalEnv` already fit. |
| `pnpm-lock.yaml` | Regenerated: +1294 / −77 (the prototype's dependency tree). The #265 expo-router 58 peer duplicate is left alone. |
| `.github/workflows/ci.yml` | Frontend job gains `Test` (`turbo run test --filter ansari-frontend...`) between Typecheck and Build; job name `frontend (lint, typecheck)` unchanged. The job comment is corrected: this check **is** required on `develop` (branch protection lists it), so a rename must change the job name and branch protection together. |
| `apps/frontend/Dockerfile.web` | The eleven legacy `EXPO_PUBLIC_*` ARGs are replaced by `EXPO_PUBLIC_API_URL`. `build:web` keeps its `gen:types &&` chain. |
| root `package.json` | `prototype` script removed. |
| `codev/resources/*` | arch.md: section renamed + new "frontend app" paragraph (identity, scheme ↔ auth coupling, env surface, Uniwind wired-unused). arch-critical: map line renamed. lessons-learned: "— prototype" sections renamed "— frontend" + a new #262 section. lessons-critical: map lines renamed; the spec 48 line also covers #262. |

## Post-merge operator steps (from #262)

1. **Railway staging** (`ansari-frontend-v4`, staging env): builder → Dockerfile `apps/frontend/Dockerfile.web`, root directory empty (repo root), watch paths as in `apps/frontend/railway.toml` (`apps/frontend/**`, `packages/**`, root `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`). Delete the Nixpacks override and the `NIXPACKS_NODE_VERSION` variable. `EXPO_PUBLIC_API_URL` only needs setting if staging should not use the baked default.
2. Verify staging serves the identical UI (the README walk: fresh browser → auto-guest → ask → stream → sidebar thread → sign-in sheet → log out → About/Terms/Privacy).
3. Close the Dependabot PRs that targeted the scaffold manifest: #219, #214, #215 (confirm #215 is scaffold-only first).
4. Per machine: drop the `prototypes/*` lines from `.codev/config.json`'s `worktree` block. In the main checkout, delete the untracked leftovers under `prototypes/ansari-expo/` (`node_modules`, lockfile) and move the real `.env.local` to `apps/frontend/` if it is still wanted.
5. Tell Omar Hamid and akhidrb the move has landed; re-apply #212's prototype half onto `apps/frontend` as a fresh PR.
6. Open the production cutover issue; start #263 (e2e) and #264 (restructure; proposed additions: move `custom-fetch.ts` into `lib/api/`, replace `api.schemas.ts`, delete `vendor/`, restore the four React Compiler rules to errors).

## Files Changed

244 files, +2112 / −1279. Of these, **150 are pure renames** `prototypes/ansari-expo/… → apps/frontend/…` (0/0). Everything else:

- `.github/workflows/ci.yml` (+7 / -0)
- `README.md` (+1 / -1)
- `apps/frontend/.gitignore` (+1 / -0)
- `apps/frontend/Dockerfile.web` (+3 / -11)
- `apps/frontend/README.md` (+192 / -42; replaced by the ported README)
- `apps/frontend/app.json` (+25 / -20)
- `apps/frontend/babel.config.js` (+9 / -0; moved, then edited)
- `apps/frontend/eslint.config.mjs` (+25 / -1)
- `apps/frontend/metro.config.js` (+3 / -0)
- `apps/frontend/package.json` (+42 / -5)
- `apps/frontend/tsconfig.json` (+11 / -3)
- `apps/frontend/src/app/_layout.tsx`, `index.tsx` (deleted: −16, −50)
- `apps/frontend/assets/images/{adaptive-icon,favicon,icon,splash-icon}.png` (scaffold images replaced by / dropped for the prototype's set)
- `apps/frontend/app/_layout.tsx` (+12 / -11), `app/chat/[id].tsx` (+1 / -2)
- `apps/frontend/components/{AmbientVideo,BrassSendButton,ChatInput,GlassCircleButton,PaperBackground,Sheet,Sidebar,SidebarDrawer,SourceStack}.tsx` (fix 1 / fix 4; +1–5 each)
- `apps/frontend/constants/layout.ts` (+9 / -1), `hooks/useScreenLandmark.ts` (+1 / -1)
- `apps/frontend/lib/{chat-trace,document-citations,footnote-groups,markdown}.ts`, `lib/markdown.test.ts`, `hooks/useRevealedText.test.tsx` (lint autofix, ±1–2)
- `apps/frontend/lib/api/{hooks,index}.ts` (comments, ±2–3)
- `apps/frontend/vendor/api-client-react/custom-fetch.ts` (+1 / -1, array-type)
- `apps/frontend/vendor/api-client-react/generated/api.ts`, `index.ts` (deleted: −592, −6)
- `apps/frontend/.env.local.example`, `scripts/retime-ambient.sh` (wording, ±1)
- `prototypes/ansari-expo/{.gitignore,README.md,app.json,babel.config.js,expo-env.d.ts,metro.config.js,package.json,tsconfig.json}` (deleted after merge into the apps/frontend files)
- `packages/auth/src/index.ts` (+4 / -3), `packages/auth/tests/auth.http.test.ts` (+8 / -4)
- `package.json` (+0 / -1)
- `pnpm-lock.yaml` (+1294 / -77)
- `codev/resources/arch.md` (+5 / -1), `arch-critical.md` (+1 / -1), `lessons-critical.md` (+8 / -8), `lessons-learned.md` (+25 / -12)
- `codev/plans/262-promote-prototypes-ansari-expo.md` (+324), `codev/reviews/262-promote-prototypes-ansari-expo.md` (this file), `codev/state/pir-262_thread.md` (+40), `codev/projects/262-…/status.yaml` (porch)

## Commits

- `e3b33ff` [PIR #262][Phase: implement] frontend scripts: ios/android build and run natively
- `c782e60` [PIR #262] thread: native worklet crash
- `a83cba4` [PIR #262][Phase: implement] mark composerBottomPad as a worklet (native crash)
- `7b07a9b` [PIR #262] thread: vendor cleanup
- `ca965ea` [PIR #262][Phase: implement] delete the unused half of the vendored Replit client
- `4807a79` [PIR #262] thread: implement phase
- `39bc873` [PIR #262][Phase: implement] docs: the prototype is now apps/frontend
- `b679a56` [PIR #262][Phase: implement] build pipeline: Dockerfile ARG surface, frontend CI Test step
- `0f33a14` [PIR #262][Phase: implement] auth: trust ansarichat:// (apps/frontend scheme), reject askansari://
- `fc78165` [PIR #262][Phase: implement] adopt @ansari/eslint-config + eslint-config-expo 57 on the ported tree
- `e51a7f6` [PIR #262][Phase: implement] fix the four SDK 57 upgrade breaks (named exceptions to verbatim)
- `a5c090e` [PIR #262][Phase: implement] join the workspace on the SDK 57 base; reconcile app config
- `430db88` [PIR #262][Phase: implement] move prototypes/ansari-expo source into apps/frontend
- `86a4eb3`, `4a4721b`, `947d764`, `0679e44`, `008c882` — plan draft and revisions
- `chore(porch)` state commits

## Testing

### Test Results

- `npx expo install --check`: ✓ "Dependencies are up to date"
- `turbo run lint --filter ansari-frontend...`: ✓ 0 errors, 49 warnings (counts above)
- `turbo run typecheck --filter ansari-frontend...`: ✓ (`gen:types` runs under the graph)
- `turbo run test --filter ansari-frontend...`: ✓ 45 files / 611 tests (the prototype's 44 files, now in CI, plus `lib/worklets.test.ts`)
- `turbo run build --filter ansari-frontend...`: ✓; `turbo run lint typecheck --filter './packages/*'`: ✓
- `turbo run test --filter @ansari/auth`: ✓ 9/9. Negative-tested: with the source back on `askansari://` it fails 1/8 (before the cross-config test), and with `app.json` `expo.scheme` set to `ansaritest` the cross-config test fails: `expected [ 'http://localhost:3100', …(3) ] to include 'ansaritest://'`, 1 failed / 8 passed.
- **Turbo cache negative test for `packages/auth/turbo.json`** (`turbo run test --filter @ansari/auth`, local worktree cache):

  | Step | Result |
  |---|---|
  | 1. baseline | cache hit `dc66d273d053813a` |
  | 2. rerun | cache hit `dc66d273d053813a` |
  | 3. `app.json` `expo.scheme` → `ansaritest` | **cache miss** `abf8f185b588f3d8`; the test runs and fails (above) |
  | 4. reverted | cache hit `dc66d273d053813a` |
  | 5. counterfactual: `packages/auth/turbo.json` removed, baseline | cache miss `3f642741b201ff3c` |
  | 6. counterfactual: scheme → `ansaritest` | **cache hit** `3f642741b201ff3c`; the guard is replayed, not run (the hole the input closes) |
  | 7. restored (turbo.json + app.json) | cache hit `dc66d273d053813a` |
- `npx expo config --type public`: name Ansari, slug `ansari-chat`, scheme `ansarichat`, version 4.0.0, `chat.ansari.app`, project `e2f465a7-…`, the four plugins.
- `docker build -f apps/frontend/Dockerfile.web .` (repo root): ✓. The image serves an `index.html` byte-identical to the local export, and `/terms`, `/chat/abc`, `/no-such-page` fall through Caddy to the SPA.
- Live-tree grep for `prototypes/ansari-expo` (excluding `codev/{specs,plans,reviews,state,projects}`): **0** hits; on the pre-move tree 7f71806: **6** hits in 5 files (`package.json`, `arch.md`, `arch-critical.md`, the prototype README ×2, `retime-ambient.sh`).
- Worklet AST scan, committed as `lib/worklets.test.ts`: 2 real hits (`composerBottomPad`) → 0 after fix 5. In-worklet closures (the `composer-shadow` `at()` helper) are recognised, so there are no false positives.
- Headless Chrome over CDP, the exported `dist/` and the Docker image: `/`, `/about`, `/terms`, `/privacy`, `/chat/:id`, an unknown route all render without the error boundary. Auto-guest registers; a question streams from `api-staging` and, once complete ("Ansari has answered"), renders its source section (numbered footnotes, hadith grades, scholarly works, Copy/Share), structurally the same as staging (SDK 54) for the same question.

### Manual verification (app architect, dev-approval)
- **Web**: export pixel-identical to staging on About/Terms, within noise on home and the sign-in sheet; Docker image serves deep links.
- **Mobile web, iOS Simulator**: the sign-in sheet stands in the shell.
- **Native iOS Simulator build** (`expo run:ios`, cleared Metro cache) after fix 5: home with the ambient layer and glass button (fix 1), sample prompt → retrieval trace row → streamed answer with the scripture box, drawer with the thread listed, sign-in sheet from the drawer, Email field focus + typing. Zero runtime errors in Metro.
- **Not verified**: Android (fix 2 is type-checked only); a physical device's motion smoothness; an actual EAS build (out of scope).

## Architecture Updates

- **COLD `arch.md` → "Monorepo layout, build & deploy"**: a new "The frontend app (`apps/frontend`, since #262)" paragraph. It covers workspace membership and CI tests; the legacy store identity; **the `ansarichat` scheme ↔ `packages/auth` `trustedOrigins` coupling** (change both together, or native sign-in fails later with nothing failing at build); `EXPO_PUBLIC_API_URL` as the whole env surface; Uniwind/HeroUI wired but unused, with `global.css` deliberately unimported; and the vendored client remnant (#264).
- **COLD `arch.md`**: section "Prototype chat display (prototypes/ansari-expo)" → "Frontend chat display (apps/frontend)", with a note that pre-#262 issue numbers refer to the prototype era.
- **HOT `arch-critical.md`**: map line renamed to match. **No new hot fact.** The tier is at its cap (10), and the scheme coupling is pinned by a comment at the coupling site and by a test that rejects the old scheme, so it is no longer a silent trap. It stays cold rather than displacing a security invariant.

## Lessons Learned Updates

- **COLD `lessons-learned.md`**: new section "Prototype promotion to apps/frontend, SDK 54 → 57 (issue #262)". Seven lessons:
  - A green typecheck + tests + export doesn't prove the bundle runs; load the built artifact (CDP, not `--dump-dom`).
  - react-native-web keeps APIs React Native removed, so web passes are no evidence for native.
  - Plain functions in worklets are native-only crashes; scan worklet bodies with the TS AST and negative-test the scan.
  - Scope invariant greps to the repo, not the moved tree (the scheme coupling miss).
  - Better Auth skips origin checks under test (#266).
  - Compare streamed answers only after the app's own completion signal.
  - `expo install` / prebuild edit `app.json` and `package.json`.
- **COLD**: the "— prototype" section titles are renamed "— frontend" (content untouched).
- **HOT `lessons-critical.md`**: no new lesson. The tier is at its cap, and the existing "'tests pass' is not 'it works'" lesson already covers the headline. The spec 48 map line is extended to point at the new #262 section (map stays at 12 topics); the "— prototype" map lines are renamed.

## Things to Look At During PR Review

- **3-way consultation (single pass): Codex REQUEST_CHANGES, fixed.** The finding: fix 5 (`composerBottomPad` `'worklet'`) had no committed regression test, so all 606 tests still passed with the directive removed, and the AST scan lived in a scratchpad. **Fix:** `apps/frontend/lib/worklets.test.ts`, the worklet scan as a committed test. It parses every non-test source in `app/ components/ hooks/ lib/ constants/` with the TypeScript AST and asserts that every call inside a worklet body (`useAnimatedStyle`/`useDerivedValue`/… callbacks and `'worklet'` functions) targets a worklet-marked function, an in-worklet closure, or a known-safe built-in. A second test pins `composerBottomPad` as a worklet. **Negative-tested:** with the directive removed, 2 tests fail and name `app/chat/[id].tsx:300` and `app/index.tsx:208`; restored, they pass. Fixtures prove the scan flags a same-file and a cross-file plain call and passes a marked helper, an in-worklet closure and `Math.*`. Gemini: APPROVE (HIGH, no key issues). PIR is single-pass, so this fix was **not** re-reviewed by a model; please check it at the `pr` gate.
- **Fix 3 is the one that green checks missed.** If anyone re-adds `@react-navigation/native` imports, the web app breaks at runtime with all checks green. Theme and focus APIs must come from `expo-router`.
- **Fix 2 (Android) is type-checked, not exercised.** No Android run was done.
- **`app/chat/[id].tsx:717`**: `didn't` → `didn&apos;t` for `react/no-unescaped-entities`; the rendered text is identical.
- **React Compiler rules at `warn`** (`eslint.config.mjs`): 26 sites. These mark components the compiler skips, not runtime errors; restoring them to errors is #264.
- **`lib/auth/store.ts` comment rewritten** (integration review): it no longer calls this throwaway prototype code. Web stores tokens and the guest password in `localStorage` (script-reachable); that is a known gap tracked in #264. Behaviour unchanged.
- **`legacy/*` lockfiles** (`legacy/frontend-app/package-lock.json`, `legacy/frontend-web/{package-lock.json,yarn.lock}`) predate this PR and sit outside the workspace; "only lockfile" holds for the workspace.
- **Comments inside moved code** still say "prototype" in a few places (`lib/api/config.ts`, `lib/auth/guest.ts`, …). They were left verbatim; #264 territory.

## How to Test Locally

- **View diff**: VSCode sidebar → right-click builder pir-262 → **Review Diff**
- **Run dev**: VSCode → **Run Dev**, or `afx dev pir-262`, or `pnpm --filter ansari-frontend dev`
- **What to verify**:
  - `pnpm install` at the root; `pnpm exec turbo run lint`, then `typecheck`, `test` and `build` with `--filter ansari-frontend...`, as separate invocations
  - `pnpm --filter ansari-frontend build:web`, serve `apps/frontend/dist` with an SPA fallback, then walk: fresh browser → auto-guest → ask → stream → sources → sidebar thread → sign-in sheet → About/Terms/Privacy
  - `docker build -f apps/frontend/Dockerfile.web .`, run it, and hit `/` and a deep link
  - Native: `pnpm --filter ansari-frontend ios` (Xcode required); run `expo start --clear` if a reload seems to replay old code

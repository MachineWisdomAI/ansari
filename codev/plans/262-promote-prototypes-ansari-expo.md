# PIR Plan: Promote prototypes/ansari-expo to apps/frontend (at Expo SDK 57)

## Understanding

Issue #262 reverses the 2026-09-01 stand-down of #94: `prototypes/ansari-expo` (the real
product, Expo SDK 54) becomes `apps/frontend`, brought UP to the scaffold's dependency base
at d676e30 (Expo ~57.0.27, RN 0.86.3, React 19.2.3, expo-router ~57.0.25, reanimated 4.5.1,
worklets 0.10.1, uniwind 1.12.2, heroui-native 1.0.10). Nothing is downgraded. Pages and
components move verbatim (refactoring is #264); Uniwind/HeroUI stay installed and wired but
unused. The prototype joins the pnpm workspace + Turborepo graph, its vitest suite starts
running in CI, `Dockerfile.web` builds it, and `prototypes/` disappears in the same PR.

The #94 plan (`origin/builder/pir-94`) is the skeleton. What changes versus it: no SDK 54
landing (decision a), `gen:types` and the Uniwind wiring stay (decision b), and the port
carries an SDK 54 → 57 upgrade, so "identical UI" is proven by behaviour, not by diff.

### Spike: what the SDK 57 port actually needs (evidence for the plan gate)

Before writing this plan I ran the whole port in a throwaway copy of the repo
(`git archive HEAD`, in the session scratchpad, nothing committed). I moved the tree, merged
the manifests, ran `npx expo install` for every prototype package, then ran `tsc`, `vitest`,
`eslint`, `expo config`, `expo export --platform web`, and loaded the exported `dist/` in
headless Chrome. Results:

| Check | Result on SDK 57 |
|---|---|
| `npx expo install --check` | **"Dependencies are up to date"** |
| `tsc --noEmit` (TS 6.0, catalog) | **24 errors**, in 4 root causes (below), all fixed in the spike |
| `vitest run` | **44 files / 606 tests; 605 pass.** The 1 failure was the spike's `app.json` name ("Ask Ansari"); with the owner's "Ansari" (resolved below) it passes unchanged |
| `npx expo config --type public` | slug `ansari-chat`, `chat.ansari.app` (iOS + Android), sdkVersion 57.0.0 resolve (spike used the scaffold's name/scheme; the plan now takes the legacy identity, see phase 2) |
| `expo export --platform web` | builds: `dist/` with the custom `public/index.html` shell (21 KB), fonts, icons, videos; 3.7 MB entry bundle |
| headless Chrome on `dist/` | **first run: error boundary ("Something went wrong").** After fix 3 below, the app renders: composer (`Ask Ansari` placeholder, `Send question`), `Menu` button, no errors except a video `play()` AbortError (see risks) |
| `eslint .` (base + expo flat) | 161 errors / 36 warnings before any fix; breakdown under phase 3 |

The four upgrade breaks. Each one forces a change to code that would otherwise move verbatim,
so each is a **minimal, named exception** to "verbatim":

1. **`StyleSheet.absoluteFillObject` no longer exists in RN 0.86** (TS2551 ×21 in 10 files:
   AmbientVideo, BrassSendButton, ChatInput, GlassCircleButton, PaperBackground, Sheet,
   SidebarDrawer, SourceStack). It is gone from `react-native/Libraries/StyleSheet/` as well
   as from the types, so on **native** `...StyleSheet.absoluteFillObject` spreads `undefined`
   and silently drops absolute positioning (ambient layer, paper, sheets, glass buttons).
   react-native-web 0.21 still has it, so **web would look fine and hide the break**.
   Fix: `absoluteFillObject` → `absoluteFill`. On RN 0.86 that is a frozen plain object; on RNW
   0.21 it prints as `{position:'absolute',left:0,right:0,top:0,bottom:0}` (verified with
   node), so spreading it is equivalent on both platforms.
2. **`expo-navigation-bar` 57 removed `setButtonStyleAsync`** (`app/_layout.tsx:173`). The call
   is wrapped in `.catch()`, but the property is `undefined`, so it would throw **synchronously
   inside a `useEffect` on every Android launch**. Fix: `NavigationBar.setStyle(...)`, the
   replacement the package documents, with the same mapping (dark scheme → `'light'` buttons).
3. **expo-router 57 vendors react-navigation** (`expo-router/build/react-navigation/`).
   The prototype imports `ThemeProvider`/`DarkTheme`/`DefaultTheme`/`Theme` (`app/_layout.tsx`)
   and `useIsFocused` (`hooks/useScreenLandmark.ts`) from the separately installed
   `@react-navigation/native`, which now has a **different React context**. On web this is the
   "Couldn't find a navigation object" error boundary. Typecheck, tests and export are all
   green with this bug, and only the headless load showed it. Fix: import the same names from
   `expo-router` (all five are exported there, `build/exports.d.ts:20-27`) and drop the
   `@react-navigation/native` dependency.
4. **reanimated 4.5 typing** (`components/SidebarDrawer.tsx:97`): an `AnimatedStyleHandle`
   is passed to `Sidebar`'s `style?: StyleProp<ViewStyle>`. Fix is type-only: widen that prop
   type to accept reanimated's animated style. No runtime change.

## Proposed Change

One PR, phases as commits (`[PIR #262][Phase: implement] …`).

### Phase 1: Move (history-preserving)

- `git rm` the scaffold placeholders `apps/frontend/src/app/_layout.tsx` and `index.tsx`
  **only**. `src/global.css`, `uniwind-env.d.ts`, `types.d.ts` stay.
- `git mv prototypes/ansari-expo/{app,components,constants,hooks,lib,vendor,public,scripts,
  babel.config.js,vitest.config.ts,PERFORMANCE.md,README.md,.env.local.example}`
  → `apps/frontend/`. The scaffold README is replaced by the prototype's, then edited in phase 5.
- Assets: `git mv` `assets/video/*`, `assets/icon-source/*`, and the prototype's
  `assets/images/*` over the scaffold's. The prototype's adaptive-icon set
  (`adaptive-icon.png` + `adaptive-icon-background.png`, generated by `scripts/build-icons.mjs`)
  covers Android, so the scaffold's `adaptive-icon.png`, `icon.png`, `splash-icon.png` are
  superseded and the scaffold-only `favicon.png` goes (web favicon = `icon.png` + the shell's
  `public/favicon.{ico,svg}`).
- **`expo-env.d.ts` reconciled by untracking it.** Both `.gitignore`s ignore it, and the
  scaffold's committed `types.d.ts` already carries `/// <reference types="expo/types" />` for
  fresh checkouts, so the duplicate goes: `git rm prototypes/ansari-expo/expo-env.d.ts`.
- `prototypes/ansari-expo/{app.json,package.json,tsconfig.json,metro.config.js,.gitignore}`
  are merged into the scaffold's files (phase 2) and then deleted. `prototypes/` disappears.
- The untracked `prototypes/ansari-expo/.env.local` in the main checkout is **never touched or
  staged**. Files are staged by explicit path only, and the diff is checked for `.env*` before
  push.

### Phase 2: Workspace membership and app config

- **`package.json`**: start from the scaffold's manifest, which keeps every d676e30 version.
  Name `ansari-frontend`. Add the prototype's packages via `npx expo install`, which in the
  spike picked: expo-blur ~57.0.3, expo-clipboard ~57.0.2, expo-font ~57.0.4,
  expo-glass-effect ~57.0.4, expo-haptics ~57.0.3, expo-image ~57.0.5, expo-image-picker
  ~57.0.20, expo-linear-gradient ~57.0.2, expo-location ~57.0.20, expo-navigation-bar ~57.0.3,
  expo-secure-store ~57.0.4, expo-symbols ~57.0.3, expo-system-ui ~57.0.4, expo-video ~57.0.5,
  expo-web-browser ~57.0.3, react-native-keyboard-controller **1.21.9**, async-storage 2.2.0,
  @expo/vector-icons ^15.1.1, the three `@expo-google-fonts/*`, babel-preset-expo ^57.0.14,
  @types/react-dom. Non-SDK packages keep the prototype's ranges: react-query ^5,
  zod ^3.25.76, zod-validation-error ^3, `@stardazed/streams-text-encoding`,
  `@ungap/structured-clone`, vitest ^3.2, testing-library, jsdom ^26, sharp ^0.35 (already in
  `onlyBuiltDependencies`). Runtime packages go in `dependencies`; test, build and type
  tooling goes in `devDependencies`. **Dropped:** the `@expo/cli 54.0.23` pin, `@expo/ngrok`
  (tunnel-only, unused by any script; re-add on demand), `@babel/core` (provided transitively),
  and `@react-navigation/native` (fix 3). Scripts: the scaffold's set, including `gen:types`
  and `build:web` with its `gen:types &&` chain and `//` note, plus `test: vitest run` and
  `build:icons`. `expo-updates`/`expo-dev-client` are already at the SDK 57 pins on d676e30,
  so f396356's pins do not move.
- **Lockfile**: `pnpm install` at the root. The root `pnpm-lock.yaml` is the only lockfile.
  `pnpm -r list --depth -1` still shows 7 packages (the prototype was never a member).
  `pnpm-workspace.yaml` is unchanged.
- **`tsconfig.json`**: the scaffold's `extends` (`expo/tsconfig.base` + `@ansari/tsconfig`),
  with the prototype's `paths` (`@/*` → `./*`, `@workspace/api-client-react` → vendor) and
  includes (`vendor/**/*.ts`, `uniwind-env.d.ts`). **No `baseUrl`**: TS 6 rejects it (TS5101,
  verified), and `paths` resolve relative to the tsconfig without it.
- **`metro.config.js`**: the scaffold's `withUniwindConfig(getDefaultConfig(...),
  {cssEntryFile: './src/global.css'})` plus the prototype's `extraNodeModules` alias for
  `@workspace/api-client-react` and its explanatory comment. Verified in the spike that
  `expo export` works with both.
- **`babel.config.js`**: `babel-preset-expo` 57 no longer reads
  `unstable_transformImportMeta`. The option is now `transformImportMeta`, default `true`
  (`babel-preset-expo/build/index.d.ts:37-43`), so the old flag is silently ignored and the
  transform is on regardless. No source file uses `import.meta`. I drop the dead option and
  keep the file with the plain preset, with a one-line comment pointing at the new default.
- **`app.json`**: **identity from the legacy store app, `legacy/frontend-app/app.json`**
  (owner decision at the plan gate, 2026-10-11; this overrides the issue's "f396356
  verbatim"): `name` **"Ansari"**, `owner` `ansari-project`, `slug` `ansari-chat`, `scheme`
  **`ansarichat`**, `ios.bundleIdentifier` / `android.package` `chat.ansari.app`,
  `ios.infoPlist.ITSAppUsesNonExemptEncryption: false`, `runtimeVersion {policy: fingerprint}`,
  `updates.url` (u.expo.dev/e2f465a7-…), `extra.eas.projectId` e2f465a7-…,
  `extra.router.origin: false`, `web.bundler: metro`. The scaffold (f396356) agreed with legacy
  on all of these except `name` ("Ask Ansari") and `scheme` (`askansari`). Legacy wins on both,
  so existing `ansarichat://` links keep reaching the successor app.
  **`version`** is a store marketing number, not an identifier. Legacy ships 3.5.0; I keep
  f396356's `4.0.0`, its successor version (build numbers are remote, per `eas.json`),
  confirmed by the owner at the plan gate. From the scaffold I also keep
  `android.predictiveBackGestureEnabled: false`. Legacy-only plugins (Sentry,
  expo-localization, expo-screen-orientation, expo-build-properties) and `extra.criticalIndex`
  / `supportsRTL` are runtime features of the old app, not identity, and are not carried. Functional config from
  the prototype: `newArchEnabled`, `backgroundColor`s, light/dark `splash`, `supportsTablet`,
  `CADisableMinimumFrameDurationOnPhone`, the two-layer adaptive icon, `web.output: single`
  and favicon, plugins **exactly** `["expo-router","expo-font","expo-web-browser","expo-video"]`,
  `experiments` (typedRoutes, reactCompiler). `expo install` auto-appended the `expo-image` and
  `expo-secure-store` plugins in the spike. I revert that to the prototype's list as the issue
  specifies, and note it for the EAS follow-up. The scaffold's `expo-splash-screen` and
  `expo-status-bar` plugin entries are replaced by the prototype's top-level `splash`.
- **Scheme coupling in `packages/auth` (shared surface, `main` reviews this hunk).** Better
  Auth validates a native request's `expo-origin` against `trustedOrigins`, and
  `packages/auth/src/index.ts:43` hard-codes `'askansari://'`. Its comment (`:38-42`) states
  that the scheme MUST match `apps/frontend/app.json`. Leaving it would break native sign-in
  later with an origin mismatch, with nothing failing in this PR. Changes:
  - `packages/auth/src/index.ts:39-43`: the trustedOrigins entry becomes `'ansarichat://'`,
    and the comment names `"scheme": "ansarichat"` / `expo-origin: ansarichat://…`.
  - `packages/auth/tests/auth.http.test.ts:73-80`: both assertions (`toContain` and the HTTP
    sign-in origin) move to `ansarichat://`, keeping the `not.toContain('ansari://')` guard,
    with the test title updated.
  - Run the `@ansari/auth` suite (`pnpm exec turbo run test --filter @ansari/auth`), and
    negative-test it: with app.json/auth out of step on purpose, the suite must fail.
  - Repo-wide check, run against `apps/ packages/ codev/resources/ docs/ RELEASE.md README.md`,
    not only the moved tree:
    `grep -rnE "askansari(://|\b[^.-])" … | grep -v askansari.ai` must return 0 hits after the
    change. Today it finds `apps/frontend/app.json:7`, `packages/auth/src/index.ts:39,40,43` and
    `packages/auth/tests/auth.http.test.ts:73,75,79,80`.
  - Deliberately unchanged: `apps/api/lib/attribution.ts:32` `KNOWN_CLIENTS =
    ['askansari-web','askansari-android']`. These are `X-Client` attribution labels, "for
    readability only — NOT enforced", not URL schemes, and the prototype sends no client id.
  `eas.json` is unchanged. It matches legacy's except the CLI floor (`>= 21.0.0` vs
  `>= 15.0.12`), and the newer floor stays.
- **`.gitignore`**: the scaffold's file, plus the prototype's `.env` line. The prototype's
  lockfile ignores are not carried (they would hide a stray nested lockfile).
- **`turbo.json`**: no change expected. `test` already exists, `EXPO_PUBLIC_*` and `VITEST`
  are in `globalEnv`, and `gen:types` with its edges stays.

### Phase 3: Code fixes forced by the upgrade, then lint

- The 4 fixes above, one commit, each line named in the commit message.
- **Lint** (`eslint.config.mjs` adapted). Spike counts: 161 errors / 36 warnings.
  - `vendor/api-client-react/**`: 128 `import/export` errors plus 5 redeclare/array-type
    warnings. These are orval-generated barrels. I ignore the vendored client: `generated/`
    per the issue, and the hand-written runtime too if its errors are the same generated
    re-export pattern. Reported with counts.
  - `scripts/*.mjs`: 5 `no-undef` (`Buffer`). Fixed by a Node-globals block for `scripts/`.
  - **React Compiler rules from eslint-config-expo 57's react-hooks v7**:
    `set-state-in-effect` 12, `refs` 9, `immutability` 3, `globals` 2. That is 26 errors in
    13 files (AuthSheet, Sheet, SourcePanel, ToastStack, SwipeToReveal, MessageActionSheet,
    useRevealedText, useShellFrame, useOverlayFocus, lib/auth, …). They are not mechanical:
    each fix restructures a component, which is #264's job. Proposal: a **scoped override**
    that sets these four rules to `warn`, with a comment pointing at #264, reported at
    dev-approval with per-file counts. They mean React Compiler skips optimising those
    components, as it already does on SDK 54. They are not runtime errors.
  - Mechanical fixes: `react/no-unescaped-entities` (1), `import/namespace` (1, to inspect),
    the unused `eslint-disable` (1), and `array-type` warnings fixed by `--fix`.
    `import/first` warnings in tests are the `vi.mock`-before-import pattern; left as
    warnings.

### Phase 4: Build pipeline and CI

- **`Dockerfile.web`**: the ARG list becomes `EXPO_PUBLIC_API_URL` alone, with a comment
  that it is the app's whole env surface (`lib/api/config.ts`) and defaults to
  api-staging. The eleven legacy ARGs go. Everything else is unchanged: repo-root context,
  `--filter ansari-frontend`, `build:web` with its `gen:types` chain, caddy.
- `Caddyfile` and `railway.toml` are unchanged (they already describe the target).
- **CI** (`.github/workflows/ci.yml`): the frontend job gains
  `Test: pnpm exec turbo run test --filter ansari-frontend...` between Typecheck and Build.
  The job name `frontend (lint, typecheck)` stays frozen.
- Root `package.json`: delete the `prototype` script.

### Phase 5: Docs and thread

- `codev/resources/arch.md` §"Prototype chat display (prototypes/ansari-expo)" becomes
  "Frontend chat display (apps/frontend)", with its paths updated. Same for the matching map
  line in `arch-critical.md`, and for the "— prototype" sections and map lines in
  `lessons-learned.md`/`lessons-critical.md` (path and naming only, not content).
- **`RELEASE.md` correction to the issue:** `grep -i prototype RELEASE.md` returns 0 hits
  today. Its Railway block already names `apps/frontend/Dockerfile.web`. I will check it
  against the final Dockerfile and update only if something has drifted.
- Ported `README.md`: remove "reference-only", "not part of the workspace", "Do **not** move
  it under `apps/`" and the npm instructions; document `pnpm --filter ansari-frontend
  dev|test|build:web|build:icons`; replace "Version gaps a porter will hit" with what the
  port did; keep the README walk (the staging verification script) intact.
  `scripts/retime-ambient.sh:13` and `.env.local.example` get their path pointers fixed.
- `codev/state/pir-262_thread.md`, committed with the PR.

## Upgrade-risk report (requested for this gate)

| Item | Finding | Evidence | Residual risk → where verified |
|---|---|---|---|
| reanimated 4.1→4.5 / worklets 0.5→0.10 | 39 files import reanimated. API surface used: `withTiming` 39, `withSpring` 26, `FadeIn` 13, `scheduleOnRN` 14, `makeMutable` 9, `runOnJS` 8, `cancelAnimation` 8, `useAnimatedReaction` 6, `createAnimatedComponent` 5, `useDerivedValue` 2. All still exported by 4.5.1, including `runOnJS`. One type break (fix 4). Worklets babel plugin wired by babel-preset-expo 57; the web export bundles and runs. | tsc, spike export, headless load | Motion feel on native (`AmbientVideo` fade, `AnsariMark*`, `PressableScale`, `Sheet`, `ThinkingLine`, `constants/motion.ts` easings) → **real device at dev-approval** |
| keyboard-controller 1.18.5 → ? | `npx expo install` picks **1.21.9** for SDK 57, not 1.22.x. Taking 1.21.9 keeps `--check` clean, as the issue's own rule requires. Imports used (`KeyboardProvider`, `KeyboardController`, `useReanimatedKeyboardAnimation`, `KeyboardAvoidingView`, `KeyboardAwareScrollView`) all typecheck. | spike `expo install`, tsc | Native keyboard behaviour → device. The web path is the custom shim (`useKeyboard.web.ts`), covered by tests, which pass |
| expo-glass-effect / symbols / video / image / blur | No type errors from these APIs (`GlassView`, `isLiquidGlassAvailable`, `BlurView`/`BlurTint`, `useVideoPlayer`/`VideoView`, `Image`). AmbientVideo tests (12) pass. Headless Chrome logs one `play() … interrupted by pause()` AbortError from the ambient video. | tsc, vitest, headless console | Check whether staging (SDK 54) logs the same AbortError (likely a headless autoplay artefact) → web pass at dev-approval. Glass/blur look → device |
| **expo-navigation-bar** (not on the issue's list) | `setButtonStyleAsync` removed, so it **would throw on every Android launch** → fix 2 | tsc TS2339 | Android device / emulator |
| **RN 0.86 StyleSheet** (not on the list) | `absoluteFillObject` removed, so it **silently breaks native layout while web looks fine** → fix 1 | tsc ×21, RN source grep | iOS device / Simulator at dev-approval |
| React 19.1→19.2, TS 5.9→6.0 | Beyond the 4 root causes above: zero errors in the 30k-line tree. TS 6 only forces dropping `baseUrl`. No local TS pin needed. | tsc clean after fixes | none |
| `unstable_transformImportMeta` | Not needed. Renamed `transformImportMeta`, default `true`; the old name is ignored | babel-preset-expo 57 `index.d.ts:37-43` | none |
| expo-router 6 → 57 | **react-navigation is vendored**, so direct `@react-navigation/native` imports break at runtime → fix 3. `_layout` Stack options, `+not-found`, typed routes, `<Head>` typecheck; `extra.router.origin:false` resolves in `expo config` | headless load before/after the fix | Full route walk (`/chat/:id`, `/terms`, `/privacy`, `/about`, unknown → not-found) at dev-approval |
| #265 expo-router 58 peer | Left alone. `apps/frontend` stays on ~57.0.25 | — | owned by `main` |

## Open questions for the gate

1. ~~`app.json` name~~ **Resolved (owner, 2026-10-11): "Ansari", with the identity taken
   from `legacy/frontend-app/app.json`** (phase 2). The #238 assertion in
   `lib/page-metadata.test.ts` passes unchanged. Consequence for the issue's acceptance line:
   `expo config` resolves scheme **`ansarichat`**, not `askansari`.
   The prototype tree hard-codes no scheme, but **`packages/auth` does**, so the change is NOT
   confined to `app.json` (see "Scheme coupling" under phase 2).
2. **Global CSS import.** I keep Uniwind wired (metro, `src/global.css`, `gen:types`, types,
   deps) but do **not** import `src/global.css` or mount `HeroUINativeProvider` in the ported
   `app/_layout.tsx`. On web, `@import "tailwindcss"` brings Tailwind's preflight reset, which
   would restyle the StyleSheet UI. "Wired and unused" therefore means the build pipeline is
   live and the CSS stays unimported until #264 adopts it.
3. **React Compiler lint rules at `warn`** (phase 3), instead of refactoring 13 files inside a
   verbatim port.

## Files to Change

- `prototypes/ansari-expo/**` → `apps/frontend/**` (git mv), then the rest of `prototypes/` deleted
- `apps/frontend/src/app/{_layout,index}.tsx` deleted; `assets/images/favicon.png` deleted;
  superseded images replaced by the prototype's
- `apps/frontend/{package.json,tsconfig.json,metro.config.js,babel.config.js,app.json,
  .gitignore,eslint.config.mjs,Dockerfile.web,README.md}`, merged and edited as above
- `apps/frontend/app/_layout.tsx` (fixes 2, 3), `hooks/useScreenLandmark.ts` (fix 3),
  `components/Sidebar.tsx` (fix 4), 10 components (fix 1), plus mechanical lint fixes
- `pnpm-lock.yaml`, root `package.json` (`prototype` script removed), `.github/workflows/ci.yml`
- `packages/auth/src/index.ts:39-43`, `packages/auth/tests/auth.http.test.ts:73-80` (scheme → `ansarichat://`)
- `codev/resources/{arch.md,arch-critical.md,lessons-learned.md,lessons-critical.md}`
- `codev/state/pir-262_thread.md`
- Unchanged: `eas.json`, `Caddyfile`, `railway.toml`, `turbo.json`, `pnpm-workspace.yaml`, `src/global.css`

## Risks & Alternatives Considered

- **Web-green, native-broken.** Fixes 1 and 2 are invisible on web, where the staging soak
  happens. Mitigation: tsc catches both, and the device pass at dev-approval must include
  native (ambient layer, sheets, glass buttons, Android launch). I cannot run a native build
  in CI. I will try the iOS Simulator via `expo run:ios` or a dev client if the toolchain
  allows, and report honestly if it does not.
- **Green checks that miss a runtime break (fix 3 class).** Mitigation: the implement phase
  repeats the headless load of `dist/` and of the Docker image, and walks the routes, before
  calling anything done.
- **Lockfile churn on a shared surface.** The prototype adds ~95 packages to the root lockfile.
  Mitigation: frozen-lockfile install in Docker and CI; `main` reviews the shared surfaces.
- **Prototype freeze.** In-flight #212/#210/#133 re-apply after merge (owner decision d). If
  another prototype PR merges to `develop` before this one, I rebase and replay its diff onto
  `apps/frontend` paths.
- Alternative: **land at SDK 54**. Rejected by owner decision (a).
- Alternative: **refactor the 26 compiler-rule violations now**. Rejected: it breaks
  "verbatim" (c) and mixes behaviour changes into the move. Belongs in #264.
- Alternative: **keep `@react-navigation/native` and wrap in a second container**. Rejected:
  two navigation contexts is the bug itself. expo-router re-exports exactly the five names used.

## Test Plan

- `pnpm install` (root): no nested lockfiles (`git ls-files '*lock*'` shows root only);
  `pnpm -r list --depth -1` lists 7 packages; `npx expo install --check` in `apps/frontend`
  is clean.
- `pnpm exec turbo run lint --filter ansari-frontend`, then `typecheck`, then `test`, then
  `build`, as separate invocations like CI. `test` reports **44 files** (606 tests today).
  `gen:types` runs under the graph.
- `npx expo config --type public`: name `Ansari`, slug `ansari-chat`, scheme `ansarichat`,
  `chat.ansari.app`, projectId e2f465a7-…,
  the prototype's 4 plugins.
- `pnpm --filter ansari-frontend run build:web` produces `dist/`. Serve it statically and load
  it in Chrome: auto-guest provisions, an answer streams with citations from `api-staging`,
  and `/chat/<id>`, `/terms`, `/privacy`, `/about` load.
- `docker build -f apps/frontend/Dockerfile.web .` from the repo root. Run it and repeat the
  load plus deep links through the Caddyfile `try_files`.
- Grep: `grep -rn "prototypes/ansari-expo"` over the live tree (excluding
  `codev/{specs,plans,reviews,state,projects}`) returns 0. Negative-tested on the pre-move
  tree, which has hits in `package.json`, `arch.md`, `arch-critical.md`, the prototype
  README and `retime-ambient.sh`. `prototypes/` does not exist. No `.env*` (other than
  `.env.local.example`) in `git diff --name-only`.
- `@ansari/auth` suite green with `ansarichat://`. The repo-wide `askansari` scheme grep
  returns 0 hits; the only `askansari` hits left are the `askansari.ai` domain and the
  attribution labels.
- CI green, including the new Test step and gitleaks.
- **Dev-approval UX pass** (`app` architect, side by side with staging SDK 54): desktop web;
  mobile web on the iOS Simulator (composer tap, keyboard shim, sign-in sheet `fitToShell`);
  a real device for ambient arrival, streaming reveal, sheets and glass buttons; Android
  launch for fix 2. Every difference is listed with the upgrade change behind it.

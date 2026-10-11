# bugfix-273 thread

## Investigate
- Reproduced (1): `npx expo export --platform android` on ed7222d emits 2 `.webm` assets (+2 `.mp4`) — AmbientVideo.tsx:28-47 requires both formats unconditionally; Android res/raw names drop the extension -> Gradle duplicate resources.
- Reproduced (2): `npx expo-doctor` 20/21, schema rejects `newArchEnabled` and `splash`. `expo-splash-screen` ~57.0.9 already a dependency.
- Fix per issue/architect: ambient-sources.ts / ambient-sources.web.ts platform split; splash -> plugin entry.

## Fix
- ambient-sources.ts (native: portrait mp4 + poster; desktopClip = portraitClip) / ambient-sources.web.ts (both encodings, both clips). AmbientVideo imports `{portraitClip, desktopClip}`; selection logic unchanged.
- Regression test components/ambient-sources.test.ts: scans native-resolvable sources for `require('@/assets/...')`, maps to Android res names, asserts no collisions / no webm. Verified: 2 failing against HEAD's AmbientVideo.tsx, green with fix.
- Android export after: 1 mp4 + 1 jpg, 0 webm (before: 2 webm, 2 mp4, 2 jpg). Web export: all 6 ambient files.
- app.json: dropped newArchEnabled; splash -> ["expo-splash-screen", {...}]. `dark.resizeMode` not in plugin's dark type; root `contain` applies. expo-doctor 21/21; `expo install --check` clean (dep already present).
- turbo lint/typecheck/test(615)/build each green separately. Lint warnings in AmbientVideo.tsx are pre-existing react-hooks ones.

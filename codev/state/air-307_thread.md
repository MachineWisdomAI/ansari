# air-307 — public shared-thread page at /share/[id]

## 2026-10-16 — implement

- Share page reads `GET /api/v2/share/:id` + `/documents` through `lib/api/share.ts`, which uses the platform `fetch`, not `customFetch`/`apiFetch`. Those attach the viewer's bearer and refresh on a 401. The share snapshot has no message ids, so synthetic `<shareId>:<index>` ids are given to both the messages and the documents entries, and the thread's own decode pipeline (citations, unbacked-marker stripping, documents degrade path) runs unchanged.
- **Surprise: "no guest sign-up by viewing" needed an auth change, not just a page.** `AuthProvider` provisions a guest at boot for anyone with nothing stored, on any route, and `AuthGate` holds every screen while `loading`. Added `AuthProvider deferGuest` (root layout passes `path.startsWith('/share/')`). With nothing stored the provider stays `loading` and mints nothing. `AuthGate` lets `/share` through while `loading`. When the visitor leaves (Continue in Ansari → `/`), the held guest is provisioned while the gate holds home. A stored session is still restored as usual.
- `AppFrame` drops the rail/drawer/account cluster on `/share`. The Sidebar queries the viewer's threads, which would 401 for a tokenless visitor.
- The page holds its fetch in local state, not react-query. `applySession` calls `queryClient.clear()`, which cancels in-flight queries. A signed-in viewer's session restore would land mid-load and leave the page stuck on its spinner.
- Non-UUID ids are not-found client-side: `shares.id` is a uuid column, and the API 500s (pg cast error) on a malformed id instead of 404ing.
- Verified on a real staging share made from a real thread. Web: built `dist/`, headless Chrome with a fresh profile. Only the two share GETs went out, with no `Authorization` and no `/users/register`. The register fired only after Continue landed on `/`. iOS Simulator: dev client, `ansarichat://share/<id>` → "Open in Ansari?" → page renders with sources. A logging proxy confirmed no `Authorization` on either share GET.
- Env gotcha for whoever runs native next: SDK 57's dev server inlines `apps/frontend/.env.local` as a virtual env module. It beats `EXPO_PUBLIC_API_URL` in the process env, and `--clear`/`EXPO_NO_DOTENV` don't change that. I put a forwarding proxy on :3000 instead of editing the file.
- Not done by me: tapping a source pill on native. The Simulator window left System Events' reach, and I didn't install idb. The same component opened the sources sheet on web.

## 2026-10-16 — CMAP round 1 (gemini APPROVE, codex REQUEST_CHANGES, claude COMMENT)

- Fixed (codex + claude): a share inherited the khushu' sample substitution, so a khushu' share whose first answer had no documents (including a failed `/documents`) would show `SAMPLE_ANSWER_CONTENT` and sample citations the sharer never sent. `mapConversationDetail` takes `{ samples }`, and shares pass `false`. Regression test covers both no-docs paths.
- Fixed (claude): the post-startup re-guest effect ignored `deferGuest`, so a session lost while reading a share minted a guest on the public page. It is now guarded and re-runs when the visitor leaves.
- Fixed (claude): `usePathname()` moved out of `RootLayout` into a thin `RouteAuthProvider`, so navigation re-renders one component, not the provider tree. `isSharePath` moved to `lib/share-link.ts` (tested).
- Fixed (claude): the no-Authorization test now asserts 2 calls, so it can't pass vacuously.
- Investigated (claude): could a native cold start from a link mint a guest before the route says `/share`? In the dev client, yes: it boots at `/` and forwards the link later, and a `register` showed on the proxy. In a release build, no. expo-router 57 builds the first state from the launch URL, synchronously on iOS via `Linking.getLinkingURL()`; on Android the navigator renders nothing until `getInitialURL` resolves. So the root layout's first path is already `/share/<id>`. I prototyped a launch-URL check, saw it was redundant, and backed it out. Not verified on a release build.
- Not taken: `noindex`/OG meta for a public page (a product call the issue doesn't make). `accessibilityRole="link"` without an href, and `router.replace` making Back skip the share, are intended.

## 2026-10-16 — architect review (2 required)

- `app/share/[id].tsx` added to `TITLE_SOURCES` in `lib/page-metadata.test.ts`, plus its two title strings in the middle-dot assertion. Planting an em-dash in the share title fails both scans.
- The "didn't load" state has a **Try again** (an attempt counter in the fetch effect's deps; loading shows again on retry). Not offered on not-found. Verified on a web build aimed at a dead :3000: failed state, then the proxy came up, Try again, and the thread loaded with sources and no auth.
- Took the cheap layering follow-up: share schemas moved to `lib/api/wire-schemas.ts`, and `decodeSharedThread` to `lib/api/decode.ts`. Left `ApiError` and the barrel export alone.

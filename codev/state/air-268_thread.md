# air-268 thread — EAS Build/Update via GitHub Actions (#268)

- 2026-10-11: Implemented. Files: apps/frontend/.eas/workflows/{build,update}.yml,
  .github/workflows/{eas-build,eas-update}.yml, RELEASE.md "Native builds and updates".
  No package.json/app.json/eas.json/ci.yml edits (architect constraint; #262 in flight).
- main's dispatcher conditions baked in: contents: read only, workflow_dispatch only,
  SHA pins (expo/expo-github-action 9.0.0 = eab7a230…), EXPO_TOKEN from GitHub
  Environments (build profile → env: production-internal/production → production),
  no token echo, concurrency per pair, cancel-in-progress false.
- Validation: `eas workflow:validate` (eas-cli 24.12.1) passes both; it rejects a bad job
  type but NOT a bad param value (`platform: ioss` passed) — it checks structure, not
  params. actionlint clean on all workflows; catches a typo'd input. SHA-pin grep: 0 hits.
- Not done/cannot: a real EAS run (no EXPO_TOKEN exists; owner's first dispatch).
- Choices: dispatchers do not `--wait` (green = EAS accepted the run); eas-cli pinned to
  24.12.1 rather than `latest`. Legacy `legacy/frontend-web/package.json` still has
  `eas build` scripts — legacy code, left alone.
- Review round (architect + main): added `queue: max` to both dispatchers; update now
  groups by channel only, `--wait`s, timeout 30 (main); build comment/doc says it serializes the
  dispatch, not the EAS build. RELEASE.md prerequisite now ordered: create Environments
  (develop-only branch policy on all three, reviewers on production) → add token →
  dispatch (a missing Environment is auto-created UNPROTECTED); explains the branch-policy
  reason (dispatch runs the selected branch's own workflow).
- actionlint 1.7.12 (latest, 2026-03) predates `concurrency.queue` and flags it; ran it with
  only that message ignored (clean otherwise). Validated both dispatchers with
  check-jsonschema against SchemaStore's current github-workflow schema (has `queue`
  single|max): ok; negative `queue: maximum` rejected.

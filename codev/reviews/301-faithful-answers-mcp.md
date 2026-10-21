# 301: Review and verification

Destination build, typechecking, 19 server/packaging tests and 47 Chromium checks passed. Frozen installation of the application dependency closure passed. All seven existing lockfile importers are preserved byte-for-byte, and existing dependency snapshots are retained; new entries are additive. Public CI verifies both the destination lockfile and a fresh standalone resolution.

Independent Codex static consultation found no blocking integration defects. It verified runtime Turbo environment declarations, package-relative container paths and preserved existing development services. Its observation that isolated CI alone did not exercise the root lockfile was addressed by adding explicit frozen-lockfile application verification.

The destination's esbuild override resolves a newer patch than the source application. Its synthetic host harness now explicitly targets current Chromium (`esnext`); the production view build is unchanged. The browser suite passes with this harness setting.

Claude and Gemini consultation were not completed; the three-model ASPIR consultation is incomplete. Independent Codex review is recorded separately and does not represent those missing reviews. Upstream merge remains a maintainer decision.

Fresh public-only isolated installation, build, typecheck, 19 server tests, 47 browser checks, uncached Docker build and no-network/no-mount runtime smoke all passed. The runtime smoke verifies one tool/current resource, complete answer preservation, safe failure and recovery, content-addressed HTML and graceful shutdown.
## Destination-branch host verification

The app from commit `ef6b9724a8bb8541fecbf37dc5a21449b8e2e920` was built using the four public `@saga-a2ui/*@0.5.4-rc.1` packages and deployed to DEV. On 2026-10-21, representative synthetic greeting answers rendered in ChatGPT, Claude and the Alexa+ simulator. Each rendered document reported the exact destination revision, version `0.12.7`, and loaded Kitab regular and bold fonts. Complete answer text, Ansari attribution and the separate “Built with saga a2ui” footer were present.

Alexa's actual cached HTML matched the served resource byte-for-byte: 1,682,873 bytes, SHA-256 `be4f0c0e1b67ccd37b40770c8247b3d1f3230ff38113a59cd0523ccb73af33c2`.

These screenshots establish rendering, not reliable first-load behavior. ChatGPT initially failed to display the card and recovered with one embedded retry. Claude required reconnecting its existing connector after a discovery failure, then displayed an embed error; it eventually rendered after the retry/native reload sequence. Alexa delivered the correct HTML fragment promptly but rendered several minutes later without another question or deployment. The cause of these startup delays/failures is unproven. The reported regular-DEV mobile failure remains unresolved; working RC and Host QA mobile screenshots do not establish destination-build mobile acceptance.

### ChatGPT

![Destination-build answer in ChatGPT](assets/301-faithful-answers/chatgpt.png)

### Claude

![Destination-build answer in Claude](assets/301-faithful-answers/claude.png)

### Alexa+

![Destination-build answer in Alexa simulator](assets/301-faithful-answers/alexa.png)

## Footer repair (0.12.8)

The attribution now uses the answer's supplied separator when present, keeping its own border only when no separator is supplied. Successful link requests remain silent, unavailable-link destinations appear in distinct readable notices, and the framework signature aligns right. The original answer text and link policy are unchanged.

Destination typechecking, build, all 19 server/packaging tests and 55 browser checks passed. Browser checks cover both footer links, supplied/absent separators, 375px and 760px layout, unavailable host capability and light/dark notice contrast. Development deployment and actual-host verification are recorded separately from these local checks.

# Phase 13 iter 1: responses

Gemini: APPROVE (no key issues). Its "working tree changed" warning names the five files of my
own fix for Codex 2 below, edited while the lanes ran; no consultant wrote to the tree.

## Codex 1: `docs/cutover/baselines.md` results are empty (B-1..B-4)

**Not fixable by the builder; recorded, not disputed.** The baselines are production
measurements the owner runs (the preflight on the production app database, Railway HTTP logs, the
Resend dashboard). Under owner amendment R-2 and the security architect's ruling, a complete
`baselines.md` is a precondition of the cutover PR's **merge word**, not of this phase. Phase 13
closes on its pre-merge deliverables (plan, phase 13 "Deliverables"). Every place that matters
says so:
- `baselines.md` (first paragraph)
- the plan's pre-merge deliverable list
- spec R-2 item 5
- the review's evidence section (_pending, owner_)
- runbook step 1

Any `limits.ts` amendment the numbers force lands in the cutover PR before the merge.

## Codex 2: edge-shape tests hardcode the provisional values

**Accepted and fixed.** Every shape in `docs/cutover/edge-header-shapes.json` now carries
`probe`, the JSON the diag probes return for it (exactly what the edge check records). The tests
derive every expectation from the file:
- apps/auth `client-ip.test.ts`: the bucket is `ipBucket(probe.x_real_ip)`; the structural check
  is "at least one via-Cloudflare shape, one direct, one no-edge" instead of fixed lengths
- apps/auth `public-face.test.ts` and apps/api `diag-client-ip.test.ts`: probe output equals
  `shape.probe`, and no XFF value but the caller's is echoed
- apps/api `rate-limit.test.ts`: `getRealIp` equals `probe.x_real_ip`

Proof: with the fixture altered (a three-entry XFF via Cloudflare, plus an added direct IPv6 shape),
all four suites pass unchanged; restored, they pass. The IPv6 probe showed apps/auth buckets
IPv6 by its /64, which is the spec's design (Client IP, line 352; N-2 is apps/api only). The test
now derives the key through `ipBucket` rather than assuming the exact address. Mutations re-run:
packages/auth trusting cf-connecting-ip first → 1 failure; apps/api preferring it → 3.

## Also in this iteration (main, via security; docs only)

The rollback targets are recorded before anything goes offline:
- Window step 1 records the current Railway deployment ID and commit of `backend` and the legacy
  web service (on staging, the web service).
- `rollback.md` steps 3 and 4 redeploy exactly those IDs, and check that the deployed commit
  equals the recorded one.
- The staging differences table mirrors this.

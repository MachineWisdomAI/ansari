# Self-Hosting Ansari Backend

This guide covers running the Ansari backend (`apps/api/`) yourself: prerequisites,
the complete environment-variable contract, and deployment notes.

## Prerequisites

- **Node.js ≥ 22** (the root `.nvmrc` pins the version)
- **pnpm ≥ 10** — `corepack enable` provides the exact pinned version (the
  `packageManager` field in the root `package.json`); the repo is a pnpm workspace
- **PostgreSQL** (any recent version; the schema is managed by Drizzle migrations)
- A **Gemini** credential — either a [Google AI Studio API key](https://aistudio.google.com/)
  or a Google Cloud project with Vertex AI enabled
- (For full search functionality) **Kalemat** and **Usul** API keys — see the caveat below

## The Kalemat / Usul caveat (read this first)

Ansari's Islamic search tools are backed by two third-party services whose keys are
**not self-serve**:

- **Kalemat** (`KALEMAT_API_KEY`) — Quran and Hadith search
- **Usul** (`USUL_API_TOKEN`) — Mawsuah (Kuwaiti fiqh encyclopedia) and Tafsir vector search

You must request keys from the respective providers. **Environment validation requires
these variables to be non-empty**, so a self-hoster without real keys must supply
placeholder values (any non-empty string). The engine then boots and works: when a
search tool is called with an invalid key, the failure is caught by the resilience
layer and the assistant answers from its other sources, noting which source could not
be consulted. You get a functioning assistant with degraded search rather than a crash.

## Environment contract

The source of truth is the strict Zod schema in `apps/api/lib/config.ts` plus a few
direct `process.env` reads. `apps/api/.env.example` mirrors this contract. Validation
runs at first config access, and a production server also runs it at boot
(`apps/api/lib/boot-check.ts`), so missing required values fail loudly at startup.

Accounts, passwords, sessions, roles, password-reset email and `ADMIN_EMAILS` belong
to the auth service, `apps/auth` (spec 300). `apps/api` holds no credential and no
signing secret: it verifies `apps/auth`'s JWTs against its JWKS and calls its
internal endpoints.

### Required (validation throws when absent)

| Variable | Notes |
|----------|-------|
| `DATABASE_URL` | Postgres connection string |
| `KALEMAT_API_KEY` | Non-empty required — see caveat above |
| `USUL_API_TOKEN` | Non-empty required — see caveat above |

### Auth service (`apps/auth`; required when `NODE_ENV=production`)

Optional in development and test (suites that never reach `apps/auth` run without
them); a production server refuses to boot when any is unset, naming the missing ones.

| Variable | Notes |
|----------|-------|
| `AUTH_INTERNAL_URL` | `apps/auth`'s INTERNAL listener (private network, no public domain). The JWKS and the internal endpoints are fetched here |
| `AUTH_JWT_ISSUER` | Must equal `apps/auth`'s `AUTH_JWT_ISSUER` |
| `AUTH_JWT_AUDIENCE` | Must equal `apps/auth`'s `AUTH_JWT_AUDIENCE` |
| `AUTH_INTERNAL_SECRET` | Min 32 characters; the same value as `apps/auth`'s. Sent on every internal call, the JWKS fetch included |
| `AUTH_LAYER_ORIGIN` | `apps/api`'s own public origin, sent as `Origin` on the `/v2/users/*` layer's calls. `apps/auth` trusts it for CSRF only, never for CORS; the same value as `apps/auth`'s |

### Gemini facilitator (one of two paths, checked at first use)

If `GOOGLE_CLOUD_PROJECT` is set, **Vertex AI** is used; otherwise the **public Gemini
API** via `GEMINI_API_KEY`. One of the two must be configured or chat requests fail.

| Variable | Default | Notes |
|----------|---------|-------|
| `GEMINI_API_KEY` | — | Public Gemini API path |
| `GOOGLE_CLOUD_PROJECT` | — | Setting this selects Vertex AI |
| `GOOGLE_CLOUD_LOCATION` | `global` | Vertex region |
| `GOOGLE_APPLICATION_CREDENTIALS` | — | Path to a service-account JSON file (local dev) |
| `GOOGLE_APPLICATION_CREDENTIALS_JSON` | — | Inline JSON contents of the service account — for hosts without a writable filesystem (e.g. Railway) |
| `GEMINI_MODEL` | `gemini-3.1-pro-preview` | Primary model |
| `GEMINI_FALLBACK_MODEL` | `gemini-3.1-pro-preview` | Used only when the primary exhausts retries on transient (e.g. 429 shared-capacity) errors; draws on a separate capacity pool |

### Primary backend switch (⚠️ experimental — NOT a supported production configuration)

`PRIMARY_BACKEND=inkling` routes **every** facilitator primary call through the
OpenAI-compatible Inkling client instead of Gemini — the whole request (tool loop,
continuations, synthesis) runs against `INKLING_BASE_URL`, and Gemini is never
called. This is an experimentation escape hatch for benchmark/eval runs and
externally hosted checkpoints (e.g. exported LoRAs); do **not** run production
traffic on it. The default (`gemini`, or the variable unset) is byte-identical to
the pre-switch behavior.

Under `PRIMARY_BACKEND=inkling`, the terminal-error rescue rung (which rescues a
failed *Gemini* call on Inkling) is inherently disabled — an Inkling-primary
failure surfaces loudly instead of being "rescued" by the same backend. The
empty-final retry ladder still applies as same-model retries.

| Variable | Default | Notes |
|----------|---------|-------|
| `PRIMARY_BACKEND` | `gemini` | `gemini` \| `inkling`. Validation fails fast (at first config access) when set to `inkling` without an API key (below) |
| `INKLING_BASE_URL` | the Tinker prod `/chat/completions` URL | Full URL of any OpenAI-compatible `/chat/completions` endpoint (https required; plain http only for localhost). Also used by the fallback rungs |
| `INKLING_API_KEY` | unset | Bearer token for `INKLING_BASE_URL`; falls back to `TINKER_API_KEY` when unset |

### Optional / defaulted

| Variable | Default | Notes |
|----------|---------|-------|
| `TINKER_API_KEY` | unset | Enables the Inkling off-Vertex backup (empty-final retry ladder rung + terminal-error rescue). When unset, both are skipped cleanly |
| `INKLING_MODEL` | `thinkingmachines/Inkling` | Which Inkling model the backup requests — e.g. a fine-tuned LoRA via a `tinker://...` sampler-weights id |
| `INKLING_MAX_TOKENS` | `8192` | Inkling completion cap (budgets thinking+answer). Must be within 8192–32768: below 8K the hidden reasoning pass starves the visible answer. Out-of-window values fail validation (no clamping) |
| `INKLING_TIMEOUT_MS` | `180000` | Per-call timeout for Inkling requests: the default when a caller passes no timeout, and a cap on the facilitator's budget-derived Inkling call timeouts (`min(remaining request budget, this value)`) — it can shorten Inkling calls, never lengthen them past the request budget. Must be within 30000–600000; out-of-window values fail validation (no clamping) |
| `USUL_BASE_URL` | `https://api.usul.ai/v1/vector-search` | |
| `TINKER_API_KEY` | unset | Enables the Inkling off-Vertex fallback rung and terminal-error rescue (issues #74/#79). When unset (and `INKLING_API_KEY` too), both are skipped cleanly |
| `LEADERBOARD_API_KEY` | unset | Bearer token for `/api/v1/chat/completions` (OpenAI-compat endpoint for evaluation harnesses). Min 32 chars when set; the endpoint returns 503 when unset |
| `MAINTENANCE_MODE` | `false` | Served by `/api/v2/app-check` |
| `IOS_MINIMUM_BUILD_VERSION` | `1` | App-version gate (`/api/v2/app-check`) |
| `IOS_LATEST_BUILD_VERSION` | `1` | |
| `ANDROID_MINIMUM_BUILD_VERSION` | `1` | |
| `ANDROID_LATEST_BUILD_VERSION` | `1` | |
| `NODE_ENV` | `development` | `development` / `production` / `test` |

### Outside the config schema (direct `process.env` reads)

| Variable | Where used | Notes |
|----------|-----------|-------|
| `SENTRY_DSN` | `sentry.*.config.ts` | Optional. Sentry is disabled when unset (and always disabled under test). No user content is ever sent to Sentry |
| `RAILWAY_ENVIRONMENT` | `sentry.server.config.ts` | Auto-injected by Railway; used as the Sentry environment tag. Falls back to `NODE_ENV`; never set manually |
| `SENTRY_AUTH_TOKEN` | build-time only | Optional — source-map uploads during `next build`. The build succeeds without it |

### Provisioning admins

Admins are an `apps/auth` concern: admin access is the auth user's `role`, set out of
band with `apps/auth/scripts/grant-admin.ts`, and `ADMIN_EMAILS` (reserved at sign-up,
asserted at `apps/auth`'s production boot) is configured on `apps/auth`. `apps/api`
asks `apps/auth` for the role on every admin request. RELEASE.md carries the
onboarding order.

## Running it

```bash
corepack enable             # provides pnpm
pnpm install                # at the REPO ROOT (single workspace lockfile)

cd apps/api
cp .env.example .env        # fill in per the tables above
pnpm db:migrate             # applies drizzle/ migrations to DATABASE_URL

pnpm dev                    # dev server on :3000
```

Verify your setup (from `apps/api/`):

```bash
pnpm lint
pnpm typecheck
pnpm test                   # full Vitest suite; no external services needed
pnpm build
# The healthcheck now verifies the database: 200 only if a live DATABASE_URL
# answers SELECT 1, otherwise 503. With a running DB and DATABASE_URL set:
curl localhost:3000/api/health   # {"status":"ok",...,"service":"ansari-backend"}
```

CI runs lint + typecheck + test (with coverage) + build with the committed dummy
env in `apps/api/.env.ci` — proof that none of them require real secrets.

## Deployment

Any host that runs a Next.js server works (`pnpm build` && `pnpm start` from
`apps/api/`), as does any Docker host via `apps/api/Dockerfile` (build from the
repo root: `docker build -f apps/api/Dockerfile .` — the image builds with the
committed dummy `apps/api/.env.ci`; real environment variables are injected at
runtime).

The production instance runs on **Railway**: a dockerfile build from
`apps/api/Dockerfile`, healthcheck on `/api/health`, restart on failure.

For a Railway deploy from this monorepo, configure the service in the dashboard:

- **Root directory: the repo root** — not `apps/api`. The Docker build context
  needs the root `pnpm-lock.yaml`, and the image also copies `packages/`.
- **Dockerfile path:** `apps/api/Dockerfile`
- **Watch paths:** `apps/api/**`, `packages/**`, `package.json`, `pnpm-lock.yaml`,
  `pnpm-workspace.yaml`. `packages/**` is required — the shared config packages are
  copied into the image, so omitting it means a packages-only change ships nothing:
  no rebuild, no deploy, and no error.

`apps/api/railway.toml` records these same values in version control but is **not read
by Railway in this deployment** — the dashboard settings above are the live
configuration. (Railway does support a config-as-code path setting; this project does
not use it.) RELEASE.md carries the full per-service table.

Because `/api/health` now returns 503 when the database is unreachable, it is a real
deploy gate: a deploy with a broken or unset `DATABASE_URL` will fail its healthcheck
and be rolled back rather than going live in a broken state. Make sure `DATABASE_URL`
is set and reachable before deploying.

Database migrations are applied with `pnpm db:migrate` (from `apps/api/`) against
the production `DATABASE_URL` (never `db:push`).

### Troubleshooting: crash loop at boot (admin bootstrap check)

The admin bootstrap check runs at `apps/auth`'s production boot
(`assertConfiguredAdminsExist` in `apps/auth/src/startup-checks.ts`), not at
`apps/api`'s: it queries the auth database to verify that every `ADMIN_EMAILS` entry
already exists as an admin, and **throws if it cannot verify this** — including when
the database is simply unreachable. Coupling boot to database reachability is
deliberate fail-fast behavior: a server that cannot verify its admins refuses to start
rather than serving with unknown admin state.

**Symptom.** On platforms that restart on crash (e.g. Railway with
`restartPolicyType = "ON_FAILURE"`), a database blip while `apps/auth` boots presents
as a **crash loop** that looks identical to a mis-provisioned deploy. The check runs
only on a production boot — never in dev or tests.

**Triage: read the boot error text — it distinguishes the two cases.**

| Boot error contains | Meaning | What to do |
|---|---|---|
| `Admin bootstrap check could not reach the database` | The auth database was unreachable when boot ran. This is an **outage, not a provisioning error** — do not re-run the bootstrap script. | Restore database reachability (`apps/auth`'s `DATABASE_URL` correct, network path open, database up). The next restart succeeds once the database answers; on restart-on-crash platforms recovery is automatic. |
| `has no account` or `role is not admin` | A real provisioning gap: the configured admin never signed up, was never granted, or was deleted/demoted since. Restarting will not fix it. | Run `pnpm exec tsx scripts/grant-admin.ts <email>` from `apps/auth/` (in the auth image's shell: `./node_modules/.bin/tsx scripts/grant-admin.ts <email>`) for the identified entry (see [Provisioning admins](#provisioning-admins)), then restart. |

The error identifies the failing entry by its **position** in `ADMIN_EMAILS`
(e.g. `configured admin #2 of 3`), never by the address itself — boot logs carry
no email content. Map the index back to your configured list.

`apps/api`'s own boot check is the environment validation above; it queries nothing.

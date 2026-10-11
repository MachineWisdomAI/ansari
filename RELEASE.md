# Release Process

How Ansari's backend goes from `develop` to production. This codifies the
process that was previously in architect notes; the smoke sequence and the
migration runbook were both proven in real releases on 2026-08-02.

## Deployment model

- **`develop`** is the integration branch. It is protected: PRs only, with the
  required CI checks from `.github/workflows/ci.yml` —
  `backend (lint, typecheck, test, build)`, `frontend (lint, typecheck)`, and
  `gitleaks (secret scan)`. Of these, `develop`'s protection currently *requires*
  `backend (lint, typecheck, test, build)` and `gitleaks (secret scan)`.

  > **Naming note (spec 48) — deferred follow-up, not an action before merge.**
  > The first check's name looks stale and is stale **on purpose**. The monorepo
  > restructure moved the backend app under `apps/api/` and renamed that CI job's
  > **ID** to `api`, but its **emitted name** is deliberately left as
  > `backend (lint, typecheck, test, build)`.
  >
  > Required status checks are matched by **name**. Changing what the job emits
  > would mean the required check never reports again, leaving every PR
  > unmergeable until a repo admin edits the protection rule — and a job's ID and
  > emitted name are independent, so keeping the name costs nothing.
  >
  > Renaming it is a follow-up that must be done as one coordinated change: edit
  > `develop`'s required-check name **and** the `name:` line in
  > `.github/workflows/ci.yml` together. It needs repo-admin access. Do not change
  > either half on its own.
> ### Railway service configuration (spec 48 — monorepo layout)
>
> Both services build with the **repo root** as their Root Directory: the pnpm
> workspace needs the root `pnpm-lock.yaml`, and both Dockerfiles now also
> `COPY packages packages`. Do **not** set Root Directory to the app folder.
>
> | Service | Dockerfile path |
> |---|---|
> | backend | `apps/api/Dockerfile` |
> | frontend (web) | `apps/frontend/Dockerfile.web` |
>
> **Watch paths** — set these per service, or Railway rebuilds *both* on every push
> (any commit touches the root lockfile):
>
> ```
> backend:   apps/api/**       packages/**  package.json  pnpm-lock.yaml  pnpm-workspace.yaml
> frontend:  apps/frontend/**  packages/**  package.json  pnpm-lock.yaml  pnpm-workspace.yaml
> ```
>
> `packages/**` is **not optional**. The shared config packages are copied into both
> images, so a packages-only change alters the built artifact. Omit the pattern and
> that change ships nothing — no rebuild, no deploy, and no error. The image simply
> drifts from the repo.
>
> **Deploy settings** — backend healthcheck `/api/health` (timeout 300s), frontend
> healthcheck `/`; restart ON_FAILURE, max 3 retries.
>
> **`apps/*/railway.toml` are not read by Railway here.** This project configures
> deployment through the dashboard with a Dockerfile path (confirmed by the operator,
> 2026-08-21). Railway does support a config-as-code path setting; this project does
> not use it. The tomls record the same values in git so the intended configuration
> stays reviewable — update them in the same PR whenever you change a dashboard
> setting, or the record drifts from reality.

- **`main`** is the production branch. The Railway service `backend` (a name in the
  Railway dashboard — unrelated to the `apps/api/` directory, and not stale)
  auto-deploys every push to `main`. Its effective settings are in the block above:
  root directory = repo root, dockerfile build from `apps/api/Dockerfile`,
  healthcheck `/api/health` with a 300s timeout, restart `ON_FAILURE` up to 3 times.
  `apps/api/railway.toml` records those same values in git.
- **Promotion is a fast-forward, nothing else.** `main` is moved to `develop`'s
  tip with `--ff-only` — no merge commits, no cherry-picks, so `main` is always
  an exact prefix of `develop`'s history.

## Standard release checklist (develop → main)

1. **CI green** on the `develop` tip you intend to ship.
2. **Pre-promotion local smoke test passes** (next section) on that same tip.
3. **Explicit human go.** A human says "release" — green CI alone is never a
   reason to promote.
4. **Promote (fast-forward only):**

   ```bash
   git fetch origin
   git checkout main
   git pull --ff-only
   git merge --ff-only origin/develop
   git push origin main
   ```

   If `--ff-only` refuses, stop: `main` has diverged. Investigate — never
   force-push `main`.

5. **Watch the Railway auto-deploy** until the new deployment is live.
   `/api/health` is a real deploy gate: it returns 200 only when the database
   answers `SELECT 1` (within 2s) and 503 otherwise, so a deploy with a broken
   `DATABASE_URL` fails its healthcheck instead of going live broken.
6. **Health-check both production domains** (both serve the Railway `backend`
   service):

   ```bash
   curl -fsS https://api.askansari.ai/api/health
   curl -fsS https://api-35.ansari.chat/api/health
   ```

   Both must return 200 with `{"status":"ok","service":"ansari-backend",...}`.
7. **Sentry watch, 15 minutes.** Watch the backend Sentry project for new or
   spiking issues (wired via `apps/api/sentry.server.config.ts`). Only after a
   quiet 15 minutes is the release considered done.
8. Anything wrong → **Rollback** (last section).

## Pre-promotion local smoke test

Proven 2026-08-02. Run from `apps/api/` on the exact `develop` tip you are
about to promote, with a real `.env` (see the env tables in
`docs/self-hosting.md` — the chat step needs real AI/search keys, because it
exercises the real model and tools, not mocks).

1. **Build:**

   ```bash
   (cd ../.. && pnpm install) && pnpm build
   ```

2. **Migrate a fresh database.** Start a disposable Postgres 16 and apply the
   full migration chain (`apps/api/drizzle/0000_baseline.sql` → latest) to an empty
   database — this proves a from-scratch install works, not just the
   incremental step:

   ```bash
   docker run --rm -d --name ansari-smoke -e POSTGRES_PASSWORD=postgres -p 5433:5432 postgres:16
   export DATABASE_URL=postgresql://postgres:postgres@localhost:5433/postgres
   pnpm db:migrate
   ```

3. **Boot the production build** against that database (same shell, so the
   `DATABASE_URL` override wins over `.env`):

   ```bash
   pnpm start
   ```

4. **Health:**

   ```bash
   curl -fsS localhost:3000/api/health   # 200 {"status":"ok",...}
   ```

5. **Auth round-trip** — register, log in, fetch the authenticated profile.
   Use a strong throwaway passphrase (the strength policy rejects weak
   passwords with a 400; max 128 chars):

   ```bash
   curl -s localhost:3000/api/v2/users/register -H 'Content-Type: application/json' \
     -d '{"email":"smoke@example.com","password":"<strong throwaway passphrase>"}'
   TOKEN=$(curl -s localhost:3000/api/v2/users/login -H 'Content-Type: application/json' \
     -d '{"email":"smoke@example.com","password":"<same passphrase>"}' | jq -r .access_token)
   curl -s localhost:3000/api/v2/users/me -H "Authorization: Bearer $TOKEN"
   ```

6. **Real streamed chat with tool use:**

   ```bash
   THREAD=$(curl -s -X POST localhost:3000/api/v2/threads \
     -H "Authorization: Bearer $TOKEN" | jq -r .thread_id)
   curl -N -s localhost:3000/api/v2/threads/$THREAD/chat \
     -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
     -d '{"message":"What does the Quran say about patience?"}'
   ```

   Expect a live SSE stream showing tool activity followed by a substantive,
   cited answer. A Quran/hadith question reliably triggers tool use.

7. **Teardown:** `docker stop ansari-smoke` (the container was started with
   `--rm`).

## Migration release (variant)

Use this variant whenever the release includes a schema change (a new file in
`apps/api/drizzle/`).

> **NEVER run `pnpm db:push` (drizzle-kit push) against production.** It
> diffs the live schema and can drop or recreate tables — and data. The rule
> for schema changes is: `pnpm db:generate` → review the generated SQL →
> apply that SQL explicitly at release time (below). `pnpm db:migrate` is
> for local/fresh databases (as in the smoke test above); production gets the
> reviewed SQL via `psql`.

Order proven for migration `0003` on 2026-08-02:
**inspect → apply via psql → bootstrap → deploy.**

1. **Inspect production data** the migration (especially any backfill) will
   touch, via `psql` — e.g. before `0003`, the rows its system-account
   backfill would match. Know what the migration will do to real rows before
   it does it.
2. **Apply the reviewed SQL explicitly:**

   ```bash
   psql "$DATABASE_URL" -f apps/api/drizzle/000N_<name>.sql
   ```

3. **Run bootstrap scripts** (after the migration, before the deploy):
   - **Admins:** from `apps/api/`, `pnpm exec tsx scripts/grant-admin.ts <email>`
     (securely prompts for a password; creates a login-capable admin, or
     promotes an existing account while resetting its password and revoking
     its sessions).
   - **System accounts** (`ai-skill`, `leaderboard`) self-provision lazily by
     `system_key` — no manual step.
4. **Then run the standard release checklist above.** The order matters:
   production boot asserts that every `ADMIN_EMAILS` entry already exists as
   an admin, so deploying before migration + bootstrap fails fast at startup
   — by design.

Migrations must be backward-compatible with the currently-deployed code: the
SQL is applied while the previous deployment is still serving traffic.

## Rollback

- **Code:** Railway dashboard → `backend` service → Deployments → select the
  previous good deployment → **Redeploy**. No git operation required. Re-run
  the health checks on both domains afterwards. Follow up by reverting the
  offending change on `develop` through the normal PR flow — never by
  force-pushing `main`.
- **Database:** migrations are not rolled back. They are applied manually and
  must be backward-compatible, so the previous code runs fine on the new
  schema. If a migration itself is bad, ship a corrective forward migration —
  never `db:push`.

## Native builds and updates

Native binaries and over-the-air updates for `apps/frontend` are produced on
EAS, dispatched from GitHub Actions. No laptop is involved, and this is the
only supported path. Each GitHub workflow is a thin dispatcher: it installs the
workspace at the repo root (the EAS CLI evaluates the app config on the
runner) and runs `eas workflow:run` on an EAS Workflow in
`apps/frontend/.eas/workflows/`. Follow the run from the EAS URL printed in
the dispatcher's last step. **EAS Build** goes green once EAS accepts the
run, not once the build finishes. **EAS Update** waits for the EAS run and
reflects its result.

**Build:** Actions tab → **EAS Build** (`.github/workflows/eas-build.yml`) →
*Run workflow* → pick `platform` (all | ios | android) and `profile`:

| Profile | Produces | Update channel | GitHub Environment |
|---|---|---|---|
| `development` | dev-client build, internal distribution | `development` | `development` |
| `preview` | release build, internal distribution | `preview` | `preview` |
| `production-internal` | production build, internal distribution | `production` | `production` |
| `production` | store build; build number auto-increments | `production` | `production` |

**Update:** Actions tab → **EAS Update** (`.github/workflows/eas-update.yml`) →
pick `platform` and `channel` (development | preview | production). The
channel also names the EAS environment and the GitHub Environment.

- **Build numbers are managed by EAS.** `eas.json` sets
  `appVersionSource: remote`, so the iOS build number and Android version code
  live on EAS, not in `app.json`. Only `production` auto-increments them.
- **`runtimeVersion: fingerprint` decides which binaries an update reaches.**
  An update is delivered only to builds on its channel whose native fingerprint
  matches the commit it was published from. After any native change (a
  dependency with native code, a config plugin, `app.json` native fields), ship
  a new build first; an update alone reaches no one. The fingerprint contract
  is tracked in #267.
- **Concurrent dispatches queue, they never cancel** (`queue: max`, so every
  pending run is kept). **Build** serializes the *dispatch* per
  profile/platform pair, not the EAS build. The dispatcher does not wait, so
  two builds of one pair can still run on EAS at the same time. **Update**
  serializes per channel (all platforms) and waits for each EAS run, so
  updates to a channel publish in dispatch order.

**Token and Environments (prerequisite, not yet done).** No `EXPO_TOKEN`
exists yet, and neither do the three Environments (the repo's existing
Environments are Railway's). Do these steps **in this order**:

1. **Create the GitHub Environments** `development`, `preview` and
   `production`. Each gets a **deployment branch policy that allows only
   `develop`**. `production` also gets **required reviewers**, so every
   production build or update waits for a human approval.
2. **Only then add the token.** Create an Expo **robot** access token with
   access to the `ansari-project` / `ansari-chat` EAS project, and store it as
   the `EXPO_TOKEN` secret in each of the three Environments.
3. **Only then dispatch.** A dispatch that names an Environment which does not
   exist yet auto-creates it **unprotected**, with no branch policy and no
   reviewer. Dispatching before step 1 would therefore create exactly the
   hole this setup closes.

The branch policy is what makes the reviewer meaningful. A `workflow_dispatch`
runs the *selected branch's own copy* of the workflow. Without a branch
restriction, anyone who can push a branch can edit the dispatcher there,
dispatch it against the `development` environment (no reviewer), and send the
same token to `eas` with a production profile or channel. The production
reviewer would never be asked. Restricting every Environment to `develop`
means only reviewed workflow code ever receives the token. The dispatchers are
the only place the token is used.

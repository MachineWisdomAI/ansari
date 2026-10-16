# @ansari/auth

Better Auth configuration (`createAuth()`), its Drizzle schema, and its database client.
`apps/auth` is the service that mounts it. Spec: `codev/specs/300-better-auth-migration.md`.

## The auth database

Better Auth's tables live in their **own database** (the auth database, which only `apps/auth`
reaches), in a dedicated `auth` Postgres schema. Nothing here touches `public`, and `apps/api`'s
tables (`public.users`, `threads`, …) live in the app database under their own journal
(`apps/api/drizzle/`).

| Table | Notes |
|---|---|
| `auth.users` | better-auth's `user` model, mapped by `user.modelName: 'users'`. Adds `first_name`, `last_name` and `registered_via`, and the admin plugin's `role`, `banned`, `ban_reason` and `ban_expires`. There is no `system_key` and no `source`. |
| `auth.session` | `user_id` → `auth.users.id` `ON DELETE CASCADE`. Adds the admin plugin's `impersonated_by`. |
| `auth.account` | `user_id` → `auth.users.id` `ON DELETE CASCADE`. `unique (user_id, provider_id)`: at most one credential row per user. |
| `auth.verification` | Keyed by `identifier`, with no user reference. |
| `auth.rate_limit` | Database rate-limit storage. |
| `auth.jwks` | The jwt plugin's signing keys. |

- **UUIDs.** Every id is `uuid` with a `gen_random_uuid()` default. `createAuth()` sets
  `advanced.database.generateId: 'uuid'`, and the pg Drizzle adapter leaves id generation to
  the database. A migrated user keeps the UUID their app data already references: the cutover
  copy inserts it explicitly, and better-auth signs that user in under the same id.
- **`timestamptz`.** Every timestamp is `timestamp with time zone`, like the legacy
  `public.users` values copied in, so microseconds and DST-boundary instants survive the copy
  exactly. better-auth reads them as JS `Date`s, which carry milliseconds.
- **Cascades.** Deleting an `auth.users` row by plain SQL (as the tombstone completion does)
  removes that user's sessions and accounts.

`tests/schema/auth-schema.test.ts` pins all of the above against a database built from the journal.

## Migrations

`drizzle/` holds the auth database's **only** journal, a fresh `0000` generated from
`src/schema.ts`.

- Change the schema, then run `pnpm --filter @ansari/auth db:generate`, and review the SQL. Never
  run `db:push`. Production SQL is human-applied at deploy (see `RELEASE.md`).
- `tests/migration/auth-journal-parity.test.ts` builds a database from the journal alone and fails
  if the schema declares a column that the journal does not create, or the reverse.
- `AUTH_DEPLOYED_THROUGH` in that test (owner: the main architect) names the last migration applied
  to the production auth database. It is `null` until the cutover window, and the deployed-state
  test is skipped, with a warning, until it is set. The window records the apply as a line
  `auth-journal-applied: <tag>` in its release notes (`RELEASE.md` or a `docs/` page). From
  then on, a `null` marker fails the suite.

## Local reset (if you ran the old `0000_better_auth_init`)

The #59 scaffold created `user`, `session`, `account` and `verification` in `public` of the
**shared** development database. That migration no longer exists. To move to the new layout:

1. Create a separate local database for auth, for example `createdb ansari_auth`, and point this
   package's `DATABASE_URL` (in `apps/auth/.env`) at it. Do not share the app database: both
   journals use drizzle's default `drizzle.__drizzle_migrations` bookkeeping table.
2. Run `pnpm --filter @ansari/auth db:migrate` against it.
3. In the app database, drop the scaffold tables if you want them gone:
   `DROP TABLE IF EXISTS public.session, public.account, public.verification, public."user";`.
   The leftover `0000_better_auth_init` row in that database's `drizzle.__drizzle_migrations` is
   harmless.

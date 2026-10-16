// The cutover copy (plan phase 12), run as the REAL scripts in
// apps/auth/scripts/cutover against two pglite databases: the APP database
// built from apps/api's journal (through 0010: the copy runs before the
// window migration 0011) and the AUTH database from packages/auth's. The pipe
// 01 | 02 is emulated by handing 01's stdout to 02's stdin (./psql.ts). The
// real psql pipe and copy.sh run in the phase 13 rehearsal.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { PGlite } from '@electric-sql/pglite';
import { createAuth, users } from '@ansari/auth';
import bcrypt from 'bcrypt';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  drizzleFor,
  emptyDatabase,
  migrate,
  setAuthEnv,
} from '../../../../packages/auth/tests/helpers/auth-db';
import { runPsqlFile } from './psql';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = resolve(here, '../../scripts/cutover');
const APP_DRIZZLE = resolve(here, '../../../api/drizzle');
const script = (name: string) => resolve(SCRIPTS, name);

const PASSWORD = 'Legacy-pass-123!';
let bcryptHash: string;

/** The app database as the window finds it: apps/api's journal through 0010. */
async function appDatabase(): Promise<PGlite> {
  const client = emptyDatabase();
  const entries = (
    JSON.parse(readFileSync(`${APP_DRIZZLE}/meta/_journal.json`, 'utf8')) as {
      entries: { idx: number; tag: string }[];
    }
  ).entries.sort((a, b) => a.idx - b.idx);
  for (const { tag } of entries) {
    if (tag.startsWith('0011')) break;
    for (const stmt of readFileSync(`${APP_DRIZZLE}/${tag}.sql`, 'utf8').split('--> statement-breakpoint')) {
      if (stmt.trim()) await client.exec(stmt);
    }
  }
  return client;
}

type LegacyRow = {
  id: string;
  email: string;
  hash?: string;
  first?: string | null;
  last?: string | null;
  via?: string | null;
  created?: string;
  updated?: string;
  admin?: boolean;
  systemKey?: string;
};

async function seed(app: PGlite, rows: LegacyRow[]): Promise<void> {
  for (const r of rows) {
    await app.query(
      `INSERT INTO users (id, email, password_hash, first_name, last_name, registered_via, created_at, updated_at, is_admin, system_key)
       VALUES ($1, $2, $3, $4, $5, $6, coalesce($7::timestamptz, now()), coalesce($8::timestamptz, now()), $9, $10)`,
      [
        r.id,
        r.email,
        r.hash ?? bcryptHash,
        r.first ?? null,
        r.last ?? null,
        r.via ?? null,
        r.created ?? null,
        r.updated ?? null,
        r.admin ?? false,
        r.systemKey ?? null,
      ]
    );
  }
}

/** 01 | 02, as copy.sh runs them. */
async function copy(app: PGlite, auth: PGlite) {
  const exported = await runPsqlFile(app, script('01-export-app.sql'));
  return runPsqlFile(auth, script('02-import-auth.sql'), { stdin: exported.stdout.join('') });
}

async function audits(app: PGlite, auth: PGlite) {
  return {
    app: (await runPsqlFile(app, script('03-audit-app.sql'))).stdout,
    auth: (await runPsqlFile(auth, script('03-audit-auth.sql'))).stdout,
  };
}

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const count = async (db: PGlite, sql: string) =>
  Number((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${sql}`)).rows[0]?.n);

let app: PGlite;
let auth: PGlite;

beforeEach(async () => {
  bcryptHash ??= await bcrypt.hash(PASSWORD, 4);
  app = await appDatabase();
  auth = await migrate();
});

afterEach(async () => {
  await app?.close();
  await auth?.close();
});

describe('the copy and the audits', () => {
  it('copies every non-system user with the same id, and the audits match', async () => {
    await seed(app, [
      { id: id(1), email: 'a@example.com', first: 'Amina', last: 'Yusuf', via: 'askansari-web' },
      { id: id(2), email: 'b@example.com' },
      { id: id(3), email: 'ai-skill@system.ansari.chat', hash: 'nologin', systemKey: 'ai-skill' },
    ]);
    const run = await copy(app, auth);
    expect(run.echo).toContain('cutover copy: committed');
    const { app: a, auth: b } = await audits(app, auth);
    expect(b).toEqual(a);
    expect(a).toContain('rows|2');
    expect(a).toContain('credentials|2');
    expect(a).toContain('system_domain_rows|0');
    const copied = await auth.query<{ id: string; registered_via: string | null; role: string }>(
      'SELECT id, registered_via, role FROM auth.users ORDER BY id'
    );
    expect(copied.rows).toEqual([
      { id: id(1), registered_via: 'askansari-web', role: 'user' },
      { id: id(2), registered_via: null, role: 'user' },
    ]);
  });

  it('scenario 20: system rows are never copied', async () => {
    await seed(app, [
      { id: id(1), email: 'a@example.com' },
      { id: id(3), email: 'ai-skill@system.ansari.chat', hash: 'nologin', systemKey: 'ai-skill' },
      { id: id(4), email: 'leaderboard@system.ansari.chat', hash: 'nologin', systemKey: 'leaderboard' },
    ]);
    await copy(app, auth);
    expect(await count(auth, `auth.users WHERE email LIKE '%@system.ansari.chat'`)).toBe(0);
    expect(await count(auth, `auth.users WHERE id IN ('${id(3)}', '${id(4)}')`)).toBe(0);
  });

  it('scenario 12: timestamps survive exactly (microseconds, a DST boundary)', async () => {
    await seed(app, [
      {
        id: id(1),
        email: 'a@example.com',
        created: '2026-03-29 01:59:59.123456+00',
        updated: '2026-10-25 00:59:59.999999+00',
      },
    ]);
    await copy(app, auth);
    const [appRow] = (await app.query<{ c: string; u: string }>(`SELECT created_at::text AS c, updated_at::text AS u FROM users WHERE id = '${id(1)}'`)).rows;
    const [userRow] = (await auth.query<{ c: string; u: string }>(`SELECT created_at::text AS c, updated_at::text AS u FROM auth.users WHERE id = '${id(1)}'`)).rows;
    const [accountRow] = (await auth.query<{ c: string; u: string }>(`SELECT created_at::text AS c, updated_at::text AS u FROM auth.account WHERE user_id = '${id(1)}'`)).rows;
    expect(userRow).toEqual(appRow);
    expect(accountRow).toEqual(appRow);
    expect(appRow?.c).toContain('.123456');
  });

  it('scenario 7: the derived name (names, local part, or "User"); first and last copy as stored', async () => {
    await seed(app, [
      { id: id(1), email: 'a@example.com', first: ' Amina ', last: 'Yusuf' },
      { id: id(2), email: 'first-only@example.com', first: 'Amina' },
      { id: id(3), email: 'nonames@example.com' },
      { id: id(4), email: '@example.com' },
    ]);
    await copy(app, auth);
    const rows = (await auth.query<{ id: string; name: string; first_name: string | null; last_name: string | null }>(
      'SELECT id, name, first_name, last_name FROM auth.users ORDER BY id'
    )).rows;
    expect(rows).toEqual([
      { id: id(1), name: 'Amina  Yusuf', first_name: ' Amina ', last_name: 'Yusuf' },
      { id: id(2), name: 'Amina', first_name: 'Amina', last_name: null },
      { id: id(3), name: 'nonames', first_name: null, last_name: null },
      { id: id(4), name: 'User', first_name: null, last_name: null },
    ]);
  });

  it('the SQL name rule matches deriveName in packages/auth (the sign-up hook)', async () => {
    const { deriveName } = await import('../../../../packages/auth/src/name');
    const cases: [string | null, string | null, string][] = [
      [' Amina ', 'Yusuf', 'a@example.com'],
      ['Amina', null, 'b@example.com'],
      [null, null, 'local.part@example.com'],
      ['  ', '\t', 'tabs@example.com'],
      [null, null, '@example.com'],
    ];
    await seed(
      app,
      cases.map(([first, last, email], i) => ({ id: id(i + 1), email, first, last }))
    );
    await copy(app, auth);
    const names = (await auth.query<{ name: string }>('SELECT name FROM auth.users ORDER BY id')).rows.map((r) => r.name);
    expect(names).toEqual(cases.map(([first, last, email]) => deriveName(first, last, email)));
  });

  it('scenario 9i: every copied user is email_verified, and nothing is mailed', async () => {
    await seed(app, [
      { id: id(1), email: 'a@example.com' },
      { id: id(2), email: 'b@example.com' },
    ]);
    await copy(app, auth);
    expect(await count(auth, 'auth.users WHERE email_verified IS NOT TRUE')).toBe(0);
    expect(await count(auth, 'auth.verification')).toBe(0);
  });

  it('scenario 13: a mixed-case, padded email is normalized, and signs in through createAuth with its legacy password', async () => {
    await seed(app, [{ id: id(1), email: '  Alice@Example.COM ' }]);
    await copy(app, auth);
    expect((await auth.query<{ email: string }>('SELECT email FROM auth.users')).rows).toEqual([
      { email: 'alice@example.com' },
    ]);
    setAuthEnv('http://localhost:3100');
    const service = createAuth(drizzleFor(auth));
    const result = await service.api.signInEmail({
      body: { email: 'ALICE@example.com', password: PASSWORD },
    });
    expect(result.user.id).toBe(id(1));
  });

  it('scenario 14: two rows that normalize to one email abort the copy, with no changes', async () => {
    await seed(app, [
      { id: id(1), email: 'Bob@x.com' },
      { id: id(2), email: 'bob@x.com' },
    ]);
    await expect(copy(app, auth)).rejects.toThrow(/1 normalized email\(s\) are held by more than one row/);
    expect(await count(auth, 'auth.users')).toBe(0);
    expect(await count(auth, 'auth.account')).toBe(0);
  });

  it('the collision error names a count, never an address', async () => {
    await seed(app, [
      { id: id(1), email: 'Bob@x.com' },
      { id: id(2), email: 'bob@x.com' },
    ]);
    const error = await copy(app, auth).catch((e: unknown) => e);
    expect(String(error)).not.toMatch(/bob@x\.com/i);
  });

  it('scenario 10: against a non-empty auth.users the copy aborts with no changes', async () => {
    await seed(app, [{ id: id(1), email: 'a@example.com' }]);
    await copy(app, auth);
    const before = await audits(app, auth);
    await expect(copy(app, auth)).rejects.toThrow(/auth\.users is not empty/);
    expect(await audits(app, auth)).toEqual(before);
  });

  it('scenario 10: re-running the account backfill on its own inserts nothing', async () => {
    await seed(app, [
      { id: id(1), email: 'a@example.com' },
      { id: id(2), email: 'b@example.com' },
    ]);
    await copy(app, auth);
    const sql = readFileSync(script('02-import-auth.sql'), 'utf8');
    const backfill = sql.slice(sql.indexOf('INSERT INTO auth.account'), sql.indexOf('COMMIT;', sql.indexOf('INSERT INTO auth.account')));
    const exported = (await runPsqlFile(app, script('01-export-app.sql'))).stdout.join('');
    await auth.exec(`CREATE TEMP TABLE import_users (id uuid, email text, first_name text, last_name text, password_hash text, registered_via text, created_at timestamptz, updated_at timestamptz)`);
    await auth.query(`COPY import_users FROM '/dev/blob'`, [], { blob: new Blob([exported]) });
    const inserted = await auth.query(backfill);
    expect(inserted.affectedRows).toBe(0);
    expect(await count(auth, 'auth.account')).toBe(2);
    await auth.exec('DISCARD TEMP');
  });

  it('an empty import aborts', async () => {
    await expect(runPsqlFile(auth, script('02-import-auth.sql'), { stdin: '' })).rejects.toThrow(/the import is empty/);
  });

  it('scenario 9h: one hash altered in transit fails the hash audit', async () => {
    await seed(app, [
      { id: id(1), email: 'a@example.com' },
      { id: id(2), email: 'b@example.com' },
    ]);
    const exported = (await runPsqlFile(app, script('01-export-app.sql'))).stdout.join('');
    const tampered = exported.replace(bcryptHash, `${bcryptHash.slice(0, -1)}X`);
    expect(tampered).not.toBe(exported);
    await runPsqlFile(auth, script('02-import-auth.sql'), { stdin: tampered });
    const { app: a, auth: b } = await audits(app, auth);
    expect(b).not.toEqual(a);
    const differing = a.filter((line, i) => line !== b[i]).map((line) => line.split('|')[0]);
    expect(differing).toEqual(['hash_checksum']);
  });

  it('scenario 9h: the import table is TEMP, and a failed step 2 leaves none behind', async () => {
    const sql = readFileSync(script('02-import-auth.sql'), 'utf8');
    expect(sql).toMatch(/CREATE TEMP TABLE import_users/);
    await seed(app, [
      { id: id(1), email: 'Bob@x.com' },
      { id: id(2), email: 'bob@x.com' },
    ]);
    await copy(app, auth).catch(() => undefined);
    expect(await count(auth, `pg_class WHERE relname = 'import_users'`)).toBe(0);
  });

  it('no copied row lands outside auth.users and auth.account', async () => {
    await seed(app, [{ id: id(1), email: 'a@example.com' }]);
    await copy(app, auth);
    expect(await count(auth, 'auth.session')).toBe(0);
    expect(await count(auth, `pg_class WHERE relname = 'import_users'`)).toBe(0);
  });
});

describe('after the copy', () => {
  it('scenario 16: the approved admin list is granted; a legacy admin left off it is not', async () => {
    await seed(app, [
      { id: id(1), email: 'kept-admin@example.com', admin: true },
      { id: id(2), email: 'dropped-admin@example.com', admin: true },
      { id: id(3), email: 'new-admin@example.com' },
    ]);
    const preflight = await runPsqlFile(app, script('00-preflight-app.sql'));
    expect(preflight.stdout).toEqual(
      expect.arrayContaining([`${id(2)}|dropped-admin@example.com`, `${id(1)}|kept-admin@example.com`])
    );
    await copy(app, auth);
    const db = drizzleFor(auth);
    for (const email of ['kept-admin@example.com', 'new-admin@example.com']) {
      await users.setRoleByEmail(db, email, 'admin');
    }
    const admins = (await runPsqlFile(auth, script('05-audit-admins-auth.sql'))).stdout;
    expect(admins).toEqual(['kept-admin@example.com', 'new-admin@example.com']);
  });

  it('amendment C: completing a pending tombstone leaves no orphan session or account', async () => {
    await seed(app, [
      { id: id(1), email: 'gone@example.com' },
      { id: id(2), email: 'stays@example.com' },
    ]);
    await copy(app, auth);
    setAuthEnv('http://localhost:3100');
    const service = createAuth(drizzleFor(auth));
    await service.api.signInEmail({ body: { email: 'gone@example.com', password: PASSWORD } });
    await service.api.signInEmail({ body: { email: 'stays@example.com', password: PASSWORD } });
    // DELETE me ran on apps/api, but its apps/auth step failed: the row is
    // gone from the app database and its tombstone is pending.
    await app.exec(`DELETE FROM users WHERE id = '${id(1)}'; INSERT INTO deleted_users (id) VALUES ('${id(1)}')`);

    const pending = (await runPsqlFile(app, script('04-tombstones-pending-app.sql'))).stdout;
    expect(pending).toEqual([`{${id(1)}}`]);
    await runPsqlFile(auth, script('04-tombstones-delete-auth.sql'), { vars: { ids: pending[0] as string } });
    await runPsqlFile(app, script('04-tombstones-mark-app.sql'), { vars: { ids: pending[0] as string } });

    expect(await count(auth, `auth.users WHERE id = '${id(1)}'`)).toBe(0);
    expect(await count(auth, `auth.session WHERE user_id = '${id(1)}'`)).toBe(0);
    expect(await count(auth, `auth.account WHERE user_id = '${id(1)}'`)).toBe(0);
    expect(await count(auth, `auth.session WHERE user_id = '${id(2)}'`)).toBe(1);
    expect(await count(app, `deleted_users WHERE id = '${id(1)}' AND auth_deleted_at IS NOT NULL`)).toBe(1);
    expect((await runPsqlFile(app, script('04-tombstones-pending-app.sql'))).stdout).toEqual(['{}']);
  });
});

describe('rollback: remove post-cutover users (docs/cutover/rollback.md)', () => {
  const CUTOVER = '2026-10-20 03:00:00+00';

  async function seeded() {
    await seed(app, [
      { id: id(1), email: 'before@example.com', created: '2026-10-19 12:00:00+00' },
      { id: id(2), email: 'after@example.com', created: '2026-10-20 03:00:00+00' },
      { id: id(3), email: 'later@example.com', created: '2026-10-20 09:30:00+00' },
      { id: id(4), email: 'ai-skill@system.ansari.chat', hash: 'nologin', systemKey: 'ai-skill', created: '2026-10-21 00:00:00+00' },
    ]);
    await app.exec(`INSERT INTO threads (id, user_id, name) VALUES ('${id(9)}', '${id(3)}', 'post-cutover thread')`);
  }

  it('the dry run counts post-cutover users and deletes nothing', async () => {
    await seeded();
    const run = await runPsqlFile(app, script('rollback-remove-post-cutover-users.sql'), { vars: { cutover_at: CUTOVER } });
    expect(run.stdout).toEqual(['2']);
    expect(run.echo.at(-1)).toMatch(/dry run only/);
    expect(await count(app, 'users')).toBe(4);
  });

  it.each(['no', 'off', 'false'])('confirm=%s is still a dry run', async (confirm) => {
    await seeded();
    await runPsqlFile(app, script('rollback-remove-post-cutover-users.sql'), { vars: { cutover_at: CUTOVER, confirm } });
    expect(await count(app, 'users')).toBe(4);
  });

  it('confirm=yes removes users created at or after cutover_at, with their threads; system rows stay', async () => {
    await seeded();
    await runPsqlFile(app, script('rollback-remove-post-cutover-users.sql'), {
      vars: { cutover_at: CUTOVER, confirm: 'yes' },
    });
    const left = (await app.query<{ id: string }>('SELECT id FROM users ORDER BY id')).rows.map((r) => r.id);
    expect(left).toEqual([id(1), id(4)]);
    expect(await count(app, 'threads')).toBe(0);
  });

  it('without cutover_at it refuses', async () => {
    await seeded();
    await expect(runPsqlFile(app, script('rollback-remove-post-cutover-users.sql'))).rejects.toThrow(/set -v cutover_at/);
    expect(await count(app, 'users')).toBe(4);
  });
});

describe('copy.sh and complete-tombstones.sh refuse to run unguarded', () => {
  // The guards exit before psql is ever called, so these run without a database.
  const run = (name: string, env: Record<string, string>) =>
    spawnSync('bash', [script(name)], { env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf8' });
  const both = { APP_DATABASE_URL: 'postgresql://app/x', AUTH_DATABASE_URL: 'postgresql://auth/y' };

  it.each(['copy.sh', 'complete-tombstones.sh'])('%s: outside a Railway shell', (name) => {
    const result = run(name, both);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/outside a Railway shell/);
  });

  it.each(['copy.sh', 'complete-tombstones.sh'])('%s: a missing URL', (name) => {
    const result = run(name, { RAILWAY_ENVIRONMENT: 'production', APP_DATABASE_URL: 'postgresql://app/x' });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/AUTH_DATABASE_URL is unset/);
  });

  it.each(['copy.sh', 'complete-tombstones.sh'])('%s: the same database twice', (name) => {
    const result = run(name, {
      RAILWAY_ENVIRONMENT: 'production',
      APP_DATABASE_URL: 'postgresql://same/db',
      AUTH_DATABASE_URL: 'postgresql://same/db',
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/the same database/);
  });

  it('copy.sh prints counts and checksums only: no echo of a URL or row data', () => {
    const source = readFileSync(script('copy.sh'), 'utf8');
    expect(source).not.toMatch(/echo .*\$(APP|AUTH)_DATABASE_URL/);
    expect(source).toMatch(/set -euo pipefail/);
    expect(source).not.toMatch(/mktemp|> *\/tmp|tee /);
  });
});

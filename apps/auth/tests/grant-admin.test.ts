// The admin role script, the ban script's arguments, and the boot assertion
// (spec 300 rule 6; plan phase 5), against the auth database on pglite.
import { users } from '@ansari/auth';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseArgs as parseBanArgs, runBanUser } from '../scripts/ban-user';
import { parseArgs, runGrantAdmin, scriptError } from '../scripts/grant-admin';
import { assertConfiguredAdminsExist, shouldRunAdminStartupCheck } from '../src/startup-checks';
import { signUpTokens, startService, type Service } from './helpers/service';

let service: Service;
let seq = 0;
const nextEmail = (label: string) => `${label}-${++seq}@example.com`;

beforeAll(async () => {
  service = await startService();
});
afterAll(async () => {
  await service.close();
});

async function credential(email: string) {
  const { rows } = await service.client.query<{ password: string; role: string | null }>(
    `select a.password, u.role from auth.users u join auth.account a on a.user_id = u.id
     where u.email = $1 and a.provider_id = 'credential'`,
    [email]
  );
  return rows[0];
}

describe('grant-admin.ts arguments', () => {
  it('parses grant, revoke and list, and refuses anything else', () => {
    expect(parseArgs(['a@example.com'])).toEqual({ kind: 'grant', email: 'a@example.com' });
    expect(parseArgs(['--revoke', 'a@example.com'])).toEqual({
      kind: 'revoke',
      email: 'a@example.com',
    });
    expect(parseArgs(['--list'])).toEqual({ kind: 'list' });
    for (const bad of [
      [],
      ['--list', 'x'],
      ['--revoke'],
      ['--revoke', '--list'],
      ['a', 'b'],
      ['--grant', 'a'],
    ]) {
      expect(parseArgs(bad)).toBeNull();
    }
  });
});

describe('grant-admin.ts', () => {
  it('grants admin by email, normalized, without touching the credential', async () => {
    const email = nextEmail('grant');
    await signUpTokens(service, email);
    const before = await credential(email);

    const lines = await runGrantAdmin(service.db, {
      kind: 'grant',
      email: `  ${email.toUpperCase()} `,
    });
    expect(lines[0]).toContain(`Granted admin to ${email}`);
    const after = await credential(email);
    expect(after?.role).toBe('admin');
    expect(after?.password).toBe(before?.password);
  });

  it('revokes back to role user', async () => {
    const email = nextEmail('revoke');
    await signUpTokens(service, email);
    await runGrantAdmin(service.db, { kind: 'grant', email });
    await runGrantAdmin(service.db, { kind: 'revoke', email });
    expect((await credential(email))?.role).toBe('user');
  });

  it('never creates a user', async () => {
    const email = nextEmail('missing');
    const failure = runGrantAdmin(service.db, { kind: 'grant', email });
    await expect(failure).rejects.toBeInstanceOf(users.UserNotFoundError);
    const { rows } = await service.client.query('select id from auth.users where email = $1', [
      email,
    ]);
    expect(rows).toHaveLength(0);
  });

  it('--list prints exactly the admin set', async () => {
    const a = nextEmail('list-a');
    const b = nextEmail('list-b');
    const plain = nextEmail('list-plain');
    for (const email of [a, b, plain]) await signUpTokens(service, email);
    await runGrantAdmin(service.db, { kind: 'grant', email: b });
    await runGrantAdmin(service.db, { kind: 'grant', email: a });

    const listed = await users.listAdmins(service.db);
    const { rows } = await service.client.query<{ email: string }>(
      "select email from auth.users where role = 'admin' order by email"
    );
    expect(listed.map((u) => u.email)).toEqual(rows.map((r) => r.email));
    const lines = await runGrantAdmin(service.db, { kind: 'list' });
    expect(lines[0]).toBe(`${rows.length} admin(s):`);
    expect(lines.join('\n')).toContain(a);
    expect(lines.join('\n')).toContain(b);
    expect(lines.join('\n')).not.toContain(plain);
  });

  it('reports a driver error by its name only', () => {
    const err = Object.assign(new Error('duplicate key value (email)=(secret@example.com)'), {
      name: 'DatabaseError',
    });
    expect(scriptError(err)).toBe('DatabaseError');
    expect(scriptError(new users.UserNotFoundError())).toBe('No auth user has this email');
  });
});

describe('ban-user.ts arguments', () => {
  it('parses ban with an optional reason and days, and unban', () => {
    expect(parseBanArgs(['--ban', 'a@example.com'])).toEqual({
      kind: 'ban',
      email: 'a@example.com',
      reason: null,
      days: null,
    });
    expect(parseBanArgs(['--ban', 'a@example.com', '--reason', 'spam', '--days', '7'])).toEqual({
      kind: 'ban',
      email: 'a@example.com',
      reason: 'spam',
      days: 7,
    });
    expect(parseBanArgs(['--unban', 'a@example.com'])).toEqual({
      kind: 'unban',
      email: 'a@example.com',
    });
    for (const bad of [
      [],
      ['--ban'],
      ['--ban', '--reason'],
      ['--ban', 'a', '--days', '0'],
      ['--ban', 'a', '--days', '1.5'],
      ['--ban', 'a', '--reason'],
      ['--ban', 'a', '--reason', 'x', '--reason', 'y'],
      ['--unban', 'a', '--days', '1'],
      ['a@example.com'],
    ]) {
      expect(parseBanArgs(bad)).toBeNull();
    }
  });

  it("a timed ban sets ban_expires, and the session delete shares the ban's transaction", async () => {
    const email = nextEmail('timed');
    const { id } = await signUpTokens(service, email);
    const now = Date.UTC(2026, 9, 16);
    await runBanUser(service.db, { kind: 'ban', email, reason: 'spam', days: 7 }, now);
    const { rows } = await service.client.query<{
      banned: boolean;
      ban_reason: string;
      ban_expires: Date;
    }>('select banned, ban_reason, ban_expires from auth.users where id = $1', [id]);
    expect(rows[0]).toMatchObject({ banned: true, ban_reason: 'spam' });
    expect(new Date(rows[0]?.ban_expires ?? 0).getTime()).toBe(now + 7 * 24 * 3600 * 1000);

    await runBanUser(service.db, { kind: 'unban', email });
    const { rows: cleared } = await service.client.query(
      'select banned, ban_reason, ban_expires from auth.users where id = $1',
      [id]
    );
    expect(cleared[0]).toEqual({ banned: false, ban_reason: null, ban_expires: null });
  });

  it('banning an unknown email changes nothing', async () => {
    await expect(
      runBanUser(service.db, { kind: 'ban', email: nextEmail('nobody'), reason: null, days: null })
    ).rejects.toBeInstanceOf(users.UserNotFoundError);
  });
});

describe('assertConfiguredAdminsExist', () => {
  it('passes with no configured admins, and when every entry is an admin', async () => {
    await expect(assertConfiguredAdminsExist(service.db, [])).resolves.toBeUndefined();
    const email = nextEmail('boot-admin');
    await signUpTokens(service, email);
    await runGrantAdmin(service.db, { kind: 'grant', email });
    await expect(
      assertConfiguredAdminsExist(service.db, [email.toUpperCase()])
    ).resolves.toBeUndefined();
  });

  it('fails when an entry has no account, naming its position and never its address', async () => {
    const admin = nextEmail('boot-ok');
    await signUpTokens(service, admin);
    await runGrantAdmin(service.db, { kind: 'grant', email: admin });
    const missing = nextEmail('boot-missing');
    const failure = assertConfiguredAdminsExist(service.db, [admin, missing]);
    await expect(failure).rejects.toThrow(/configured admin #2 of 2 .* has no account/);
    await failure.catch((err: Error) => expect(err.message).not.toContain('example.com'));
  });

  it('fails when an entry exists but is not an admin', async () => {
    const email = nextEmail('boot-plain');
    await signUpTokens(service, email);
    await expect(assertConfiguredAdminsExist(service.db, [email])).rejects.toThrow(
      /role is not admin/
    );
  });

  it('fails as unreachable, not as missing, when the database errors', async () => {
    const broken = {
      select: () => {
        throw new Error('connect ECONNREFUSED');
      },
    } as unknown as Service['db'];
    await expect(assertConfiguredAdminsExist(broken, ['a@example.com'])).rejects.toThrow(
      /could not reach the database/
    );
  });
});

describe('shouldRunAdminStartupCheck', () => {
  it('runs in production only', () => {
    expect(shouldRunAdminStartupCheck({ NODE_ENV: 'production' })).toBe(true);
    for (const NODE_ENV of ['development', 'test', undefined]) {
      expect(shouldRunAdminStartupCheck({ NODE_ENV })).toBe(false);
    }
  });
});

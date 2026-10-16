// The internal endpoints (spec 300 rules 5, 6 and 8; plan phase 5, P-1, P-2,
// G-3), driven over the internal listener with real JWTs minted by the same
// createAuth() instance.
import { randomUUID } from 'node:crypto';

import { limits, users } from '@ansari/auth';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { internalLimitKey } from '../src/routes/internal';
import { TEST_JWT_AUDIENCE, TEST_JWT_ISSUER } from '../../../packages/auth/tests/helpers/auth-db';
import { runBanUser } from '../scripts/ban-user';
import {
  internalHeaders,
  INTERNAL_SECRET,
  send,
  signIn,
  signUp,
  signUpTokens,
  startService,
  STRONG_PASSWORD,
  tokenStatus,
  type Service,
} from './helpers/service';

let service: Service;
let seq = 0;
const nextEmail = (label: string) => `${label}-${++seq}@example.com`;

beforeAll(async () => {
  service = await startService();
});
afterAll(async () => {
  await service.close();
});

function internal(
  path: string,
  opts: { method?: string; bearer?: string; secret?: string | null } = {}
) {
  const headers =
    opts.secret === null ? {} : internalHeaders(undefined, opts.secret ?? INTERNAL_SECRET);
  return send(service.internalUrl, path, {
    method: opts.method ?? 'GET',
    bearer: opts.bearer,
    headers,
  });
}

const profile = (id: string, secret?: string | null) =>
  internal(`/internal/users/${id}/profile`, { secret });
const role = (id: string, secret?: string | null) =>
  internal(`/internal/users/${id}/role`, { secret });
const del = (id: string, bearer?: string, secret?: string | null) =>
  internal(`/internal/users/${id}`, { method: 'DELETE', bearer, secret });
const revoke = (id: string, bearer?: string, secret?: string | null) =>
  internal(`/internal/users/${id}/revoke-sessions`, { method: 'POST', bearer, secret });

async function userRow(id: string) {
  const { rows } = await service.client.query('select id from auth.users where id = $1', [id]);
  return rows[0];
}
async function count(table: 'session' | 'account', id: string) {
  const { rows } = await service.client.query<{ n: number }>(
    `select count(*)::int as n from auth.${table} where user_id = $1`,
    [id]
  );
  return rows[0]?.n ?? 0;
}

/** A token signed by this service's own key, with chosen claims. */
async function signed(payload: Record<string, unknown>) {
  const { token } = await service.auth.api.signJWT({ body: { payload } });
  return token;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

describe('the internal credential', () => {
  const routes = (id: string) => [
    () => profile(id, null),
    () => role(id, null),
    () => del(id, undefined, null),
    () => revoke(id, undefined, null),
    () => profile(id, 'a-wrong-secret-that-is-also-32-characters'),
    () => role(id, `${INTERNAL_SECRET}x`),
    () => del(id, undefined, INTERNAL_SECRET.slice(0, -1)),
    () => revoke(id, undefined, ''),
  ];

  it('every internal route answers 401 without the right credential, and leaks nothing', async () => {
    const { id, jwt } = await signUpTokens(service, nextEmail('cred'));
    for (const call of routes(id)) {
      const res = await call();
      expect(res.status).toBe(401);
      expect(await res.text()).not.toContain('example.com');
    }
    // Even the subject's own JWT does not stand in for the credential.
    expect((await del(id, jwt, null)).status).toBe(401);
    expect(await userRow(id)).toBeDefined();
  });

  it('the internal routes are not mounted on the public listener', async () => {
    const { id } = await signUpTokens(service, nextEmail('public'));
    const res = await send(service.publicUrl, `/internal/users/${id}/profile`, {
      headers: internalHeaders(),
    });
    expect(res.status).toBe(404);
  });
});

describe('GET /internal/users/:id/profile', () => {
  it('returns exactly the profile fields', async () => {
    const email = nextEmail('profile');
    const { id } = await signUpTokens(service, email);
    const res = await profile(id);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual([
      'email',
      'first_name',
      'id',
      'last_name',
      'registered_via',
    ]);
    expect(body).toMatchObject({
      id,
      email,
      first_name: null,
      last_name: null,
      registered_via: null,
    });
  });

  it('carries first_name, last_name and registered_via as stored', async () => {
    const email = nextEmail('named');
    const res = await send(service.publicUrl, '/api/auth/sign-up/email', {
      body: { email, password: STRONG_PASSWORD, first_name: 'Amina', last_name: 'Khan' },
      headers: { 'x-ansari-client': 'ios' },
    });
    const { user } = (await res.json()) as { user: { id: string } };
    const body = await (await profile(user.id)).json();
    expect(body).toMatchObject({ first_name: 'Amina', last_name: 'Khan' });
    const { rows } = await service.client.query<{ registered_via: string | null }>(
      'select registered_via from auth.users where id = $1',
      [user.id]
    );
    expect(body.registered_via).toBe(rows[0]?.registered_via);
  });

  it('404s an unknown id and a non-UUID id', async () => {
    expect((await profile(randomUUID())).status).toBe(404);
    expect((await profile('not-a-uuid')).status).toBe(404);
    expect((await role("1' or '1'='1")).status).toBe(404);
  });

  it('never returns a system account, because none can exist in the auth database', async () => {
    expect((await signUp(service, 'ai-skill@system.ansari.chat')).status).toBe(409);
    const { rows } = await service.client.query(
      "select id from auth.users where email like '%@system.ansari.chat'"
    );
    expect(rows).toHaveLength(0);
  });
});

describe('GET /internal/users/:id/role', () => {
  it('reports the role and ban state', async () => {
    const email = nextEmail('role');
    const { id } = await signUpTokens(service, email);
    expect(await (await role(id)).json()).toEqual({ role: 'user', banned: false });

    await users.setRoleByEmail(service.db, email, users.ADMIN_ROLE);
    expect(await (await role(id)).json()).toEqual({ role: 'admin', banned: false });
  });

  it('an expired ban is not reported as banned', async () => {
    const email = nextEmail('expired-ban');
    const { id } = await signUpTokens(service, email);
    await users.banUserByEmail(service.db, email, { expiresAt: new Date(Date.now() - 1000) });
    expect(await (await role(id)).json()).toEqual({ role: 'user', banned: false });
  });
});

describe('DELETE /internal/users/:id (scenario 9g)', () => {
  it("refuses without a JWT, with another user's JWT, and with forged JWTs; the account remains", async () => {
    const target = await signUpTokens(service, nextEmail('target'));
    const other = await signUpTokens(service, nextEmail('other'));

    const foreignKey = (await generateKeyPair('EdDSA')).privateKey;
    const [header] = target.jwt.split('.');
    const forged = {
      // Signed by a key this service never issued, with the real kid.
      foreignKey: await new SignJWT({ sub: target.id })
        .setProtectedHeader({
          alg: 'EdDSA',
          kid: JSON.parse(Buffer.from(header ?? '', 'base64url').toString()).kid,
        })
        .setIssuer(TEST_JWT_ISSUER)
        .setAudience(TEST_JWT_AUDIENCE)
        .setExpirationTime('5m')
        .sign(foreignKey),
      // The other user's token with its payload swapped for the target's.
      swappedPayload: [
        other.jwt.split('.')[0],
        Buffer.from(
          JSON.stringify({
            ...JSON.parse(Buffer.from(other.jwt.split('.')[1] ?? '', 'base64url').toString()),
            sub: target.id,
          })
        ).toString('base64url'),
        other.jwt.split('.')[2],
      ].join('.'),
      unsigned: `${Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')}.${Buffer.from(
        JSON.stringify({
          sub: target.id,
          iss: TEST_JWT_ISSUER,
          aud: TEST_JWT_AUDIENCE,
          exp: nowSeconds() + 300,
        })
      ).toString('base64url')}.`,
      // The HS256 confusion attack, keyed by the internal secret.
      hmac: await new SignJWT({ sub: target.id })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuer(TEST_JWT_ISSUER)
        .setAudience(TEST_JWT_AUDIENCE)
        .setExpirationTime('5m')
        .sign(new TextEncoder().encode(INTERNAL_SECRET)),
      wrongIssuer: await signed({ sub: target.id, iss: 'https://evil.example' }),
      wrongAudience: await signed({ sub: target.id, aud: 'someone-else' }),
      expired: await signed({ sub: target.id, exp: nowSeconds() - 60 }),
      // The session token is not a JWT.
      sessionToken: target.sessionToken,
    };

    expect((await del(target.id)).status).toBe(401);
    expect((await del(target.id, other.jwt)).status).toBe(403);
    for (const [name, token] of Object.entries(forged)) {
      const res = await del(target.id, token);
      expect({ name, status: res.status }).toEqual({ name, status: 401 });
    }

    expect(await userRow(target.id)).toBeDefined();
    expect(await count('session', target.id)).toBe(1);
    expect(await count('account', target.id)).toBe(1);
    expect(await tokenStatus(service, target.sessionToken)).toBe(200);
  });

  it('a non-Bearer Authorization header is refused', async () => {
    const target = await signUpTokens(service, nextEmail('scheme'));
    const res = await send(service.internalUrl, `/internal/users/${target.id}`, {
      method: 'DELETE',
      headers: { ...internalHeaders(), authorization: `Basic ${target.jwt}` },
    });
    expect(res.status).toBe(401);
    expect(await userRow(target.id)).toBeDefined();
  });

  it("with the subject's own JWT it deletes the sessions, accounts and user, and is idempotent", async () => {
    const email = nextEmail('delete');
    const target = await signUpTokens(service, email);
    const bystander = await signUpTokens(service, nextEmail('bystander'));

    expect((await del(target.id, target.jwt)).status).toBe(204);
    expect(await userRow(target.id)).toBeUndefined();
    expect(await count('session', target.id)).toBe(0);
    expect(await count('account', target.id)).toBe(0);
    expect(await tokenStatus(service, target.sessionToken)).toBe(401);
    expect((await signIn(service, email, STRONG_PASSWORD)).status).toBe(401);
    expect((await profile(target.id)).status).toBe(404);

    // A retry (apps/api's tombstone path) is a 204 too.
    expect((await del(target.id, target.jwt)).status).toBe(204);
    // Nobody else was touched.
    expect(await userRow(bystander.id)).toBeDefined();
    expect(await tokenStatus(service, bystander.sessionToken)).toBe(200);
  });
});

describe("keys planted in the service's own JWKS", () => {
  // The service only ever signs EdDSA tokens with an exp, so these pins are
  // reached by adding keys to its own jwks table: older than its signing key,
  // which stays the one /token signs with, and in a separate service.
  let planted: Service;
  beforeAll(async () => {
    planted = await startService();
  });
  afterAll(async () => {
    await planted.close();
  });

  async function plant(alg: 'EdDSA' | 'RS256') {
    const { publicKey, privateKey } = await generateKeyPair(alg, { extractable: true });
    const kid = randomUUID();
    const jwk = await exportJWK(publicKey);
    await planted.client.query(
      `insert into auth.jwks (id, public_key, private_key, created_at, alg, crv)
       values ($1, $2, $3, now() - interval '1 day', $4, $5)`,
      [kid, JSON.stringify(jwk), 'unused', alg, jwk.crv ?? null]
    );
    return (claims: { exp?: boolean }) => {
      const jwt = new SignJWT({})
        .setProtectedHeader({ alg, kid })
        .setIssuer(TEST_JWT_ISSUER)
        .setAudience(TEST_JWT_AUDIENCE);
      return (subject: string) => {
        jwt.setSubject(subject);
        if (claims.exp !== false) jwt.setExpirationTime('5m');
        return jwt.sign(privateKey);
      };
    };
  }

  const revokeAt = (id: string, bearer: string) =>
    send(planted.internalUrl, `/internal/users/${id}/revoke-sessions`, {
      method: 'POST',
      bearer,
      headers: internalHeaders(),
    });

  it('a token with no exp is refused, though its key is trusted', async () => {
    const target = await signUpTokens(planted, nextEmail('no-exp'));
    const sign = await plant('EdDSA');
    expect((await revokeAt(target.id, await sign({ exp: false })(target.id))).status).toBe(401);
    expect(await tokenStatus(planted, target.sessionToken)).toBe(200);
    // The control: the same key with an exp is accepted.
    expect((await revokeAt(target.id, await sign({})(target.id))).status).toBe(204);
  });

  it('a key of another algorithm in the JWKS is never accepted', async () => {
    const target = await signUpTokens(planted, nextEmail('rs256'));
    const sign = await plant('RS256');
    expect((await revokeAt(target.id, await sign({})(target.id))).status).toBe(401);
    expect(await tokenStatus(planted, target.sessionToken)).toBe(200);
  });
});

describe('POST /internal/users/:id/revoke-sessions (G-3)', () => {
  it('has the same refusal matrix as delete', async () => {
    const target = await signUpTokens(service, nextEmail('revoke-target'));
    const other = await signUpTokens(service, nextEmail('revoke-other'));

    expect((await revoke(target.id)).status).toBe(401);
    expect((await revoke(target.id, other.jwt)).status).toBe(403);
    expect((await revoke(target.id, await signed({ sub: target.id, aud: 'x' }))).status).toBe(401);
    expect(
      (await revoke(target.id, await signed({ sub: target.id, exp: nowSeconds() - 60 }))).status
    ).toBe(401);
    expect((await revoke(target.id, target.sessionToken)).status).toBe(401);
    expect(await tokenStatus(service, target.sessionToken)).toBe(200);
  });

  it('ends every session of the subject, so none can mint a JWT; the user remains', async () => {
    const email = nextEmail('revoke');
    const first = await signUpTokens(service, email);
    const second = await signIn(service, email, STRONG_PASSWORD);
    const secondToken = ((await second.json()) as { token: string }).token;
    const bystander = await signUpTokens(service, nextEmail('revoke-bystander'));
    expect(await count('session', first.id)).toBe(2);

    expect((await revoke(first.id, first.jwt)).status).toBe(204);
    expect(await count('session', first.id)).toBe(0);
    expect(await tokenStatus(service, first.sessionToken)).toBe(401);
    expect(await tokenStatus(service, secondToken)).toBe(401);
    expect(await userRow(first.id)).toBeDefined();
    expect(await tokenStatus(service, bystander.sessionToken)).toBe(200);
    // The user can sign in again.
    expect((await signIn(service, email, STRONG_PASSWORD)).status).toBe(200);
  });
});

describe('a ban (scripts/ban-user.ts)', () => {
  it('kills every session, refuses sign-in, and the role endpoint reports banned', async () => {
    const email = nextEmail('banned');
    const target = await signUpTokens(service, email);

    const lines = await runBanUser(service.db, { kind: 'ban', email, reason: 'abuse', days: null });
    expect(lines.join('\n')).toContain('deleted 1 session(s)');
    expect(await count('session', target.id)).toBe(0);
    expect(await tokenStatus(service, target.sessionToken)).toBe(401);
    const signInRes = await signIn(service, email, STRONG_PASSWORD);
    expect(signInRes.status).toBe(403);
    expect(((await signInRes.json()) as { code: string }).code).toBe('BANNED_USER');
    expect(await (await role(target.id)).json()).toEqual({ role: 'user', banned: true });

    await runBanUser(service.db, { kind: 'unban', email });
    expect(await (await role(target.id)).json()).toEqual({ role: 'user', banned: false });
    expect((await signIn(service, email, STRONG_PASSWORD)).status).toBe(200);
  });
});

describe('the internal rate limit (P-2)', () => {
  it('each endpoint has its own global budget of INTERNAL_ENDPOINT', async () => {
    const { id } = await signUpTokens(service, nextEmail('limited'));
    const key = internalLimitKey('profile');
    await service.client.query(
      `insert into auth.rate_limit (key, count, last_request) values ($1, $2, $3)
       on conflict (key) do update set count = excluded.count, last_request = excluded.last_request`,
      [key, limits.INTERNAL_ENDPOINT.max - 1, Date.now()]
    );
    // The last request in the window passes; the next is refused, from any caller.
    expect((await profile(id)).status).toBe(200);
    const refused = await profile(randomUUID());
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get('x-retry-after'))).toBeGreaterThan(0);
    // The role endpoint's budget is separate.
    expect((await role(id)).status).toBe(200);

    await service.client.query('delete from auth.rate_limit where key = $1', [key]);
    expect((await profile(id)).status).toBe(200);
  });
});

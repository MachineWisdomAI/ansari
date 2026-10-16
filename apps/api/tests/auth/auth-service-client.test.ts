import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import {
  AuthServiceUnavailableError,
  authServiceFetch,
  deleteAuthUser,
  getAuthProfile,
  getAuthRole,
} from '@/lib/auth-service/client';
import { INTERNAL_SECRET, setApiEnv } from './helpers';

/**
 * The auth-service client against a stub that answers whatever a test sets,
 * for the responses the real apps/auth never sends: a 5xx carrying a
 * valid-looking body, a profile for another id, a bad shape.
 */

let server: Server;
let reply: { status: number; body?: string };
let seen: { method?: string; url?: string; headers: IncomingHttpHeaders }[];

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    res.writeHead(reply.status, { 'content-type': 'application/json' });
    res.end(reply.body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  seen = [];
  reply = { status: 200, body: '{}' };
  setApiEnv(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
});

const profile = (id: string) =>
  JSON.stringify({ id, email: 'a@b.test', first_name: null, last_name: null, registered_via: null });

async function unavailableStatus(promise: Promise<unknown>) {
  const err = await promise.then(
    () => null,
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(AuthServiceUnavailableError);
  return (err as AuthServiceUnavailableError).status;
}

describe('authServiceFetch', () => {
  it('sends the credential, the forwarded IP and the bearer', async () => {
    await authServiceFetch('/internal/x', { clientIp: '203.0.113.9', bearer: 'jwt-value' });
    expect(seen[0].headers['x-ansari-internal-auth']).toBe(INTERNAL_SECRET);
    expect(seen[0].headers['x-ansari-forwarded-client-ip']).toBe('203.0.113.9');
    expect(seen[0].headers.authorization).toBe('Bearer jwt-value');
  });

  it('sends no forwarded IP when there is none', async () => {
    await authServiceFetch('/internal/x', { clientIp: null });
    expect(seen[0].headers['x-ansari-forwarded-client-ip']).toBeUndefined();
  });
});

describe('getAuthProfile', () => {
  it('returns the profile for the id it asked about, at the encoded path', async () => {
    const id = randomUUID();
    reply = { status: 200, body: profile(id) };
    expect((await getAuthProfile(id))?.id).toBe(id);
    expect(seen[0].url).toBe(`/internal/users/${id}/profile`);
  });

  it('404 is "no such user"', async () => {
    reply = { status: 404 };
    expect(await getAuthProfile(randomUUID())).toBeNull();
  });

  it('a 5xx is unavailable even with a valid-looking body', async () => {
    const id = randomUUID();
    reply = { status: 500, body: profile(id) };
    expect(await unavailableStatus(getAuthProfile(id))).toBe(500);
  });

  it('a profile for another id is unavailable, never used', async () => {
    reply = { status: 200, body: profile(randomUUID()) };
    expect(await unavailableStatus(getAuthProfile(randomUUID()))).toBe(200);
  });

  it('a bad shape or bad JSON is unavailable', async () => {
    reply = { status: 200, body: '{"id":1}' };
    expect(await unavailableStatus(getAuthProfile(randomUUID()))).toBe(200);
    reply = { status: 200, body: 'not json' };
    expect(await unavailableStatus(getAuthProfile(randomUUID()))).toBe(200);
  });

  it('no listener is unavailable with no status', async () => {
    await new Promise((resolve) => server.close(resolve));
    try {
      expect(await unavailableStatus(getAuthProfile(randomUUID()))).toBeNull();
    } finally {
      await new Promise<void>((resolve) =>
        server.listen(Number(new URL(process.env.AUTH_INTERNAL_URL!).port), '127.0.0.1', resolve)
      );
    }
  });
});

describe('getAuthRole', () => {
  it('returns role and ban state; 404 is null; 429 and 5xx are unavailable', async () => {
    reply = { status: 200, body: '{"role":"admin","banned":false}' };
    expect(await getAuthRole(randomUUID())).toEqual({ role: 'admin', banned: false });
    reply = { status: 404 };
    expect(await getAuthRole(randomUUID())).toBeNull();
    reply = { status: 429, body: '{"role":"admin","banned":false}' };
    expect(await unavailableStatus(getAuthRole(randomUUID()))).toBe(429);
    reply = { status: 503, body: '{"role":"admin","banned":false}' };
    expect(await unavailableStatus(getAuthRole(randomUUID()))).toBe(503);
  });
});

describe('deleteAuthUser', () => {
  it('sends DELETE with the subject JWT; only 204 is done', async () => {
    const id = randomUUID();
    reply = { status: 204 };
    await deleteAuthUser(id, 'subject-jwt');
    expect(seen[0]).toMatchObject({ method: 'DELETE', url: `/internal/users/${id}` });
    expect(seen[0].headers.authorization).toBe('Bearer subject-jwt');
    reply = { status: 403 };
    expect(await unavailableStatus(deleteAuthUser(id, 'x'))).toBe(403);
  });
});

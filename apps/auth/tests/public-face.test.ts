// The rest of the public face: CORS (scenario 28), the edge-check diag route
// (plan P-4) and the health probe.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BASE, send, signUp, startService, STRONG_PASSWORD, type Service } from './helpers/service';

let service: Service;

beforeAll(async () => {
  service = await startService();
  expect((await signUp(service, 'cors@example.com')).status).toBe(200);
});

afterAll(async () => {
  await service?.close();
});

const preflight = (origin: string, requestHeaders = 'content-type,authorization,x-ansari-client') =>
  fetch(`${service.publicUrl}/api/auth/sign-in/email`, {
    method: 'OPTIONS',
    headers: {
      origin,
      'access-control-request-method': 'POST',
      'access-control-request-headers': requestHeaders,
    },
  });

describe('CORS (scenario 28)', () => {
  it('a preflight from the allowed origin passes, X-Ansari-Client included, without credentials', async () => {
    const res = await preflight(BASE);
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(BASE);
    const allowed = (res.headers.get('access-control-allow-headers') ?? '').toLowerCase();
    for (const header of ['content-type', 'authorization', 'x-ansari-client']) {
      expect(allowed).toContain(header);
    }
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('an allowed origin can read set-auth-token and set-auth-jwt', async () => {
    const res = await send(service.publicUrl, '/api/auth/sign-in/email', {
      body: { email: 'cors@example.com', password: STRONG_PASSWORD },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe(BASE);
    const exposed = (res.headers.get('access-control-expose-headers') ?? '').toLowerCase();
    expect(exposed).toContain('set-auth-token');
    expect(exposed).toContain('set-auth-jwt');
    expect(res.headers.get('set-auth-token')).toBeTruthy();

    // get-session is where the jwt plugin hands out set-auth-jwt.
    const session = await send(service.publicUrl, '/api/auth/get-session', {
      bearer: res.headers.get('set-auth-token') ?? '',
    });
    expect(session.status).toBe(200);
    expect(session.headers.get('set-auth-jwt')).toBeTruthy();
    const sessionExposed = (session.headers.get('access-control-expose-headers') ?? '').toLowerCase();
    expect(sessionExposed).toContain('set-auth-token');
    expect(sessionExposed).toContain('set-auth-jwt');
  });

  it.each(['https://evil.example', `${BASE}.evil.example`, 'http://localhost:31000', 'null'])(
    'a disallowed origin (%s) gets no allow headers, on the preflight or the request',
    async (origin) => {
      const pre = await preflight(origin);
      expect(pre.headers.get('access-control-allow-origin')).toBeNull();
      expect(pre.headers.get('access-control-allow-headers')).toBeNull();
      const res = await send(service.publicUrl, '/api/auth/get-session', {
        headers: { origin, cookie: 'better-auth.session_token=anything' },
      });
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
      expect(res.headers.get('access-control-allow-credentials')).toBeNull();
      expect(res.headers.get('access-control-expose-headers')).toBeNull();
    }
  );

  it('a credentialed request from a disallowed origin is refused by the origin check', async () => {
    const res = await send(service.publicUrl, '/api/auth/sign-out', {
      headers: { origin: 'https://evil.example', cookie: 'better-auth.session_token=anything' },
      body: {},
    });
    expect(res.status).toBe(403);
  });

  it('the internal listener sends no CORS headers at all', async () => {
    const res = await fetch(`${service.internalUrl}/api/auth/get-session`, { headers: { origin: BASE } });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('the diag route (P-4)', () => {
  it("returns only the caller's own X-Real-IP and the X-Forwarded-For entry count, no-store", async () => {
    const res = await send(service.publicUrl, '/__diag/client-ip', {
      ip: '203.0.113.150',
      headers: { 'x-forwarded-for': '198.51.100.1, 198.51.100.2' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ x_real_ip: '203.0.113.150', x_forwarded_for_entries: 2 });
    expect(text).not.toContain('198.51.100');
  });

  it('reports no IP as null', async () => {
    const res = await send(service.publicUrl, '/__diag/client-ip', { ip: null });
    expect(await res.json()).toEqual({ x_real_ip: null, x_forwarded_for_entries: 0 });
  });

  it('is not on the internal listener', async () => {
    const res = await send(service.internalUrl, '/__diag/client-ip', {
      headers: { 'x-ansari-internal-auth': 'test-internal-secret-at-least-32-characters' },
    });
    expect(res.status).toBe(404);
  });
});

describe('health', () => {
  it('answers 200 once the auth database answers select 1', async () => {
    const res = await send(service.publicUrl, '/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('answers 503 when the database cannot', async () => {
    const down = await startService();
    await down.client.close();
    try {
      const res = await send(down.publicUrl, '/health');
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ status: 'unavailable' });
    } finally {
      await down.close().catch(() => {});
    }
  });
});

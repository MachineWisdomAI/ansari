// The listener split and the client IP (spec 300 Client IP; plan P-1,
// amendments A and B; scenarios 21 and 22). Rate-limit buckets are read back
// from auth.rate_limit, so each test shows WHICH key a request landed in, not
// only whether it was limited.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { limits } from '@ansari/auth';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  FORWARDED_IP_HEADER,
  internalPerimeter,
  ipBucket,
  singleIp,
  stripForwardedIp,
  verifyInternalCredential,
} from '../src/middleware/client-ip';
import {
  internalHeaders,
  INTERNAL_SECRET,
  rateLimitKeys,
  send,
  startService,
  type Service,
} from './helpers/service';

const SIGN_IN = '/api/auth/sign-in/email';

type EdgeShape = { name: string; headers: Record<string, string>; client?: string; never?: string[] };
/** Header shapes behind Railway's edge, per path (docs/cutover/edge-check.md). */
const EDGE = JSON.parse(
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../docs/cutover/edge-header-shapes.json'), 'utf8')
) as { shapes: EdgeShape[]; withoutTheEdge: EdgeShape[] };
const wrongPassword = { email: 'nobody@example.com', password: 'Wrong-Passw0rd!' };

let service: Service;

beforeAll(async () => {
  service = await startService({ mode: 'ip' });
});

afterAll(async () => {
  await service?.close();
});

const failedSignIn = (baseUrl: string, ip: string | null, headers: Record<string, string> = {}) =>
  send(baseUrl, SIGN_IN, { ip, headers, body: wrongPassword });

describe('public listener (amendment A)', () => {
  it.each([
    '/internal/users/00000000-0000-0000-0000-000000000000/profile',
    '/INTERNAL/users/x/role',
    '/internal/',
    '/internal',
    '/%69nternal/users/x/profile',
    '/Internal/users/x',
  ])('%s is not mounted: 404, with or without the credential', async (path) => {
    for (const headers of [{}, internalHeaders()]) {
      const res = await send(service.publicUrl, path, { headers });
      expect(res.status).toBe(404);
      expect(await res.text()).toBe('');
    }
  });

  it('a forwarded IP sent WITH a valid credential is stripped and never becomes a bucket', async () => {
    const res = await failedSignIn(service.publicUrl, '203.0.113.60', internalHeaders('192.0.2.60'));
    expect(res.status).toBe(401);
    const keys = await rateLimitKeys(service);
    expect(keys).toContain(`203.0.113.60|${'/sign-in/email'}`);
    expect(keys.some((k) => k.includes('192.0.2.60'))).toBe(false);
  });
});

describe('internal listener: the credential is required on every request', () => {
  it.each([
    ['/internal/users/x/profile', 'GET'],
    ['/api/auth/jwks', 'GET'],
    ['/api/auth/get-session', 'GET'],
    [SIGN_IN, 'POST'],
  ])('%s without the credential → 401', async (path, method) => {
    const body = method === 'POST' ? wrongPassword : undefined;
    expect((await send(service.internalUrl, path, { method, body })).status).toBe(401);
    const wrong = await send(service.internalUrl, path, {
      method,
      body,
      headers: internalHeaders(undefined, `${INTERNAL_SECRET}x`),
    });
    expect(wrong.status).toBe(401);
  });

  it('a forwarded IP without the credential is refused, never bucketed', async () => {
    const res = await failedSignIn(service.internalUrl, null, { [FORWARDED_IP_HEADER]: '192.0.2.61' });
    expect(res.status).toBe(401);
    expect((await rateLimitKeys(service)).some((k) => k.includes('192.0.2.61'))).toBe(false);
  });

  it('with the credential, /internal/* is past the gate (routes arrive in phase 5)', async () => {
    const res = await send(service.internalUrl, '/internal/users/x/profile', {
      headers: internalHeaders(),
    });
    expect(res.status).toBe(404);
  });

  it('with the credential, the JWKS answers', async () => {
    const res = await send(service.internalUrl, '/api/auth/jwks', { headers: internalHeaders() });
    expect(res.status).toBe(200);
  });
});

describe('forwarded-IP validation (amendment B)', () => {
  const forged = [
    '',
    '   ',
    '1.2.3.4, 5.6.7.8',
    '::ffff:zz.zz',
    '::ffff:999.1.1.1',
    'attacker.example',
    `1.2.3.${'4'.repeat(60)}`,
    'fe80::1%eth0',
    '300.1.1.1',
  ];

  it.each(forged)('%j with a valid credential falls back to X-Real-IP', async (value) => {
    const realIp = '203.0.113.70';
    const before = new Set(await rateLimitKeys(service));
    const res = await failedSignIn(service.internalUrl, realIp, internalHeaders(value));
    expect(res.status).not.toBe(400);
    const added = (await rateLimitKeys(service)).filter((k) => !before.has(k));
    expect(added.every((k) => k.startsWith(`${realIp}|`))).toBe(true);
    if (value.trim()) {
      expect((await rateLimitKeys(service)).some((k) => k.includes(value.trim()))).toBe(false);
    }
  });

  it.each(forged)('%j with no X-Real-IP gets the production 400', async (value) => {
    const prod = await startService({ production: true });
    try {
      const res = await failedSignIn(prod.internalUrl, null, internalHeaders(value));
      expect(res.status).toBe(400);
      expect(await rateLimitKeys(prod)).toEqual([]);
    } finally {
      await prod.close();
    }
  });

  it('singleIp accepts exactly one address', () => {
    expect(singleIp('203.0.113.1')).toBe('203.0.113.1');
    expect(singleIp(' 2001:db8::1 ')).toBe('2001:db8::1');
    expect(singleIp('::ffff:203.0.113.1')).toBe('::ffff:203.0.113.1');
    for (const bad of [...forged, undefined, ['1.2.3.4']]) expect(singleIp(bad)).toBeNull();
  });
});

describe('scenario 21: one bucket per X-Real-IP', () => {
  it(`the ${limits.SIGN_IN.max + 1}th sign-in from one X-Real-IP is 429`, async () => {
    const ip = '203.0.113.80';
    for (let i = 0; i < limits.SIGN_IN.max; i++) {
      expect((await failedSignIn(service.publicUrl, ip)).status).toBe(401);
    }
    expect((await failedSignIn(service.publicUrl, ip)).status).toBe(429);
    expect((await failedSignIn(service.publicUrl, '203.0.113.81')).status).toBe(401);
  });

  it('a forged two-entry X-Forwarded-For does not change the bucket', async () => {
    const ip = '203.0.113.82';
    for (let i = 0; i < limits.SIGN_IN.max; i++) await failedSignIn(service.publicUrl, ip);
    const res = await failedSignIn(service.publicUrl, ip, {
      'x-forwarded-for': '198.51.100.9, 198.51.100.10',
    });
    expect(res.status).toBe(429);
  });

  it('direct and layer sign-ins for one client share one budget', async () => {
    const ip = '203.0.113.83';
    for (let i = 0; i < 3; i++) await failedSignIn(service.publicUrl, ip);
    for (let i = 0; i < limits.SIGN_IN.max - 3; i++) {
      expect((await failedSignIn(service.internalUrl, null, internalHeaders(ip))).status).toBe(401);
    }
    expect((await failedSignIn(service.internalUrl, null, internalHeaders(ip))).status).toBe(429);
    expect((await failedSignIn(service.publicUrl, ip)).status).toBe(429);
  });
});

describe('scenario 22: through the layer, two clients are two buckets', () => {
  it('two forwarded IPs land in two buckets, never the hop peer’s', async () => {
    const [a, b] = ['203.0.113.90', '203.0.113.91'];
    for (let i = 0; i < limits.SIGN_IN.max; i++) {
      await failedSignIn(service.internalUrl, '10.0.0.5', internalHeaders(a));
    }
    expect((await failedSignIn(service.internalUrl, '10.0.0.5', internalHeaders(a))).status).toBe(429);
    expect((await failedSignIn(service.internalUrl, '10.0.0.5', internalHeaders(b))).status).toBe(401);
    const keys = await rateLimitKeys(service);
    expect(keys).toEqual(expect.arrayContaining([`${a}|/sign-in/email`, `${b}|/sign-in/email`]));
    expect(keys).not.toContain('10.0.0.5|/sign-in/email');
  });
});

describe('the production 400: no request reaches the shared no-trusted-ip bucket', () => {
  let prod: Service;

  beforeAll(async () => {
    prod = await startService({ production: true });
  });

  afterAll(async () => {
    await prod?.close();
  });

  it.each([
    ['public, no X-Real-IP', () => failedSignIn(prod.publicUrl, null)],
    ['public, a two-entry X-Real-IP', () => failedSignIn(prod.publicUrl, '1.2.3.4, 5.6.7.8')],
    ['internal, credential but no IP source', () => failedSignIn(prod.internalUrl, null, internalHeaders())],
  ])('%s → 400', async (_name, request) => {
    expect((await request()).status).toBe(400);
  });

  // apps/api's verifier fetches the key set with the credential and no end
  // user behind it, so no IP: it must answer in production, outside the
  // router, and still require the credential (phase 8 consult, Codex).
  it('internal JWKS answers with the credential and no IP source, in production', async () => {
    const res = await send(prod.internalUrl, '/api/auth/jwks', { ip: null, headers: internalHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { keys: { kid: string; alg?: string }[] };
    expect(Array.isArray(body.keys)).toBe(true);
  });

  it('internal JWKS without the credential is still 401', async () => {
    expect((await send(prod.internalUrl, '/api/auth/jwks', { ip: null })).status).toBe(401);
  });

  it('the public JWKS with no IP source is still refused', async () => {
    expect((await send(prod.publicUrl, '/api/auth/jwks', { ip: null })).status).toBe(400);
  });

  it('nothing was bucketed, least of all no-trusted-ip', async () => {
    expect(await rateLimitKeys(prod)).toEqual([]);
  });

  it('health and the diag route still answer without an IP', async () => {
    expect((await send(prod.publicUrl, '/health', { ip: null })).status).toBe(200);
    expect((await send(prod.publicUrl, '/__diag/client-ip', { ip: null })).status).toBe(200);
  });

  it('outside production a missing IP is not refused', async () => {
    expect((await failedSignIn(service.publicUrl, null)).status).toBe(401);
  });
});

describe('verifyInternalCredential', () => {
  it('accepts only the exact secret', () => {
    expect(verifyInternalCredential(INTERNAL_SECRET, INTERNAL_SECRET)).toBe(true);
    for (const bad of ['', `${INTERNAL_SECRET} `, INTERNAL_SECRET.slice(0, -1), 'x', undefined, [INTERNAL_SECRET]]) {
      expect(verifyInternalCredential(bad, INTERNAL_SECRET)).toBe(false);
    }
  });

  it('the public listener deletes the forwarded IP before anything reads it', () => {
    // Nothing on the public listener consults the header today; the strip keeps
    // it that way for any later middleware or Better Auth hook.
    const req = { headers: internalHeaders('192.0.2.99') } as never;
    let nextCalled = false;
    stripForwardedIp(req, {} as never, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
    expect((req as { headers: Record<string, string> }).headers[FORWARDED_IP_HEADER]).toBeUndefined();
  });

  it('the middleware strips the credential before Better Auth sees it', () => {
    const req = { headers: { 'x-ansari-internal-auth': INTERNAL_SECRET } } as never;
    let nextCalled = false;
    internalPerimeter(INTERNAL_SECRET)(req, {} as never, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
    expect((req as { headers: Record<string, string> }).headers).toEqual({});
  });
});

describe('ipBucket groups exactly like better-auth', () => {
  it.each([
    ['203.0.113.5', '203.0.113.5'],
    ['::ffff:203.0.113.5', '203.0.113.5'],
    ['::FFFF:203.0.113.5', '203.0.113.5'],
    ['::ffff:cb00:7105', '203.0.113.5'],
    ['0:0:0:0:0:ffff:cb00:7105', '203.0.113.5'],
    ['::ffff:cb00:7106', '203.0.113.6'],
    ['2001:db8:1:2:3:4:5:6', '2001:0db8:0001:0002:0000:0000:0000:0000'],
    ['2001:DB8:1:2::9', '2001:0db8:0001:0002:0000:0000:0000:0000'],
    ['2001:db8::1', '2001:0db8:0000:0000:0000:0000:0000:0000'],
  ])('%s → %s', (ip, bucket) => {
    expect(ipBucket(ip)).toBe(bucket);
  });
  it.each(['::ffff:cb00:7107', '::ffff:203.0.113.8', '2001:db8:9:9::1', '203.0.113.9'])(
    "%s lands in the same bucket better-auth's router computes",
    async (ip) => {
      await failedSignIn(service.publicUrl, ip);
      expect(await rateLimitKeys(service)).toContain(`${ipBucket(ip)}|/sign-in/email`);
    }
  );
});

describe('edge header shapes (docs/cutover/edge-header-shapes.json): only X-Real-IP is the client', () => {
  it('the fixture has both paths and both no-edge shapes', () => {
    expect(EDGE.shapes).toHaveLength(2);
    expect(EDGE.withoutTheEdge).toHaveLength(2);
  });

  it.each(EDGE.shapes.map((s) => [s.name, s] as const))(
    '%s: the bucket is the X-Real-IP client; cf-connecting-ip and x-forwarded-for are never a key',
    async (_name, shape) => {
      const prod = await startService({ production: true });
      try {
        const res = await failedSignIn(prod.publicUrl, null, shape.headers);
        expect(res.status).toBe(401);
        const keys = await rateLimitKeys(prod);
        expect(keys).toEqual([`${shape.client}|/sign-in/email`]);
        for (const other of shape.never ?? []) expect(keys.some((k) => k.includes(other))).toBe(false);
      } finally {
        await prod.close();
      }
    }
  );

  it.each(EDGE.withoutTheEdge.map((s) => [s.name, s] as const))(
    '%s: the production 400, and no bucket',
    async (_name, shape) => {
      const prod = await startService({ production: true });
      try {
        const res = await failedSignIn(prod.publicUrl, null, shape.headers);
        expect(res.status).toBe(400);
        expect(await rateLimitKeys(prod)).toEqual([]);
      } finally {
        await prod.close();
      }
    }
  );
});

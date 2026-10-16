// Rate limiting as configured in createAuth() (spec 300, phase 3): enabled,
// database storage, the router rules from limits.ts, and the client IP read
// from X-Real-IP alone. The `email` fallback, the reset limiters and the
// forwarded-IP hop are apps/auth's (phase 4).
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createAuth, schema, type Auth, type Db } from '../../src/index';
import { DEFAULT_RULE, ROUTER_RULES, SIGN_IN, SIGN_UP, TOKEN_EXCHANGE } from '../../src/limits';
import { drizzleFor, migrate, setAuthEnv } from '../helpers/auth-db';
import { BASE, call } from '../helpers/http';

let client: PGlite;
let db: Db;
let auth: Auth;

beforeAll(async () => {
  setAuthEnv(BASE);
  client = await migrate();
  db = drizzleFor(client);
  auth = createAuth(db);
});

afterAll(async () => {
  await client?.close();
});

const failedSignIn = (ip: string | null, headers?: Record<string, string>) =>
  call(auth, '/sign-in/email', {
    ip,
    headers,
    body: { email: 'nobody@example.com', password: 'Wrong-Passw0rd!' },
  });

async function rateLimitKeys(): Promise<string[]> {
  return (await db.select({ key: schema.rateLimit.key }).from(schema.rateLimit)).map((r) => r.key);
}

describe('rate-limit configuration', () => {
  it('is enabled, stored in the database, with limits.ts as its rules', () => {
    expect(auth.options.rateLimit).toMatchObject({
      enabled: true,
      storage: 'database',
      window: DEFAULT_RULE.window,
      max: DEFAULT_RULE.max,
      customRules: ROUTER_RULES,
    });
    expect(ROUTER_RULES['/sign-in/email']).toEqual({ window: 60, max: 5 });
    expect(ROUTER_RULES['/sign-up/email']).toEqual({ window: 60, max: 3 });
  });

  it('reads the client IP from x-real-ip only, with no trusted proxies', () => {
    expect(auth.options.advanced?.ipAddress).toEqual({ ipAddressHeaders: ['x-real-ip'] });
  });
});

describe('sign-in and sign-up limits, per X-Real-IP', () => {
  it(`sign-in: ${SIGN_IN.max} per ${SIGN_IN.window}s, the next one is 429`, async () => {
    const ip = '203.0.113.10';
    for (let i = 0; i < SIGN_IN.max; i++) expect((await failedSignIn(ip)).status).toBe(401);
    expect((await failedSignIn(ip)).status).toBe(429);
    // Another client is unaffected.
    expect((await failedSignIn('203.0.113.11')).status).toBe(401);
  });

  it(`sign-up: ${SIGN_UP.max} per ${SIGN_UP.window}s, the next one is 429`, async () => {
    const ip = '203.0.113.20';
    for (let i = 0; i < SIGN_UP.max; i++) {
      const res = await call(auth, '/sign-up/email', {
        ip,
        body: { email: `limit-${i}@example.com`, password: 'Limit-Passw0rd!', name: 'X' },
      });
      expect(res.status).toBe(200);
    }
    const over = await call(auth, '/sign-up/email', {
      ip,
      body: { email: 'limit-over@example.com', password: 'Limit-Passw0rd!', name: 'X' },
    });
    expect(over.status).toBe(429);
  });

  it(`the session → JWT exchange allows a burst of ${TOKEN_EXCHANGE.max}`, async () => {
    const ip = '203.0.113.30';
    for (let i = 0; i < TOKEN_EXCHANGE.max; i++) {
      expect((await call(auth, '/token', { ip, bearer: 'no-such-session' })).status).toBe(401);
    }
    expect((await call(auth, '/token', { ip, bearer: 'no-such-session' })).status).toBe(429);
  });
});

describe('the bucket is X-Real-IP, never X-Forwarded-For', () => {
  it('a request with a two-entry X-Forwarded-For is keyed by its X-Real-IP', async () => {
    await failedSignIn('203.0.113.40', { 'x-forwarded-for': '10.9.9.9, 10.8.8.8' });
    const keys = await rateLimitKeys();
    expect(keys).toContain('203.0.113.40|/sign-in/email');
    expect(keys.some((k) => k.startsWith('10.'))).toBe(false);
    expect(keys.some((k) => k.startsWith('no-trusted-ip'))).toBe(false);
  });

  it('forging X-Forwarded-For does not move a client out of its exhausted bucket', async () => {
    const ip = '203.0.113.50';
    for (let i = 0; i < SIGN_IN.max; i++) await failedSignIn(ip);
    for (const forged of ['198.51.100.1', '198.51.100.2, 198.51.100.3']) {
      expect((await failedSignIn(ip, { 'x-forwarded-for': forged })).status).toBe(429);
    }
  });
});

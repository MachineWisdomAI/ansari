// apps/auth's own limiters (limits/email-limiter.ts): the reset-request caps in
// both modes, and the `email`-mode fallback (scenario 32) with its list-walk
// alert. Time moves with a faked Date, which both better-auth's router and
// these limiters read.
import { limits, touchKey } from '@ansari/auth';
import * as Sentry from '@sentry/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { LIST_WALK_MESSAGE, type ListWalkAlert } from '../src/alerts';
import { emailHash, emailKey, ipBurstKey, ipKey } from '../src/limits/email-limiter';
import {
  rateLimitRow,
  send,
  signIn,
  signUp,
  startService,
  STRONG_PASSWORD,
  type Service,
} from './helpers/service';

const RESET = '/api/auth/request-password-reset';

function advance(seconds: number): void {
  vi.setSystemTime(Date.now() + seconds * 1000);
}

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-16T12:00:00Z') });
});

afterAll(() => {
  vi.useRealTimers();
});

const requestReset = (service: Service, email: string, ip: string) =>
  send(service.publicUrl, RESET, { ip, body: { email } });

async function snapshot(res: Response) {
  return { status: res.status, body: await res.text() };
}

describe.each(['ip', 'email'] as const)('reset requests (%s mode)', (mode) => {
  let service: Service;

  beforeAll(async () => {
    service = await startService({ mode });
    expect((await signUp(service, 'reset-me@example.com')).status).toBe(200);
    expect((await signUp(service, 'reset-two@example.com')).status).toBe(200);
  });

  afterAll(async () => {
    await service?.close();
  });

  it(`the per-email cap (${limits.RESET_REQUEST_PER_EMAIL.max}/h) holds across two IPs, known and unknown alike`, async () => {
    for (const [n, email] of ['reset-me@example.com', 'no-such-user@example.com'].entries()) {
      const ips = [`203.0.113.${110 + 2 * n}`, `203.0.113.${111 + 2 * n}`];
      for (let i = 0; i < limits.RESET_REQUEST_PER_EMAIL.max; i++) {
        expect((await requestReset(service, email, ips[i % 2] as string)).status).not.toBe(429);
      }
      const over = await requestReset(service, ` ${email.toUpperCase()} `, `203.0.113.${115 + n}`);
      expect(over.status).toBe(429);
      const row = await rateLimitRow(service, emailKey(email, '/request-password-reset'));
      expect(row?.count).toBe(limits.RESET_REQUEST_PER_EMAIL.max + 1);
    }
  });

  it('an unknown email draws the same response as a known one, at every step', async () => {
    const known: unknown[] = [];
    const unknown: unknown[] = [];
    for (let i = 0; i <= limits.RESET_REQUEST_PER_EMAIL.max; i++) {
      advance(61); // past better-auth's own per-IP burst rule
      known.push(await snapshot(await requestReset(service, 'reset-two@example.com', '203.0.113.120')));
      unknown.push(await snapshot(await requestReset(service, 'ghost@example.com', '203.0.113.121')));
    }
    advance(3600);
    expect(unknown).toEqual(known);
  });

  it(`the IP cap (${limits.RESET_REQUEST_PER_IP.max}/15 min) holds across many emails`, async () => {
    const ip = '203.0.113.130';
    for (let i = 0; i < limits.RESET_REQUEST_PER_IP.max; i++) {
      advance(61);
      expect((await requestReset(service, `walker-${i}@example.com`, ip)).status).not.toBe(429);
    }
    advance(61);
    expect((await requestReset(service, 'walker-last@example.com', ip)).status).toBe(429);
    expect((await rateLimitRow(service, ipKey(ip, '/request-password-reset')))?.count).toBe(
      limits.RESET_REQUEST_PER_IP.max + 1
    );
    advance(limits.RESET_REQUEST_PER_IP.window);
    expect((await requestReset(service, 'walker-after@example.com', ip)).status).not.toBe(429);
  });

  it(`a request refused by the ${limits.RESET_REQUEST_BURST.max}/min burst still counts toward the IP cap`, async () => {
    advance(3600);
    const ip = '203.0.113.160';
    const total = limits.RESET_REQUEST_PER_IP.max;
    const statuses: number[] = [];
    for (let i = 0; i < total; i++) {
      statuses.push((await requestReset(service, `burst-${i}@example.com`, ip)).status);
    }
    expect(statuses.filter((s) => s === 429)).toHaveLength(total - limits.RESET_REQUEST_BURST.max);
    expect((await rateLimitRow(service, ipKey(ip, '/request-password-reset')))?.count).toBe(total);
    expect((await rateLimitRow(service, ipBurstKey(ip, '/request-password-reset')))?.count).toBe(total);
    advance(61); // the burst window is over; the 15-minute cap is not
    expect((await requestReset(service, 'burst-after@example.com', ip)).status).toBe(429);
  });

  it('a request refused by the burst still counts toward the email cap', async () => {
    advance(3600);
    const email = 'burst-victim@example.com';
    const ip = '203.0.113.161';
    for (let i = 0; i < limits.RESET_REQUEST_BURST.max; i++) {
      await requestReset(service, `filler-${i}@example.com`, ip);
    }
    expect((await requestReset(service, email, ip)).status).toBe(429); // burst
    for (let i = 1; i < limits.RESET_REQUEST_PER_EMAIL.max; i++) {
      expect((await requestReset(service, email, `203.0.113.${170 + i}`)).status).not.toBe(429);
    }
    expect((await requestReset(service, email, '203.0.113.179')).status).toBe(429);
  });

  it("better-auth's router has no rule of its own for the path", () => {
    expect(service.auth.options.rateLimit?.customRules?.['/request-password-reset']).toBe(false);
  });

  it('no key holds a raw email', async () => {
    const { rows } = await service.client.query<{ key: string }>('select key from auth.rate_limit');
    expect(rows.some((r) => r.key.includes('@'))).toBe(false);
  });
});

describe('the email-mode fallback (scenario 32)', () => {
  let service: Service;
  const alerts: ListWalkAlert[] = [];
  const victim = 'victim@example.com';
  const wrong = 'Wrong-Passw0rd!';
  const rule = limits.FALLBACK_SIGN_IN_PER_EMAIL;

  beforeAll(async () => {
    service = await startService({ mode: 'email', alert: (a) => alerts.push(a) });
    expect((await signUp(service, victim)).status).toBe(200);
    expect((await signUp(service, 'steady@example.com')).status).toBe(200);
  });

  afterAll(async () => {
    await service?.close();
  });

  afterEach(() => {
    advance(3600);
  });

  it(`${rule.max} wrong passwords, then the right one: 429; after the window it succeeds`, async () => {
    // Each attempt from a different IP: the lock is per email, not per IP.
    for (let i = 0; i < rule.max; i++) {
      expect((await signIn(service, victim, wrong)).status).toBe(401);
    }
    const walkKey = `walk:${emailHash(victim)}`;
    const walkAtLock = (await rateLimitRow(service, walkKey))?.last_request;
    expect(walkAtLock).toBeDefined();
    expect((await signIn(service, victim, STRONG_PASSWORD)).status).toBe(429);
    advance(30);
    // A refused attempt is not counted, so it cannot extend the lock, and it
    // writes no list-walk row: the lock's engaging failure already did.
    expect((await signIn(service, victim, wrong)).status).toBe(429);
    expect((await rateLimitRow(service, emailKey(victim, '/sign-in/email')))?.count).toBe(rule.max);
    expect((await rateLimitRow(service, walkKey))?.last_request).toBe(walkAtLock);
    advance(rule.window - 30);
    expect((await signIn(service, victim, STRONG_PASSWORD)).status).toBe(200);
  });

  it('ten correct sign-ins in a row, from one IP, are never limited', async () => {
    for (let i = 0; i < 10; i++) {
      expect((await signIn(service, 'steady@example.com', STRONG_PASSWORD, { ip: '203.0.113.140' })).status).toBe(200);
    }
    expect(await rateLimitRow(service, emailKey('steady@example.com', '/sign-in/email'))).toBeUndefined();
  });

  it('with the per-IP rule off, many failures from one IP for different emails are not a global cap', async () => {
    for (let i = 0; i < limits.SIGN_IN.max * 2; i++) {
      expect((await signIn(service, `spread-${i}@example.com`, wrong, { ip: '203.0.113.141' })).status).toBe(401);
    }
  });

  it(`sign-up: ${limits.FALLBACK_SIGN_UP_PER_EMAIL.max} per email, every request counted`, async () => {
    for (let i = 0; i < limits.FALLBACK_SIGN_UP_PER_EMAIL.max; i++) {
      expect((await signUp(service, 'dup@example.com')).status).not.toBe(429);
    }
    expect((await signUp(service, 'dup@example.com')).status).toBe(429);
  });

  it(`sign-up: the global ceiling (${limits.FALLBACK_SIGN_UP_GLOBAL.max}/min) holds across emails and IPs`, async () => {
    // Too-short passwords fail fast and still count: the ceiling counts every request.
    for (let i = 0; i < limits.FALLBACK_SIGN_UP_GLOBAL.max; i++) {
      expect((await signUp(service, `ceiling-${i}@example.com`, 'short')).status).toBe(400);
    }
    expect((await signUp(service, 'ceiling-over@example.com', STRONG_PASSWORD)).status).toBe(429);
  });

  it(`the list-walk alert fires once at ${limits.LIST_WALK_ALERT.distinctEmails} distinct emails, with no raw email`, async () => {
    const threshold = limits.LIST_WALK_ALERT.distinctEmails;
    alerts.length = 0;
    const walked = Array.from({ length: threshold + 2 }, (_, i) => `walked-${i}@example.com`);
    for (const [i, email] of walked.entries()) {
      for (let n = 0; n < rule.max; n++) await signIn(service, email, wrong);
      expect(alerts.length).toBe(i + 1 < threshold ? 0 : 1);
    }
    const [alert] = alerts;
    expect(alert?.distinctEmails).toBe(threshold);
    expect(alert?.windowSeconds).toBe(limits.LIST_WALK_ALERT.window);
    expect(alert?.hashPrefixes).toHaveLength(threshold);
    for (const prefix of alert?.hashPrefixes ?? []) expect(prefix).toMatch(/^[0-9a-f]{8}$/);
    expect(walked.map((e) => emailHash(e).slice(0, 8))).toEqual(expect.arrayContaining(alert?.hashPrefixes ?? []));
    expect(JSON.stringify(alert)).not.toMatch(/@|walked/);
  });
});

describe('the list-walk alert through Sentry', () => {
  let service: Service;
  const envelopes: unknown[] = [];

  beforeAll(async () => {
    Sentry.init({
      dsn: 'https://public@o0.ingest.sentry.io/0',
      defaultIntegrations: false,
      transport: () => ({
        send: async (envelope) => {
          envelopes.push(envelope);
          return {};
        },
        flush: async () => true,
      }),
    });
    service = await startService({ mode: 'email' });
  });

  afterAll(async () => {
    await Sentry.close();
    await service?.close();
  });

  it('a Sentry transport spy sees one event with counts and hash prefixes, and no email', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const now = Date.now();
    const threshold = limits.LIST_WALK_ALERT.distinctEmails;
    for (let i = 0; i < threshold - 1; i++) {
      await touchKey(service.db, `walk:${emailHash(`seeded-${i}@example.com`)}`, now);
    }
    const email = 'Final.Walker@Example.com';
    for (let n = 0; n < limits.FALLBACK_SIGN_IN_PER_EMAIL.max; n++) {
      await signIn(service, email, 'Wrong-Passw0rd!');
    }
    await Sentry.flush(2000);

    const serialized = JSON.stringify(envelopes);
    expect(envelopes).toHaveLength(1);
    expect(serialized).toContain(LIST_WALK_MESSAGE);
    expect(serialized).toContain(emailHash(email).slice(0, 8));
    for (const leak of [email, email.toLowerCase(), 'final.walker', 'example.com', 'seeded-']) {
      expect(serialized.toLowerCase()).not.toContain(leak.toLowerCase());
    }
    const ours = warn.mock.calls.filter((call) => call[0] === LIST_WALK_MESSAGE);
    expect(ours).toHaveLength(1);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/@|walker|seeded/i);
    warn.mockRestore();
  });
});

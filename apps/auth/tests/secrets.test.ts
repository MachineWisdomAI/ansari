// RESEND_API_KEY and AUTH_INTERNAL_SECRET appear in no log line and no
// response body (spec 300 acceptance, "Password reset"; plan phase 5). Every
// console call and every stdout/stderr write is captured while the service is
// driven through its success, refusal and failure paths, and every response
// body is kept; then both secrets are searched for in all of it.
import { getEnv, resetEnvCache } from '@ansari/auth';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { setAuthEnv } from '../../../packages/auth/tests/helpers/auth-db';
import {
  BASE,
  internalHeaders,
  INTERNAL_SECRET,
  send,
  signUpTokens,
  startService,
  STRONG_PASSWORD,
  type Service,
} from './helpers/service';

const RESEND_KEY = 're_test_key_at_least_20_chars';

const captured: string[] = [];
const bodies: string[] = [];
const restore: (() => void)[] = [];

function capture(): void {
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    const original = console[method];
    console[method] = (...args: unknown[]) => {
      captured.push(
        args
          .map((a) =>
            a instanceof Error
              ? `${a.name} ${a.message} ${a.stack}`
              : (JSON.stringify(a) ?? String(a))
          )
          .join(' ')
      );
    };
    restore.push(() => {
      console[method] = original;
    });
  }
  for (const stream of [process.stdout, process.stderr]) {
    const original = stream.write.bind(stream);
    stream.write = ((chunk: unknown, ...rest: unknown[]) => {
      captured.push(String(chunk));
      return (original as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof stream.write;
    restore.push(() => {
      stream.write = original;
    });
  }
}

async function keep(res: Promise<Response>): Promise<Response> {
  const response = await res;
  bodies.push(await response.clone().text());
  bodies.push(JSON.stringify([...response.headers.entries()]));
  return response;
}

let service: Service;
let failingMail: Service;

beforeAll(async () => {
  service = await startService();
  failingMail = await startService({
    mailer: async () => {
      throw new Error(`Resend refused: bad key ${RESEND_KEY} / ${INTERNAL_SECRET}`);
    },
  });
  capture();
});

afterAll(async () => {
  for (const undo of restore.reverse()) undo();
  await service.close();
  await failingMail.close();
});

describe('secrets in logs and bodies', () => {
  it('the test secrets are the ones the service runs with', () => {
    expect(getEnv().AUTH_INTERNAL_SECRET).toBe(INTERNAL_SECRET);
    expect(getEnv().RESEND_API_KEY).toBe(RESEND_KEY);
  });

  it("appear nowhere across the service's paths", async () => {
    const email = 'secrets@example.com';
    const user = await signUpTokens(service, email);
    const internal = (path: string, method = 'GET', headers = internalHeaders(), bearer?: string) =>
      keep(send(service.internalUrl, path, { method, headers, bearer }));

    // The credential: missing, wrong, a prefix of the real one, the real one.
    await internal(`/internal/users/${user.id}/profile`, 'GET', {});
    await internal(
      `/internal/users/${user.id}/profile`,
      'GET',
      internalHeaders(undefined, 'x'.repeat(40))
    );
    await internal(
      `/internal/users/${user.id}/role`,
      'GET',
      internalHeaders(undefined, INTERNAL_SECRET.slice(0, 10))
    );
    await internal(`/internal/users/${user.id}/profile`);
    await internal(`/internal/users/${user.id}/role`);
    await internal('/internal/users/not-a-uuid/role');
    await internal(`/internal/users/${user.id}`, 'DELETE', internalHeaders(), 'not.a.jwt');
    await internal(
      `/internal/users/${user.id}/revoke-sessions`,
      'POST',
      internalHeaders(),
      user.sessionToken
    );
    await internal('/api/auth/jwks', 'GET', {});
    await internal('/api/auth/jwks');
    await internal('/nowhere');
    // The credential sent to the public listener is ignored there.
    await keep(
      send(service.publicUrl, `/internal/users/${user.id}/profile`, { headers: internalHeaders() })
    );
    await keep(send(service.publicUrl, '/api/auth/get-session', { headers: internalHeaders() }));

    // Reset: known, unknown, a bad token; a mailer that fails with both secrets in its error.
    await keep(send(service.publicUrl, '/api/auth/request-password-reset', { body: { email } }));
    await keep(
      send(service.publicUrl, '/api/auth/request-password-reset', {
        body: { email: 'nobody@example.com' },
      })
    );
    await keep(
      send(service.publicUrl, '/api/auth/reset-password', {
        body: { token: 'bad', newPassword: STRONG_PASSWORD },
      })
    );
    await keep(
      send(failingMail.publicUrl, '/api/auth/sign-up/email', {
        body: { email, password: STRONG_PASSWORD, name: 'X' },
      })
    );
    await keep(
      send(failingMail.publicUrl, '/api/auth/request-password-reset', { body: { email } })
    );
    await new Promise((r) => setTimeout(r, 50));

    // The subject's own delete, then the internal endpoints with a dead database (the 500 path).
    await internal(`/internal/users/${user.id}`, 'DELETE', internalHeaders(), user.jwt);
    const dead = await startService();
    await dead.client.close();
    await keep(
      send(dead.internalUrl, `/internal/users/${user.id}/profile`, { headers: internalHeaders() })
    );
    await keep(
      send(dead.internalUrl, `/internal/users/${user.id}`, {
        method: 'DELETE',
        headers: internalHeaders(),
        bearer: user.jwt,
      })
    );
    await dead.close().catch(() => undefined);

    // Env validation with both secrets too short: the error names variables only.
    process.env.AUTH_INTERNAL_SECRET = 'short-internal-secret';
    process.env.RESEND_API_KEY = 're_short_key';
    resetEnvCache();
    let envError = '';
    try {
      getEnv();
    } catch (err) {
      envError = err instanceof Error ? err.message : String(err);
    }
    captured.push(envError);
    expect(envError).toContain('AUTH_INTERNAL_SECRET');
    expect(envError).not.toContain('short-internal-secret');
    expect(envError).not.toContain('re_short_key');
    setAuthEnv(BASE);
    process.env.AUTH_RATE_LIMIT_MODE = 'ip';

    // The capture saw the failure paths, so an empty search proves something.
    const logs = captured.join('\n');
    expect(logs).toContain('Password reset email failed:');
    expect(logs).toContain('internal profile failed:');
    expect(bodies.length).toBeGreaterThan(40);

    for (const secret of [INTERNAL_SECRET, RESEND_KEY]) {
      expect(logs.includes(secret), `log carries ${secret.slice(0, 8)}…`).toBe(false);
      expect(
        bodies.some((b) => b.includes(secret)),
        `a body carries ${secret.slice(0, 8)}…`
      ).toBe(false);
    }
    expect(logs.includes(email)).toBe(false);
  });
});

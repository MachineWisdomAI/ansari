// Both apps/auth listeners over one createAuth(pglite) instance, each on an
// ephemeral port, driven with fetch. The database is built from packages/auth's
// migration journal, through that package's own test helpers.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { PGlite } from '@electric-sql/pglite';

import type { Auth, AuthEnv, Db } from '@ansari/auth';

import {
  drizzleFor,
  migrate,
  setAuthEnv,
} from '../../../../packages/auth/tests/helpers/auth-db';
import type { ListWalkAlert } from '../../src/alerts';
import { createInternalApp, createPublicApp, createServiceAuth } from '../../src/app';
import { FORWARDED_IP_HEADER, INTERNAL_AUTH_HEADER } from '../../src/middleware/client-ip';

export { TEST_ADMIN_EMAIL } from '../../../../packages/auth/tests/helpers/auth-db';

/** BETTER_AUTH_URL and the one CORS origin in tests. */
export const BASE = 'http://localhost:3100';
export const INTERNAL_SECRET = 'test-internal-secret-at-least-32-characters';

export type Service = {
  client: PGlite;
  db: Db;
  auth: Auth;
  publicUrl: string;
  internalUrl: string;
  close: () => Promise<void>;
};

export type ServiceOptions = {
  mode?: AuthEnv['AUTH_RATE_LIMIT_MODE'];
  production?: boolean;
  alert?: (alert: ListWalkAlert) => void;
};

function listen(app: { listen: (port: number, cb: () => void) => Server }): Promise<Server> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

const urlOf = (server: Server) => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

export async function startService(options: ServiceOptions = {}): Promise<Service> {
  setAuthEnv(BASE);
  process.env.AUTH_RATE_LIMIT_MODE = options.mode ?? 'ip';
  const client = await migrate();
  const db = drizzleFor(client);
  const auth = createServiceAuth(db, options.alert);
  const appOptions = { production: options.production ?? false };
  const publicServer = await listen(createPublicApp({ auth, db }, appOptions));
  const internalServer = await listen(createInternalApp({ auth, db }, appOptions));
  return {
    client,
    db,
    auth,
    publicUrl: urlOf(publicServer),
    internalUrl: urlOf(internalServer),
    async close() {
      await new Promise((r) => publicServer.close(r));
      await new Promise((r) => internalServer.close(r));
      await client.close();
    },
  };
}

let ipCounter = 0;

/** A fresh client IP, so tests not about limits never share a bucket. */
export function freshIp(): string {
  ipCounter += 1;
  return `198.18.${Math.floor(ipCounter / 250) % 250}.${(ipCounter % 250) + 1}`;
}

export type RequestOptions = {
  method?: string;
  body?: unknown;
  /** X-Real-IP; a fresh one by default, `null` for none. */
  ip?: string | null;
  bearer?: string;
  headers?: Record<string, string>;
};

/** A raw request to a listener. `path` is sent as written (no normalization). */
export async function send(baseUrl: string, path: string, opts: RequestOptions = {}) {
  // Node's fetch sends Sec-Fetch-Mode, so better-auth's CSRF check then
  // requires a trusted Origin, exactly as it would from a browser.
  const headers: Record<string, string> = { origin: BASE, ...opts.headers };
  const ip = opts.ip === undefined ? freshIp() : opts.ip;
  if (ip !== null) headers['x-real-ip'] = ip;
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  return fetch(`${baseUrl}${path}`, {
    method: opts.method ?? (opts.body === undefined ? 'GET' : 'POST'),
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
}

/** Headers for the credentialed internal hop, with an optional forwarded IP. */
export function internalHeaders(forwardedIp?: string, secret = INTERNAL_SECRET) {
  const headers: Record<string, string> = { [INTERNAL_AUTH_HEADER]: secret };
  if (forwardedIp !== undefined) headers[FORWARDED_IP_HEADER] = forwardedIp;
  return headers;
}

export async function rateLimitKeys(service: Service): Promise<string[]> {
  const { rows } = await service.client.query<{ key: string }>('select key from auth.rate_limit');
  return rows.map((r) => r.key);
}

export async function rateLimitRow(service: Service, key: string) {
  const { rows } = await service.client.query<{ count: number; last_request: string }>(
    'select count, last_request from auth.rate_limit where key = $1',
    [key]
  );
  return rows[0];
}

export const STRONG_PASSWORD = 'Correct-Horse-Battery-9';

export async function signUp(service: Service, email: string, password = STRONG_PASSWORD) {
  return send(service.publicUrl, '/api/auth/sign-up/email', {
    body: { email, password, name: 'Test User' },
  });
}

export async function signIn(
  service: Service,
  email: string,
  password: string,
  opts: Omit<RequestOptions, 'body'> = {}
) {
  return send(service.publicUrl, '/api/auth/sign-in/email', { ...opts, body: { email, password } });
}

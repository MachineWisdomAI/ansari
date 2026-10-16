import { readFileSync } from 'fs';
import path from 'path';
import { vi } from 'vitest';
import { NextRequest } from 'next/server';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '@/db/schema';
import { hashPassword } from '@/lib/auth/password';
import { resetEnvCache } from '@/lib/config';
import { POST as register } from '../../src/app/api/v2/users/register/route';
import { POST as login } from '../../src/app/api/v2/users/login/route';
import { POST as refreshToken } from '../../src/app/api/v2/users/refresh_token/route';
import { POST as logout } from '../../src/app/api/v2/users/logout/route';
import { GET as meGet, DELETE as meDelete } from '../../src/app/api/v2/users/me/route';
import { POST as requestPasswordReset } from '../../src/app/api/v2/request_password_reset/route';
import { POST as resetPassword } from '../../src/app/api/v2/reset_password/route';
import { GET as threadsGet } from '../../src/app/api/v2/threads/route';
import { GET as adminStats } from '../../src/app/api/v2/admin/stats/route';

/**
 * Contract harness for the legacy `/v2/users/*` surface (spec 300, plan phase 1).
 *
 * The `AuthBackend` seam swaps SETUP only: how the database is built, how a user
 * is seeded, how time is advanced past the access-token lifetime, and where sent
 * email is captured. Every assertion lives in legacy-users-contract.test.ts and
 * reads the frozen fixtures; the suite never branches on the backend. Phase 8
 * adds the `better-auth` backend and must pass the same assertions unedited.
 *
 * The test file owns the two module mocks (vitest hoists `vi.mock` per file):
 * `@/lib/db/index` points the app's `db` handle at pglite, and `resend` records
 * outgoing email instead of sending it. Nothing else is mocked: real route
 * handlers, real middleware, real `lib/db` helpers, real bcrypt and real JWTs.
 */

export type AuthBackend = 'legacy' | 'better-auth';

export const AUTH_BACKEND: AuthBackend = 'legacy';

/** State shared with the test file's hoisted module mocks. */
export interface MockState {
  db: unknown;
  sentEmails: SentEmail[];
}

export interface SentEmail {
  to: string;
  html: string;
}

type Handler = (request: NextRequest) => Promise<Response>;

const ROUTES = {
  register: { method: 'POST', path: '/api/v2/users/register', handler: register },
  login: { method: 'POST', path: '/api/v2/users/login', handler: login },
  refresh_token: { method: 'POST', path: '/api/v2/users/refresh_token', handler: refreshToken },
  logout: { method: 'POST', path: '/api/v2/users/logout', handler: logout },
  'me.get': { method: 'GET', path: '/api/v2/users/me', handler: meGet },
  'me.delete': { method: 'DELETE', path: '/api/v2/users/me', handler: meDelete },
  request_password_reset: { method: 'POST', path: '/api/v2/request_password_reset', handler: requestPasswordReset },
  reset_password: { method: 'POST', path: '/api/v2/reset_password', handler: resetPassword },
  // A data route standing in for "the bearer call" in the client flows.
  'threads.get': { method: 'GET', path: '/api/v2/threads', handler: threadsGet },
  // What the admin analytics page calls with the `access_token` from login.
  'admin.stats': { method: 'GET', path: '/api/v2/admin/stats?days=30&limit=50', handler: adminStats },
} satisfies Record<string, { method: string; path: string; handler: Handler }>;

export type RouteName = keyof typeof ROUTES;

export interface CallInit {
  /** JSON-encoded as the request body. */
  body?: unknown;
  /** Sent verbatim instead of `body`, for malformed-JSON cases. */
  rawBody?: string;
  /** Sent as `Authorization: Bearer <token>`. */
  token?: string;
  headers?: Record<string, string>;
}

export interface WireResponse {
  status: number;
  contentType: string | null;
  body: unknown;
}

export interface SeedUserInput {
  email: string;
  password: string;
  firstName?: string | null;
  lastName?: string | null;
  admin?: boolean;
}

export interface AppUserRow {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  registered_via: string | null;
}

export interface ContractHarness {
  readonly backend: AuthBackend;
  call(route: RouteName, init?: CallInit): Promise<WireResponse>;
  seedUser(input: SeedUserInput): Promise<{ id: string }>;
  /** A thread, a preference row and a feedback row owned by the user (app DB). */
  seedOwnedRows(userId: string): Promise<void>;
  ownedRowCounts(userId: string): Promise<{ threads: number; preferences: number; feedback: number }>;
  appUser(email: string): Promise<AppUserRow | undefined>;
  /** Advance the clock just past the backend's access-token lifetime. */
  expireAccessToken(): void;
  /** Resolves once a reset email to `to` has been sent; returns the token in its link. */
  awaitResetToken(to: string): Promise<string>;
  sentEmails(): readonly SentEmail[];
  /** The `${FRONTEND_URL}` the reset link is built from. */
  readonly frontendUrl: string;
  /** An address configured as an admin address (`ADMIN_EMAILS`), reserved at registration. */
  readonly reservedAdminEmail: string;
  reset(): Promise<void>;
  close(): Promise<void>;
}

const FRONTEND_URL = 'https://contract.example.test';
const RESERVED_ADMIN_EMAIL = 'reserved-admin@example.com';
const LEGACY_ACCESS_TOKEN_EXPIRY_HOURS = 2;
const CLOCK_START = new Date('2026-10-16T12:00:00.000Z');
const DRIZZLE_DIR = path.resolve(__dirname, '../../drizzle');

const RESET_LINK = /reset-password\?token=([^"'&<\s]+)/;

/** Build the app database from the real migration journal: the legacy DDL, exactly. */
async function migratedPglite(): Promise<PGlite> {
  const client = new PGlite();
  const journal: { tag: string }[] = JSON.parse(
    readFileSync(path.join(DRIZZLE_DIR, 'meta/_journal.json'), 'utf8')
  ).entries;
  for (const { tag } of journal) {
    const migration = readFileSync(path.join(DRIZZLE_DIR, `${tag}.sql`), 'utf8');
    for (const statement of migration.split('--> statement-breakpoint')) {
      if (statement.trim()) await client.exec(statement);
    }
  }
  return client;
}

function setLegacyEnv(): void {
  process.env.JWT_SECRET = 'contract-testing-secret-for-purposes-only-32chars';
  process.env.DATABASE_URL = 'postgresql://placeholder:placeholder@localhost:5432/placeholder';
  process.env.KALEMAT_API_KEY = 'placeholder';
  process.env.USUL_API_TOKEN = 'placeholder';
  process.env.ACCESS_TOKEN_EXPIRY_HOURS = String(LEGACY_ACCESS_TOKEN_EXPIRY_HOURS);
  process.env.REFRESH_TOKEN_EXPIRY_HOURS = '2160';
  process.env.ADMIN_EMAILS = RESERVED_ADMIN_EMAIL;
  process.env.RESEND_API_KEY = 're_contract_placeholder';
  process.env.FRONTEND_URL = FRONTEND_URL;
  delete process.env.MARKETMAKER_URL;
  resetEnvCache();
}

function toRequest(route: RouteName, init: CallInit): NextRequest {
  const { method, path: routePath } = ROUTES[route];
  const headers: Record<string, string> = { ...init.headers };
  if (init.token !== undefined) headers.Authorization = `Bearer ${init.token}`;
  let body: string | undefined;
  if (init.rawBody !== undefined) body = init.rawBody;
  else if (init.body !== undefined) body = JSON.stringify(init.body);
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return new NextRequest(`http://localhost${routePath}`, { method, headers, body });
}

export async function createLegacyHarness(state: MockState): Promise<ContractHarness> {
  setLegacyEnv();
  // Only Date is faked: JWT iat/exp and token expiry all read Date.now(), while
  // bcrypt, pglite and timers run for real.
  vi.useFakeTimers({ toFake: ['Date'], now: CLOCK_START });
  const client = await migratedPglite();
  state.db = drizzle(client, { schema });

  const harness: ContractHarness = {
    backend: 'legacy',
    frontendUrl: FRONTEND_URL,
    reservedAdminEmail: RESERVED_ADMIN_EMAIL,

    async call(route, init = {}) {
      // Legacy JWTs carry no jti, so two issued in the same second for the same
      // user are byte-identical. One second per request keeps each issuance
      // distinct, as it is in production.
      vi.advanceTimersByTime(1000);
      const response = await ROUTES[route].handler(toRequest(route, init));
      const text = await response.text();
      return {
        status: response.status,
        contentType: response.headers.get('content-type'),
        body: text === '' ? undefined : JSON.parse(text),
      };
    },

    async seedUser({ email, password, firstName = null, lastName = null, admin = false }) {
      const passwordHash = await hashPassword(password);
      const result = await client.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, first_name, last_name, is_admin)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [email.toLowerCase(), passwordHash, firstName, lastName, admin]
      );
      return { id: result.rows[0].id };
    },

    async seedOwnedRows(userId) {
      const thread = await client.query<{ id: string }>(
        `INSERT INTO threads (user_id, name) VALUES ($1, 'contract thread') RETURNING id`,
        [userId]
      );
      const threadId = thread.rows[0].id;
      const message = await client.query<{ id: string }>(
        `INSERT INTO messages (thread_id, role, content) VALUES ($1, 'assistant', '"hi"'::jsonb) RETURNING id`,
        [threadId]
      );
      await client.query(`INSERT INTO preferences (user_id, key, value) VALUES ($1, 'theme', 'dark')`, [userId]);
      await client.query(
        `INSERT INTO feedback (user_id, thread_id, message_id, feedback_class) VALUES ($1, $2, $3, 'thumbsup')`,
        [userId, threadId, message.rows[0].id]
      );
    },

    async ownedRowCounts(userId) {
      const count = async (table: string) =>
        (await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE user_id = $1`, [userId]))
          .rows[0].n;
      return {
        threads: await count('threads'),
        preferences: await count('preferences'),
        feedback: await count('feedback'),
      };
    },

    async appUser(email) {
      const result = await client.query<AppUserRow>(
        `SELECT id, email, first_name, last_name, registered_via FROM users WHERE email = $1`,
        [email.toLowerCase()]
      );
      return result.rows[0];
    },

    expireAccessToken() {
      vi.advanceTimersByTime(LEGACY_ACCESS_TOKEN_EXPIRY_HOURS * 60 * 60 * 1000 + 1000);
    },

    async awaitResetToken(to) {
      const email = await vi.waitFor(
        () => {
          const sent = state.sentEmails.filter((e) => e.to === to).at(-1);
          if (!sent) throw new Error(`no reset email sent to ${to} yet`);
          return sent;
        },
        { timeout: 5000, interval: 10 }
      );
      const match = RESET_LINK.exec(email.html);
      if (!match) throw new Error('reset email carries no reset-password link');
      return decodeURIComponent(match[1]);
    },

    sentEmails() {
      return state.sentEmails;
    },

    async reset() {
      await client.exec('TRUNCATE users CASCADE');
      state.sentEmails.length = 0;
      vi.setSystemTime(CLOCK_START);
    },

    async close() {
      vi.useRealTimers();
      await client.close();
    },
  };
  return harness;
}

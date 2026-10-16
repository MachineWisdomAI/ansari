import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import * as schema from '@/db/schema';
import { resetEnvCache } from '@/lib/config';
import { resetJwksCache } from '@/lib/auth/verify-jwt';
import {
  INTERNAL_SECRET,
  startService,
  type Service,
  type ServiceOptions,
} from '../../../auth/tests/helpers/service';

/**
 * Shared plumbing for the spec 300 phase 7 suites.
 *
 * - `startJwksServer`: a local JWKS handler with real key pairs, standing in
 *   for apps/auth's internal listener in the rejection matrix. It requires the
 *   internal credential, as apps/auth does, and counts every request.
 * - `startAuth`: the real apps/auth (both listeners over pglite), with apps/api's
 *   env pointed at its internal listener.
 * - `migrateAppDb`: the app database from the real journal, as at the window
 *   (through 0011, so `password_hash` is nullable).
 */

export { INTERNAL_SECRET };
export const TEST_ISSUER = 'https://auth.test.example';
export const TEST_AUDIENCE = 'ansari-api-test';
export const LEGACY_JWT_SECRET = 'phase-7-legacy-jwt-secret-at-least-32-chars';

/** apps/api's own required env, plus apps/auth's coordinates. */
export function setApiEnv(internalUrl: string, secret = INTERNAL_SECRET): void {
  process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test';
  process.env.JWT_SECRET = LEGACY_JWT_SECRET;
  process.env.KALEMAT_API_KEY = 'placeholder';
  process.env.USUL_API_TOKEN = 'placeholder';
  process.env.AUTH_INTERNAL_URL = internalUrl;
  process.env.AUTH_JWT_ISSUER = TEST_ISSUER;
  process.env.AUTH_JWT_AUDIENCE = TEST_AUDIENCE;
  process.env.AUTH_INTERNAL_SECRET = secret;
  resetEnvCache();
  resetJwksCache();
}

// ---------------------------------------------------------------------------
// Local JWKS server

export interface SigningKey {
  kid: string;
  alg: 'EdDSA' | 'RS256';
  privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
  publicJwk: JWK;
}

export async function newKey(alg: 'EdDSA' | 'RS256' = 'EdDSA'): Promise<SigningKey> {
  const { privateKey, publicKey } = await generateKeyPair(alg, { extractable: true });
  const kid = randomUUID();
  return { kid, alg, privateKey, publicJwk: { ...(await exportJWK(publicKey)), kid, alg } };
}

export interface JwksServer {
  url: string;
  /** Every request that reached the handler, credentialed or not. */
  requests: number;
  /** The keys served, in order. */
  keys: SigningKey[];
  /** Answer 500 instead of the key set. */
  failing: boolean;
  stop(): Promise<void>;
}

export async function startJwksServer(initial: SigningKey[]): Promise<JwksServer> {
  const state = { requests: 0, keys: [...initial], failing: false };
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    state.requests += 1;
    if (req.headers['x-ansari-internal-auth'] !== INTERNAL_SECRET) {
      res.writeHead(401).end();
      return;
    }
    if (req.url !== '/api/auth/jwks' || state.failing) {
      res.writeHead(state.failing ? 500 : 404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ keys: state.keys.map((k) => k.publicJwk) }));
  };
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    get requests() {
      return state.requests;
    },
    get keys() {
      return state.keys;
    },
    get failing() {
      return state.failing;
    },
    set failing(value: boolean) {
      state.failing = value;
    },
    async stop() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export interface TokenOptions {
  key: SigningKey;
  sub?: string | null;
  sid?: string | null;
  issuer?: string;
  audience?: string;
  /** Seconds from now; negative for an expired token; null for no `exp`. */
  expiresIn?: number | null;
  kid?: string;
}

/** A token as apps/auth would mint it, with any claim overridable or omitted. */
export async function signToken(opts: TokenOptions): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = {};
  const sub = opts.sub === undefined ? randomUUID() : opts.sub;
  const sid = opts.sid === undefined ? randomUUID() : opts.sid;
  if (sub !== null) payload.sub = sub;
  if (sid !== null) payload.sid = sid;
  const jwt = new SignJWT(payload)
    .setProtectedHeader({ alg: opts.key.alg, kid: opts.kid ?? opts.key.kid })
    .setIssuedAt(now - 60)
    .setIssuer(opts.issuer ?? TEST_ISSUER)
    .setAudience(opts.audience ?? TEST_AUDIENCE);
  const expiresIn = opts.expiresIn === undefined ? 900 : opts.expiresIn;
  if (expiresIn !== null) jwt.setExpirationTime(now + expiresIn);
  return jwt.sign(opts.key.privateKey);
}

// ---------------------------------------------------------------------------
// Real apps/auth

export type AuthService = Service;

export async function startAuth(options: ServiceOptions = {}): Promise<Service> {
  const service = await startService(options);
  setApiEnv(service.internalUrl);
  return service;
}

/** An address with nothing listening, for "apps/auth is unreachable". */
export async function deadUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await new Promise((resolve) => server.close(resolve));
  return url;
}

// ---------------------------------------------------------------------------
// App database

const DRIZZLE_DIR = path.resolve(__dirname, '../../drizzle');

export async function migrateAppDb(): Promise<PGlite> {
  const client = new PGlite();
  const journal: { tag: string }[] = JSON.parse(
    readFileSync(path.join(DRIZZLE_DIR, 'meta/_journal.json'), 'utf8')
  ).entries;
  for (const { tag } of journal) {
    const sql = readFileSync(path.join(DRIZZLE_DIR, `${tag}.sql`), 'utf8');
    for (const stmt of sql.split('--> statement-breakpoint')) {
      if (stmt.trim()) await client.exec(stmt);
    }
  }
  return client;
}

export function appDrizzle(client: PGlite) {
  return drizzle(client, { schema });
}

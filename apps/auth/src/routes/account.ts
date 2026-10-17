// The account endpoints (spec 300, "Two databases" rules 2, 5, 6 and 8, owner
// amendment 2026-10-17): the facts apps/api needs about a user, asked with
// that user's OWN JWT, on the public listener like any other client. There is
// no shared credential and no id in the path: the user is always the token's
// `sub`, so no caller can ask about anyone else.
//
//   GET    /api/account/me               live sid; {id, email, first_name, last_name, registered_via, role, banned}
//   POST   /api/account/revoke-sessions  live sid; 204, every session of the user (legacy logout)
//   DELETE /api/account                  204; the user already gone is 204 too, else live sid
//
// Every request first needs a JWT this service issued (EdDSA, iss, aud, exp,
// sub, sid; 401 otherwise, with no database write), then one per-user budget
// per endpoint (ACCOUNT_ENDPOINT). "Live sid" means the token's session still
// exists: sign-out, revocation, a password reset and deletion all end it, so
// the token stops working here at once, not when it expires.
//
// Mounted outside Better Auth's handler path, so the router's per-IP limits
// never apply: apps/api calls these with its own egress IP.
import { consumeWindow, getEnv, limits, users, type Auth, type Db } from '@ansari/auth';
import { Router, type Request, type Response } from 'express';
import { createLocalJWKSet, jwtVerify } from 'jose';

import type { ServiceDeps } from '../app';

export const ACCOUNT_PATH = '/api/account';

/** The token algorithm createAuth() signs with; nothing else is accepted. */
const JWT_ALGORITHMS = ['EdDSA'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const accountLimitKey = (sub: string, endpoint: string) =>
  `sub:${sub}|${ACCOUNT_PATH}/${endpoint}`;

export type TokenSubject = { sub: string; sid: string };

/** `{name, code}` only: a driver error's message can carry query parameters. */
function errorMeta(err: unknown): { name: string; code?: unknown } {
  if (!(err instanceof Error)) return { name: 'unknown' };
  const own = (err as { code?: unknown }).code;
  const cause = (err.cause as { code?: unknown } | undefined)?.code;
  return { name: err.name, code: own ?? cause };
}

function bearerOf(req: Request): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer ([^\s]+)$/.exec(header);
  return match?.[1] ?? null;
}

/**
 * The subject and session of a JWT this service issued, verified against its
 * own JWKS with the algorithm, issuer, audience and expiry pinned; null when
 * it is anything else. Reading the key set is outside the try: a database
 * failure there is an outage (500, which apps/api reads as unavailable), never
 * "this token is bad" (401, which apps/api reads as refused).
 */
export async function verifySubjectToken(auth: Auth, token: string): Promise<TokenSubject | null> {
  const env = getEnv();
  const jwks = createLocalJWKSet(await auth.api.getJwks());
  try {
    const { payload } = await jwtVerify(token, jwks, {
      algorithms: JWT_ALGORITHMS,
      issuer: env.AUTH_JWT_ISSUER,
      audience: env.AUTH_JWT_AUDIENCE,
      requiredClaims: ['exp', 'sub', 'sid'],
    });
    const { sub, sid } = payload;
    if (typeof sub !== 'string' || typeof sid !== 'string') return null;
    if (!UUID.test(sub) || !UUID.test(sid)) return null;
    return { sub, sid };
  } catch {
    return null;
  }
}

type Handler = (subject: TokenSubject, res: Response) => Promise<void>;

/** The token, then the subject's budget for `name`, then the handler; an error logs `{name, code}` only. */
function endpoint(auth: Auth, db: Db, name: string, handler: Handler) {
  return async (req: Request, res: Response) => {
    try {
      const token = bearerOf(req);
      const subject = token ? await verifySubjectToken(auth, token) : null;
      if (!subject) {
        res.status(401).json({ message: 'Unauthorized' });
        return;
      }
      const rule = limits.ACCOUNT_ENDPOINT;
      const { count, retryAfter } = await consumeWindow(db, accountLimitKey(subject.sub, name), rule);
      if (count > rule.max) {
        res.status(429).set('X-Retry-After', String(retryAfter)).json({ message: 'Too many requests' });
        return;
      }
      await handler(subject, res);
    } catch (err) {
      console.error(`account ${name} failed:`, errorMeta(err));
      if (!res.headersSent) res.status(500).json({ message: 'Internal error' });
    }
  };
}

/** 401 unless the token's session is still live; true when the caller may go on. */
async function requireLiveSession(db: Db, { sub, sid }: TokenSubject, res: Response) {
  if (await users.isSessionLive(db, sid, sub)) return true;
  res.status(401).json({ message: 'Unauthorized' });
  return false;
}

export function accountRouter({ auth, db }: ServiceDeps): Router {
  const router = Router();

  router.get(
    '/me',
    endpoint(auth, db, 'me', async (subject, res) => {
      if (!(await requireLiveSession(db, subject, res))) return;
      const user = await users.findUserById(db, subject.sub);
      if (!user) {
        res.status(404).end();
        return;
      }
      res.json({
        id: user.id,
        email: user.email,
        first_name: user.firstName,
        last_name: user.lastName,
        registered_via: user.registeredVia,
        role: user.role,
        banned: users.isBanned(user),
      });
    })
  );

  // Legacy logout (G-3): the legacy client sends only its JWT, and logout must
  // end every session of the user, as it does today.
  router.post(
    '/revoke-sessions',
    endpoint(auth, db, 'revoke-sessions', async (subject, res) => {
      if (!(await requireLiveSession(db, subject, res))) return;
      const { internalAdapter } = await auth.$context;
      await internalAdapter.deleteUserSessions(subject.sub);
      res.status(204).end();
    })
  );

  // better-auth's internal adapter deletes the sessions, the accounts and then
  // the user. `auth.api.deleteUser` is not used: it is disabled and enforces
  // freshAge. A user already gone is a 204 before the session check, because
  // the delete itself ends every session: a retry after a lost 204 carries a
  // dead sid and must still succeed. It answers only for the token's own sub.
  router.delete(
    '/',
    endpoint(auth, db, 'delete', async (subject, res) => {
      if (!(await users.findUserById(db, subject.sub))) {
        res.status(204).end();
        return;
      }
      if (!(await requireLiveSession(db, subject, res))) return;
      const { internalAdapter } = await auth.$context;
      await internalAdapter.deleteUser(subject.sub);
      res.status(204).end();
    })
  );

  return router;
}

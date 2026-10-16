// The internal endpoints (spec 300, "Two databases" rules 5, 6 and 8; plan
// phase 5, P-1, P-2, G-3): the cross-service facts apps/api needs, over the
// internal credential. Mounted on the internal listener only, after
// internalPerimeter, so every request here has already passed the credential.
//
//   GET    /internal/users/:id/profile          {id, email, first_name, last_name, registered_via}
//   GET    /internal/users/:id/role             {role, banned}
//   DELETE /internal/users/:id                  subject JWT required; 204
//   POST   /internal/users/:id/revoke-sessions  subject JWT required; 204
//
// The profile returns any user's personal data, so the credential alone is
// High impact; delete and revoke-sessions also require the subject's own JWT,
// so the credential alone can never destroy an account or log anyone out.
// Each endpoint has one global budget (INTERNAL_ENDPOINT) shared by every
// instance.
import { consumeWindow, getEnv, limits, users, type Auth, type Db } from '@ansari/auth';
import { Router, type Request, type Response } from 'express';
import { createLocalJWKSet, jwtVerify } from 'jose';

import type { ServiceDeps } from '../app';

/** The token algorithm createAuth() signs with; nothing else is accepted. */
const JWT_ALGORITHMS = ['EdDSA'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const internalLimitKey = (endpoint: string) => `global|/internal/${endpoint}`;

type Handler = (req: Request<{ id: string }>, res: Response) => Promise<void>;

/** One global fixed window per endpoint, then the handler; an error logs `{name, code}` only. */
function endpoint(db: Db, name: string, handler: Handler) {
  return async (req: Request<{ id: string }>, res: Response) => {
    try {
      const { count, retryAfter } = await consumeWindow(
        db,
        internalLimitKey(name),
        limits.INTERNAL_ENDPOINT
      );
      if (count > limits.INTERNAL_ENDPOINT.max) {
        res
          .status(429)
          .set('X-Retry-After', String(retryAfter))
          .json({ message: 'Too many requests' });
        return;
      }
      if (!UUID.test(req.params.id)) {
        res.status(404).end();
        return;
      }
      await handler(req, res);
    } catch (err) {
      console.error(`internal ${name} failed:`, errorMeta(err));
      if (!res.headersSent) res.status(500).json({ message: 'Internal error' });
    }
  };
}

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
 * The subject of a JWT this service issued, verified against its own JWKS with
 * the algorithm, issuer, audience and expiry pinned; null when it is anything
 * else.
 */
export async function verifySubjectToken(auth: Auth, token: string): Promise<string | null> {
  const env = getEnv();
  try {
    const jwks = createLocalJWKSet(await auth.api.getJwks());
    const { payload } = await jwtVerify(token, jwks, {
      algorithms: JWT_ALGORITHMS,
      issuer: env.AUTH_JWT_ISSUER,
      audience: env.AUTH_JWT_AUDIENCE,
      requiredClaims: ['exp', 'sub'],
    });
    return typeof payload.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}

/**
 * 401 without a valid subject JWT, 403 when it names another user. The
 * account is untouched in both cases.
 */
async function requireSubject(auth: Auth, req: Request<{ id: string }>, res: Response) {
  const token = bearerOf(req);
  const subject = token ? await verifySubjectToken(auth, token) : null;
  if (!subject) {
    res.status(401).json({ message: 'Unauthorized' });
    return false;
  }
  if (subject !== req.params.id) {
    res.status(403).json({ message: 'Forbidden' });
    return false;
  }
  return true;
}

export function internalRouter({ auth, db }: ServiceDeps): Router {
  const router = Router();

  router.get(
    '/users/:id/profile',
    endpoint(db, 'profile', async (req, res) => {
      const user = await users.findUserById(db, req.params.id);
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
      });
    })
  );

  router.get(
    '/users/:id/role',
    endpoint(db, 'role', async (req, res) => {
      const user = await users.findUserById(db, req.params.id);
      if (!user) {
        res.status(404).end();
        return;
      }
      res.json({ role: user.role, banned: users.isBanned(user) });
    })
  );

  // better-auth's internal adapter deletes the sessions, the accounts and then
  // the user. `auth.api.deleteUser` is not used: it is disabled and enforces
  // freshAge. An id that is already gone is a 204 too, so a retry is safe.
  router.delete(
    '/users/:id',
    endpoint(db, 'delete', async (req, res) => {
      if (!(await requireSubject(auth, req, res))) return;
      const { internalAdapter } = await auth.$context;
      await internalAdapter.deleteUser(req.params.id);
      res.status(204).end();
    })
  );

  // Legacy logout (G-3): the legacy client sends only its JWT, and logout must
  // end every session of the user, as it does today.
  router.post(
    '/users/:id/revoke-sessions',
    endpoint(db, 'revoke-sessions', async (req, res) => {
      if (!(await requireSubject(auth, req, res))) return;
      const { internalAdapter } = await auth.$context;
      await internalAdapter.deleteUserSessions(req.params.id);
      res.status(204).end();
    })
  );

  return router;
}

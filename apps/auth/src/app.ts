// The two Express apps apps/auth serves (plan P-1, amendment A), built without
// listening so tests can drive them. Both share one Better Auth instance and
// one database, so a rate-limit budget is the same on both paths.
//
// Public (PORT, the public domain): /api/auth/*, /health and the diag route.
//   The forwarded-IP header is always stripped; /internal/* is never mounted.
// Internal (INTERNAL_PORT, Railway's private network only, no domain): the
//   credentialed /api/auth/* hop for apps/api's layer, its JWKS fetch, and
//   /internal/*. Every request must carry the internal credential.
import { createAuth, getEnv, type Auth, type Db, type Mailer } from '@ansari/auth';
import { toNodeHandler } from 'better-auth/node';
import express, { type Express, type Request, type Response } from 'express';

import type { ListWalkAlert } from './alerts';
import { createPerimeterHooks } from './limits/email-limiter';
import { blockedPaths } from './middleware/blocked-paths';
import { internalPerimeter, requireClientIp, stripForwardedIp } from './middleware/client-ip';
import { corsFor, mergeExposedHeaders } from './middleware/cors';
import { clientIpDiag, DIAG_PATH } from './routes/diag';
import { health } from './routes/health';
import { internalRouter } from './routes/internal';

export type ServiceDeps = { auth: Auth; db: Db };
export type AppOptions = {
  /** Refuse router requests with no usable client IP. Defaults to NODE_ENV=production. */
  production?: boolean;
};

const AUTH_ROUTE = '/api/auth{/*path}';

export type ServiceAuthOptions = {
  alert?: (alert: ListWalkAlert) => void;
  /** The reset-email transport; Resend by default. */
  mailer?: Mailer;
};

/** The configured Better Auth instance with apps/auth's limiters as its hooks. */
export function createServiceAuth(db: Db, { alert, mailer }: ServiceAuthOptions = {}): Auth {
  const hooks = createPerimeterHooks({ db, mode: getEnv().AUTH_RATE_LIMIT_MODE, alert });
  return createAuth(db, { ...hooks, mailer });
}

function isProduction(options: AppOptions): boolean {
  return options.production ?? getEnv().NODE_ENV === 'production';
}

function notFound(_req: Request, res: Response): void {
  res.status(404).end();
}

export function createPublicApp({ auth, db }: ServiceDeps, options: AppOptions = {}): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(stripForwardedIp);
  app.use(corsFor(getEnv().CORS_ORIGIN));
  app.use(mergeExposedHeaders);
  app.use(blockedPaths);
  app.get('/health', health(db));
  app.get(DIAG_PATH, clientIpDiag);
  // Better Auth reads the raw body, so no body parser runs before it.
  app.all(AUTH_ROUTE, requireClientIp(isProduction(options)), toNodeHandler(auth));
  app.use(notFound);
  return app;
}

export function createInternalApp({ auth, db }: ServiceDeps, options: AppOptions = {}): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(internalPerimeter(getEnv().AUTH_INTERNAL_SECRET));
  app.use(blockedPaths);
  // Outside Better Auth's handler path (spec 300 rule 8), behind the credential.
  app.use('/internal', internalRouter({ auth, db }));
  app.all(AUTH_ROUTE, requireClientIp(isProduction(options)), toNodeHandler(auth));
  app.use(notFound);
  return app;
}

// apps/auth — the runnable Better Auth service (spec 300): the only place that
// signs users in, signs them up, resets passwords or manages sessions.
//
// It listens twice (plan P-1): PORT for the public domain, INTERNAL_PORT for
// Railway's private network. The apps themselves are built in app.ts.
import 'dotenv/config';
import { createDb, getEnv } from '@ansari/auth';

import { initSentry } from './alerts';
import { createInternalApp, createPublicApp, createServiceAuth } from './app';
import { assertConfiguredAdminsExist, shouldRunAdminStartupCheck } from './startup-checks';

const env = getEnv();
initSentry(env.SENTRY_DSN, env.NODE_ENV);

const db = createDb();

if (shouldRunAdminStartupCheck(env)) {
  try {
    await assertConfiguredAdminsExist(db, env.ADMIN_EMAILS);
  } catch (err) {
    console.error(err instanceof Error ? err.message : 'Admin bootstrap check failed');
    process.exit(1);
  }
}

const auth = createServiceAuth(db);

createPublicApp({ auth, db }).listen(env.PORT, () => {
  console.log(`auth service (public) listening on port ${env.PORT}`);
});
createInternalApp({ auth, db }).listen(env.INTERNAL_PORT, () => {
  console.log(`auth service (internal) listening on port ${env.INTERNAL_PORT}`);
});

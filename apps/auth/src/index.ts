// apps/auth — the runnable Better Auth service (spec 300): the only place that
// signs users in, signs them up, resets passwords or manages sessions.
//
// It listens once, on PORT, behind the public domain (owner amendment
// 2026-10-17: no internal listener). The app itself is built in app.ts.
import 'dotenv/config';
import { createDb, getEnv } from '@ansari/auth';

import { initSentry } from './alerts';
import { createApp, createServiceAuth } from './app';
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

createApp({ auth, db }).listen(env.PORT, () => {
  console.log(`auth service listening on port ${env.PORT}`);
});

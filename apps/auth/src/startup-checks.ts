// Fail-fast boot assertion (spec 4, carried into spec 300): every configured
// admin address (`ADMIN_EMAILS`) must already be an auth user with
// role = 'admin'. Admin addresses are reserved at sign-up, so the only way to
// make one an admin is out of band (scripts/grant-admin.ts); asserting it at
// boot turns a mis-provisioned deploy into a loud failure.
//
// Ported from apps/api/lib/auth/startup-checks.ts, against `auth.users.role`.
import { users, type Db } from '@ansari/auth';

/**
 * Throws on the first configured admin that is missing or not an admin. The
 * error names the entry by its position, never by its address, because it is
 * logged at boot.
 */
export async function assertConfiguredAdminsExist(
  db: Db,
  adminEmails: readonly string[]
): Promise<void> {
  for (let i = 0; i < adminEmails.length; i++) {
    const label = `configured admin #${i + 1} of ${adminEmails.length} (from ADMIN_EMAILS)`;
    let user: users.UserRecord | undefined;
    try {
      user = await users.findUserByEmail(db, adminEmails[i] ?? '');
    } catch {
      // A database outage at boot must read as one, not as a missing admin.
      throw new Error(
        `Admin bootstrap check could not reach the database while verifying ${label}. Retry once the database is reachable.`
      );
    }
    if (!user) {
      throw new Error(
        `Admin bootstrap check failed: ${label} has no account. ` +
          `The account must exist before its address joins ADMIN_EMAILS (copied at the cutover, ` +
          `or signed up first, since sign-up refuses a reserved address); then run ` +
          `scripts/grant-admin.ts before deploy.`
      );
    }
    if (user.role !== users.ADMIN_ROLE) {
      throw new Error(
        `Admin bootstrap check failed: ${label} exists but its role is not admin. ` +
          `Run scripts/grant-admin.ts to grant it.`
      );
    }
  }
}

/**
 * The check runs only in a production server. apps/auth has no build-time or
 * edge execution of its entry point, so production is the whole gate (dev,
 * test and CI may have no such rows, or no database).
 */
export function shouldRunAdminStartupCheck(env: { NODE_ENV?: string } = process.env): boolean {
  return env.NODE_ENV === 'production';
}

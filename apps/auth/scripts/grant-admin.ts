/**
 * Admin role script (spec 300; moved from apps/api/scripts/grant-admin.ts,
 * same name). Admin is `auth.users.role = 'admin'`, and the admin plugin's
 * HTTP surface is blocked, so this script is the only way to grant or revoke
 * it. It runs against the AUTH database (`DATABASE_URL` in apps/auth's env),
 * never sets a password, and never touches the app database.
 *
 *   Deploy ordering (runbook): migration → copy → THIS script → deploy. The
 *   boot assertion refuses to start without every ADMIN_EMAILS entry granted.
 *
 * Usage (from apps/auth/):
 *   pnpm exec tsx scripts/grant-admin.ts <email>            grant admin
 *   pnpm exec tsx scripts/grant-admin.ts --revoke <email>   back to role 'user'
 *   pnpm exec tsx scripts/grant-admin.ts --list             every admin, for the audit
 *
 * The account must already exist. An ADMIN_EMAILS address is reserved at
 * sign-up, so a new admin signs up before their address joins ADMIN_EMAILS.
 * A demotion takes effect at once: apps/api asks for the role on each admin
 * request.
 */
import 'dotenv/config';
import { createDb, normalizeEmail, users, type Db } from '@ansari/auth';

export type GrantAdminCommand =
  { kind: 'grant'; email: string } | { kind: 'revoke'; email: string } | { kind: 'list' };

export const USAGE = [
  'Usage: pnpm exec tsx scripts/grant-admin.ts <email>',
  '       pnpm exec tsx scripts/grant-admin.ts --revoke <email>',
  '       pnpm exec tsx scripts/grant-admin.ts --list',
].join('\n');

export function parseArgs(argv: readonly string[]): GrantAdminCommand | null {
  const [first, second, ...rest] = argv;
  if (rest.length > 0) return null;
  if (first === '--list') return second === undefined ? { kind: 'list' } : null;
  if (first === '--revoke')
    return second && !second.startsWith('--') ? { kind: 'revoke', email: second } : null;
  if (first && !first.startsWith('--') && second === undefined)
    return { kind: 'grant', email: first };
  return null;
}

/** Runs one command and returns the lines to print. */
export async function runGrantAdmin(db: Db, command: GrantAdminCommand): Promise<string[]> {
  if (command.kind === 'list') {
    const admins = await users.listAdmins(db);
    return [`${admins.length} admin(s):`, ...admins.map((a) => `  ${a.email}  ${a.id}`)];
  }
  const email = normalizeEmail(command.email);
  if (command.kind === 'grant') {
    await users.setRoleByEmail(db, email, users.ADMIN_ROLE);
    return [`Granted admin to ${email} (role=admin). No password was changed.`];
  }
  await users.setRoleByEmail(db, email, users.USER_ROLE);
  return [`Revoked admin from ${email} (role=user).`];
}

/** A missing user is reported plainly; anything else by its name (no driver detail). */
export function scriptError(err: unknown): string {
  if (err instanceof users.UserNotFoundError) return err.message;
  return err instanceof Error ? err.name : 'unknown';
}

async function main(): Promise<void> {
  const command = parseArgs(process.argv.slice(2));
  if (!command) {
    console.error(USAGE);
    process.exit(1);
  }
  const lines = await runGrantAdmin(createDb(), command);
  for (const line of lines) console.log(line);
  process.exit(0);
}

if (process.argv[1]?.endsWith('grant-admin.ts')) {
  main().catch((err: unknown) => {
    console.error('grant-admin failed:', scriptError(err));
    process.exit(1);
  });
}

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Drift guard (issue #21): docs/self-hosting.md documents the boot-time admin
 * bootstrap check's failure modes by quoting distinguishing phrases from its
 * error messages. The check lives in apps/auth since spec 300. If the error
 * text in apps/auth/src/startup-checks.ts changes, or the docs
 * section is removed, operators lose the outage-vs-provisioning triage table.
 * This test fails on either side of that drift.
 */

const doc = readFileSync(resolve(__dirname, '../../../docs/self-hosting.md'), 'utf8');
const source = readFileSync(resolve(__dirname, '../../auth/src/startup-checks.ts'), 'utf8');

// The phrases the docs' triage table keys on, one per failure mode:
// DB unreachable, admin account missing, account present but not an admin.
const DISTINGUISHING_PHRASES = [
  'could not reach the database',
  'has no account',
  'role is not admin',
];

describe('self-hosting docs: boot-blocks-on-unreachable-DB triage (issue #21)', () => {
  it.each(DISTINGUISHING_PHRASES)(
    'apps/auth startup-checks.ts still throws an error containing %j',
    (phrase) => {
      expect(source).toContain(phrase);
    }
  );

  it.each(DISTINGUISHING_PHRASES)(
    'docs/self-hosting.md documents the error phrase %j',
    (phrase) => {
      expect(doc).toContain(phrase);
    }
  );

  it('documents the crash-loop symptom on restart-on-crash platforms', () => {
    expect(doc.toLowerCase()).toContain('crash loop');
  });

  it('points operators at the bootstrap script for the provisioning case', () => {
    expect(doc).toContain('scripts/grant-admin.ts');
    expect(doc).toContain('from `apps/auth/`');
    expect(existsSync(resolve(__dirname, '../../auth/scripts/grant-admin.ts'))).toBe(true);
  });
});

describe('self-hosting docs: two databases, two services (spec 300)', () => {
  it('asks for two databases and runs both services', () => {
    expect(doc).toMatch(/two databases/i);
    expect(doc).toContain('applies packages/auth/drizzle/ to DATABASE_URL (the auth database)');
    expect(existsSync(resolve(__dirname, '../../../packages/auth/drizzle/0000_auth_schema.sql'))).toBe(true);
    expect(doc).toContain('pnpm auth dev');
    expect(doc).toContain('pnpm api dev');
  });

  it('applies production migrations by psql with both flags, never by db:migrate or db:push', () => {
    expect(doc).toContain('psql -X -v ON_ERROR_STOP=1 --single-transaction -f <file>');
    expect(doc).toMatch(/Production migrations are \*\*not\*\* applied with `pnpm db:migrate`/);
    expect(doc).not.toMatch(/applied with `pnpm db:migrate` \(from `apps\/api\/`\) against\s+the production/);
  });
});

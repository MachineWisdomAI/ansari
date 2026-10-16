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

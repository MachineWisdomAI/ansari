import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The Better Auth cutover runbooks (spec 300, plan phase 12) are executed
// mid-window by an operator who cannot stop to hunt for a file. Every repo
// path they name must exist, every window step must carry a mechanical check
// and an abort, and the scripts' README must describe every script there is.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (rel: string) => readFileSync(resolve(repoRoot, rel), 'utf8');

const RUNBOOK = 'docs/cutover/better-auth-cutover.md';
const ROLLBACK = 'docs/cutover/rollback.md';
const SCRIPTS_DIR = 'apps/auth/scripts/cutover';
const SCRIPTS_README = `${SCRIPTS_DIR}/README.md`;
const DOCS = [RUNBOOK, ROLLBACK, 'docs/cutover/edge-check.md', 'docs/cutover/baselines.md', SCRIPTS_README];

/** Repo-relative paths a doc names in backticks or as a command argument. */
export function namedRepoPaths(doc: string): string[] {
  const found = new Set<string>();
  for (const m of doc.matchAll(/(?<![\w./-])((?:apps|packages|docs)\/[A-Za-z0-9_.\/-]+\.(?:sql|sh|ts|md|json|toml))/g)) {
    found.add(m[1] as string);
  }
  return [...found];
}

describe('cutover docs: every named file exists', () => {
  it.each(DOCS)('%s exists', (rel) => {
    expect(existsSync(resolve(repoRoot, rel))).toBe(true);
  });

  it.each([
    [RUNBOOK, 8],
    [ROLLBACK, 1],
  ])('every repo path %s names exists', (rel, atLeast) => {
    const paths = namedRepoPaths(read(rel));
    expect(paths.length).toBeGreaterThanOrEqual(atLeast);
    for (const path of paths) {
      expect(existsSync(resolve(repoRoot, path)), `${rel} names ${path}, which does not exist`).toBe(true);
    }
  });

  it('the path scan finds a planted missing file and ignores a near-miss', () => {
    const planted = 'run `apps/auth/scripts/cutover/99-missing.sql` then see https://example.com/apps/x.sql';
    expect(namedRepoPaths(planted)).toEqual(['apps/auth/scripts/cutover/99-missing.sql']);
    expect(existsSync(resolve(repoRoot, 'apps/auth/scripts/cutover/99-missing.sql'))).toBe(false);
  });

  it('the scripts README describes every script in the directory, and nothing else', () => {
    const readme = read(SCRIPTS_README);
    const scripts = readdirSync(resolve(repoRoot, SCRIPTS_DIR)).filter((f) => /\.(sql|sh)$/.test(f));
    expect(scripts.length).toBeGreaterThanOrEqual(10);
    for (const file of scripts) {
      expect(readme, `${file} is not in the README`).toContain(`\`${file}\``);
    }
    for (const m of readme.matchAll(/`([\w.-]+\.(?:sql|sh))`/g)) {
      expect(scripts, `the README names ${m[1]}, which is not in ${SCRIPTS_DIR}`).toContain(m[1]);
    }
  });
});

describe('the window runbook', () => {
  const doc = read(RUNBOOK);
  const steps = doc.split(/^## (?=\d+\. )/m).slice(1);

  const stepOf = (title: RegExp) => {
    const index = steps.findIndex((s) => title.test(s.split('\n')[0] ?? ''));
    if (index < 0) throw new Error(`no runbook step titled ${title}`);
    return index + 1;
  };

  it('has 18 steps, in order (the plan 17 plus the promotion, security R5)', () => {
    expect(steps.map((s) => Number(s.split('.')[0]))).toEqual(Array.from({ length: 18 }, (_, i) => i + 1));
  });

  it.each(Array.from({ length: 18 }, (_, i) => i + 1))('step %i has a check and an abort', (n) => {
    const step = steps[n - 1] as string;
    expect(step).toMatch(/\*\*Check:\*\*/);
    expect(step).toMatch(/\*\*Abort/);
  });

  it('applies every migration with both psql flags, naming the database', () => {
    const applies = doc.split('\n').filter((l) => /psql .*-f \S*drizzle\/\S+\.sql/.test(l));
    expect(applies.length).toBe(4);
    for (const line of applies) {
      expect(line).toMatch(/psql "\$(APP|AUTH)_DATABASE_URL" -X -v ON_ERROR_STOP=1 --single-transaction -f /);
    }
  });

  it('takes cutover_at after apps/api is offline and before the new apps/api deploys', () => {
    const taken = steps.findIndex((s) => /select now\(\)/.test(s) && /cutover_at/.test(s)) + 1;
    expect(taken).toBeGreaterThan(stepOf(/apps\/api` offline/));
    expect(taken).toBeLessThan(stepOf(/Deploy `apps\/api` and `apps\/frontend`/));
  });

  it('promotes to main only after apps/api is offline, with auto-deploy off (R5)', () => {
    expect(stepOf(/Promote `develop` to `main`/)).toBeGreaterThan(stepOf(/apps\/api` offline/));
    expect(doc).toMatch(/Auto-deploy is OFF for `backend`/);
    expect(doc).toMatch(/main` is current except for spec 300/);
  });

  it('attaches the auth domain before the web swap (R4)', () => {
    expect(stepOf(/Attach `auth\.askansari\.ai`/)).toBeLessThan(stepOf(/Replace legacy web/));
  });

  it('deploys apps/auth privately with ADMIN_EMAILS empty before any database step, and sets it after the grants', () => {
    const deployAuth = stepOf(/Deploy `apps\/auth` privately/);
    expect(deployAuth).toBeLessThan(stepOf(/The auth baseline/));
    expect(steps[deployAuth - 1]).toMatch(/`ADMIN_EMAILS` empty/);
    expect(steps[stepOf(/Admin roles/) - 1]).toMatch(/set `ADMIN_EMAILS`.*redeploy `auth`/s);
  });

  it('names the exact operator environment, and every database step runs in it', () => {
    expect(doc).toContain('railway ssh --service auth --environment production');
    expect(doc).toContain('/etc/ansari-auth-image');
    expect(doc).not.toMatch(/RAILWAY_ENVIRONMENT=/);
  });

  it.each([/Edge probe on the `apps\/api` production domains/, /Attach `auth\.askansari\.ai`/])(
    '%s checks both edge properties: forged headers are overwritten, and two networks differ',
    (title) => {
      const step = steps[stepOf(title) - 1] as string;
      expect(step).toMatch(/-H 'X-Real-IP: 203\.0\.113\.9' -H 'X-Forwarded-For: 203\.0\.113\.9'/);
      expect(step).toMatch(/second network/);
    }
  );

  it('keeps the legacy variables on backend for the rollback (R3)', () => {
    const bullet = (steps[0] as string).split('\n- ').find((b) => b.includes('keeps its legacy variables'));
    expect(bullet, 'the legacy-variables precondition').toBeDefined();
    for (const name of ['JWT_SECRET', 'ACCESS_TOKEN_EXPIRY_HOURS', 'REFRESH_TOKEN_EXPIRY_HOURS', 'ADMIN_EMAILS']) {
      expect(bullet).toContain(`\`${name}\``);
    }
  });

  it('carries the operator-facing facts from the reviews', () => {
    expect(doc).toMatch(/CORS_ORIGIN.*real web origins/s);
    expect(doc).toMatch(/signed in to a real account before the cutover/i);
    expect(doc).toMatch(/Key rotation is not revocation/);
    expect(doc).toMatch(/no domain on `INTERNAL_PORT`/i);
  });
});

describe('the rollback runbook', () => {
  const doc = read(ROLLBACK);

  it('is bounded by the 24-hour deadline and runs the dry run before the delete', () => {
    expect(doc).toMatch(/cutover_at` \+ 24 hours/);
    const dry = doc.indexOf('-f apps/auth/scripts/cutover/rollback-remove-post-cutover-users.sql');
    const confirm = doc.indexOf('-v confirm=yes');
    expect(dry).toBeGreaterThan(0);
    expect(confirm).toBeGreaterThan(dry);
  });

  it('restarts from the auth baseline (window step 7)', () => {
    expect(doc).toMatch(/from \*\*step 7\*\* \(the auth\s+baseline\)/);
  });

  it('empties the auth database if no second attempt follows within 7 days (R6)', () => {
    expect(doc).toMatch(/within 7 days/);
    expect(doc).toContain("DROP SCHEMA auth CASCADE'");
  });

  it('runs its database step in the operator environment', () => {
    expect(doc).toContain('railway ssh --service auth --environment production');
  });
});

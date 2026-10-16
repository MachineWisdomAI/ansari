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

  it('has the 17 steps of the plan, in order', () => {
    expect(steps.map((s) => Number(s.split('.')[0]))).toEqual(Array.from({ length: 17 }, (_, i) => i + 1));
  });

  it.each(Array.from({ length: 17 }, (_, i) => i + 1))('step %i has a check and an abort', (n) => {
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

  it('takes cutover_at before any new code can create a user (step 3)', () => {
    expect(steps[2]).toMatch(/cutover_at/);
    expect(steps[2]).toMatch(/select now\(\)/);
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

  it('restarts from the auth baseline (window step 5)', () => {
    expect(doc).toMatch(/from \*\*step 5\*\*/);
  });
});

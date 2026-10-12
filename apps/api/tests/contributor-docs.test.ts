import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

// The issue forms and CONTRIBUTING.md are the public front door. GitHub silently
// falls back to a blank issue when a form is invalid, and nothing else in CI
// reads these files — so these tests are the only thing that notices a broken
// form or a security link that drifted to a public channel.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const templateDir = resolve(repoRoot, '.github/ISSUE_TEMPLATE');
const ADVISORY_URL = 'https://github.com/iaser-ai/ansari/security/advisories/new';

type Field = {
  type: string;
  id?: string;
  attributes?: { label?: string; options?: string[] };
  validations?: { required?: boolean };
};
type Form = { name: string; description: string; body: Field[] };

const loadForm = (file: string): Form => parse(readFileSync(resolve(templateDir, file), 'utf8'));
const inputs = (form: Form) => form.body.filter((f) => f.type !== 'markdown');
const requiredIds = (form: Form) =>
  inputs(form)
    .filter((f) => f.validations?.required === true)
    .map((f) => f.id);

describe('issue forms', () => {
  it('are YAML forms, not prose templates', () => {
    const files = readdirSync(templateDir).sort();
    expect(files).toEqual(['bug_report.yml', 'config.yml', 'feature_request.yml']);
  });

  it.each(['bug_report.yml', 'feature_request.yml'])('%s satisfies the GitHub form schema basics', (file) => {
    const form = loadForm(file);
    expect(form.name).toBeTruthy();
    expect(form.description).toBeTruthy();
    // GitHub rejects a form with no non-markdown field, duplicate ids, or duplicate labels.
    expect(inputs(form).length).toBeGreaterThan(0);
    const ids = inputs(form).map((f) => f.id);
    const labels = inputs(form).map((f) => f.attributes?.label);
    expect(ids.every(Boolean)).toBe(true);
    expect(labels.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('bug report requires what is needed to reproduce and correlate logs', () => {
    const form = loadForm('bug_report.yml');
    expect(requiredIds(form)).toEqual(['what-happened', 'expected', 'steps', 'surface', 'when']);
    const surface = form.body.find((f) => f.id === 'surface');
    expect(surface?.type).toBe('dropdown');
    expect(surface?.attributes?.options).toEqual(['askansari.ai (web)', 'Mobile app', 'API', 'Self-hosted']);
    // Browser/OS is only relevant for some surfaces, so it must stay optional.
    expect(requiredIds(form)).not.toContain('environment');
  });

  it('feature request requires the problem, not the solution', () => {
    const form = loadForm('feature_request.yml');
    expect(requiredIds(form)).toEqual(['problem', 'who', 'alternatives']);
  });

  it('config keeps blank issues open and routes security privately', () => {
    const config = parse(readFileSync(resolve(templateDir, 'config.yml'), 'utf8'));
    expect(config.blank_issues_enabled).toBe(true);
    const links: { name: string; url: string; about: string }[] = config.contact_links;
    expect(links.every((l) => l.name && l.url && l.about)).toBe(true);
    expect(links.find((l) => /security/i.test(l.name))?.url).toBe(ADVISORY_URL);
    expect(links.some((l) => /question/i.test(l.name))).toBe(true);
  });
});

describe('CONTRIBUTING.md', () => {
  const doc = readFileSync(resolve(repoRoot, 'CONTRIBUTING.md'), 'utf8');

  it('sends security reports to private vulnerability reporting', () => {
    expect(doc).toContain(ADVISORY_URL);
  });

  it('only links to repo files that exist', () => {
    const targets = [...doc.matchAll(/\]\((?!https?:|#|mailto:)([^)#]+)/g)].map((m) => m[1]);
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      expect(existsSync(resolve(repoRoot, target)), `broken link: ${target}`).toBe(true);
    }
  });

  it('names required CI checks that the workflow actually emits', () => {
    const ci = parse(readFileSync(resolve(repoRoot, '.github/workflows/ci.yml'), 'utf8'));
    const emitted = Object.values(ci.jobs as Record<string, { name: string }>).map((j) => j.name);
    // All four jobs are required on `develop`, so the doc must name each one
    // exactly as the workflow emits it — and notice when a job is added or renamed.
    expect(emitted.length).toBe(4);
    for (const check of emitted) {
      expect(doc).toContain(`\`${check}\``);
    }
  });

  it('only names secret-scan files that exist', () => {
    for (const file of ['.gitleaksignore', '.gitleaks.toml', '.github/scripts/gitleaks-scan.sh']) {
      expect(existsSync(resolve(repoRoot, file)), `missing: ${file}`).toBe(true);
    }
    expect(doc).toContain('`.gitleaksignore`');
    expect(doc).toContain('`.gitleaks.toml`');
    // The documented PR scan range must match what the scan script actually builds.
    expect(doc).toContain('`origin/develop..HEAD`');
    expect(readFileSync(resolve(repoRoot, '.github/scripts/gitleaks-scan.sh'), 'utf8')).toContain('range="${base}..HEAD"');
  });

  it('keeps the recommended Developing-with-Codev section, and README points at it', () => {
    // README strongly recommends Codev and sends fork contributors here; the
    // section must survive edits and keep saying so.
    expect(doc).toMatch(/^### Developing with Codev \(strongly recommended\)$/m);
    expect(doc).toContain('We strongly recommend developing with [Codev](https://github.com/cluesmith/codev)');
    const readme = readFileSync(resolve(repoRoot, 'README.md'), 'utf8');
    expect(readme).toContain('CONTRIBUTING.md#developing-with-codev-strongly-recommended');
    expect(readme).toMatch(/strongly\s+recommended/);
  });

  it('targets develop and mentions git add -A only to discourage it', () => {
    expect(doc).toMatch(/target `develop`/);
    const lines = doc.split('\n').filter((l) => l.includes('git add -A'));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).toMatch(/don't|never|not/i);
  });
});

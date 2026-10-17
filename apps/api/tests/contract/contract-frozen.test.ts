import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The phase 1 contract is frozen (spec 300, plan phase 8): the compatibility
 * layer must pass phase 1's assertions UNEDITED. The hashes are those of the
 * files at phase 1's final commit, 60b1118:
 *
 *   git show 60b1118:apps/api/tests/contract/fixtures/legacy-users.json | shasum -a 256
 *
 * and, for the test file, of everything from `type FixtureName` to the end
 * (every assertion), at 60b1118. CI checks out one commit, so it cannot diff
 * against 60b1118; the hashes stand in for that diff. The body's only allowed
 * change is the harness factory name (`createLegacyHarness` → `createHarness`),
 * mapped back before hashing.
 *
 * The preamble above `type FixtureName` (imports, header comment, module
 * mocks) is pinned separately to its reviewed state: the security review of
 * the cutover PR removed the two mocks of deleted legacy modules (the reset
 * email template and `resend`) and updated the header. Its only mock is the db
 * handle. Changing any constant is a change to the frozen contract and needs
 * the security architect's sign-off.
 */

const FIXTURES_AT_PHASE_1 = '914746551d65187a4d82e10ca299fe5822285b8873ecdb86ade27c60ed8de0f8';
const ASSERTIONS_AT_PHASE_1 = 'c42356fcc0c1030b3180c3acee2e9f83d320ae68700c42a9d451caf68a4feea5';
const PREAMBLE_REVIEWED = '00134c88c350c015dabbf501267cc27374c46793ea04ae37b6679118215d20d3';
const BODY_START = 'type FixtureName';

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const read = (file: string) => readFileSync(path.join(__dirname, file), 'utf8');

describe('the phase 1 contract is unchanged', () => {
  it('the fixtures are byte-identical to phase 1', () => {
    expect(sha256(read('fixtures/legacy-users.json'))).toBe(FIXTURES_AT_PHASE_1);
  });

  it('the assertions are byte-identical to phase 1, except the harness factory name', () => {
    const source = read('legacy-users-contract.test.ts');
    const body = source.slice(source.indexOf(BODY_START));
    expect(source.indexOf(BODY_START)).toBeGreaterThan(0);
    expect(sha256(body.replaceAll('createHarness', 'createLegacyHarness'))).toBe(ASSERTIONS_AT_PHASE_1);
  });

  it('the preamble is the reviewed one, and its only module mock is the db handle', () => {
    const source = read('legacy-users-contract.test.ts');
    const preamble = source.slice(0, source.indexOf(BODY_START));
    expect(sha256(preamble)).toBe(PREAMBLE_REVIEWED);
    expect([...source.matchAll(/vi\.mock\('([^']+)'/g)].map((m) => m[1])).toEqual(['@/lib/db/index']);
  });
});

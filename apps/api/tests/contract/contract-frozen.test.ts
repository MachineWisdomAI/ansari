import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The phase 1 contract is frozen (spec 300, plan phase 8): the compatibility
 * layer must pass phase 1's assertions UNEDITED. These hashes are those of the
 * files at phase 1's final commit, 60b1118:
 *
 *   git show 60b1118:apps/api/tests/contract/fixtures/legacy-users.json | shasum -a 256
 *   git show 60b1118:apps/api/tests/contract/legacy-users-contract.test.ts | shasum -a 256
 *
 * CI checks out one commit, so it cannot diff against 60b1118; the hashes stand
 * in for that diff. The test file's only allowed change is the harness factory
 * name (`createLegacyHarness` → `createHarness`), mapped back before hashing.
 * Changing either constant is a change to the frozen contract and needs the
 * security architect's sign-off.
 */

const FIXTURES_AT_PHASE_1 = '914746551d65187a4d82e10ca299fe5822285b8873ecdb86ade27c60ed8de0f8';
const ASSERTIONS_AT_PHASE_1 = '47a3c980a28319e92c3d2671a17412e4060abf064f25098732af7a4b040922fc';

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const read = (file: string) => readFileSync(path.join(__dirname, file), 'utf8');

describe('the phase 1 contract is unchanged', () => {
  it('the fixtures are byte-identical to phase 1', () => {
    expect(sha256(read('fixtures/legacy-users.json'))).toBe(FIXTURES_AT_PHASE_1);
  });

  it('the assertions are byte-identical to phase 1, except the harness factory name', () => {
    const source = read('legacy-users-contract.test.ts').replaceAll('createHarness', 'createLegacyHarness');
    expect(sha256(source)).toBe(ASSERTIONS_AT_PHASE_1);
  });
});

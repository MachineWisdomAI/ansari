import { describe, expect, it } from 'vitest';
import { isSharePath } from '@/lib/share-link';

describe('isSharePath', () => {
  it('matches a shared thread and nothing else', () => {
    expect(isSharePath('/share/d4757c81-660b-47f1-b178-095492dc2920')).toBe(true);
    expect(isSharePath('/share')).toBe(false);
    expect(isSharePath('/sharer/x')).toBe(false);
    expect(isSharePath('/chat/d4757c81-660b-47f1-b178-095492dc2920')).toBe(false);
  });
});

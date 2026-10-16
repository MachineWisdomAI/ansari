import { describe, expect, it } from 'vitest';
import { isPublicPath } from '@/lib/public-paths';

describe('isPublicPath', () => {
  it('matches a shared thread and the two reset pages', () => {
    expect(isPublicPath('/share/d4757c81-660b-47f1-b178-095492dc2920')).toBe(true);
    expect(isPublicPath('/forgot-password')).toBe(true);
    expect(isPublicPath('/reset-password')).toBe(true);
  });

  it('matches nothing else (near-misses included)', () => {
    for (const path of ['/', '/chat/x', '/share', '/delete-account', '/reset-password-x', '/forgot', '/login', '/about']) {
      expect(isPublicPath(path)).toBe(false);
    }
  });
});

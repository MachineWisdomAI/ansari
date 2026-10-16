import { isSharePath } from '@/lib/share-link';

/**
 * The pages that need no identity: a shared thread (`isSharePath`), and the
 * two halves of a password reset (#304). Each renders while the session is
 * still being restored, shows no rail and no account chrome (they are the
 * viewer's own threads and identity), and must NOT provision a guest: a
 * reset link opened in a fresh browser, a private window, a webmail's
 * in-app browser or a link scanner would otherwise spend one of the three
 * sign-ups per minute on every click. Leaving the page releases the held
 * guest (`AuthProvider` `deferGuest`).
 */
export const RESET_PATHS = ['/forgot-password', '/reset-password'] as const;

export function isPublicPath(path: string): boolean {
  return isSharePath(path) || (RESET_PATHS as readonly string[]).includes(path);
}

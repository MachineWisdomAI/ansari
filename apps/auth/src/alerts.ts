// The list-walk alert (spec 300, Client IP fallback; plan P-2). When per-email
// limits trip for many distinct emails in a short period, someone is likely
// walking an email list. The event carries counts and 8-character prefixes of
// the email hashes, never an email.
import * as Sentry from '@sentry/node';

export type ListWalkAlert = {
  /** Distinct emails that hit a per-email limit inside the window. */
  distinctEmails: number;
  /** The window, in seconds. */
  windowSeconds: number;
  /** First 8 hex characters of sha256(normalized email), a sample. */
  hashPrefixes: string[];
};

export const LIST_WALK_MESSAGE = 'auth: per-email limits tripped across many emails (list walk?)';

export function initSentry(dsn: string | undefined, environment: string): void {
  if (!dsn) return;
  Sentry.init({ dsn, environment, sendDefaultPii: false });
}

/** One Sentry event (plus a log line with the same fields). */
export function sendListWalkAlert(alert: ListWalkAlert): void {
  console.warn(LIST_WALK_MESSAGE, alert);
  Sentry.captureMessage(LIST_WALK_MESSAGE, {
    level: 'warning',
    tags: { alert: 'auth-list-walk' },
    extra: { ...alert },
  });
}

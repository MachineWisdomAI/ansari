// Every rate-limit number for the auth service (spec 300, plan P-2), and the
// only place they are written down. createAuth() builds better-auth's router
// rules from ROUTER_RULES; apps/auth's own limiters (sign-in, sign-up and reset
// per email, the global ceilings, the session-token and account budgets) read
// the rest. Tests import these constants rather than repeating numbers, so
// amending a number after the production baselines (B-1 to B-4) touches this
// file alone.
//
// No limit on a path apps/api's /v2/users layer calls is keyed by client IP
// (owner amendment, 2026-10-17). The layer reaches apps/auth anonymously over
// the public domain, so apps/auth sees apps/api's egress IP on every legacy
// call: a per-IP rule there would put every mobile user in one bucket. Those
// paths are limited per email, per session token, per user or globally here,
// and per client IP by apps/api itself (apps/api `lib/auth-service/limits.ts`).
// This is TEMPORARY, until the legacy system is replaced.
//
// Windows are in seconds, as better-auth's `customRules` expects.

export type LimitRule = { readonly window: number; readonly max: number };

const MINUTE = 60;
const HOUR = 60 * MINUTE;

/**
 * better-auth's global default, per client IP, for any router path without a
 * rule. It never applies to a path the layer calls (each is `false` below).
 * apps/api's JWKS fetch falls under it, at most one fetch per 30 s cooldown.
 */
export const DEFAULT_RULE: LimitRule = { window: MINUTE, max: 100 };

/** Reset request, per normalized email (stored hashed), every request, unknown emails included. */
export const RESET_REQUEST_PER_EMAIL: LimitRule = { window: HOUR, max: 3 };

/**
 * Reset request, every caller together: max(30/min, 10 × B-3 peak per minute).
 * 30 until B-3 is measured; it must never bind on real traffic.
 */
export const RESET_REQUEST_GLOBAL: LimitRule = { window: MINUTE, max: 30 };

/**
 * Reset consume (`/reset-password`), every caller together. Tokens are random,
 * so this only stops hammering; it must never bind on real traffic.
 */
export const RESET_CONSUME_GLOBAL: LimitRule = { window: MINUTE, max: 30 };

/**
 * Session → JWT exchange (`/token`, `/get-session`), per session token (stored
 * hashed). The released mobile client refreshes concurrently with no
 * single-flight guard, so bursts must pass.
 */
export const TOKEN_EXCHANGE_PER_SESSION: LimitRule = { window: MINUTE, max: 60 };

/** Each account endpoint (`/api/account`: me, revoke-sessions, delete), per user. */
export const ACCOUNT_ENDPOINT: LimitRule = { window: MINUTE, max: 60 };

/** Sign-in per normalized email, FAILED attempts only; locks the email for the window. */
export const SIGN_IN_PER_EMAIL: LimitRule = { window: MINUTE, max: 5 };

/** Sign-up per normalized email, every request. */
export const SIGN_UP_PER_EMAIL: LimitRule = { window: MINUTE, max: 3 };

/**
 * The global sign-up ceiling, max(30/min, 10 × B-1 peak per minute). 30 until
 * B-1 is measured; it must never bind on real traffic.
 */
export const SIGN_UP_GLOBAL: LimitRule = { window: MINUTE, max: 30 };

/** List-walk alert when this many distinct emails hit a per-email limit in the window. */
export const LIST_WALK_ALERT = { window: 10 * MINUTE, distinctEmails: 20 } as const;

/** The longest window above. better-auth's pruner keeps rows at least this long. */
export const LONGEST_WINDOW = Math.max(
  ...[
    DEFAULT_RULE,
    RESET_REQUEST_PER_EMAIL,
    RESET_REQUEST_GLOBAL,
    RESET_CONSUME_GLOBAL,
    TOKEN_EXCHANGE_PER_SESSION,
    ACCOUNT_ENDPOINT,
    SIGN_IN_PER_EMAIL,
    SIGN_UP_PER_EMAIL,
    SIGN_UP_GLOBAL,
    LIST_WALK_ALERT,
  ].map((rule) => rule.window)
);

/**
 * better-auth router rules, keyed by the path the router sees (basePath
 * stripped). `false` switches the router's per-IP limiter off for that path,
 * the global default included (better-auth returns before choosing a bucket);
 * apps/auth's own limiters enforce the rules above instead. Absent would fall
 * back to better-auth's built-in per-IP rules (sign-in/sign-up 3 per 10 s,
 * reset request 3 per 60 s) or the default.
 *
 * These are exactly the paths apps/api's layer calls (`lib/auth-service/legacy.ts`).
 */
export const ROUTER_RULES: Readonly<Record<string, false>> = {
  '/sign-in/email': false,
  '/sign-up/email': false,
  '/request-password-reset': false,
  '/reset-password': false,
  '/token': false,
  '/get-session': false,
};

// Every rate-limit number for the auth service (spec 300, plan P-2), and the
// only place they are written down. createAuth() builds better-auth's router
// rules from ROUTER_RULES; apps/auth's own limiters (per-email reset, the
// `email`-mode fallback, the internal endpoints) read the rest. Tests import
// these constants rather than repeating numbers, so amending a number after the
// production baselines (B-1 to B-4) touches this file alone.
//
// Windows are in seconds, as better-auth's `customRules` expects.

export type LimitRule = { readonly window: number; readonly max: number };

const MINUTE = 60;
const HOUR = 60 * MINUTE;

/** better-auth's global default for any path without a rule, per client IP. */
export const DEFAULT_RULE: LimitRule = { window: MINUTE, max: 100 };

/** Sign-in, per client IP, every request (issue decision). */
export const SIGN_IN: LimitRule = { window: MINUTE, max: 5 };

/** Sign-up, per client IP, every request (issue decision; guests are sign-ups). */
export const SIGN_UP: LimitRule = { window: MINUTE, max: 3 };

/** Reset request on better-auth's router, per client IP: its built-in burst cap, kept. */
export const RESET_REQUEST_BURST: LimitRule = { window: MINUTE, max: 3 };

/** Reset request, per client IP, every request (apps/auth limiter). */
export const RESET_REQUEST_PER_IP: LimitRule = { window: 15 * MINUTE, max: 5 };

/** Reset request, per normalized email (stored hashed), every request, unknown emails included. */
export const RESET_REQUEST_PER_EMAIL: LimitRule = { window: HOUR, max: 3 };

/** Reset consume (`/reset-password`), per client IP. Tokens are random; this only stops hammering. */
export const RESET_CONSUME: LimitRule = { window: 15 * MINUTE, max: 5 };

/**
 * Session → JWT exchange (`/token`, `/get-session`), per client IP. The released
 * mobile client refreshes concurrently with no single-flight guard, so bursts
 * must pass.
 */
export const TOKEN_EXCHANGE: LimitRule = { window: MINUTE, max: 60 };

/** Each internal endpoint (profile, role, delete, revoke-sessions), global. */
export const INTERNAL_ENDPOINT: LimitRule = { window: MINUTE, max: 600 };

/** `email` mode: sign-in per normalized email, FAILED attempts only; locks the email for the window. */
export const FALLBACK_SIGN_IN_PER_EMAIL: LimitRule = { window: MINUTE, max: 5 };

/** `email` mode: sign-up per normalized email, every request. */
export const FALLBACK_SIGN_UP_PER_EMAIL: LimitRule = { window: MINUTE, max: 3 };

/**
 * `email` mode: the global sign-up ceiling, max(30/min, 10 × B-1 peak per
 * minute). 30 until B-1 is measured; it must never bind on real traffic.
 */
export const FALLBACK_SIGN_UP_GLOBAL: LimitRule = { window: MINUTE, max: 30 };

/** `email` mode: list-walk alert when this many distinct emails hit a per-email limit in the window. */
export const LIST_WALK_ALERT = { window: 10 * MINUTE, distinctEmails: 20 } as const;

/**
 * better-auth router rules, keyed by the path the router sees (basePath
 * stripped). Every path is listed explicitly, so none falls back to
 * better-auth's built-in special rules (sign-in/sign-up are 3 per 10 s there).
 */
export const ROUTER_RULES: Readonly<Record<string, LimitRule>> = {
  '/sign-in/email': SIGN_IN,
  '/sign-up/email': SIGN_UP,
  '/request-password-reset': RESET_REQUEST_BURST,
  '/reset-password': RESET_CONSUME,
  '/token': TOKEN_EXCHANGE,
  '/get-session': TOKEN_EXCHANGE,
};

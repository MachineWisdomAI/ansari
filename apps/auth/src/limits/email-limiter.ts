// apps/auth's own limiters, run as better-auth hooks (createAuth's
// `extensions`), on `auth.rate_limit` so every instance shares one budget.
//
// None is keyed by client IP (owner amendment, 2026-10-17; TEMPORARY until the
// legacy system is replaced): apps/api's /v2/users layer calls these paths
// anonymously, so they all arrive with apps/api's IP, and the router has no
// per-IP rule on them (packages/auth `limits.ts` ROUTER_RULES). apps/api limits
// the layer's routes per client IP itself.
//
//   - `/sign-in/email`: per email, FAILED attempts only. The fifth failure in a
//     window locks the email until the window ends, even for the right
//     password. A refused attempt is not counted, so it cannot extend the lock.
//   - `/sign-up/email`: per email, every request, plus a global ceiling.
//   - `/request-password-reset`: per email and a global ceiling, every request
//     counted against both (an unknown email included), the same 429 for both.
//   - `/reset-password`: a global ceiling.
//   - `/token`, `/get-session`: per session token (the bearer, stored hashed).
//   - The list-walk alert, when per-email limits trip for many distinct emails.
//
// Keys never hold a raw email or token: `email:<sha256(normalized)>|<path>`,
// `session:<sha256(token)>|<path>`.
import { createHash } from 'node:crypto';

import {
  consumeWindow,
  isAuthError,
  keysSeenSince,
  limits,
  normalizeEmail,
  peekWindow,
  tooManyRequests,
  touchKey,
  type AuthExtensions,
  type AuthHookContext,
  type Db,
} from '@ansari/auth';

import { sendListWalkAlert, type ListWalkAlert } from '../alerts';

const SIGN_IN = '/sign-in/email';
const SIGN_UP = '/sign-up/email';
const RESET_REQUEST = '/request-password-reset';
const RESET_CONSUME = '/reset-password';
const TOKEN_PATHS: ReadonlySet<string> = new Set(['/token', '/get-session']);

const WALK_PREFIX = 'walk:';
const WALK_ALERT_KEY = 'alert|list-walk';
const HASH_PREFIX_LENGTH = 8;

export function emailHash(email: string): string {
  return createHash('sha256').update(normalizeEmail(email), 'utf8').digest('hex');
}

export const emailKey = (email: string, path: string) => `email:${emailHash(email)}|${path}`;
export const sessionKey = (token: string, path: string) =>
  `session:${createHash('sha256').update(token, 'utf8').digest('hex')}|${path}`;
export const globalKey = (path: string) => `global|${path}`;

export type PerimeterOptions = {
  db: Db;
  alert?: (alert: ListWalkAlert) => void;
  now?: () => number;
};

function emailOf(ctx: AuthHookContext): string | null {
  const email = (ctx.body as { email?: unknown } | undefined)?.email;
  return typeof email === 'string' && email.trim().length > 0 ? email : null;
}

/** The bearer session token, as the bearer() plugin reads it; null without one. */
function bearerOf(ctx: AuthHookContext): string | null {
  const headers = ctx.request?.headers ?? ctx.headers;
  const match = /^Bearer (\S+)$/i.exec(headers?.get('authorization') ?? '');
  return match?.[1] ?? null;
}

export function createPerimeterHooks(options: PerimeterOptions): AuthExtensions {
  const { db } = options;
  const alert = options.alert ?? sendListWalkAlert;
  const now = options.now ?? Date.now;

  /**
   * Record that this email tripped a per-email limit, and alert (at most once
   * per window, across instances) when enough distinct emails have.
   */
  async function recordLimitHit(email: string): Promise<void> {
    const at = now();
    const { window, distinctEmails } = limits.LIST_WALK_ALERT;
    await touchKey(db, `${WALK_PREFIX}${emailHash(email)}`, at);
    const seen = await keysSeenSince(db, WALK_PREFIX, at - window * 1000, distinctEmails);
    if (seen.total < distinctEmails) return;
    const gate = await consumeWindow(db, WALK_ALERT_KEY, { window, max: 1 }, at);
    if (gate.count !== 1) return;
    alert({
      distinctEmails: seen.total,
      windowSeconds: window,
      hashPrefixes: seen.sample.map((key) =>
        key.slice(WALK_PREFIX.length, WALK_PREFIX.length + HASH_PREFIX_LENGTH)
      ),
    });
  }

  async function limitResetRequest(ctx: AuthHookContext): Promise<void> {
    const at = now();
    const email = emailOf(ctx);
    // Count against both before deciding, so each refusal still costs budget.
    const [global, perEmail] = await Promise.all([
      consumeWindow(db, globalKey(RESET_REQUEST), limits.RESET_REQUEST_GLOBAL, at),
      email
        ? consumeWindow(db, emailKey(email, RESET_REQUEST), limits.RESET_REQUEST_PER_EMAIL, at)
        : null,
    ]);
    if (perEmail && perEmail.count > limits.RESET_REQUEST_PER_EMAIL.max) {
      throw tooManyRequests(perEmail.retryAfter);
    }
    if (global.count > limits.RESET_REQUEST_GLOBAL.max) throw tooManyRequests(global.retryAfter);
  }

  async function limitResetConsume(): Promise<void> {
    const state = await consumeWindow(db, globalKey(RESET_CONSUME), limits.RESET_CONSUME_GLOBAL, now());
    if (state.count > limits.RESET_CONSUME_GLOBAL.max) throw tooManyRequests(state.retryAfter);
  }

  async function limitTokenExchange(ctx: AuthHookContext, path: string): Promise<void> {
    const token = bearerOf(ctx);
    // No bearer: better-auth answers with no session, from no lookup.
    if (!token) return;
    const rule = limits.TOKEN_EXCHANGE_PER_SESSION;
    const state = await consumeWindow(db, sessionKey(token, path), rule, now());
    if (state.count > rule.max) throw tooManyRequests(state.retryAfter);
  }

  async function refuseLockedSignIn(ctx: AuthHookContext): Promise<void> {
    const email = emailOf(ctx);
    if (!email) return;
    const rule = limits.SIGN_IN_PER_EMAIL;
    const state = await peekWindow(db, emailKey(email, SIGN_IN), rule, now());
    // No limit hit is recorded here: countFailedSignIn recorded it when the
    // lock engaged, and the lock (one window) is shorter than the list-walk
    // window, so a refusal adds nothing but a rate_limit write per request.
    if (state.count >= rule.max) throw tooManyRequests(state.retryAfter);
  }

  async function countFailedSignIn(ctx: AuthHookContext): Promise<void> {
    const email = emailOf(ctx);
    if (!email) return;
    const rule = limits.SIGN_IN_PER_EMAIL;
    const state = await consumeWindow(db, emailKey(email, SIGN_IN), rule, now());
    // The failure that engages the lock is a limit hit: a list walker that
    // stops at the limit for each email never sees a 429.
    if (state.count >= rule.max) await recordLimitHit(email);
  }

  async function limitSignUp(ctx: AuthHookContext): Promise<void> {
    const at = now();
    const email = emailOf(ctx);
    const [global, perEmail] = await Promise.all([
      consumeWindow(db, globalKey(SIGN_UP), limits.SIGN_UP_GLOBAL, at),
      email
        ? consumeWindow(db, emailKey(email, SIGN_UP), limits.SIGN_UP_PER_EMAIL, at)
        : null,
    ]);
    if (email && perEmail && perEmail.count > limits.SIGN_UP_PER_EMAIL.max) {
      await recordLimitHit(email);
      throw tooManyRequests(perEmail.retryAfter);
    }
    if (global.count > limits.SIGN_UP_GLOBAL.max) throw tooManyRequests(global.retryAfter);
  }

  return {
    async before(ctx) {
      if (ctx.path === RESET_REQUEST) return limitResetRequest(ctx);
      if (ctx.path === RESET_CONSUME) return limitResetConsume();
      if (TOKEN_PATHS.has(ctx.path)) return limitTokenExchange(ctx, ctx.path);
      if (ctx.path === SIGN_IN) return refuseLockedSignIn(ctx);
      if (ctx.path === SIGN_UP) return limitSignUp(ctx);
    },
    async after(ctx) {
      if (ctx.path !== SIGN_IN) return;
      if (isAuthError(ctx.context.returned)) await countFailedSignIn(ctx);
    },
  };
}

// apps/auth's own limiters, run as better-auth hooks (createAuth's
// `extensions`), on `auth.rate_limit` so every instance shares one budget.
//
// Both modes:
//   - `/request-password-reset`: a per-IP burst, a per-IP cap and a per-email
//     cap, every request counted against all three (the router has no rule for
//     this path, so nothing refuses a request before it is counted), an unknown
//     email included, the same 429 for both.
// `email` mode only (AUTH_RATE_LIMIT_MODE, plan P-3; the router then has no
// per-IP sign-in or sign-up rule):
//   - `/sign-in/email`: per email, FAILED attempts only. The fifth failure in a
//     window locks the email until the window ends, even for the right
//     password. A refused attempt is not counted, so it cannot extend the lock.
//   - `/sign-up/email`: per email, every request, plus a global ceiling.
//   - The list-walk alert, when per-email limits trip for many distinct emails.
//
// Keys never hold a raw email: `email:<sha256(normalized)>|<path>`.
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
  type AuthEnv,
  type AuthExtensions,
  type AuthHookContext,
  type Db,
} from '@ansari/auth';

import { sendListWalkAlert, type ListWalkAlert } from '../alerts';
import { ipBucket, singleIp } from '../middleware/client-ip';

const SIGN_IN = '/sign-in/email';
const SIGN_UP = '/sign-up/email';
const RESET_REQUEST = '/request-password-reset';

const WALK_PREFIX = 'walk:';
const WALK_ALERT_KEY = 'alert|list-walk';
const HASH_PREFIX_LENGTH = 8;

export function emailHash(email: string): string {
  return createHash('sha256').update(normalizeEmail(email), 'utf8').digest('hex');
}

export const emailKey = (email: string, path: string) => `email:${emailHash(email)}|${path}`;
export const ipKey = (ip: string, path: string) => `ip:${ipBucket(ip)}|${path}`;
export const ipBurstKey = (ip: string, path: string) => `ip-burst:${ipBucket(ip)}|${path}`;
export const globalKey = (path: string) => `global|${path}`;

export type PerimeterOptions = {
  db: Db;
  mode: AuthEnv['AUTH_RATE_LIMIT_MODE'];
  alert?: (alert: ListWalkAlert) => void;
  now?: () => number;
};

function emailOf(ctx: AuthHookContext): string | null {
  const email = (ctx.body as { email?: unknown } | undefined)?.email;
  return typeof email === 'string' && email.trim().length > 0 ? email : null;
}

function ipOf(ctx: AuthHookContext): string | null {
  const headers = ctx.request?.headers ?? ctx.headers;
  return singleIp(headers?.get('x-real-ip'));
}

export function createPerimeterHooks(options: PerimeterOptions): AuthExtensions {
  const { db, mode } = options;
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
    const ip = ipOf(ctx);
    const email = emailOf(ctx);
    // Count against both before deciding, so each refusal still costs budget.
    const [burst, perIp, perEmail] = await Promise.all([
      ip ? consumeWindow(db, ipBurstKey(ip, RESET_REQUEST), limits.RESET_REQUEST_BURST, at) : null,
      ip ? consumeWindow(db, ipKey(ip, RESET_REQUEST), limits.RESET_REQUEST_PER_IP, at) : null,
      email
        ? consumeWindow(db, emailKey(email, RESET_REQUEST), limits.RESET_REQUEST_PER_EMAIL, at)
        : null,
    ]);
    if (burst && burst.count > limits.RESET_REQUEST_BURST.max) {
      throw tooManyRequests(burst.retryAfter);
    }
    if (perIp && perIp.count > limits.RESET_REQUEST_PER_IP.max) {
      throw tooManyRequests(perIp.retryAfter);
    }
    if (perEmail && perEmail.count > limits.RESET_REQUEST_PER_EMAIL.max) {
      throw tooManyRequests(perEmail.retryAfter);
    }
  }

  async function refuseLockedSignIn(ctx: AuthHookContext): Promise<void> {
    const email = emailOf(ctx);
    if (!email) return;
    const rule = limits.FALLBACK_SIGN_IN_PER_EMAIL;
    const state = await peekWindow(db, emailKey(email, SIGN_IN), rule, now());
    if (state.count >= rule.max) {
      await recordLimitHit(email);
      throw tooManyRequests(state.retryAfter);
    }
  }

  async function countFailedSignIn(ctx: AuthHookContext): Promise<void> {
    const email = emailOf(ctx);
    if (!email) return;
    const rule = limits.FALLBACK_SIGN_IN_PER_EMAIL;
    const state = await consumeWindow(db, emailKey(email, SIGN_IN), rule, now());
    // The failure that engages the lock is a limit hit: a list walker that
    // stops at the limit for each email never sees a 429.
    if (state.count >= rule.max) await recordLimitHit(email);
  }

  async function limitSignUp(ctx: AuthHookContext): Promise<void> {
    const at = now();
    const email = emailOf(ctx);
    const [global, perEmail] = await Promise.all([
      consumeWindow(db, globalKey(SIGN_UP), limits.FALLBACK_SIGN_UP_GLOBAL, at),
      email
        ? consumeWindow(db, emailKey(email, SIGN_UP), limits.FALLBACK_SIGN_UP_PER_EMAIL, at)
        : null,
    ]);
    if (email && perEmail && perEmail.count > limits.FALLBACK_SIGN_UP_PER_EMAIL.max) {
      await recordLimitHit(email);
      throw tooManyRequests(perEmail.retryAfter);
    }
    if (global.count > limits.FALLBACK_SIGN_UP_GLOBAL.max) throw tooManyRequests(global.retryAfter);
  }

  return {
    async before(ctx) {
      if (ctx.path === RESET_REQUEST) return limitResetRequest(ctx);
      if (mode !== 'email') return;
      if (ctx.path === SIGN_IN) return refuseLockedSignIn(ctx);
      if (ctx.path === SIGN_UP) return limitSignUp(ctx);
    },
    async after(ctx) {
      if (mode !== 'email' || ctx.path !== SIGN_IN) return;
      if (isAuthError(ctx.context.returned)) await countFailedSignIn(ctx);
    },
  };
}

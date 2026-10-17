import { NextRequest, NextResponse } from 'next/server';
import { checkRateLimit, getClientIp } from '@/lib/rate-limit';
import { tooManyRequestsResponse } from './legacy';

/**
 * Per-client-IP limits on the /v2/users layer's routes (spec 300; owner
 * amendment 2026-10-17, Option A). The layer calls apps/auth anonymously, so
 * apps/auth sees apps/api's egress IP on every legacy call and keys none of
 * those paths by IP (packages/auth `limits.ts`). apps/api is the one that sees
 * the client's edge-stamped X-Real-IP, so the per-IP rules live here, at the
 * numbers apps/auth used to enforce per IP. apps/auth's per-email, per-session
 * and global limits still apply behind them.
 *
 * TEMPORARY, until the legacy system is replaced. The store is in memory, per
 * instance (`lib/rate-limit.ts`), so with N instances a client gets up to N
 * times each budget.
 */
export const LEGACY_IP_LIMITS = {
  login: { max: 5, windowMs: 60_000 },
  register: { max: 3, windowMs: 60_000 },
  refresh_token: { max: 60, windowMs: 60_000 },
  request_password_reset: { max: 5, windowMs: 15 * 60_000 },
  reset_password: { max: 5, windowMs: 15 * 60_000 },
} as const;

export type LegacyRoute = keyof typeof LEGACY_IP_LIMITS;

/** The bucket key: the route and the client IP, never shared with another route's budget. */
export const legacyLimitKey = (route: LegacyRoute, ip: string) => `legacy:${route}|${ip}`;

/**
 * Count this request against its client's budget for `route`. Returns the
 * legacy 429 when the budget is spent, or null to go on. Every request counts,
 * before its body is read, as apps/auth's per-IP rules counted.
 */
export function limitLegacyRoute(request: NextRequest, route: LegacyRoute): NextResponse | null {
  const { max, windowMs } = LEGACY_IP_LIMITS[route];
  const { allowed, retryAfter } = checkRateLimit(legacyLimitKey(route, getClientIp(request)), max, windowMs);
  return allowed ? null : tooManyRequestsResponse(String(retryAfter));
}

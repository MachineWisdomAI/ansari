// Where the client IP comes from on each listener (spec 300 Client IP; plan
// P-1, amendments A and B). Better Auth keys its rate limits by `x-real-ip`
// alone, so these middlewares decide what that header holds before it runs.
//
// - Public listener: `X-Real-IP` is stamped by Railway's edge. The forwarded
//   header is always deleted, credential or not.
// - Internal listener (private network only): every request must carry the
//   internal credential. The forwarded header then replaces `x-real-ip`, but
//   only when it holds exactly one IP address.
// - Both, in production: a request to Better Auth's router with no usable IP is
//   refused with 400, so nothing reaches its shared `no-trusted-ip|<path>` bucket.
import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP, isIPv4 } from 'node:net';

import type { NextFunction, Request, Response } from 'express';

/** The end user's IP, as apps/api received it from the edge. */
export const FORWARDED_IP_HEADER = 'x-ansari-forwarded-client-ip';
/** The credential only apps/api and apps/auth hold. */
export const INTERNAL_AUTH_HEADER = 'x-ansari-internal-auth';

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest();

/**
 * Constant-time credential check. Both sides are hashed first, so the
 * comparison runs over equal lengths and leaks neither the length nor a prefix.
 */
export function verifyInternalCredential(presented: unknown, secret: string): boolean {
  if (typeof presented !== 'string' || presented.length === 0) return false;
  return timingSafeEqual(sha256(presented), sha256(secret));
}

/**
 * A single IP address, or null. Rejects lists, hostnames, empty values, zone
 * ids and anything a duplicated header joined together.
 */
export function singleIp(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const ip = value.trim();
  if (ip.length === 0 || ip.length > 45 || ip.includes('%')) return null;
  return isIP(ip) ? ip : null;
}

/** Public listener: the forwarded IP is never honoured here. */
export function stripForwardedIp(req: Request, _res: Response, next: NextFunction): void {
  delete req.headers[FORWARDED_IP_HEADER];
  next();
}

/**
 * Internal listener: 401 without the credential; with it, a valid forwarded IP
 * becomes `x-real-ip`. An invalid one is treated as absent, so the request
 * keeps its own `x-real-ip` or meets the production 400.
 */
export function internalPerimeter(secret: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const forwarded = req.headers[FORWARDED_IP_HEADER];
    delete req.headers[FORWARDED_IP_HEADER];
    if (!verifyInternalCredential(req.headers[INTERNAL_AUTH_HEADER], secret)) {
      res.status(401).json({ message: 'Unauthorized' });
      return;
    }
    delete req.headers[INTERNAL_AUTH_HEADER];
    const ip = singleIp(forwarded);
    if (ip) req.headers['x-real-ip'] = ip;
    next();
  };
}

/** Production only: Better Auth's router needs one usable client IP. */
export function requireClientIp(production: boolean) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (production && !singleIp(req.headers['x-real-ip'])) {
      res.status(400).json({ message: 'Client IP unavailable' });
      return;
    }
    next();
  };
}

/**
 * The rate-limit bucket for an IP, grouped as better-auth groups it: IPv4 as
 * is, an IPv4-mapped IPv6 address as its IPv4, any other IPv6 address by its
 * /64, so one host cannot rotate through its own prefix.
 */
export function ipBucket(ip: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped?.[1] && isIPv4(mapped[1])) return mapped[1];
  if (isIPv4(ip)) return ip;
  const [head = '', tail = ''] = ip.toLowerCase().split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = ip.includes('::')
    ? [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right]
    : left;
  return `${groups
    .slice(0, 4)
    .map((g) => g.padStart(4, '0'))
    .join(':')}::/64`;
}

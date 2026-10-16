// Refuses the admin plugin's HTTP surface and the two profile-changing routes
// before Better Auth sees the request (spec 300, Hosting and token model).
//
// `disabledPaths` in createAuth() covers the same routes, but better-auth
// matches it against the exact normalized path only (dist/api/index.mjs:166-168).
// This middleware canonicalizes first, so case, trailing-slash, percent-encoded,
// backslash, doubled-slash and dot-segment variants all get the one block
// response: 404 with an empty body.
import { posix } from 'node:path';

import type { NextFunction, Request, Response } from 'express';

const ADMIN_PREFIX = '/api/auth/admin';
const BLOCKED_EXACT = new Set(['/api/auth/change-email', '/api/auth/update-user']);

/** Decode repeatedly so `%2561dmin` cannot survive as `%61dmin`. */
const MAX_DECODE_PASSES = 4;

/**
 * The path as a request router could end up seeing it: decoded, backslashes as
 * slashes (the WHATWG URL parser does that), doubled slashes collapsed, dot
 * segments resolved, lowercased, no trailing slash. `null` when the encoding is
 * malformed.
 */
export function canonicalPath(rawUrl: string): string | null {
  let path = rawUrl.split(/[?#]/, 1)[0] ?? '';
  for (let pass = 0; pass < MAX_DECODE_PASSES; pass++) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      return null;
    }
    if (decoded === path) break;
    path = decoded;
  }
  path = path.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  path = posix.normalize(path.startsWith('/') ? path : `/${path}`).toLowerCase();
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

export function isBlockedPath(rawUrl: string): boolean {
  const path = canonicalPath(rawUrl);
  // Malformed encoding is refused rather than passed through undecided.
  if (path === null) return true;
  return path === ADMIN_PREFIX || path.startsWith(`${ADMIN_PREFIX}/`) || BLOCKED_EXACT.has(path);
}

export function blockedPaths(req: Request, res: Response, next: NextFunction): void {
  if (isBlockedPath(req.originalUrl)) {
    res.status(404).end();
    return;
  }
  next();
}

import { createRemoteJWKSet, customFetch, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { config } from '@/lib/config';
import { AUTH_SERVICE_TIMEOUT_MS, INTERNAL_AUTH_HEADER } from '@/lib/auth-service/client';

/**
 * Verification of apps/auth's JWTs (spec 300, "Hosting and token model"; plan
 * phase 7, P-1). The JWKS comes from apps/auth's internal listener, which
 * requires the internal credential on every request, the JWKS included.
 *
 * - The algorithm is pinned to EdDSA, the one createAuth() signs with, so
 *   `none`, HS256 (a legacy token) and RS256 are refused before any key lookup.
 * - `iss`, `aud`, `exp`, `sub` and `sid` are required.
 * - Keys are cached for 10 minutes. Steady state makes no network call.
 * - An unknown `kid` re-fetches at most once per 30 s cooldown, and so does a
 *   failed fetch (see `gatedFetch`), so a flood of random `kid`s, or traffic
 *   while apps/auth is down, cannot turn apps/api into an amplifier.
 */

/** The algorithm apps/auth signs with; nothing else is accepted. */
const JWT_ALGORITHMS = ['EdDSA'];
export const JWKS_PATH = '/api/auth/jwks';
export const JWKS_COOLDOWN_MS = 30_000;
export const JWKS_CACHE_MAX_AGE_MS = 600_000;

export interface VerifiedToken {
  /** The user's UUID, the same in both databases. */
  sub: string;
  /** The Better Auth session the token was minted from. */
  sid: string;
}

/**
 * jose's own cooldown applies only after a successful fetch: a failed one sets
 * no timestamp, so while apps/auth is down every request would fetch again.
 * This gate allows one network attempt per cooldown, successful or not. jose
 * itself never fetches twice within the cooldown after a success, so the gate
 * changes nothing in the healthy case.
 */
function gatedFetch(cooldownMs: number): typeof fetch {
  let lastAttempt = Number.NEGATIVE_INFINITY;
  return (input, init) => {
    const now = Date.now();
    if (now - lastAttempt < cooldownMs) {
      return Promise.reject(new Error('JWKS fetch cooling down'));
    }
    lastAttempt = now;
    return fetch(input, init);
  };
}

let cached: { key: string; jwks: JWTVerifyGetKey } | null = null;

/** One remote key set per (URL, credential), so a config change in tests takes effect. */
function remoteJwks(internalUrl: string, internalSecret: string): JWTVerifyGetKey {
  const key = `${internalUrl}\n${internalSecret}`;
  if (cached?.key !== key) {
    cached = {
      key,
      jwks: createRemoteJWKSet(new URL(JWKS_PATH, internalUrl), {
        headers: { [INTERNAL_AUTH_HEADER]: internalSecret },
        cooldownDuration: JWKS_COOLDOWN_MS,
        cacheMaxAge: JWKS_CACHE_MAX_AGE_MS,
        timeoutDuration: AUTH_SERVICE_TIMEOUT_MS,
        [customFetch]: gatedFetch(JWKS_COOLDOWN_MS),
      }),
    };
  }
  return cached.jwks;
}

/** Test-only: drop the cached key set, so the next verification starts cold. */
export function resetJwksCache(): void {
  cached = null;
}

/**
 * The token's subject and session, or null when it is not a valid apps/auth
 * access token for this audience. Never throws for a bad token.
 */
export async function verifyAccessToken(token: string): Promise<VerifiedToken | null> {
  const { internalUrl, internalSecret, jwtIssuer, jwtAudience } = config.authService;
  try {
    const { payload } = await jwtVerify(token, remoteJwks(internalUrl, internalSecret), {
      algorithms: JWT_ALGORITHMS,
      issuer: jwtIssuer,
      audience: jwtAudience,
      requiredClaims: ['exp', 'sub', 'sid'],
    });
    if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string') return null;
    return { sub: payload.sub, sid: payload.sid };
  } catch {
    return null;
  }
}

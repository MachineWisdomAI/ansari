import { z } from 'zod';
import { config } from '@/lib/config';

/**
 * The one HTTP client for apps/auth (spec 300, "Two databases" rule 8; plan
 * P-1). Every call goes to the internal listener (`AUTH_INTERNAL_URL`, the
 * private network) with the internal credential, and times out after 3 s.
 *
 * Nothing here logs: a body can carry an email, and the headers carry the
 * credential and a bearer. Callers log ids and statuses only.
 */

/** The credential only apps/api and apps/auth hold (apps/auth `middleware/client-ip.ts`). */
export const INTERNAL_AUTH_HEADER = 'x-ansari-internal-auth';
/** The end user's `X-Real-IP`, honoured by apps/auth only with the credential. */
export const FORWARDED_IP_HEADER = 'x-ansari-forwarded-client-ip';

export const AUTH_SERVICE_TIMEOUT_MS = 3_000;

/**
 * apps/auth could not give an answer: a network error, a timeout, a 5xx, a 429
 * or a response of the wrong shape. Callers fail closed on it (503), never
 * open, and never read it as "the user does not exist".
 */
export class AuthServiceUnavailableError extends Error {
  constructor(readonly status: number | null) {
    super(
      status === null
        ? 'apps/auth is unreachable'
        : `apps/auth answered ${status}`
    );
    this.name = 'AuthServiceUnavailableError';
  }
}

export interface AuthServiceRequest {
  method?: string;
  /** JSON-encoded as the body. */
  body?: unknown;
  /** Sent as `Authorization: Bearer <token>`. */
  bearer?: string;
  /** The end user's IP, forwarded so apps/auth rate-limits them, not apps/api. */
  clientIp?: string | null;
}

/**
 * One request to apps/auth's internal listener. Resolves with the response for
 * any status apps/auth chose to send; rejects with AuthServiceUnavailableError
 * only when no response arrived.
 */
export async function authServiceFetch(
  path: string,
  request: AuthServiceRequest = {}
): Promise<Response> {
  const { internalUrl, internalSecret } = config.authService;
  const headers: Record<string, string> = { [INTERNAL_AUTH_HEADER]: internalSecret };
  if (request.clientIp) headers[FORWARDED_IP_HEADER] = request.clientIp;
  if (request.bearer) headers.authorization = `Bearer ${request.bearer}`;
  if (request.body !== undefined) headers['content-type'] = 'application/json';

  try {
    return await fetch(new URL(path, internalUrl), {
      method: request.method ?? (request.body === undefined ? 'GET' : 'POST'),
      headers,
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      redirect: 'manual',
      signal: AbortSignal.timeout(AUTH_SERVICE_TIMEOUT_MS),
    });
  } catch {
    throw new AuthServiceUnavailableError(null);
  }
}

const userPath = (id: string, suffix = '') => `/internal/users/${encodeURIComponent(id)}${suffix}`;

const profileSchema = z.object({
  id: z.string(),
  email: z.string(),
  first_name: z.string().nullable(),
  last_name: z.string().nullable(),
  registered_via: z.string().nullable(),
});

export type AuthProfile = z.infer<typeof profileSchema>;

const roleSchema = z.object({
  role: z.string().nullable(),
  banned: z.boolean(),
});

export type AuthRole = z.infer<typeof roleSchema>;

/** A 200 body parsed against `schema`; anything else from apps/auth is unavailability. */
async function parseOk<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  if (response.status !== 200) throw new AuthServiceUnavailableError(response.status);
  const parsed = schema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) throw new AuthServiceUnavailableError(response.status);
  return parsed.data;
}

/** The user's profile, or null when apps/auth does not know the id (404). */
export async function getAuthProfile(id: string): Promise<AuthProfile | null> {
  const response = await authServiceFetch(userPath(id, '/profile'));
  if (response.status === 404) return null;
  const profile = await parseOk(response, profileSchema);
  if (profile.id !== id) throw new AuthServiceUnavailableError(response.status);
  return profile;
}

/** The user's role and ban state, or null when apps/auth does not know the id (404). */
export async function getAuthRole(id: string): Promise<AuthRole | null> {
  const response = await authServiceFetch(userPath(id, '/role'));
  if (response.status === 404) return null;
  return parseOk(response, roleSchema);
}

/**
 * Delete the auth user and its sessions. apps/auth requires the subject's own
 * JWT and answers 204 for an id that is already gone, so a retry is safe.
 */
export async function deleteAuthUser(id: string, jwt: string): Promise<void> {
  const response = await authServiceFetch(userPath(id), { method: 'DELETE', bearer: jwt });
  if (response.status !== 204) throw new AuthServiceUnavailableError(response.status);
}

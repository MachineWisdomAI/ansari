import { resolveBaseUrl } from '@/lib/api/config';
import { decodeSharedThread } from '@/lib/api/decode';
import type { ConversationDetail } from '@/lib/api/types';

/**
 * A shared thread (`GET /api/v2/share/{id}`) — the one anonymous entry point.
 *
 * Read with the platform `fetch`, never `customFetch`/`apiFetch`: those attach
 * the viewer's bearer and refresh on a 401, and a share is public. Viewing one
 * must send no credential and must never become a sign-in.
 *
 * Decoding is `decodeSharedThread` (`lib/api/decode`).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Thrown when the share does not exist (unknown, revoked, or not an id at all). */
export class ShareNotFoundError extends Error {
  constructor() {
    super('Share not found');
    this.name = 'ShareNotFoundError';
  }
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

async function getJson(url: string, fetchImpl: FetchLike): Promise<unknown> {
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: { accept: 'application/json' },
    credentials: 'omit',
  });
  if (response.status === 404) throw new ShareNotFoundError();
  if (!response.ok) {
    throw Object.assign(new Error(`Share request failed (${response.status})`), {
      status: response.status,
    });
  }
  return response.json();
}

/**
 * The share and its source documents (spec 168), in parallel. As for a thread,
 * a documents failure only costs the sources; the share request keeps its
 * error path, with a 404 (or an id that cannot be one) as `ShareNotFoundError`.
 */
export async function loadSharedThread(
  shareId: string,
  fetchImpl: FetchLike = (url, init) => fetch(url, init),
  baseUrl: string = resolveBaseUrl(),
): Promise<ConversationDetail> {
  if (!UUID.test(shareId)) throw new ShareNotFoundError();
  const url = `${baseUrl}/api/v2/share/${encodeURIComponent(shareId)}`;
  const [raw, rawDocuments] = await Promise.all([
    getJson(url, fetchImpl),
    getJson(`${url}/documents`, fetchImpl).catch((error: unknown) => {
      console.warn('Share documents unavailable; showing answers without sources:', {
        status: (error as { status?: number } | null)?.status ?? null,
      });
      return undefined;
    }),
  ]);
  return decodeSharedThread(raw, rawDocuments);
}

import { z } from 'zod';
import { resolveBaseUrl } from '@/lib/api/config';
import { decodeConversationDetail } from '@/lib/api/decode';
import { documentBlockSchema, messageContentSchema } from '@/lib/api/wire-schemas';
import type { ConversationDetail } from '@/lib/api/types';

/**
 * A shared thread (`GET /api/v2/share/{id}`) — the one anonymous entry point.
 *
 * Read with the platform `fetch`, never `customFetch`/`apiFetch`: those attach
 * the viewer's bearer and refresh on a 401, and a share is public. Viewing one
 * must send no credential and must never become a sign-in.
 *
 * A share's messages are a snapshot with no ids, and its `/documents` entries
 * are keyed by `message_index` alone. Both are given the same synthetic id
 * (`<shareId>:<index>`) so the thread's own decode pipeline — citations,
 * unbacked-marker stripping, the documents degrade path — runs unchanged.
 */

const sharedThreadSchema = z.object({
  id: z.string(),
  thread_name: z.string().nullable().optional(),
  messages: z.array(
    z.object({
      role: z.string(),
      content: messageContentSchema,
      created_at: z.string().nullable().optional(),
    }),
  ),
  created_at: z.string().optional(),
});

const sharedDocumentsSchema = z.object({
  messages: z.array(
    z.object({
      message_index: z.number().int().nonnegative(),
      documents: z.array(documentBlockSchema),
    }),
  ),
});

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

export function decodeSharedThread(
  raw: unknown,
  rawDocuments?: unknown,
): ConversationDetail {
  const share = sharedThreadSchema.parse(raw);
  const idAt = (index: number) => `${share.id}:${index}`;
  const detail = {
    thread_id: share.id,
    thread_name: share.thread_name,
    created_at: share.created_at,
    messages: share.messages.map((m, index) => ({
      id: idAt(index),
      role: m.role,
      content: m.content,
      created_at: m.created_at ?? undefined,
    })),
  };
  const docs = sharedDocumentsSchema.safeParse(rawDocuments);
  const threadDocuments = docs.success
    ? {
        thread_id: share.id,
        messages: docs.data.messages.map((entry) => ({
          message_id: idAt(entry.message_index),
          ...entry,
        })),
      }
    : rawDocuments; // undefined (request failed) or a bad shape the decoder logs
  return decodeConversationDetail(detail, threadDocuments, { samples: false });
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

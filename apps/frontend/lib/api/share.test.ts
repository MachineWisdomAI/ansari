import { describe, expect, it, vi } from 'vitest';
import { setAuthTokenGetter } from '@/vendor/api-client-react/custom-fetch';
import { loadSharedThread, ShareNotFoundError } from '@/lib/api/share';

const BASE = 'https://api.test';
const SHARE_ID = '3f2b8c1e-9d4a-4b7e-8f61-2a5c0d9e7b13';

const quranDoc = {
  type: 'document',
  source: {
    type: 'text',
    media_type: 'application/json',
    data: JSON.stringify({ ar: 'بِسْمِ ٱللَّهِ', en: 'In the name of Allah' }),
  },
  title: 'Al-Fatiha 1:1',
};

// Share GET's shape, as legacy web reads it today: no message ids, content a
// bare string for a single text block.
const shareBody = {
  id: SHARE_ID,
  thread_name: 'The Basmala',
  messages: [
    { role: 'user', content: 'What does the basmala mean?', created_at: '2026-01-01T00:00:00Z' },
    { role: 'assistant', content: 'It opens the Qur’an [1].', created_at: '2026-01-01T00:00:01Z' },
  ],
  created_at: '2026-01-01T00:00:02Z',
};
const documentsBody = {
  id: SHARE_ID,
  messages: [{ message_index: 1, documents: [quranDoc] }],
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** A fetch double for the two public endpoints; records every request. */
function fetchDouble(routes: Record<string, () => Response>) {
  return vi.fn(async (url: string, _init: RequestInit) => {
    const route = routes[url.replace(BASE, '')];
    return route ? route() : json(404, { detail: 'Not found' });
  });
}

describe('loadSharedThread', () => {
  it('renders the shared thread with its sources from the two public endpoints', async () => {
    const fetchImpl = fetchDouble({
      [`/api/v2/share/${SHARE_ID}`]: () => json(200, shareBody),
      [`/api/v2/share/${SHARE_ID}/documents`]: () => json(200, documentsBody),
    });

    const thread = await loadSharedThread(SHARE_ID, fetchImpl, BASE);

    expect(thread.title).toBe('The Basmala');
    expect(thread.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    const answer = thread.messages[1];
    expect(answer.citations).toHaveLength(1);
    expect(answer.citations[0].marker).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('sends no Authorization header, even with a bearer registered for the app', async () => {
    setAuthTokenGetter(() => 'viewer-access-token');
    try {
      const fetchImpl = fetchDouble({
        [`/api/v2/share/${SHARE_ID}`]: () => json(200, shareBody),
        [`/api/v2/share/${SHARE_ID}/documents`]: () => json(200, documentsBody),
      });
      await loadSharedThread(SHARE_ID, fetchImpl, BASE);

      expect(fetchImpl).toHaveBeenCalledTimes(2);
      for (const [, init] of fetchImpl.mock.calls) {
        const headers = new Headers(init.headers);
        expect(headers.has('authorization')).toBe(false);
        expect(init.credentials).toBe('omit');
      }
    } finally {
      setAuthTokenGetter(null);
    }
  });

  it('an unknown or revoked share is not-found', async () => {
    const fetchImpl = fetchDouble({});
    await expect(loadSharedThread(SHARE_ID, fetchImpl, BASE)).rejects.toBeInstanceOf(
      ShareNotFoundError,
    );
  });

  it('an id that cannot be a share is not-found without a request', async () => {
    const fetchImpl = fetchDouble({});
    await expect(loadSharedThread('not-a-share', fetchImpl, BASE)).rejects.toBeInstanceOf(
      ShareNotFoundError,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a server failure is an error, not not-found', async () => {
    const fetchImpl = fetchDouble({
      [`/api/v2/share/${SHARE_ID}`]: () => json(500, { detail: 'boom' }),
    });
    const error = await loadSharedThread(SHARE_ID, fetchImpl, BASE).catch((e) => e);
    expect(error).not.toBeInstanceOf(ShareNotFoundError);
    expect(error.status).toBe(500);
  });

  it('a documents failure costs only the sources', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchImpl = fetchDouble({
      [`/api/v2/share/${SHARE_ID}`]: () => json(200, shareBody),
      [`/api/v2/share/${SHARE_ID}/documents`]: () => json(503, {}),
    });

    const thread = await loadSharedThread(SHARE_ID, fetchImpl, BASE);

    expect(thread.messages).toHaveLength(2);
    expect(thread.messages[1].citations).toEqual([]);
    // Unbacked marker text is stripped, as on a thread without documents.
    expect(thread.messages[1].content).not.toContain('[1]');
    warn.mockRestore();
  });

  it('shows exactly what was shared, never the khushu’ sample answer', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const khushu = {
      ...shareBody,
      messages: [
        { role: 'user', content: 'How do I develop khushu in prayer?' },
        { role: 'assistant', content: 'The answer the sharer actually got.' },
      ],
    };
    // Both ways an answer can arrive without sources: no entry for it, and a
    // failed documents request.
    for (const documents of [
      () => json(200, { id: SHARE_ID, messages: [] }),
      () => json(503, {}),
    ]) {
      const fetchImpl = fetchDouble({
        [`/api/v2/share/${SHARE_ID}`]: () => json(200, khushu),
        [`/api/v2/share/${SHARE_ID}/documents`]: documents,
      });
      const thread = await loadSharedThread(SHARE_ID, fetchImpl, BASE);
      expect(thread.messages[1].content).toBe('The answer the sharer actually got.');
      expect(thread.messages[1].citations).toEqual([]);
    }
    warn.mockRestore();
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BoundedSessionEventStore } from '../src/server/event-store.ts';

describe('BoundedSessionEventStore', () => {
  it('stores events per stream and replays after a given id', async () => {
    const store = new BoundedSessionEventStore();
    const first = await store.storeEvent('s1', { jsonrpc: '2.0', method: 'a', params: {} });
    const second = await store.storeEvent('s1', { jsonrpc: '2.0', method: 'b', params: {} });
    await store.storeEvent('s2', { jsonrpc: '2.0', method: 'other', params: {} });
    const replayed: string[] = [];
    const streamId = await store.replayEventsAfter(first, {
      send: async (eventId, message) => {
        replayed.push(`${eventId}:${(message as { method?: string }).method}`);
      },
    });
    assert.equal(streamId, 's1');
    assert.equal(replayed.length, 1);
    assert.ok(replayed[0]?.startsWith(`${second}:b`));
  });

  it('replays only events after a middle cursor on the same stream', async () => {
    const store = new BoundedSessionEventStore();
    await store.storeEvent('s1', { jsonrpc: '2.0', method: 'a', params: {} });
    const second = await store.storeEvent('s1', { jsonrpc: '2.0', method: 'b', params: {} });
    const third = await store.storeEvent('s1', { jsonrpc: '2.0', method: 'c', params: {} });
    await store.storeEvent('s2', { jsonrpc: '2.0', method: 'other', params: {} });
    const replayed: string[] = [];
    await store.replayEventsAfter(second, {
      send: async (eventId, message) => {
        replayed.push(`${eventId}:${(message as { method?: string }).method}`);
      },
    });
    assert.equal(replayed.length, 1);
    assert.ok(replayed[0]?.startsWith(`${third}:c`));
  });

  it('replays nothing after the last same-stream cursor', async () => {
    const store = new BoundedSessionEventStore();
    await store.storeEvent('s1', { jsonrpc: '2.0', method: 'a', params: {} });
    await store.storeEvent('s1', { jsonrpc: '2.0', method: 'b', params: {} });
    const last = await store.storeEvent('s1', { jsonrpc: '2.0', method: 'c', params: {} });
    const replayed: string[] = [];
    await store.replayEventsAfter(last, {
      send: async (eventId) => {
        replayed.push(eventId);
      },
    });
    assert.equal(replayed.length, 0);
  });

  it('drops oldest events when the bound is exceeded', async () => {
    const store = new BoundedSessionEventStore(2);
    const first = await store.storeEvent('s', { jsonrpc: '2.0', method: 'one', params: {} });
    await store.storeEvent('s', { jsonrpc: '2.0', method: 'two', params: {} });
    await store.storeEvent('s', { jsonrpc: '2.0', method: 'three', params: {} });
    assert.equal(store.size(), 2);
    assert.equal(await store.getStreamIdForEventId(first), undefined);
  });

  it('releases all session state', async () => {
    const store = new BoundedSessionEventStore();
    const id = await store.storeEvent('s', { jsonrpc: '2.0', method: 'x', params: {} });
    store.release();
    assert.equal(store.size(), 0);
    assert.equal(await store.getStreamIdForEventId(id), undefined);
  });
});

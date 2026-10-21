import type { EventStore, JSONRPCMessage } from '@modelcontextprotocol/server';

type StoredEvent = {
  streamId: string;
  message: JSONRPCMessage;
};

/**
 * Bounded, session-scoped EventStore. Isolated by stream id, retained for
 * the session, released on close/expiry. No durable replay across process
 * restart.
 */
export class BoundedSessionEventStore implements EventStore {
  private readonly events = new Map<string, StoredEvent>();
  private readonly order: string[] = [];
  private seq = 0;

  constructor(private readonly maxEvents = 256) {}

  async storeEvent(streamId: string, message: JSONRPCMessage): Promise<string> {
    const eventId = `${streamId}:${this.seq}:${crypto.randomUUID()}`;
    this.seq += 1;
    this.events.set(eventId, { streamId, message });
    this.order.push(eventId);
    while (this.order.length > this.maxEvents) {
      const oldest = this.order.shift();
      if (oldest) {
        this.events.delete(oldest);
      }
    }
    return eventId;
  }

  async replayEventsAfter(
    lastEventId: string,
    { send }: { send: (eventId: string, message: JSONRPCMessage) => Promise<void> },
  ): Promise<string> {
    if (!lastEventId) {
      return '';
    }
    const known = this.events.get(lastEventId);
    const streamId = known?.streamId ?? lastEventId.split(':')[0] ?? '';
    if (!streamId) {
      return '';
    }
    if (!known) {
      return streamId;
    }
    let foundLast = false;
    for (const eventId of this.order) {
      const stored = this.events.get(eventId);
      if (!stored || stored.streamId !== streamId) {
        continue;
      }
      if (eventId === lastEventId) {
        foundLast = true;
        continue;
      }
      if (foundLast) {
        await send(eventId, stored.message);
      }
    }
    return streamId;
  }

  async getStreamIdForEventId(eventId: string): Promise<string | undefined> {
    return this.events.get(eventId)?.streamId;
  }

  size(): number {
    return this.events.size;
  }

  release(): void {
    this.events.clear();
    this.order.length = 0;
  }
}

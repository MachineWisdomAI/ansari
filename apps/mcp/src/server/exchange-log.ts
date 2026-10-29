// What one MCP exchange looked like on the wire, for first-load diagnosis (#335): which method a host called,
// which card address it read and whether that address is the one served now, and how the response ended.
// Only fixed fields are derived from the request; no question, answer or other parameter value is kept.

/** Request bodies larger than this are not inspected; MCP requests from hosts are a few kilobytes at most. */
const MAX_INSPECTED_BODY = 65_536;
/** How much of a response is searched for a JSON-RPC error code. A successful card read is far larger. */
const RESPONSE_HEAD = 2_048;
const TOKEN = /^[A-Za-z0-9 ._:/@+-]{1,80}$/;
const UI_URI = /^ui:\/\/[A-Za-z0-9._/-]{1,200}$/;
const ERROR_CODE = /"error"\s*:\s*\{\s*"code"\s*:\s*(-?\d{1,6})/;

export type RpcSummary = {
  rpc: string;
  requestId?: string | number;
  uri?: string;
  uriCurrent?: boolean;
  client?: string;
  clientVersion?: string;
  protocol?: string;
  tool?: string;
};

export type ExchangeEnd = {outcome: 'complete' | 'cancelled' | 'failed'; bytes: number; errorCode?: number};

const token = (value: unknown): string | undefined => typeof value === 'string' ? (TOKEN.test(value) ? value : 'other') : undefined;
const record = (value: unknown): Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};

function summarizeMessage(message: Record<string, unknown>, currentUri: string): RpcSummary {
  if (typeof message.method !== 'string') return {rpc: 'result' in message || 'error' in message ? 'response' : 'unparsed'};
  const summary: RpcSummary = {rpc: token(message.method)!};
  if (typeof message.id === 'number' || (typeof message.id === 'string' && TOKEN.test(message.id))) summary.requestId = message.id;
  const params = record(message.params);
  if (message.method === 'initialize') {
    const clientInfo = record(params.clientInfo);
    summary.client = token(clientInfo.name);
    summary.clientVersion = token(clientInfo.version);
    summary.protocol = token(params.protocolVersion);
  } else if (message.method === 'tools/call') {
    summary.tool = token(params.name);
  } else if (message.method === 'resources/read') {
    const uri = typeof params.uri === 'string' && UI_URI.test(params.uri) ? params.uri : 'other';
    summary.uri = uri;
    summary.uriCurrent = uri === currentUri;
  }
  return summary;
}

/** The JSON-RPC method(s) of a request body, with the few identifying fields that tell first-load paths apart. */
export function summarizeRpc(body: string, currentUri: string): RpcSummary {
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return {rpc: 'unparsed'}; }
  if (Array.isArray(parsed)) {
    const messages = parsed.slice(0, 5).map(item => summarizeMessage(record(item), currentUri));
    return {...messages[0], rpc: messages.map(message => message.rpc).join(',') || 'empty'};
  }
  return summarizeMessage(record(parsed), currentUri);
}

/** The body of a POST, read from a copy so the MCP handler still receives the original. */
export async function inspectableBody(request: Request): Promise<string | undefined> {
  if (request.method !== 'POST') return undefined;
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > MAX_INSPECTED_BODY) return undefined;
  const text = await request.clone().text();
  return text.length > MAX_INSPECTED_BODY ? undefined : text;
}

/**
 * Passes the response through unchanged while counting what is sent, and reports once how it ended: fully sent,
 * abandoned by the client, or failed. The first bytes are searched for a JSON-RPC error code, which an MCP error
 * carries inside an HTTP 200.
 */
export function observeResponse(response: Response, done: (end: ExchangeEnd) => void): Response {
  let ended = false;
  let bytes = 0;
  let head = '';
  const decoder = new TextDecoder();
  const finish = (outcome: ExchangeEnd['outcome']) => {
    if (ended) return;
    ended = true;
    const code = ERROR_CODE.exec(head)?.[1];
    done({outcome, bytes, ...(code === undefined ? {} : {errorCode: Number(code)})});
  };
  if (response.body === null) { finish('complete'); return response; }
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const {done: last, value} = await reader.read();
        if (last) { finish('complete'); controller.close(); return; }
        bytes += value.byteLength;
        if (head.length < RESPONSE_HEAD) head += decoder.decode(value.subarray(0, RESPONSE_HEAD), {stream: true});
        controller.enqueue(value);
      } catch (error) {
        finish('failed');
        controller.error(error);
      }
    },
    cancel(reason) {
      finish('cancelled');
      return reader.cancel(reason);
    },
  });
  return new Response(body, {status: response.status, statusText: response.statusText, headers: response.headers});
}

/** An error's name and code only: never its message, which can carry request content. */
export function errorIdentity(error: unknown): {name?: string; code?: string | number} {
  const value = record(error);
  const code = value.code;
  return {
    name: error instanceof Error ? token(error.name) : undefined,
    ...(typeof code === 'number' ? {code} : typeof code === 'string' ? {code: token(code)} : {}),
  };
}

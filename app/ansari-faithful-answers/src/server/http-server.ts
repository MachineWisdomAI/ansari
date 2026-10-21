import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import {
  hostHeaderValidation,
  originValidation,
  NodeStreamableHTTPServerTransport,
} from '@modelcontextprotocol/node';
import { isInitializeRequest } from '@modelcontextprotocol/server';
import { createAnsariHttpCompleter, type AnswerCompleter } from './ansari-client.js';
import { createAnsariMcpServer } from './create-server.js';
import { BoundedSessionEventStore } from './event-store.js';
import {
  type OperationLogger,
  defaultOperationLogger,
  deployedRevision,
  jsonRpcMeta,
  writeOperationLog,
} from './operation-log.js';

export const DEFAULT_PORT = 3000;
export const MCP_PATH = '/mcp';
const DEFAULT_ALLOWED_HOSTS = ['localhost', '127.0.0.1'];

const MAX_SESSIONS = 64;
const SESSION_IDLE_MS = 30 * 60_000;

type SessionRecord = {
  transport: NodeStreamableHTTPServerTransport;
  eventStore: BoundedSessionEventStore;
  lastActive: number;
};

export type ListenOptions = {
  port?: number;
  host?: string;
  completer?: AnswerCompleter;
  allowedHosts?: string[];
  allowedOrigins?: string[];
  html?: string;
  logger?: OperationLogger;
  requestMs?: number;
  enableJsonResponse?: boolean;
};

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

export function createHttpServer(options: ListenOptions = {}) {
  const completer = options.completer ?? createAnsariHttpCompleter();
  const extraHosts = (process.env.MCP_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const extraOrigins = (process.env.MCP_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const allowedHosts = [...new Set([...(options.allowedHosts ?? DEFAULT_ALLOWED_HOSTS), ...extraHosts])];
  const allowedOrigins = [
    ...new Set([...(options.allowedOrigins ?? allowedHosts), ...extraOrigins]),
  ];
  const validateHost = hostHeaderValidation(allowedHosts);
  const validateOrigin = originValidation(allowedOrigins);
  const logger = options.logger ?? defaultOperationLogger;
  const sessions = new Map<string, SessionRecord>();

  const sweep = (): void => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (now - session.lastActive > SESSION_IDLE_MS) {
        session.eventStore.release();
        void session.transport.close();
        sessions.delete(id);
      }
    }
  };
  const sweepTimer = setInterval(sweep, 60_000);
  sweepTimer.unref();

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      if (req.method === 'GET' && url.pathname === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, mcp: MCP_PATH, release: deployedRevision() }));
        return;
      }
      if (url.pathname !== MCP_PATH) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }
      if (!validateHost(req, res) || !validateOrigin(req, res)) {
        return;
      }

      const sessionIdHeader = req.headers['mcp-session-id'];
      const sessionId = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader;
      if (sessionId && sessions.has(sessionId)) {
        const session = sessions.get(sessionId)!;
        session.lastActive = Date.now();
        const parsedBody = req.method === 'POST' ? await readJsonBody(req) : undefined;
        writeOperationLog({ event: 'mcp.request', ...jsonRpcMeta(parsedBody) }, logger);
        await session.transport.handleRequest(req, res, parsedBody);
        return;
      }

      if (req.method === 'POST') {
        const parsedBody = await readJsonBody(req);
        if (!sessionId && isInitializeRequest(parsedBody)) {
          if (sessions.size >= MAX_SESSIONS) {
            res.writeHead(503, { 'content-type': 'application/json' });
            res.end(
              JSON.stringify({
                jsonrpc: '2.0',
                error: { code: -32000, message: 'Too many open sessions' },
                id: null,
              }),
            );
            return;
          }
          const eventStore = new BoundedSessionEventStore();
          const enableJsonResponse =
            options.enableJsonResponse ?? process.env.MCP_RESPONSE_MODE === 'json';
          const transport = new NodeStreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            eventStore,
            enableJsonResponse,
            onsessioninitialized: (id) => {
              sessions.set(id, { transport, eventStore, lastActive: Date.now() });
            },
          });
          transport.onclose = () => {
            if (transport.sessionId) {
              const record = sessions.get(transport.sessionId);
              record?.eventStore.release();
              sessions.delete(transport.sessionId);
            }
          };
          const mcp = createAnsariMcpServer({
            completer,
            html: options.html,
            logger,
            requestMs: options.requestMs,
          });
          await mcp.connect(transport);
          writeOperationLog({ event: 'mcp.request', ...jsonRpcMeta(parsedBody) }, logger);
          await transport.handleRequest(req, res, parsedBody);
          return;
        }
        if (sessionId) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              error: { code: -32001, message: 'Session not found' },
              id: null,
            }),
          );
          return;
        }
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Bad Request: Session ID required' },
            id: null,
          }),
        );
        return;
      }

      if (sessionId) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32001, message: 'Session not found' },
            id: null,
          }),
        );
        return;
      }
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Bad Request: Session ID required' },
          id: null,
        }),
      );
    } catch (error) {
      writeOperationLog({ event: 'mcp.error', method: req.method }, logger);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
      }
      if (!res.writableEnded) {
        res.end(
          JSON.stringify({
            error: 'internal error',
          }),
        );
      }
    }
  });

  return {
    server,
    sessions,
    close: async () => {
      clearInterval(sweepTimer);
      for (const session of sessions.values()) {
        session.eventStore.release();
        await session.transport.close();
      }
      sessions.clear();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

export async function listen(options: ListenOptions = {}): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const port = options.port ?? Number(process.env.PORT ?? DEFAULT_PORT);
  const host = options.host ?? '0.0.0.0';
  const http = createHttpServer(options);
  await new Promise<void>((resolve, reject) => {
    http.server.once('error', reject);
    http.server.listen(port, host, () => { http.server.off('error', reject); resolve(); });
  });
  const address = http.server.address();
  const bound = typeof address === 'object' && address ? address.port : port;
  return { port: bound, close: http.close };
}

import {createAdaptorServer} from '@hono/node-server';
import {hostHeaderValidation, originValidation} from '@modelcontextprotocol/hono';
import {createMcpHandler} from '@modelcontextprotocol/server';
import {Hono} from 'hono';
import {createAnsariHttpCompleter, type AnswerCompleter} from './ansari-client.js';
import {createAnsariMcpServer} from './create-server.js';
import {prepareAnswerView} from './view-artifact.js';
import {type OperationLogger, defaultOperationLogger, deployedRevision, writeOperationLog} from './operation-log.js';

export const DEFAULT_PORT = 3000;
export const MCP_PATH = '/mcp';
const DEFAULT_ALLOWED_HOSTS = ['localhost', '127.0.0.1'];

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

export function createHttpServer(options: ListenOptions = {}) {
  const completer = options.completer ?? createAnsariHttpCompleter();
  const logger = options.logger ?? defaultOperationLogger;
  const release = deployedRevision();
  const view = prepareAnswerView(options.html, release);
  const extraHosts = (process.env.MCP_ALLOWED_HOSTS ?? '').split(',').map(value=>value.trim()).filter(Boolean);
  const extraOrigins = (process.env.MCP_ALLOWED_ORIGINS ?? '').split(',').map(value=>value.trim()).filter(Boolean);
  const allowedHosts = [...new Set([...(options.allowedHosts ?? DEFAULT_ALLOWED_HOSTS), ...extraHosts])];
  const allowedOrigins = [...new Set([...(options.allowedOrigins ?? allowedHosts), ...extraOrigins])];
  const enableJsonResponse = options.enableJsonResponse ?? process.env.MCP_RESPONSE_MODE === 'json';

  // The official handler owns per-request transports, protocol negotiation and cleanup.
  // Both modern MCP and its older-host fallback are stateless; only the prepared view is shared.
  const mcp = createMcpHandler(
    () => createAnsariMcpServer({completer, view, logger, requestMs: options.requestMs}),
    {responseMode: enableJsonResponse ? 'json' : 'sse', onerror: () => writeOperationLog({event:'mcp.error'}, logger)},
  );
  const app = new Hono();
  app.get('/health', c=>c.json({ok:true, mcp:MCP_PATH, release}));
  app.use(MCP_PATH, hostHeaderValidation(allowedHosts));
  app.use(MCP_PATH, originValidation(allowedOrigins));
  app.all(MCP_PATH, c=>{
    writeOperationLog({event:'mcp.request', method:c.req.method}, logger);
    return mcp.fetch(c.req.raw);
  });
  app.notFound(c=>c.json({error:'not found'},404));
  app.onError((_,c)=>{
    writeOperationLog({event:'mcp.error',method:c.req.method},logger);
    return c.json({error:'internal error'},500);
  });

  const server = createAdaptorServer({fetch:app.fetch});
  return {
    server,
    close: async () => {
      await mcp.close();
      await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
    },
  };
}

export async function listen(options: ListenOptions = {}): Promise<{port:number; close:()=>Promise<void>}> {
  const port = options.port ?? Number(process.env.PORT ?? DEFAULT_PORT);
  const host = options.host ?? '0.0.0.0';
  const http = createHttpServer(options);
  await new Promise<void>((resolve,reject)=>{
    http.server.once('error',reject);
    http.server.listen(port,host,()=>{http.server.off('error',reject);resolve();});
  });
  const address = http.server.address();
  const bound = typeof address === 'object' && address ? address.port : port;
  return {port:bound,close:http.close};
}

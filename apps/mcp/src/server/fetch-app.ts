import {hostHeaderValidation, originValidation} from '@modelcontextprotocol/hono';
import {createMcpHandler} from '@modelcontextprotocol/server';
import {Hono} from 'hono';
import type {AnswerCompleter} from './ansari-client.js';
import {createAnsariMcpServer} from './create-server.js';
import {errorIdentity, inspectableBody, observeResponse, summarizeRpc} from './exchange-log.js';
import {VIEW_DIAGNOSTICS_PATH, prepareAnswerView} from './view-artifact.js';
import {MAX_VIEW_REPORT_BYTES, originHost, parseViewReport} from './view-report.js';
import {type OperationLogger, writeOperationLog} from './operation-log.js';

export const MCP_PATH = '/mcp';

/**
 * Everything the application needs, supplied explicitly. This module reads no process environment,
 * file or global, so the same code runs under Node and Cloudflare Workers.
 */
export type FetchAppOptions = {
  completer: AnswerCompleter;
  /** The built card, before release stamping. */
  html: string;
  release: string;
  allowedHosts: string[];
  allowedOrigins: string[];
  enableJsonResponse: boolean;
  logger: OperationLogger;
  requestMs?: number;
  /** Dev-only: the public origin a diagnostic card reports its milestones to (see `VIEW_DIAGNOSTICS_PATH`). */
  viewDiagnosticsOrigin?: string;
};

export type FetchApp = {
  fetch: (request: Request) => Response | Promise<Response>;
  close: () => Promise<void>;
};

/** One Hono application over the official stateless MCP handler. Hosting adapters only supply a listener or an entry point. */
export function createFetchApp(options: FetchAppOptions): FetchApp {
  const {completer, logger, release} = options;
  const log = (record: Parameters<typeof writeOperationLog>[0]) => writeOperationLog(record, logger, release);
  // The view is prepared once: release stamping first, then the resource identity from the final bytes.
  const view = prepareAnswerView(options.html, release, options.viewDiagnosticsOrigin);
  // The official handler owns per-request transports, protocol negotiation and cleanup.
  // Both modern MCP and its older-host fallback are stateless; only the prepared view is shared.
  const mcp = createMcpHandler(
    () => createAnsariMcpServer({completer, view, logger, release, requestMs: options.requestMs}),
    {responseMode: options.enableJsonResponse ? 'json' : 'sse', onerror: (error: unknown) => log({event: 'mcp.error', ...errorIdentity(error)})},
  );
  const app = new Hono();
  app.get('/health', c => c.json({ok: true, mcp: MCP_PATH, release}));
  app.use(MCP_PATH, hostHeaderValidation(options.allowedHosts));
  app.use(MCP_PATH, originValidation(options.allowedOrigins));
  // One line when a request arrives and one when its response ends, joined by `rid`: which method a host called,
  // which card address it read, and whether the response was fully sent (#335).
  app.all(MCP_PATH, async c => {
    const started = Date.now();
    const rid = crypto.randomUUID().slice(0, 8);
    const body = await inspectableBody(c.req.raw);
    const summary = body === undefined ? {rpc: c.req.method === 'POST' ? 'oversize' : 'none'} : summarizeRpc(body, view.uri);
    log({event: 'mcp.request', at: started, method: c.req.method, rid, ...summary});
    const response = await mcp.fetch(c.req.raw);
    const headersMs = Date.now() - started;
    return observeResponse(response, end => log({event: 'mcp.response', at: Date.now(), rid, rpc: summary.rpc, status: response.status, headersMs, ms: Date.now() - started, ...end}));
  });
  if (options.viewDiagnosticsOrigin !== undefined) {
    app.use(VIEW_DIAGNOSTICS_PATH, hostHeaderValidation(options.allowedHosts));
    // A beacon from a sandboxed card: no credentials, a simple text/plain request and nothing to read back.
    app.post(VIEW_DIAGNOSTICS_PATH, async c => {
      c.header('access-control-allow-origin', '*');
      const origin = originHost(c.req.header('origin') ?? null);
      if (Number(c.req.header('content-length') ?? 0) > MAX_VIEW_REPORT_BYTES) {
        log({event: 'view.report.invalid', reason: 'size', origin});
        return c.body(null, 413);
      }
      const text = await c.req.text();
      if (text.length > MAX_VIEW_REPORT_BYTES) {
        log({event: 'view.report.invalid', reason: 'size', origin});
        return c.body(null, 413);
      }
      const report = parseViewReport(text);
      if (report === undefined) {
        log({event: 'view.report.invalid', reason: 'shape', origin});
        return c.body(null, 400);
      }
      log({event: 'view.report', at: Date.now(), origin, ...report});
      return c.body(null, 204);
    });
  }
  app.notFound(c => c.json({error: 'not found'}, 404));
  app.onError((error, c) => {
    log({event: 'mcp.error', method: c.req.method, ...errorIdentity(error)});
    return c.json({error: 'internal error'}, 500);
  });
  return {fetch: request => app.fetch(request), close: () => mcp.close()};
}

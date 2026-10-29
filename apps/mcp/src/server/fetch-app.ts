import {hostHeaderValidation, originValidation} from '@modelcontextprotocol/hono';
import {createMcpHandler} from '@modelcontextprotocol/server';
import {Hono} from 'hono';
import type {AnswerCompleter} from './ansari-client.js';
import {createAnsariMcpServer} from './create-server.js';
import {errorIdentity, inspectRequest, observeResponse, readBounded} from './exchange-log.js';
import {VIEW_DIAGNOSTICS_PATH, prepareAnswerView} from './view-artifact.js';
import {MAX_VIEW_REPORT_BYTES, VIEW_REPORTS_PER_MINUTE, originHost, parseViewReport} from './view-report.js';
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
  // The exact card this instance serves: a diagnostic card differs from the closed one in bytes, address and permissions.
  log({event: 'view.prepared', at: Date.now(), uri: view.uri, bytes: new TextEncoder().encode(view.html).byteLength, diagnostics: options.viewDiagnosticsOrigin !== undefined, connectDomains: view.csp.connectDomains.join(',')});
  // One line when a request has been inspected and one when its response stream ends, joined by `rid`: which method a
  // host called, which card address it read, and how the response stream ended (#335). Inspection reads a copy
  // alongside the handler and never holds up or alters the exchange.
  app.all(MCP_PATH, async c => {
    const started = Date.now();
    const rid = crypto.randomUUID().slice(0, 8);
    const inspected = inspectRequest(c.req.raw, view.uri);
    void inspected.then(summary => log({event: 'mcp.request', at: started, method: c.req.method, rid, ...summary}));
    const response = await mcp.fetch(c.req.raw);
    const headersMs = Date.now() - started;
    return observeResponse(response, end => {
      const ms = Date.now() - started;
      void inspected.then(summary => log({event: 'mcp.response', at: Date.now(), rid, rpc: summary.rpc, status: response.status, headersMs, ms, ...end}));
    });
  });
  if (options.viewDiagnosticsOrigin !== undefined) {
    app.use(VIEW_DIAGNOSTICS_PATH, hostHeaderValidation(options.allowedHosts));
    let windowStart = 0;
    let windowCount = 0;
    // A beacon from a sandboxed card: unauthenticated, client-authored and only as trustworthy as the card that sent
    // it. Bounded in size and rate; nothing is read back.
    app.post(VIEW_DIAGNOSTICS_PATH, async c => {
      c.header('access-control-allow-origin', '*');
      const now = Date.now();
      if (now - windowStart >= 60_000) { windowStart = now; windowCount = 0; }
      if (++windowCount > VIEW_REPORTS_PER_MINUTE) {
        if (windowCount === VIEW_REPORTS_PER_MINUTE + 1) log({event: 'view.report.limited', perMinute: VIEW_REPORTS_PER_MINUTE});
        return c.body(null, 429);
      }
      const origin = originHost(c.req.header('origin') ?? null);
      const read = c.req.raw.body === null ? {text: ''} : await readBounded(c.req.raw.body, MAX_VIEW_REPORT_BYTES).catch(() => ({exceeded: true as const}));
      if ('exceeded' in read) {
        log({event: 'view.report.invalid', reason: 'size', origin});
        return c.body(null, 413);
      }
      const report = parseViewReport(read.text);
      if (report === undefined) {
        log({event: 'view.report.invalid', reason: 'shape', origin});
        return c.body(null, 400);
      }
      log({event: 'view.report', at: now, clientAuthored: true, origin, ...report});
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

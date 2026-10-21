import {McpServer} from '@modelcontextprotocol/server';
import {createServerBudgets, registerPublicOperation, viewUriForHtml} from '@saga-a2ui/mcp/server';
import {z} from 'zod';
import type {AnswerCompleter} from './ansari-client.js';
import {stampHtmlRevision,writeOperationLog,type OperationLogger} from './operation-log.js';
import {answerFingerprint} from './answer-fingerprint.js';
import {APP_VERSION} from '../version.js';
import {ANSWER_ENVELOPE_VERSION} from '../view/envelope.js';
import {readFileSync} from 'node:fs';
import {perCallLifetime} from './call-lifetime.js';


// Existing application identity and text, not a new release declaration.
export const SERVER_NAME='ansari-faithful-answers';
export const MCP_PROTOCOL_VERSION='2025-11-25';
export const TOOL_UNAVAILABLE_TEXT='Ansari could not complete this request.';
/** The handler wait the tool declares; the request budget of each call below is the same, never the SDK default. */
export const HANDLER_BOUND_MS=60_000;
export type CreateMcpServerOptions = {
  completer: AnswerCompleter;
  html?: string;
  logger?: OperationLogger;
  requestMs?: number;
};

export function createAnsariMcpServer(options:CreateMcpServerOptions):McpServer{
  const currentHtml = stampHtmlRevision(options.html ?? readFileSync(new URL('../../dist/view.html', import.meta.url), 'utf8'));
  const currentUri = viewUriForHtml(currentHtml);
  const viewCsp = {connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: []};
  // Without a context the SDK default 10 s request budget would clamp the declared handler bound below. The request
  // budget is the declared bound itself: no new timeout target and no change to the SDK defaults. Each call gets its own.
  const budgets=createServerBudgets({requestMs:options.requestMs??HANDLER_BOUND_MS});
  const server=new McpServer({name:SERVER_NAME,version:APP_VERSION},{capabilities:{tools:{},resources:{}}});
  registerPublicOperation(server,{
    name:'ask_ansari',
    title:'Ask Ansari',
    description:'Answers a question about Islam and shows the returned answer, with its attribution, in the Ansari answer card.',
    // No backend-specific hints inferred from the synthetic experiments.
    annotations:{},
    // Application handler bound, with a fresh lifetime per call.
    boundMs:HANDLER_BOUND_MS,
    input:z.object({question:z.string().min(1).describe('The question to send to Ansari')}),
    output:z.object({version:z.literal(ANSWER_ENVELOPE_VERSION),question:z.string(),answer:z.string()}).strict(),
    // Discovery, every result's _meta.ui.resourceUri and the resource read all come from this one declaration.
    view:{uri:currentUri,title:'Ansari answer card',html:currentHtml,csp:viewCsp},
    failures:{absent:TOOL_UNAVAILABLE_TEXT,unavailable:TOOL_UNAVAILABLE_TEXT,invalidOutput:TOOL_UNAVAILABLE_TEXT},
    async handle({question},request){
      writeOperationLog({event:'source.start',method:'tools/call'},options.logger);
      await request.reportProgress({progress:0,total:1});
      // Source records do not claim terminal MCP delivery or upstream abortion.
      let answer:string;
      try {
        answer=await options.completer.complete({question});
      } catch (error) {
        // Record source failure without inspecting or serializing the exception.
        writeOperationLog({event:'source.error',method:'tools/call'},options.logger);
        throw error;
      }
      writeOperationLog({event:'source.complete',method:'tools/call',...answerFingerprint(answer)},options.logger);
      return {kind:'record' as const,record:{question,answer}};
    },
    project:record=>({text:record.answer,data:{version:ANSWER_ENVELOPE_VERSION,question:record.question,answer:record.answer}}),
  },perCallLifetime(budgets));
  return server;
}

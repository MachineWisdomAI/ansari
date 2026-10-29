import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createFetchApp} from '../src/server/fetch-app.ts';
import type {OperationRecord} from '../src/server/operation-log.ts';
import {settingsFromEnv} from '../src/server/runtime-config.ts';
import {VIEW_DIAGNOSTICS_PATH, prepareAnswerView} from '../src/server/view-artifact.ts';

// First-load diagnosis (#335): what the server and the card record, and the Dev-only beacon channel.
const CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; connect-src 'none'; frame-src 'none'">`;
const html = `<html><head>${CSP}</head><body data-release="0">synthetic card ${'x'.repeat(4096)}</body></html>`;
const QUESTION = 'PRIVATE_QUESTION_CANARY';
const ANSWER = 'PRIVATE_ANSWER_CANARY';
const STALE = 'ui://views/answer-card.a0cf6be6ed3f0fc75f083280d39ee589.html';
const ORIGIN = 'https://dev.example';

function harness(env: Record<string, string> = {}, complete: () => Promise<string> = async () => ANSWER) {
  const logs: OperationRecord[] = [];
  const app = createFetchApp({...settingsFromEnv(env), html, logger: record => logs.push(record), completer: {complete}});
  let id = 0;
  const rpc = (method: string, params: Record<string, unknown> = {}) => app.fetch(new Request('http://localhost/mcp', {
    method: 'POST',
    headers: {host: 'localhost', 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25'},
    body: JSON.stringify({jsonrpc: '2.0', id: ++id, method, params}),
  }));
  const beacon = (body: string, headers: Record<string, string> = {}) => app.fetch(new Request(`http://localhost${VIEW_DIAGNOSTICS_PATH}`, {
    method: 'POST', headers: {host: 'localhost', 'content-type': 'text/plain', origin: 'https://sandbox.host.example', ...headers}, body,
  }));
  return {app, logs, rpc, beacon};
}

const settled = async (response: Response) => { await response.text(); await new Promise(resolve => setTimeout(resolve, 0)); };
const byRid = (logs: OperationRecord[], event: string, rpc: string) => logs.filter(r => r.event === event && r.rpc === rpc);

test('each MCP exchange records its method, card address, outcome, size and timing without content', async () => {
  const {app, logs, rpc} = harness();
  try {
    const listed = await rpc('tools/list');
    const uri = (JSON.parse((await listed.text()).replace(/^[\s\S]*?data: /, '')) as {result: {tools: {_meta: {ui: {resourceUri: string}}}[]}}).result.tools[0]._meta.ui.resourceUri;
    await settled(await rpc('initialize', {protocolVersion: '2025-06-18', capabilities: {}, clientInfo: {name: 'probe-host', version: '9.1'}}));
    await settled(await rpc('resources/read', {uri}));
    await settled(await rpc('resources/read', {uri: STALE}));
    await settled(await rpc('tools/call', {name: 'answer_islamic_question', arguments: {question: QUESTION}}));

    const [current, stale] = byRid(logs, 'mcp.request', 'resources/read');
    assert.equal(current.uri, uri);
    assert.equal(current.uriCurrent, true);
    assert.equal(stale.uri, STALE);
    assert.equal(stale.uriCurrent, false, 'a card address from an earlier deploy is visible as such');
    const initialize = byRid(logs, 'mcp.request', 'initialize')[0];
    assert.equal(initialize.client, 'probe-host');
    assert.equal(initialize.clientVersion, '9.1');
    assert.equal(initialize.protocol, '2025-06-18');
    assert.equal(byRid(logs, 'mcp.request', 'tools/call')[0].tool, 'answer_islamic_question');

    const [read, missing] = byRid(logs, 'mcp.response', 'resources/read');
    assert.equal(read.rid, current.rid, 'request and response lines share one id');
    assert.equal(read.status, 200);
    assert.equal(read.outcome, 'complete');
    assert.equal(read.errorCode, undefined);
    assert.ok((read.bytes as number) > html.length, 'the card read reports the bytes actually sent');
    assert.equal(typeof read.ms, 'number');
    assert.equal(typeof read.headersMs, 'number');
    assert.equal(missing.errorCode, -32602, 'a stale card read is a JSON-RPC error inside an HTTP 200');
    for (const record of logs.filter(r => r.event === 'mcp.request')) assert.equal(record.method, 'POST', 'the request line keeps the HTTP verb in `method`');
    const serialized = JSON.stringify(logs);
    assert.ok(!serialized.includes(QUESTION) && !serialized.includes(ANSWER), 'no question or answer text is logged');
  } finally { await app.close(); }
});

test('a client that hangs up mid-response is recorded as cancelled', async () => {
  let release!: () => void;
  const {app, logs, rpc} = harness({}, () => new Promise(resolve => { release = () => resolve(ANSWER); }));
  try {
    const response = await rpc('tools/call', {name: 'answer_islamic_question', arguments: {question: QUESTION}});
    assert.equal(response.headers.get('content-type')?.startsWith('text/event-stream'), true);
    await response.body!.cancel();
    release();
    for (let waited = 0; !byRid(logs, 'mcp.response', 'tools/call').length && waited < 1000; waited += 10) await new Promise(r => setTimeout(r, 10));
    assert.equal(byRid(logs, 'mcp.response', 'tools/call')[0]?.outcome, 'cancelled');
  } finally { await app.close(); }
});

test('handler errors are logged by name and code only', async () => {
  const {app, logs} = harness();
  try {
    const response = await app.fetch(new Request('http://localhost/mcp', {
      method: 'POST', headers: {host: 'localhost', 'content-type': 'application/json', accept: 'application/json, text/event-stream'}, body: '{not json',
    }));
    await response.text();
    const request = logs.find(r => r.event === 'mcp.request')!;
    assert.equal(request.rpc, 'unparsed');
    const response_ = logs.find(r => r.event === 'mcp.response')!;
    assert.equal((response_.status as number) >= 400 || typeof response_.errorCode === 'number', true);
  } finally { await app.close(); }
});

test('without a diagnostics origin the card, its address and its permissions are unchanged', async () => {
  assert.equal(settingsFromEnv({}).viewDiagnosticsOrigin, undefined);
  const plain = prepareAnswerView(html, 'r1');
  assert.deepEqual(prepareAnswerView(html, 'r1', undefined), plain);
  assert.ok(!plain.html.includes('data-diagnostics'));
  assert.ok(plain.html.includes("connect-src 'none'"));
  assert.deepEqual(plain.csp.connectDomains, []);
  const {app, beacon} = harness();
  try { assert.equal((await beacon('{}')).status, 404, 'no beacon route unless diagnostics are configured'); } finally { await app.close(); }
});

test('a diagnostics origin opens exactly one connect origin and stamps the beacon address', () => {
  const settings = settingsFromEnv({MCP_VIEW_DIAGNOSTICS_ORIGIN: `${ORIGIN}/`});
  assert.equal(settings.viewDiagnosticsOrigin, ORIGIN);
  const view = prepareAnswerView(html, 'r1', ORIGIN);
  assert.ok(view.html.includes(`data-diagnostics="${ORIGIN}${VIEW_DIAGNOSTICS_PATH}"`));
  assert.ok(view.html.includes(`connect-src ${ORIGIN};`));
  assert.ok(!view.html.includes("connect-src 'none'"));
  assert.deepEqual(view.csp.connectDomains, [ORIGIN]);
  assert.notEqual(view.uri, prepareAnswerView(html, 'r1').uri, 'a diagnostic card has its own address');
  for (const bad of ['http://dev.example', 'https://dev.example/path', 'https://user@dev.example', 'not a url', 'https://dev.example?x=1']) {
    assert.throws(() => settingsFromEnv({MCP_VIEW_DIAGNOSTICS_ORIGIN: bad}), /MCP_VIEW_DIAGNOSTICS_ORIGIN/, bad);
  }
  assert.equal(settingsFromEnv({MCP_VIEW_DIAGNOSTICS_ORIGIN: 'http://127.0.0.1:8080'}).viewDiagnosticsOrigin, 'http://127.0.0.1:8080');
  assert.throws(() => prepareAnswerView('<html><body></body></html>', 'r1', ORIGIN), /connect-src/, 'a card without the closed connect rule fails loudly');
});

test('the beacon accepts only the fixed report shape and logs it without free text', async () => {
  const {app, logs, beacon} = harness({MCP_VIEW_DIAGNOSTICS_ORIGIN: ORIGIN});
  try {
    const report = {
      v: 1, id: 'abc123def456', release: 'r1', reason: 'pagehide', visibility: 'hidden', host: 'Claude',
      marks: {script: 12.4, main: 410.9, context: 980.2, fonts: 1300.1, unknownMark: 5},
      errors: [{type: 'csp', directive: 'connect-src', blocked: 'https'}, {type: 'error', name: 'TypeError', message: ANSWER}],
      failure: 'connect', extra: ANSWER,
    };
    const accepted = await beacon(JSON.stringify(report));
    assert.equal(accepted.status, 204);
    assert.equal(accepted.headers.get('access-control-allow-origin'), '*');
    const logged = logs.find(r => r.event === 'view.report')!;
    assert.equal(logged.view, 'abc123def456');
    assert.equal(logged.reason, 'pagehide');
    assert.equal(logged.failure, 'connect');
    assert.equal(logged.host, 'Claude');
    assert.equal(logged.origin, 'sandbox.host.example');
    assert.deepEqual(logged.marks, {script: 12, main: 411, fonts: 1300, context: 980});
    assert.deepEqual(logged.errors, [{type: 'csp', directive: 'connect-src', blocked: 'https'}, {type: 'error', name: 'TypeError'}]);
    assert.ok(!JSON.stringify(logs).includes(ANSWER), 'free text in a report is never logged');

    for (const bad of ['not json', JSON.stringify({...report, v: 2}), JSON.stringify({...report, id: 'has space'}), JSON.stringify({...report, reason: 'other'})]) {
      assert.equal((await beacon(bad)).status, 400, bad);
    }
    assert.equal((await beacon('x'.repeat(9000))).status, 413);
    assert.equal(logs.filter(r => r.event === 'view.report.invalid').length, 5);
  } finally { await app.close(); }
});

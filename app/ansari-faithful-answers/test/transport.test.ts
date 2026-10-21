import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {Client, StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {listen} from '../src/server/http-server.js';
import {createAnsariHttpCompleter} from '../src/server/ansari-client.js';

const answer = '3. Complete English answer\n   1. Nested item\n\nالإجابة العربية\n\n*Answered by [Ansari](https://askansari.ai).*\n';
async function resource(html: string) {
  const service = await listen({host:'127.0.0.1',port:0,html,logger:()=>{},completer:{async complete(){return answer;}}});
  const client = new Client({name:'synthetic',version:'1'});
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${service.port}/mcp`));
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map(t=>t.name), ['ask_ansari']);
    const result = await client.callTool({name:'ask_ansari',arguments:{question:'synthetic'}});
    assert.deepEqual(result.structuredContent,{version:'0.1.0',question:'synthetic',answer});
    assert.deepEqual(result.content,[{type:'text',text:answer}]);
    const uri = (result._meta as {ui:{resourceUri:string}}).ui.resourceUri;
    const listed = await client.listResources();
    assert.deepEqual(listed.resources.map(r=>r.uri),[uri]);
    const read = await client.readResource({uri});
    const text = (read.contents[0] as {text:string}).text;
    assert.equal(uri,`ui://sha256/${createHash('sha256').update(text).digest('hex')}.html`);
    await assert.rejects(client.readResource({uri:'ui://obsolete.html'}));
    for(const path of ['/demo','/demo/answer','/fonts/amiri.ttf']) assert.equal((await fetch(`http://127.0.0.1:${service.port}${path}`)).status,404);
    return uri;
  } finally {await transport.terminateSession();await client.close();await service.close();}
}
test('one current resource, unchanged answer, MCP linkage and HTML identity', async()=>{
  const a=await resource('<html><body>one</body></html>');
  const b=await resource('<html><body>two</body></html>');
  assert.notEqual(a,b);
});
test('API client sends the question and preserves the complete response',async()=>{
  const client=createAnsariHttpCompleter({baseUrl:'https://synthetic.invalid/',fetchImpl:async(url,init)=>{
    assert.equal(url,'https://synthetic.invalid/api/v2/mcp-complete');
    assert.deepEqual(JSON.parse(String(init?.body)),{messages:[{role:'user',content:'question'}]});
    return new Response(answer);
  }});
  assert.equal(await client.complete({question:'question'}),answer);
});

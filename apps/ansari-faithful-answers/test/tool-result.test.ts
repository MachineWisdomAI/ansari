import assert from 'node:assert/strict';
import {test} from 'node:test';
import {classifyToolResult} from '../src/view/tool-result.js';
test('structured results require the current envelope, without legacy acceptance',()=>{
  for(const version of [undefined,'0.0.1','9.9.9']) assert.equal(classifyToolResult({structuredContent:{version,question:'q',answer:'a'}}).kind,'rejected');
  assert.deepEqual(classifyToolResult({structuredContent:{version:'0.1.0',question:'q',answer:'complete answer\n'}}),{kind:'valid',envelope:{question:'q',answer:'complete answer\n'}});
});
test('hosts that deliver only the current text result preserve its bytes',()=>{
  assert.deepEqual(classifyToolResult({content:[{type:'text',text:'answer\n'}]}),{kind:'valid',envelope:{question:'',answer:'answer\n'}});
});

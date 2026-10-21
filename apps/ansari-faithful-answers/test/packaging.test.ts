import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
test('packaged HTML is self-contained and assets contain bytes',()=>{
  const html=readFileSync(join(root,'dist/view.html'),'utf8');
  assert.ok(html.includes('data:image/'));
  for (const name of ['Kitab-Regular.ttf', 'Kitab-Bold.ttf']) {
    const bytes=readFileSync(join(root,'assets/fonts',name));
    assert.equal(bytes.readUInt32BE(0),0x00010000, 'actual TrueType bytes');
    assert.ok(html.includes(bytes.toString('base64')), `${name} is embedded verbatim`);
  }
  assert.ok(!html.includes('version https://git-lfs.github.com/spec/v1'));
  assert.doesNotMatch(html,/<script[^>]+src=/i);
  assert.doesNotMatch(html,/<link[^>]+href=["'][^"']+\.css/i);
  assert.doesNotMatch(html,/\{\{brand\.|\{\{release\}\}/);
  assert.deepEqual(readdirSync(join(root,'dist')).sort(),['server','view.html']);
  for(const name of ['answer-assets.ts','brand-mark.ts']) {
    const source=readFileSync(join(root,'assets',name),'utf8');
    assert.ok(!source.startsWith('version https://git-lfs.github.com/spec/v1'));
  }
});

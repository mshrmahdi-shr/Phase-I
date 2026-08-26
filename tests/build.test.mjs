import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('Pages staging includes app modules but excludes repository and test dependencies',async t=>{
  const {buildSite}=await import('../scripts/build-site.mjs');
  const output=await fs.mkdtemp(path.join(os.tmpdir(),'phase-i-stage-'));
  t.after(()=>fs.rm(output,{recursive:true,force:true}));
  await buildSite({output,revision:'test-commit'});
  assert.ok((await fs.readFile(path.join(output,'app.js'),'utf8')).length>0);
  assert.ok((await fs.stat(path.join(output,'src/geology.mjs'))).isFile());
  assert.equal(JSON.parse(await fs.readFile(path.join(output,'version.json'),'utf8')).revision,'test-commit');
  for(const name of ['.git','node_modules','tests','scripts'])await assert.rejects(()=>fs.access(path.join(output,name)));
});

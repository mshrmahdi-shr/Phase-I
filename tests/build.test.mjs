import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const importSpecifiers=source=>[
  ...source.matchAll(/\bfrom\s*['\"](\.{1,2}\/[^'\"]+)['\"]/g),
  ...source.matchAll(/new URL\(\s*['\"](\.{1,2}\/[^'\"]+)['\"]\s*,\s*import\.meta\.url\s*\)/g)
].map(([,specifier])=>specifier);

async function releaseGraph(output,revision){
  const html=await fs.readFile(path.join(output,'index.html'),'utf8');
  const entries=[...html.matchAll(/(?:href|src)="(\.{0,2}\/?(?:styles\.css|app\.js)[^"]*)"/g)].map(([,url])=>url);
  const expectedQuery='?v='+encodeURIComponent(revision);
  assert.deepEqual(entries.sort(),[`app.js${expectedQuery}`,`styles.css${expectedQuery}`].sort());
  const moduleUrls=[];
  const visit=async url=>{
    const file=fileURLToPath(new URL(url,pathToFileURL(path.join(output,'index.html'))));
    assert.ok(file.startsWith(output+path.sep),`first-party URL escapes staging: ${url}`);
    const source=await fs.readFile(file,'utf8');
    for(const specifier of importSpecifiers(source)){
      const dependency=new URL(specifier,pathToFileURL(file));
      assert.equal(dependency.search,expectedQuery,`unversioned dependency from ${url}: ${specifier}`);
      await fs.access(fileURLToPath(dependency));
      moduleUrls.push(dependency.href);
      if(dependency.pathname.endsWith('.mjs')&&!visited.has(dependency.href)){
        visited.add(dependency.href);await visit(dependency.href);
      }
    }
  };
  const app=new URL(entries.find(url=>url.startsWith('app.js')),pathToFileURL(path.join(output,'index.html')));
  const visited=new Set([app.href]);await visit(app.href);
  return {entries,moduleUrls};
}

test('Pages staging includes app modules but excludes repository and test dependencies',async t=>{
  const {buildSite}=await import('../scripts/build-site.mjs');
  const output=await fs.mkdtemp(path.join(os.tmpdir(),'phase-i-stage-'));
  t.after(()=>fs.rm(output,{recursive:true,force:true}));
  await buildSite({output,revision:'test-commit'});
  assert.ok((await fs.readFile(path.join(output,'app.js'),'utf8')).length>0);
  assert.ok((await fs.stat(path.join(output,'src/geology.mjs'))).isFile());
  assert.ok((await fs.stat(path.join(output,'src/company-ui.mjs'))).isFile());
  for(const name of ['vendor/jspdf.umd.min.js','vendor/jspdf.LICENSE','assets/fonts/DejaVuSans.ttf','assets/fonts/LICENSE.txt'])assert.ok((await fs.stat(path.join(output,name))).isFile(),name);
  assert.equal(JSON.parse(await fs.readFile(path.join(output,'version.json'),'utf8')).revision,'test-commit');
  for(const name of ['.git','node_modules','tests','scripts','.superpowers','work','reference.pdf'])await assert.rejects(()=>fs.access(path.join(output,name)));
  const staged=[];
  const walk=async directory=>{for(const entry of await fs.readdir(directory,{withFileTypes:true})){const file=path.join(directory,entry.name);entry.isDirectory()?await walk(file):staged.push(path.relative(output,file));}};
  await walk(output);
  assert.equal(staged.some(name=>/\.phasei-(?:template|project)\.zip$/i.test(name)),false,'user template/project archives must never be staged');
});

test('staged first-party executable and style URLs change as a release moves',async t=>{
  const {buildSite}=await import('../scripts/build-site.mjs');
  const first=await fs.mkdtemp(path.join(os.tmpdir(),'phase-i-release-a-'));
  const second=await fs.mkdtemp(path.join(os.tmpdir(),'phase-i-release-b-'));
  t.after(()=>Promise.all([fs.rm(first,{recursive:true,force:true}),fs.rm(second,{recursive:true,force:true})]));
  await buildSite({output:first,revision:'release A/?&'});
  await buildSite({output:second,revision:'release B/?&'});
  const a=await releaseGraph(first,'release A/?&');
  const b=await releaseGraph(second,'release B/?&');
  assert.ok(a.moduleUrls.length>10,'the complete module graph must be staged and checked');
  assert.equal(a.moduleUrls.length,b.moduleUrls.length);
  for(let index=0;index<a.entries.length;index++)assert.notEqual(a.entries[index],b.entries[index]);
  for(let index=0;index<a.moduleUrls.length;index++)assert.notEqual(a.moduleUrls[index],b.moduleUrls[index]);
  const html=await fs.readFile(path.join(first,'index.html'),'utf8');
  assert.match(html,/https:\/\/unpkg\.com\/leaflet@1\.9\.4\/dist\/leaflet\.js/);
  assert.match(html,/https:\/\/cdn\.jsdelivr\.net\/npm\/jszip@3\.10\.1\/dist\/jszip\.min\.js/);
});

test('release module transform versions side-effect imports with an importable apostrophe-safe revision',async t=>{
  const {releaseModuleSource,relativeModuleSpecifiers}=await import('../scripts/build-site.mjs');
  assert.equal(typeof releaseModuleSource,'function');
  assert.equal(typeof relativeModuleSpecifiers,'function');
  const output=await fs.mkdtemp(path.join(os.tmpdir(),'phase-i-release-module-'));
  t.after(()=>fs.rm(output,{recursive:true,force:true}));
  const entry=path.join(output,'entry.mjs'),dependency=path.join(output,'dependency.mjs');
  await fs.writeFile(dependency,'globalThis.__releaseCacheSideEffect=true; export const answer=42;');
  const revision="O'Brien\uD800",expected='?v=O%27Brien%EF%BF%BD';
  const emitted=releaseModuleSource("import './dependency.mjs'; export {answer} from './dependency.mjs';",revision);
  assert.deepEqual(relativeModuleSpecifiers(emitted),[`./dependency.mjs${expected}`,`./dependency.mjs${expected}`]);
  await fs.writeFile(entry,emitted);
  const previous=globalThis.__releaseCacheSideEffect;
  t.after(()=>{if(previous===undefined)delete globalThis.__releaseCacheSideEffect;else globalThis.__releaseCacheSideEffect=previous;});
  const loaded=await import(pathToFileURL(entry).href+'?entry');
  assert.equal(loaded.answer,42);assert.equal(globalThis.__releaseCacheSideEffect,true);
});

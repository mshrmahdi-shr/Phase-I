import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {Worker} from 'node:worker_threads';

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
  await fs.mkdir(path.join(output,'vendor'),{recursive:true});
  await fs.writeFile(path.join(output,'vendor/proj4.js'),'stale browser artifact');
  await fs.writeFile(path.join(output,'vendor/proj4.umd.mjs'),'stale browser artifact');
  await fs.mkdir(path.join(output,'src'),{recursive:true});
  await fs.writeFile(path.join(output,'src/proj4-runtime.mjs'),'stale global adapter');
  await buildSite({output,revision:'test-commit'});
  assert.ok((await fs.readFile(path.join(output,'app.js'),'utf8')).length>0);
  assert.ok((await fs.stat(path.join(output,'src/geology.mjs'))).isFile());
  assert.ok((await fs.stat(path.join(output,'src/company-ui.mjs'))).isFile());
  for(const name of ['vendor/jspdf.umd.min.js','vendor/jspdf.LICENSE','vendor/geotiff.js','vendor/geotiff.LICENSE','vendor/proj4.esm.mjs','vendor/proj4.LICENSE.md','assets/fonts/DejaVuSans.ttf','assets/fonts/LICENSE.txt'])assert.ok((await fs.stat(path.join(output,name))).isFile(),name);
  assert.ok((await fs.stat(path.join(output,'vendor/geotiff.js'))).size>100_000,'the pinned self-contained browser entry is staged');
  assert.ok((await fs.stat(path.join(output,'vendor/proj4.esm.mjs'))).size>100_000,'the pinned self-contained projection browser entry is staged');
  for(const stale of ['vendor/proj4.js','vendor/proj4.umd.mjs','src/proj4-runtime.mjs'])await assert.rejects(()=>fs.access(path.join(output,stale)));
  assert.equal(JSON.parse(await fs.readFile(path.join(output,'version.json'),'utf8')).revision,'test-commit');
  assert.match(await fs.readFile(path.join(output,'src/imagery/manual-image.mjs'),'utf8'),/new URL\('\.\.\/\.\.\/vendor\/geotiff\.js\?v=test-commit'/);
  const projectionSource=await fs.readFile(path.join(output,'src/projection.mjs'),'utf8');
  const projectionRuntimeSource=await fs.readFile(path.join(output,'vendor/proj4.esm.mjs'),'utf8');
  assert.match(projectionSource,/new URL\('\.\.\/vendor\/proj4\.esm\.mjs\?v=test-commit'/);
  assert.match(projectionRuntimeSource,/const __proj4Sandbox=\{\};/);
  assert.match(projectionRuntimeSource,/export default proj4;/);
  assert.doesNotMatch(projectionRuntimeSource,/globalThis/,'the browser artifact must never access the shared global object');
  assert.doesNotMatch(projectionSource+projectionRuntimeSource,/https?:|cdn|unpkg/i,'projection runtime must load only the locally staged module');
  for(const name of ['.git','node_modules','tests','scripts','.superpowers','work','reference.pdf'])await assert.rejects(()=>fs.access(path.join(output,name)));
  const staged=[];
  const walk=async directory=>{for(const entry of await fs.readdir(directory,{withFileTypes:true})){const file=path.join(directory,entry.name);entry.isDirectory()?await walk(file):staged.push(path.relative(output,file));}};
  await walk(output);
  assert.equal(staged.some(name=>/\.phasei-(?:template|project)\.zip$/i.test(name)),false,'user template/project archives must never be staged');
  assert.equal(staged.some(name=>/pako|lerc|zstd|float16|mgrs|wkt-parser|node_modules|(?:geotiff|proj4)\.js\.map|proj4-src/i.test(name)),false,'no package tree, source map, or transitive projection/GeoTIFF dependency is staged');
});

test('proj4 browser transform requires the exact pinned wrapper, version, and source integrity',async()=>{
  const {proj4BrowserModuleSource}=await import('../scripts/build-site.mjs');
  const source=await fs.readFile(fileURLToPath(new URL('../node_modules/proj4/dist/proj4.js',import.meta.url)),'utf8');
  const emitted=proj4BrowserModuleSource(source,'2.21.0');
  assert.equal((emitted.match(/const __proj4Sandbox=/g)||[]).length,1);
  assert.equal((emitted.match(/__proj4Sandbox/g)||[]).length,3);
  assert.equal((emitted.match(/export default proj4;/g)||[]).length,1);
  assert.doesNotMatch(emitted,/globalThis/);
  assert.throws(()=>proj4BrowserModuleSource(source,'2.21.1'),/version|pin/i);
  assert.throws(()=>proj4BrowserModuleSource(source.replace('globalThis','globalThisChanged'),'2.21.0'),/wrapper|integrity/i);
  assert.throws(()=>proj4BrowserModuleSource(source+'\n','2.21.0'),/integrity/i);
});

function snapshotOwnProperty(name){
  return {present:Object.hasOwn(globalThis,name),descriptor:Object.getOwnPropertyDescriptor(globalThis,name)};
}

function restoreOwnProperty(name,snapshot){
  if(snapshot.present)Object.defineProperty(globalThis,name,snapshot.descriptor);
  else delete globalThis[name];
}

async function stagedBrowserProjection(t,revision){
  const output=await fs.mkdtemp(path.join(os.tmpdir(),'phase-i-proj4-browser-'));
  t.after(()=>fs.rm(output,{recursive:true,force:true}));
  const {buildSite}=await import('../scripts/build-site.mjs');
  await buildSite({output,revision});
  return pathToFileURL(path.join(output,'vendor/proj4.esm.mjs')).href;
}

test('distinct staged browser projection modules leave the proj4 global absent',async t=>{
  const proj4Snapshot=snapshotOwnProperty('proj4');
  t.after(()=>restoreOwnProperty('proj4',proj4Snapshot));
  delete globalThis.proj4;
  const url=await stagedBrowserProjection(t,'browser-absent');
  const [first,second]=await Promise.all([import(url+'?copy=absent-a'),import(url+'?copy=absent-b')]);
  assert.equal(typeof first.default,'function');assert.equal(first.default.version,'2.21.0');
  assert.equal(typeof second.default,'function');assert.equal(second.default.version,'2.21.0');
  assert.notEqual(first.default,second.default,'distinct module URLs must produce independent scoped exports');
  assert.equal(Object.hasOwn(globalThis,'proj4'),false);
});

test('distinct staged browser projection modules never access or mutate a changing host sentinel',async t=>{
  const proj4Snapshot=snapshotOwnProperty('proj4');
  t.after(()=>restoreOwnProperty('proj4',proj4Snapshot));
  const firstSentinel=Object.freeze({owner:'first'}),secondSentinel=Object.freeze({owner:'second'});
  let current=firstSentinel,reads=0,writes=0;
  const get=()=>{reads++;return current;},set=()=>{writes++;};
  Object.defineProperty(globalThis,'proj4',{get,set,enumerable:false,configurable:true});
  const before=Object.getOwnPropertyDescriptor(globalThis,'proj4');
  const url=await stagedBrowserProjection(t,'browser-sentinel');
  const loading=Promise.all([import(url+'?copy=sentinel-a'),import(url+'?copy=sentinel-b')]);
  current=secondSentinel;
  Object.defineProperty(globalThis,'proj4',{value:secondSentinel,writable:false,enumerable:true,configurable:true});
  const changed=Object.getOwnPropertyDescriptor(globalThis,'proj4');
  const [first,second]=await loading;
  assert.equal(typeof first.default,'function');assert.equal(typeof second.default,'function');assert.notEqual(first.default,second.default);
  assert.equal(reads,0);assert.equal(writes,0);
  assert.notDeepEqual(changed,before);assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis,'proj4'),changed);
  assert.equal(changed.value,secondSentinel);assert.equal(current,secondSentinel);
});

test('distinct staged browser projection modules ignore a non-configurable host proj4 descriptor',async t=>{
  const url=await stagedBrowserProjection(t,'browser-nonconfigurable');
  const workerSource=`
    const {parentPort,workerData}=require('node:worker_threads');
    (async()=>{
      let reads=0,writes=0;
      const sentinel=Object.freeze({owner:'worker'}),get=()=>{reads++;return sentinel;},set=()=>{writes++;};
      Object.defineProperty(globalThis,'proj4',{get,set,enumerable:false,configurable:false});
      const before=Object.getOwnPropertyDescriptor(globalThis,'proj4');
      const [first,second]=await Promise.all(workerData.urls.map(value=>import(value)));
      const after=Object.getOwnPropertyDescriptor(globalThis,'proj4');
      parentPort.postMessage({reads,writes,unchanged:before.get===after.get&&before.set===after.set&&before.configurable===after.configurable&&before.enumerable===after.enumerable,firstType:typeof first.default,secondType:typeof second.default,firstVersion:first.default.version,secondVersion:second.default.version,independent:first.default!==second.default});
    })().catch(error=>parentPort.postMessage({error:String(error?.stack||error)}));
  `;
  const worker=new Worker(workerSource,{eval:true,workerData:{urls:[url+'?copy=nonconfig-a',url+'?copy=nonconfig-b']}});
  t.after(()=>worker.terminate());
  const result=await new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject);});
  assert.equal(result.error,undefined,result.error);
  assert.deepEqual(result,{reads:0,writes:0,unchanged:true,firstType:'function',secondType:'function',firstVersion:'2.21.0',secondVersion:'2.21.0',independent:true});
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

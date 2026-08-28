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
  await fs.mkdir(path.join(output,'vendor'),{recursive:true});
  await fs.writeFile(path.join(output,'vendor/proj4.js'),'stale browser artifact');
  await buildSite({output,revision:'test-commit'});
  assert.ok((await fs.readFile(path.join(output,'app.js'),'utf8')).length>0);
  assert.ok((await fs.stat(path.join(output,'src/geology.mjs'))).isFile());
  assert.ok((await fs.stat(path.join(output,'src/company-ui.mjs'))).isFile());
  for(const name of ['vendor/jspdf.umd.min.js','vendor/jspdf.LICENSE','vendor/geotiff.js','vendor/geotiff.LICENSE','vendor/proj4.umd.mjs','vendor/proj4.LICENSE.md','assets/fonts/DejaVuSans.ttf','assets/fonts/LICENSE.txt'])assert.ok((await fs.stat(path.join(output,name))).isFile(),name);
  assert.ok((await fs.stat(path.join(output,'vendor/geotiff.js'))).size>100_000,'the pinned self-contained browser entry is staged');
  assert.ok((await fs.stat(path.join(output,'vendor/proj4.umd.mjs'))).size>100_000,'the pinned self-contained projection browser entry is staged');
  await assert.rejects(()=>fs.access(path.join(output,'vendor/proj4.js')));
  assert.equal(JSON.parse(await fs.readFile(path.join(output,'version.json'),'utf8')).revision,'test-commit');
  assert.match(await fs.readFile(path.join(output,'src/imagery/manual-image.mjs'),'utf8'),/new URL\('\.\.\/\.\.\/vendor\/geotiff\.js\?v=test-commit'/);
  const projectionSource=await fs.readFile(path.join(output,'src/projection.mjs'),'utf8');
  const projectionRuntimeSource=await fs.readFile(path.join(output,'src/proj4-runtime.mjs'),'utf8');
  assert.match(projectionSource,/from '\.\/proj4-runtime\.mjs\?v=test-commit'/);
  assert.match(projectionRuntimeSource,/new URL\('\.\.\/vendor\/proj4\.umd\.mjs\?v=test-commit'/);
  assert.doesNotMatch(projectionSource+projectionRuntimeSource,/https?:|cdn|unpkg/i,'projection runtime must load only the locally staged module');
  for(const name of ['.git','node_modules','tests','scripts','.superpowers','work','reference.pdf'])await assert.rejects(()=>fs.access(path.join(output,name)));
  const staged=[];
  const walk=async directory=>{for(const entry of await fs.readdir(directory,{withFileTypes:true})){const file=path.join(directory,entry.name);entry.isDirectory()?await walk(file):staged.push(path.relative(output,file));}};
  await walk(output);
  assert.equal(staged.some(name=>/\.phasei-(?:template|project)\.zip$/i.test(name)),false,'user template/project archives must never be staged');
  assert.equal(staged.some(name=>/pako|lerc|zstd|float16|mgrs|wkt-parser|node_modules|(?:geotiff|proj4)\.js\.map|proj4-src/i.test(name)),false,'no package tree, source map, or transitive projection/GeoTIFF dependency is staged');
});

function snapshotOwnProperty(name){
  return {present:Object.hasOwn(globalThis,name),descriptor:Object.getOwnPropertyDescriptor(globalThis,name)};
}

function restoreOwnProperty(name,snapshot){
  if(snapshot.present)Object.defineProperty(globalThis,name,snapshot.descriptor);
  else delete globalThis[name];
}

async function importStagedBrowserProjection(t,revision){
  const output=await fs.mkdtemp(path.join(os.tmpdir(),'phase-i-proj4-browser-'));
  t.after(()=>fs.rm(output,{recursive:true,force:true}));
  const {buildSite}=await import('../scripts/build-site.mjs');
  await buildSite({output,revision});
  return import(pathToFileURL(path.join(output,'src/proj4-runtime.mjs')).href);
}

test('staged browser projection runtime removes the temporary proj4 global when none existed',async t=>{
  const windowSnapshot=snapshotOwnProperty('window'),proj4Snapshot=snapshotOwnProperty('proj4');
  t.after(()=>{restoreOwnProperty('window',windowSnapshot);restoreOwnProperty('proj4',proj4Snapshot);});
  Object.defineProperty(globalThis,'window',{value:globalThis,writable:true,configurable:true});
  delete globalThis.proj4;
  const loaded=await importStagedBrowserProjection(t,'browser-absent');
  assert.equal(typeof loaded.default,'function');
  assert.equal(Object.hasOwn(globalThis,'proj4'),false);
});

test('staged browser projection runtime restores a pre-existing proj4 global descriptor',async t=>{
  const windowSnapshot=snapshotOwnProperty('window'),proj4Snapshot=snapshotOwnProperty('proj4');
  t.after(()=>{restoreOwnProperty('window',windowSnapshot);restoreOwnProperty('proj4',proj4Snapshot);});
  const sentinel=Object.freeze({owner:'host'});
  Object.defineProperty(globalThis,'window',{value:globalThis,writable:true,configurable:true});
  Object.defineProperty(globalThis,'proj4',{value:sentinel,writable:false,enumerable:false,configurable:true});
  const before=Object.getOwnPropertyDescriptor(globalThis,'proj4');
  const loaded=await importStagedBrowserProjection(t,'browser-sentinel');
  assert.equal(typeof loaded.default,'function');
  assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis,'proj4'),before);
  assert.equal(globalThis.proj4,sentinel);
});

test('staged browser projection runtime is safe across concurrent and cached module imports',async t=>{
  const windowSnapshot=snapshotOwnProperty('window'),proj4Snapshot=snapshotOwnProperty('proj4');
  t.after(()=>{restoreOwnProperty('window',windowSnapshot);restoreOwnProperty('proj4',proj4Snapshot);});
  const sentinel=Object.freeze({owner:'first'});
  Object.defineProperty(globalThis,'window',{value:globalThis,writable:true,configurable:true});
  Object.defineProperty(globalThis,'proj4',{value:sentinel,writable:true,enumerable:true,configurable:true});
  const output=await fs.mkdtemp(path.join(os.tmpdir(),'phase-i-proj4-cache-'));
  t.after(()=>fs.rm(output,{recursive:true,force:true}));
  const {buildSite}=await import('../scripts/build-site.mjs');
  await buildSite({output,revision:'browser-cache'});
  const url=pathToFileURL(path.join(output,'src/proj4-runtime.mjs')).href;
  const [first,second]=await Promise.all([import(url),import(url)]);
  assert.equal(first,second);assert.equal(first.default,second.default);assert.equal(globalThis.proj4,sentinel);
  const laterSentinel=Object.freeze({owner:'later'});globalThis.proj4=laterSentinel;
  const cached=await import(url);
  assert.equal(cached,first);assert.equal(cached.default,first.default);assert.equal(globalThis.proj4,laterSentinel);
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

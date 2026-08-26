import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {JSDOM} from 'jsdom';
import JSZip from 'jszip';
import {siteFeature} from '../src/geology.mjs';
import {loadBedrockCache, resolveBedrockSourceUrl} from '../src/bedrock-cache.mjs';
import {buildBedrockCache} from '../scripts/cache-mrd126.mjs';

globalThis.DOMParser = new JSDOM('').window.DOMParser;
const root = 'https://www.geologyontario.mndm.gov.on.ca/mines/data/google/MRD126/files/paleo/';
const baseUrl = 'https://example.test/Phase-I/mrd126-cache/';
const bounds = {west:-79.4,south:43.6,east:-79.3,north:43.7};
const tileBounds = {west:-80,south:43,east:-79,north:44};
const feature = {name:'55b', description:'Synthetic unit', unitCode:'55b', official:null,
  polygon:[[-80,43],[-79,43],[-79,44],[-80,44],[-80,43]], holes:[],color:'#00b4cc',fillOpacity:0.6};
const entry = (n, b = tileBounds) => ({path:`files/${n}.json`,bounds:b,featureCount:1});
const manifest = (files = [entry('a'),entry('b')]) => ({version:1,source:'MRD126-REV1',cachedAt:'2026-08-26T00:00:00.000Z',complete:true,
  counts:{expected:files.length,saved:files.length,failed:0,pending:0},files});
const json = value => new Response(JSON.stringify(value), {headers:{'content-type':'application/json'}});
const tile = (code='55b',hole='') => `<kml><Placemark><name>${code}</name><Polygon><outerBoundaryIs><LinearRing><coordinates>-80,43 -79,43 -79,44 -80,44 -80,43</coordinates></LinearRing></outerBoundaryIs>${hole}</Polygon></Placemark></kml>`;
const link = href => `<NetworkLink><Region><LatLonAltBox><west>-80</west><south>43.5</south><east>-79.5</east><north>44</north></LatLonAltBox></Region><Link><href>${href}</href></Link></NetworkLink>`;
const index = `<kml>${link('files/a.kmz')}${link('files/b.kmz')}</kml>`;
async function temporary(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'phase-i-bedrock-'));
  t.after(() => fs.rm(dir,{recursive:true,force:true}));
  return dir;
}

test('browser cache loads all geometry-bounds intersections, including SITE beyond nominal Region', async () => {
  const files = [entry('a'),entry('b'),entry('far',{west:1,south:1,east:2,north:2})];
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push(url);
    assert.equal(options.redirect, 'error');
    if (url === baseUrl+'manifest.json') return json(manifest(files));
    if (url === baseUrl+'files/a.json') return json({features:[feature]});
    if (url === baseUrl+'files/b.json') return json({features:[{...feature,unitCode:'55a'}]});
    throw Error('Outside selected cache: '+url);
  };
  const result = await loadBedrockCache(bounds,{baseUrl,fetchImpl});
  assert.equal(result.features.length,2);
  assert.equal(siteFeature(result.features,{lat:43.65,lng:-79.38}).unitCode,'55b');
  assert.deepEqual(result.coverage,bounds);
  assert.equal(result.docs,2);
  assert.equal(result.source.id,'MRD126-REV1');
  assert.equal(requests.length,3);
});

test('browser refuses incomplete manifests and inconsistent file counts', async () => {
  for (const m of [ {...manifest(),complete:false}, {...manifest(),counts:{expected:3,saved:2,failed:0,pending:1}},
    {...manifest(),source:'custom'}, {...manifest(),files:[entry('a'),entry('a')]} ]) {
    await assert.rejects(loadBedrockCache(bounds,{baseUrl,fetchImpl:async()=>json(m)}), /manifest|incomplete|duplicate/i);
  }
});

test('manifest traversal, remote URLs, encoded escapes and cross-origin cache roots are refused', async () => {
  for (const p of ['../outside.json','files/../../outside.json','https://evil.test/a.json','//evil.test/a.json','files/%2e%2e/a.json','files\\a.json','files/a.json?x=1']) {
    const m=manifest([{...entry('a'),path:p}]);
    await assert.rejects(loadBedrockCache(bounds,{baseUrl,fetchImpl:async()=>json(m)}), /path|cache|manifest/i);
  }
  const previous=globalThis.location;
  globalThis.location={href:'https://example.test/Phase-I/index.html'};
  try { await assert.rejects(loadBedrockCache(bounds,{baseUrl:'https://evil.test/cache/',fetchImpl:async()=>{throw Error('Should not fetch');}}), /origin|local/i); }
  finally { if(previous)globalThis.location=previous;else delete globalThis.location; }
});

test('browser rejects missing selected files or corrupt geometry, without returning partial coverage', async () => {
  await assert.rejects(loadBedrockCache(bounds,{baseUrl,fetchImpl:async url=>url.endsWith('manifest.json')?json(manifest()):new Response('',{status:404})}), /404/);
  await assert.rejects(loadBedrockCache(bounds,{baseUrl,fetchImpl:async url=>url.endsWith('manifest.json')?json(manifest([entry('a')])):json({features:[{...feature,polygon:[[0,0]]}]})}), /geometry|boundary|polygon/i);
});

test('no intersecting cache tiles returns empty SITE coverage', async () => {
  const result=await loadBedrockCache({west:1,south:1,east:2,north:2},{baseUrl,fetchImpl:async()=>json(manifest())});
  assert.deepEqual(result.features,[]);
  assert.equal(result.docs,0);
});

test('browser aborts active tile fetches and never starts queued tiles after cancellation', async () => {
  const controller=new AbortController(); let active=0,started=0;
  let tileStarted;const ready=new Promise(resolve=>{tileStarted=resolve;});
  const fetchImpl=async (url,{signal})=> {
    if(url.endsWith('manifest.json'))return json(manifest(Array.from({length:12},(_,i)=>entry(i))));
    active++;started++;tileStarted();
    return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{active--;reject(signal.reason);},{once:true}));
  };
  const result=loadBedrockCache(bounds,{baseUrl,fetchImpl,signal:controller.signal});
  await ready;
  controller.abort();
  await assert.rejects(result,{name:'AbortError'});
  assert.equal(active,0);
  assert.ok(started>0 && started<=4,'bounded tile concurrency');
  let fetched=false;
  await assert.rejects(loadBedrockCache(bounds,{baseUrl,signal:controller.signal,fetchImpl:async()=>{fetched=true;}}),{name:'AbortError'});
  assert.equal(fetched,false);
});

test('official source traversal stays inside the supplied With Lowlands polygon branch', () => {
  assert.equal(resolveBedrockSourceUrl('files/a.kmz',root+'doc.kml'),root+'files/a.kmz');
  assert.equal(resolveBedrockSourceUrl(root.replace('https:','http:')+'doc.kml'),root+'doc.kml');
  for(const href of ['../no_paleo/doc.kml','../../Dikes.kmz','files/../a.kmz','files/%2e%2e/a.kmz','https://evil.test/a.kmz','//evil.test/a.kmz','files/a.kmz?x=1']) {
    assert.throws(()=>resolveBedrockSourceUrl(href,root+'doc.kml'),/source|branch|path|URL/i);
  }
});

test('builder writes a complete true-bounds cache and retains full polygons and holes', async t => {
  const outputDir=await temporary(t);
  const hole='<innerBoundaryIs><LinearRing><coordinates>-79.9,43.1 -79.8,43.1 -79.8,43.2 -79.9,43.2 -79.9,43.1</coordinates></LinearRing></innerBoundaryIs>';
  const kmz=await new JSZip().file('doc.kml',tile('55b',hole)).generateAsync({type:'uint8array'});
  const fetchImpl=async url=>url===root+'doc.kml'?new Response(index):new Response(kmz);
  const m=await buildBedrockCache({outputDir,fetchImpl,expectedFiles:2});
  assert.equal(m.complete,true);
  assert.equal(m.counts.saved,2);
  assert.deepEqual(m.files[0].bounds,tileBounds);
  const cached=JSON.parse(await fs.readFile(path.join(outputDir,m.files[0].path),'utf8'));
  assert.deepEqual(cached.features[0].polygon,feature.polygon);
  assert.equal(cached.features[0].holes[0].length,5);
  assert.equal(siteFeature(cached.features,{lat:43.65,lng:-79.38}).unitCode,'55b');
  const onDisk=JSON.parse(await fs.readFile(path.join(outputDir,'manifest.json'),'utf8'));
  assert.equal(onDisk.complete,true);
  assert.ok(onDisk.totalBytes>0);
});

test('builder retries transient requests and refuses partial builds, bad indexes and excessive output', async t => {
  const dir=await temporary(t);let tries=0;
  const kmz=await new JSZip().file('doc.kml',tile()).generateAsync({type:'uint8array'});
  const m=await buildBedrockCache({outputDir:path.join(dir,'retry'),expectedFiles:2,retryDelayMs:0,fetchImpl:async url=>{
    if(url===root+'doc.kml')return new Response(index);
    if(url.endsWith('a.kmz') && ++tries===1)return new Response('',{status:503});
    return new Response(kmz);
  }});
  assert.equal(m.complete,true);assert.equal(tries,2);
  const partial=path.join(dir,'partial');let failures=0;
  await assert.rejects(buildBedrockCache({outputDir:partial,expectedFiles:2,retryDelayMs:0,fetchImpl:async url=>{
    if(url===root+'doc.kml')return new Response(index);
    failures++;return new Response('',{status:503});
  }}),/503|Incomplete/);
  assert.ok(failures<=6,'at most three attempts per file');
  const partialManifest=JSON.parse(await fs.readFile(path.join(partial,'manifest.json'),'utf8'));
  assert.equal(partialManifest.complete,false);
  await assert.rejects(buildBedrockCache({outputDir:path.join(dir,'bad'),expectedFiles:3,fetchImpl:async()=>new Response(index)}), /count|expected|index/i);
  await assert.rejects(buildBedrockCache({outputDir:path.join(dir,'large'),expectedFiles:2,maxBytes:10,fetchImpl:async url=>url===root+'doc.kml'?new Response(index):new Response(kmz)}),/byte|limit/i);
});

test('builder confines concurrency and cancellation leaves an incomplete manifest', async t => {
  const outputDir=await temporary(t),controller=new AbortController();let active=0,started=0;
  let tileStarted;const ready=new Promise(resolve=>{tileStarted=resolve;});
  const result=buildBedrockCache({outputDir,expectedFiles:12,signal:controller.signal,fetchImpl:async (url,{signal})=>{
    if(url===root+'doc.kml')return new Response(`<kml>${Array.from({length:12},(_,i)=>link(`files/${i}.kmz`)).join('')}</kml>`);
    active++;started++;tileStarted();
    return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{active--;reject(signal.reason);},{once:true}));
  }});
  await ready;
  controller.abort();
  await assert.rejects(result,{name:'AbortError'});
  assert.equal(active,0);
  assert.ok(started>0 && started<=4);
  assert.equal(JSON.parse(await fs.readFile(path.join(outputDir,'manifest.json'),'utf8')).complete,false);
});

test('builder rejects nested polygon links and remote redirects without publishing complete cache',async t=>{
  const dir=await temporary(t);
  const nested=await new JSZip().file('doc.kml',`<kml>${link('other.kmz')}</kml>`).generateAsync({type:'uint8array'});
  await assert.rejects(buildBedrockCache({outputDir:path.join(dir,'nested'),expectedFiles:2,fetchImpl:async url=>url===root+'doc.kml'?new Response(index):new Response(nested)}),/nested link/);
  await assert.rejects(buildBedrockCache({outputDir:path.join(dir,'redirect'),expectedFiles:2,retryDelayMs:0,fetchImpl:async()=>{
    const response=new Response(index);Object.defineProperty(response,'url',{value:'https://evil.test/index.kml'});return response;
  }}),/redirect/i);
});

test('builder checks ZIP declared expansion size before attempting decompression',async t=>{
  const outputDir=await temporary(t);
  const zip=await new JSZip().file('doc.kml',tile()).generateAsync({type:'nodebuffer',compression:'DEFLATE'});
  // ZIP central-directory uncompressed size: synthetic bomb metadata, no large
  // allocation or compression needed in the test itself.
  const central=zip.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));
  zip.writeUInt32LE(129*1024*1024,central+24);
  await assert.rejects(buildBedrockCache({outputDir,expectedFiles:2,fetchImpl:async url=>
    url===root+'doc.kml'?new Response(index):new Response(zip)}),/KML byte limit/);
});

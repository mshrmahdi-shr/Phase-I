import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import {fetchWmsCapabilitiesXml,wmsAllLayerDescriptors,wmsGetMapUrl} from '../src/imagery/wms-client.mjs';
import {validateImageryProvider,validateImageryResult} from '../src/imagery/provider-registry.mjs';
import {NAPL_IMAGERY_PROVIDER,naplCapabilitiesUrl,NAPL_GETMAP_SERVICE} from '../src/imagery/providers/napl.mjs';

const DOMParserClass=new JSDOM('').window.DOMParser;
const domParserImpl=(value,type)=>new DOMParserClass().parseFromString(value,type);
const REGINA=Object.freeze({lat:50.46,lng:-104.6});
const HALIFAX=Object.freeze({lat:44.65,lng:-63.6});
const OUTSIDE_CANADA=Object.freeze({lat:40.71,lng:-74.0});
const capabilitiesXml=await readFile(new URL('./fixtures/imagery/napl-capabilities-all.xml',import.meta.url),'utf8');

function xmlResponse(body,url,{status=200,type='text/xml'}={}){
  const bytes=new TextEncoder().encode(body);
  return {
    ok:status>=200&&status<300,status,url,
    headers:{get(name){if(name.toLowerCase()==='content-type')return type;if(name.toLowerCase()==='content-length')return String(bytes.byteLength);return null;}},
    body:new ReadableStream({start(controller){controller.enqueue(bytes);controller.close();}})
  };
}

function fixedFetch(body,{type}={}){return async(url)=>xmlResponse(body,url,{type});}

test('NAPL_IMAGERY_PROVIDER is a validated provider with a national coverage envelope',()=>{
  assert.equal(validateImageryProvider(NAPL_IMAGERY_PROVIDER),NAPL_IMAGERY_PROVIDER);
  assert.equal(NAPL_IMAGERY_PROVIDER.covers(REGINA),true);
  assert.equal(NAPL_IMAGERY_PROVIDER.covers(OUTSIDE_CANADA),false);
});

test('wmsAllLayerDescriptors auto-discovers every published region from one combined capabilities document, skipping the folder wrapper',()=>{
  const doc=domParserImpl(capabilitiesXml,'application/xml');
  const layers=wmsAllLayerDescriptors(doc);
  const names=layers.map(layer=>layer.name).sort();
  assert.deepEqual(names,['halifax','markham','ontario-ring-of-fire','ottawa','regina','salish','tuktoyaktuk','victoria']);
  const regina=layers.find(layer=>layer.name==='regina');
  assert.deepEqual(regina.times.map(value=>value.year),[1947,1967]);
  assert.match(regina.title,/Regina/);
  assert.ok(regina.coverage.west<regina.coverage.east&&regina.coverage.south<regina.coverage.north);
  const ringOfFire=layers.find(layer=>layer.name==='ontario-ring-of-fire');
  assert.deepEqual(ringOfFire.times.map(value=>value.year),[1954,1973,1974,1975,1976]);
});

test('NAPL search returns one exportable, validated result per acquisition year for every region covering the SITE',async()=>{
  const results=await NAPL_IMAGERY_PROVIDER.search({location:REGINA,fetchImpl:fixedFetch(capabilitiesXml),domParserImpl});
  assert.deepEqual(results.map(result=>result.id).sort(),['regina-1947','regina-1967']);
  for(const result of results){
    validateImageryResult({...result,id:`napl:${result.id}`},NAPL_IMAGERY_PROVIDER);
    assert.equal(result.policy,'exportable');assert.equal(result.export.kind,'wms-export');
    const url=new URL(result.export.url);
    assert.equal(url.origin+url.pathname,NAPL_GETMAP_SERVICE);assert.equal(url.searchParams.get('LAYERS'),'regina');
    assert.ok(['1947-07-01T12:00:00Z','1967-07-01T12:00:00Z'].includes(url.searchParams.get('TIME')));
  }
});

test('NAPL search only returns regions whose published bounding box actually contains the SITE',async()=>{
  const results=await NAPL_IMAGERY_PROVIDER.search({location:HALIFAX,fetchImpl:fixedFetch(capabilitiesXml),domParserImpl});
  assert.deepEqual(results.map(result=>result.id).sort(),['halifax-1947','halifax-1977']);
});

test('NAPL search skips the capabilities fetch entirely for a location outside the national envelope',async()=>{
  let calls=0;
  const results=await NAPL_IMAGERY_PROVIDER.search({location:OUTSIDE_CANADA,fetchImpl:async(...args)=>{calls++;return fixedFetch(capabilitiesXml)(...args);},domParserImpl});
  assert.equal(results.length,0);assert.equal(calls,0);
});

test('fetchWmsCapabilitiesXml enforces https origin allowlisting, content-type, and size limits',async()=>{
  const options={allowedOrigins:['https://datacube.services.geo.ca'],allowedRoots:['https://datacube.services.geo.ca/web/'],domParserImpl};
  await assert.rejects(fetchWmsCapabilitiesXml('https://evil.example/web/aerial.xml?request=GetCapabilities&service=WMS&version=1.3.0',{...options,fetchImpl:fixedFetch(capabilitiesXml)}),/official provider|origin/);
  await assert.rejects(fetchWmsCapabilitiesXml(naplCapabilitiesUrl,{...options,fetchImpl:fixedFetch(capabilitiesXml,{type:'text/html'})}),/content-type/);
  await assert.rejects(fetchWmsCapabilitiesXml(naplCapabilitiesUrl,{...options,fetchImpl:fixedFetch('x'.repeat(3_000_000))}),/size limit/);
  const doc=await fetchWmsCapabilitiesXml(naplCapabilitiesUrl,{...options,fetchImpl:fixedFetch(capabilitiesXml)});
  assert.equal(wmsAllLayerDescriptors(doc).length,8);
});

test('wmsGetMapUrl requires exactly LAYERS and TIME on the service URL and enforces safe export dimensions',()=>{
  const base='https://datacube.services.geo.ca/ows/aerial?LAYERS=regina&TIME=1947-07-01T12%3A00%3A00Z';
  const bounds={west:-104.7,south:50.4,east:-104.6,north:50.5};
  const url=new URL(wmsGetMapUrl({serviceUrl:base,bounds,width:512,height:384}));
  assert.equal(url.searchParams.get('SERVICE'),'WMS');assert.equal(url.searchParams.get('REQUEST'),'GetMap');
  assert.equal(url.searchParams.get('LAYERS'),'regina');assert.equal(url.searchParams.get('TIME'),'1947-07-01T12:00:00Z');
  assert.equal(url.searchParams.get('CRS'),'EPSG:3857');assert.equal(url.searchParams.get('WIDTH'),'512');assert.equal(url.searchParams.get('HEIGHT'),'384');
  assert.throws(()=>wmsGetMapUrl({serviceUrl:'https://datacube.services.geo.ca/ows/aerial?LAYERS=regina',bounds,width:1,height:1}),/TIME/);
  assert.throws(()=>wmsGetMapUrl({serviceUrl:base+'&EXTRA=1',bounds,width:1,height:1}),/only preset LAYERS and TIME/);
  assert.throws(()=>wmsGetMapUrl({serviceUrl:base,bounds,width:5000,height:1}),/exceed/);
});

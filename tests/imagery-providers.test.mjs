import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fetchArcGisJson,arcGisExportUrl} from '../src/imagery/arcgis-client.mjs';
import {validateImageryProvider,validateImageryResult} from '../src/imagery/provider-registry.mjs';
import {ONTARIO_IMAGERY_PROVIDER} from '../src/imagery/providers/ontario.mjs';
import {TORONTO_IMAGERY_PROVIDER} from '../src/imagery/providers/toronto.mjs';
import {OTTAWA_IMAGERY_PROVIDER} from '../src/imagery/providers/ottawa.mjs';

const fixture=async name=>JSON.parse(await readFile(new URL(`./fixtures/imagery/${name}`,import.meta.url),'utf8'));
const [mapService,torontoDirectory,ottawaDirectory,ontarioSource]=await Promise.all([
  fixture('map-service.json'),fixture('toronto-directory.json'),fixture('ottawa-directory.json'),fixture('ontario-source.json')
]);

function jsonResponse(value,url,{status=200,type='application/json',contentLength}={}){
  const body=typeof value==='string'?value:JSON.stringify(value);
  const bytes=new TextEncoder().encode(body);
  return {
    ok:status>=200&&status<300,status,url,
    headers:{get(name){
      if(name.toLowerCase()==='content-type')return type;
      if(name.toLowerCase()==='content-length')return contentLength===undefined?String(bytes.byteLength):String(contentLength);
      return null;
    }},
    body:new ReadableStream({start(controller){controller.enqueue(bytes);controller.close();}}),
    text:async()=>body
  };
}

function readerBody(chunks,hooks={}){
  let index=0;
  return {getReader(){return {
    async read(){hooks.reads=(hooks.reads??0)+1;return index<chunks.length?{done:false,value:chunks[index++]}:{done:true,value:undefined};},
    async cancel(reason){hooks.cancels=(hooks.cancels??0)+1;hooks.cancelReason=reason;},
    releaseLock(){hooks.releases=(hooks.releases??0)+1;}
  };}};
}

function routedFetch(routes,calls=[]){
  return async(input,init)=>{
    const url=new URL(input);
    calls.push({url,init});
    assert.equal(url.searchParams.get('f'),'json');
    const route=routes.get(url.pathname);
    if(route===undefined)throw Error(`Unexpected fixture request: ${url.pathname}`);
    return jsonResponse(typeof route==='function'?route(url):route,url.href);
  };
}

function providerRoutes(root,directory){
  const routes=new Map([[new URL(root).pathname,{services:directory.services}]]);
  for(const service of directory.services){
    if(service.type!=='MapServer')continue;
    const leaf=service.name.startsWith('basemap/')?service.name.slice('basemap/'.length):service.name;
    const url=new URL(`${leaf}/MapServer`,root);
    routes.set(url.pathname,{...mapService,...(directory.metadata[service.name]??{})});
  }
  return routes;
}

test('official providers expose validated jurisdiction coverage and exact ArcGIS roots',()=>{
  for(const provider of [ONTARIO_IMAGERY_PROVIDER,TORONTO_IMAGERY_PROVIDER,OTTAWA_IMAGERY_PROVIDER]){
    assert.equal(validateImageryProvider(provider),provider);
  }
  assert.equal(ONTARIO_IMAGERY_PROVIDER.allowedRoots[0],'https://ws.lioservices.lrc.gov.on.ca/arcgis2/rest/services/LIO_Imagery/');
  assert.equal(TORONTO_IMAGERY_PROVIDER.allowedRoots[0],'https://gis.toronto.ca/arcgis/rest/services/basemap/');
  assert.equal(OTTAWA_IMAGERY_PROVIDER.allowedRoots[0],'https://maps.ottawa.ca/arcgis/rest/services/');
  assert.equal(TORONTO_IMAGERY_PROVIDER.covers({lat:43.65,lng:-79.38}),true);
  assert.equal(TORONTO_IMAGERY_PROVIDER.covers({lat:45.42,lng:-75.69}),false);
  assert.equal(OTTAWA_IMAGERY_PROVIDER.covers({lat:45.42,lng:-75.69}),true);
  assert.equal(ONTARIO_IMAGERY_PROVIDER.covers({lat:43.65,lng:-79.38}),true);
});

test('safe ArcGIS JSON fetch forces f=json and omits credentials',async()=>{
  const root='https://gis.toronto.ca/arcgis/rest/services/basemap/';
  let request;
  const value=await fetchArcGisJson(`${root}?f=html`,{
    allowedOrigins:['https://gis.toronto.ca'],allowedRoots:[root],
    fetchImpl:async(url,init)=>{request={url:new URL(url),init};return jsonResponse({services:[]},url);}
  });
  assert.deepEqual(value,{services:[]});
  assert.equal(request.url.search,'?f=json');
  assert.equal(request.init.credentials,'omit');
  assert.ok(request.init.signal instanceof AbortSignal);
});

test('safe ArcGIS JSON fetch confines requests and redirect targets to normalized roots',async()=>{
  const root='https://gis.toronto.ca/arcgis/rest/services/basemap/';
  const options={allowedOrigins:['https://gis.toronto.ca'],allowedRoots:[root],fetchImpl:async url=>jsonResponse({},url)};
  for(const url of [
    'https://evil.example/arcgis/rest/services/basemap/',
    'https://user:pass@gis.toronto.ca/arcgis/rest/services/basemap/',
    'https://gis.toronto.ca/arcgis/rest/services/basemap/../private/',
    'https://gis.toronto.ca/arcgis/rest/services/basemap/%252e%252e/private/',
    'https://gis.toronto.ca/arcgis/rest/services/basemap/?token=secret',
    'https://gis.toronto.ca/arcgis/rest/services/basemap/?callback=steal',
    'https://gis.toronto.ca/arcgis/rest/services/basemap/?f=json&%66=pjson',
    'https://gis.toronto.ca/arcgis/rest/services/basemap/#fragment',
    '//gis.toronto.ca/arcgis/rest/services/basemap/'
  ]) await assert.rejects(fetchArcGisJson(url,options),/official|origin|root|credential|traversal|query|parameter|fragment|absolute|path/i);

  await assert.rejects(fetchArcGisJson(root,{
    ...options,fetchImpl:async url=>jsonResponse({},'https://evil.example/arcgis/rest/services/basemap/?f=json')
  }),/redirect|official|origin|root/i);
  await assert.rejects(fetchArcGisJson(root,{
    ...options,fetchImpl:async url=>jsonResponse({},`${root}?f=pjson`)
  }),/redirect|preserve|f=json/i);
  await assert.rejects(fetchArcGisJson(root,{
    ...options,fetchImpl:async url=>({...jsonResponse({},url),url:undefined})
  }),/redirect|final|response|URL/i);
  await assert.rejects(fetchArcGisJson(`${root}nested//`,{
    allowedOrigins:['https://gis.toronto.ca'],allowedRoots:[`${root}nested//`],fetchImpl:async url=>jsonResponse({},url)
  }),/normalized|root|path/i);
});

test('safe ArcGIS JSON fetch rejects bad status, content, size, JSONP and ArcGIS errors',async()=>{
  const root='https://maps.ottawa.ca/arcgis/rest/services/';
  const base={allowedOrigins:['https://maps.ottawa.ca'],allowedRoots:[root]};
  const reject=async(response,pattern)=>assert.rejects(fetchArcGisJson(root,{...base,fetchImpl:async()=>response}),pattern);
  await reject(jsonResponse({},`${root}?f=json`,{status:503}),/503|status/i);
  await reject(jsonResponse('<html></html>',`${root}?f=json`,{type:'text/html'}),/content.?type|JSON/i);
  await reject(jsonResponse('{}',`${root}?f=json`,{contentLength:1_048_577}),/size|large|limit/i);
  await reject(jsonResponse('callback({"ok":true})',`${root}?f=json`,{type:'application/javascript'}),/JSONP|content.?type|JSON/i);
  await reject(jsonResponse('{broken',`${root}?f=json`),/malformed|JSON/i);
  await reject(jsonResponse({error:{code:499,message:'Token Required'}},`${root}?f=json`),/499|Token Required|ArcGIS/i);
});

test('safe ArcGIS JSON fetch stops oversized streams with missing or false lengths before reading remaining chunks',async()=>{
  const root='https://maps.ottawa.ca/arcgis/rest/services/';
  for(const declaredLength of [null,2]){
    const hooks={textCalls:0};
    const chunks=[new Uint8Array(700_000),new Uint8Array(400_000),new TextEncoder().encode('{}')];
    const base=jsonResponse({},`${root}?f=json`,{contentLength:2});
    const response={
      ...base,
      headers:{get:name=>name.toLowerCase()==='content-length'?declaredLength:base.headers.get(name)},
      body:readerBody(chunks,hooks),
      text:async()=>{hooks.textCalls++;return ' '.repeat(1_100_000);}
    };
    await assert.rejects(fetchArcGisJson(root,{
      allowedOrigins:['https://maps.ottawa.ca'],allowedRoots:[root],fetchImpl:async()=>response
    }),/size|large|limit|1048576/i);
    assert.equal(hooks.reads,2,'the unread third chunk must not be pulled');
    assert.equal(hooks.textCalls,0,'streaming bodies must not be buffered through text()');
    assert.equal(hooks.cancels,1);
    assert.equal(hooks.releases,1);
  }
});

test('safe ArcGIS JSON fetch preserves split UTF-8 boundaries and releases malformed byte, chunk and JSON streams',async()=>{
  const root='https://maps.ottawa.ca/arcgis/rest/services/';
  const base={allowedOrigins:['https://maps.ottawa.ca'],allowedRoots:[root]};
  const bytes=new TextEncoder().encode('{"label":"é😀"}');
  const chunks=Array.from(bytes,value=>Uint8Array.of(value));
  const splitHooks={};
  const split={...jsonResponse({},`${root}?f=json`),body:readerBody(chunks,splitHooks),text:async()=>{throw Error('text() must not be called');}};
  assert.deepEqual(await fetchArcGisJson(root,{...base,fetchImpl:async()=>split}),{label:'é😀'});
  assert.equal(splitHooks.releases,1);
  assert.equal(splitHooks.cancels,undefined);

  const malformedHooks={};
  const malformed={...jsonResponse({},`${root}?f=json`),body:readerBody([Uint8Array.of(0xc3,0x28)],malformedHooks)};
  await assert.rejects(fetchArcGisJson(root,{...base,fetchImpl:async()=>malformed}),/UTF-8|encoding|JSON/i);
  assert.equal(malformedHooks.cancels,1);
  assert.equal(malformedHooks.releases,1);

  const wrongTypeHooks={};
  const wrongType={...jsonResponse({},`${root}?f=json`),body:readerBody(['{}'],wrongTypeHooks)};
  await assert.rejects(fetchArcGisJson(root,{...base,fetchImpl:async()=>wrongType}),/chunk|Uint8Array|byte/i);
  assert.equal(wrongTypeHooks.cancels,1);
  assert.equal(wrongTypeHooks.releases,1);

  const jsonHooks={};
  const malformedJson={...jsonResponse({},`${root}?f=json`),body:readerBody([new TextEncoder().encode('{broken')],jsonHooks)};
  await assert.rejects(fetchArcGisJson(root,{...base,fetchImpl:async()=>malformedJson}),/malformed|JSON/i);
  assert.equal(jsonHooks.cancels,undefined);
  assert.equal(jsonHooks.releases,1);
});

test('safe ArcGIS JSON fetch fails closed when response body streaming is unavailable',async()=>{
  const root='https://maps.ottawa.ca/arcgis/rest/services/';
  let textCalls=0;
  const response={...jsonResponse({},`${root}?f=json`),body:null,text:async()=>{textCalls++;return '{}';}};
  await assert.rejects(fetchArcGisJson(root,{
    allowedOrigins:['https://maps.ottawa.ca'],allowedRoots:[root],fetchImpl:async()=>response
  }),/stream|body|unavailable/i);
  assert.equal(textCalls,0);
});

test('safe ArcGIS JSON fetch aborts promptly while a response body is still pending',async()=>{
  const root='https://maps.ottawa.ca/arcgis/rest/services/';
  const controller=new AbortController();
  const hooks={};
  let releaseRead;
  const body={getReader(){return {
    read(){hooks.reads=(hooks.reads??0)+1;return new Promise(resolve=>{releaseRead=resolve;});},
    cancel(){hooks.cancels=(hooks.cancels??0)+1;releaseRead?.({done:true});},
    releaseLock(){hooks.releases=(hooks.releases??0)+1;}
  };}};
  const pending=fetchArcGisJson(root,{
    signal:controller.signal,allowedOrigins:['https://maps.ottawa.ca'],allowedRoots:[root],
    fetchImpl:async url=>({...jsonResponse({},url),body,text:async()=>{throw Error('text() must not be called');}})
  });
  await new Promise(resolve=>setTimeout(resolve,0));
  controller.abort();
  const outcome=await Promise.race([
    pending.then(()=> 'resolved',error=>error.name),
    new Promise(resolve=>setTimeout(()=>resolve('still-pending'),50))
  ]);
  await pending.catch(()=>{});
  assert.equal(outcome,'AbortError');
  assert.equal(hooks.cancels,1);
  assert.equal(hooks.releases,1);
});

test('ArcGIS export URL projects normalized geographic bounds to EPSG:3857 and enforces limits',()=>{
  const url=new URL(arcGisExportUrl({
    serviceUrl:'https://gis.toronto.ca/arcgis/rest/services/basemap/cot_historic_aerial_1939/MapServer',
    bounds:{west:-79.5,south:43.6,east:-79.2,north:43.8},width:2048,height:1024,format:'png32'
  }));
  assert.equal(url.pathname.endsWith('/MapServer/export'),true);
  assert.equal(url.searchParams.get('f'),'image');
  assert.equal(url.searchParams.get('bboxSR'),'3857');
  assert.equal(url.searchParams.get('imageSR'),'3857');
  assert.equal(url.searchParams.get('size'),'2048,1024');
  const bbox=url.searchParams.get('bbox').split(',').map(Number);
  assert.ok(bbox.every(Number.isFinite));
  assert.ok(bbox[0]<bbox[2]&&bbox[1]<bbox[3]);
  for(const changes of [
    {width:4097},{height:2049,maxHeight:2048},{width:1.5},{format:'svg'},
    {bounds:{west:-79,south:44,east:-80,north:43}},
    {bounds:{west:-79,south:-90,east:-78,north:43}},
    {serviceUrl:'https://gis.toronto.ca/arcgis/rest/services/basemap/a/MapServer?token=x'},
    {serviceUrl:'https://gis.toronto.ca/arcgis/rest/services/basemap/a/MapServer/../private'},
    {serviceUrl:'https://gis.toronto.ca/arcgis//rest/services/basemap/a/MapServer'}
  ]) assert.throws(()=>arcGisExportUrl({
    serviceUrl:'https://gis.toronto.ca/arcgis/rest/services/basemap/a/MapServer',
    bounds:{west:-79.5,south:43.6,east:-79.2,north:43.8},width:2048,height:1024,...changes
  }),/bound|dimension|width|height|format|service|query|path|Web Mercator/i);
});

test('Toronto enumerates only approved names, normalizes footprints and applies licence and export allowlists',async()=>{
  const root='https://gis.toronto.ca/arcgis/rest/services/basemap/';
  const results=await TORONTO_IMAGERY_PROVIDER.search({
    location:{lat:43.65,lng:-79.38},year:1972,fetchImpl:routedFetch(providerRoutes(root,torontoDirectory))
  });
  assert.deepEqual(results.map(value=>value.year),[1939,2012,2024]);
  assert.deepEqual(results.map(value=>value.policy),['exportable','exportable','exportable']);
  assert.deepEqual(results.map(value=>value.resolutionMeters),[null,0.05,0.08]);
  assert.ok(results[0].coverage.west>-80&&results[0].coverage.east<-79);
  assert.equal(results[0].export.maxWidth,4096);
  assert.ok(results.every(value=>value.export?.maxWidth===4096));
  assert.ok(results.every(value=>Object.hasOwn(value.preview,'tileTemplate')));
  for(const value of results)validateImageryResult({...value,id:`toronto:${value.id}`},TORONTO_IMAGERY_PROVIDER);
  assert.ok(results.every(value=>value.sourceUrl.startsWith(root)));
});

test('Toronto policy truth table preserves unknown before considering Export Map capability',async()=>{
  const root='https://gis.toronto.ca/arcgis/rest/services/basemap/';
  const directory={
    services:[
      {name:'basemap/cot_historic_aerial_1939',type:'MapServer'},
      {name:'basemap/cot_historic_aerial_1954',type:'MapServer'},
      {name:'basemap/cot_historic_aerial_1965',type:'MapServer'},
      {name:'basemap/cot_historic_aerial_1978',type:'MapServer'}
    ],
    metadata:{
      'basemap/cot_historic_aerial_1939':{},
      'basemap/cot_historic_aerial_1954':{capabilities:'Query'},
      'basemap/cot_historic_aerial_1965':{copyrightText:''},
      'basemap/cot_historic_aerial_1978':{copyrightText:'',capabilities:'Query'}
    }
  };
  const results=await TORONTO_IMAGERY_PROVIDER.search({
    location:{lat:43.65,lng:-79.38},year:1972,fetchImpl:routedFetch(providerRoutes(root,directory))
  });
  assert.deepEqual(results.map(value=>value.policy),['exportable','link-only','unknown','unknown']);
  assert.ok(results[0].export&&Object.hasOwn(results[0].preview,'tileTemplate'));
  assert.ok(results.slice(1).every(value=>value.export===null&&!Object.hasOwn(value.preview,'tileTemplate')));
});

test('Toronto refuses unsupported footprint spatial references instead of guessing',async()=>{
  const root='https://gis.toronto.ca/arcgis/rest/services/basemap/';
  const directory={services:[{name:'basemap/cot_historic_aerial_1939',type:'MapServer'}],metadata:{
    'basemap/cot_historic_aerial_1939':{fullExtent:{xmin:1,ymin:2,xmax:3,ymax:4,spatialReference:{wkid:26917}}}
  }};
  await assert.rejects(TORONTO_IMAGERY_PROVIDER.search({
    location:{lat:43.65,lng:-79.38},year:1939,fetchImpl:routedFetch(providerRoutes(root,directory))
  }),/3857|spatial reference|projection/i);
});

test('Ottawa accepts only exact Basemap_Imagery_YYYY names and keeps unverified aerial licensing unknown',async()=>{
  const root='https://maps.ottawa.ca/arcgis/rest/services/';
  const results=await OTTAWA_IMAGERY_PROVIDER.search({
    location:{lat:45.42,lng:-75.69},year:1958,fetchImpl:routedFetch(providerRoutes(root,ottawaDirectory))
  });
  assert.deepEqual(results.map(value=>value.year),[1928,1958]);
  assert.ok(results.every(value=>value.policy==='unknown'&&value.export===null));
  assert.ok(results.every(value=>!Object.hasOwn(value.preview,'tileTemplate')));
  assert.equal(results[1].year,1958,'approved service identity wins over conflicting arbitrary prose');
  for(const value of results)validateImageryResult({...value,id:`ottawa:${value.id}`},OTTAWA_IMAGERY_PROVIDER);
});

test('Ontario returns only checked-in open collections whose published footprints intersect SITE',async()=>{
  const root='https://ws.lioservices.lrc.gov.on.ca/arcgis2/rest/services/LIO_Imagery/';
  const sourceUrl=new URL('Ontario_Imagery_Web_Map_Service_Source/MapServer',root);
  const imageUrl=new URL('Ontario_Imagery_Web_Map_Service/MapServer',root);
  const routes=new Map([
    [sourceUrl.pathname,{layers:ontarioSource.layers.map(({id,name})=>({id,name}))}],
    [imageUrl.pathname,{...mapService,copyrightText:''}]
  ]);
  for(const layer of ontarioSource.layers)routes.set(`${sourceUrl.pathname}/${layer.id}`,layer);
  const results=await ONTARIO_IMAGERY_PROVIDER.search({
    location:{lat:45.42,lng:-75.69},year:2024,fetchImpl:routedFetch(routes)
  });
  assert.deepEqual(results.map(value=>value.year),[2024]);
  assert.deepEqual(results.map(value=>value.id),['drape-2024']);
  assert.equal(results[0].policy,'link-only');
  assert.equal(results[0].licenseUrl,'https://www.ontario.ca/page/open-government-licence-ontario');
  assert.deepEqual(results[0].preview,{kind:'official-link',url:`${sourceUrl.href}/1`});
  assert.equal(results[0].export,null);
  assert.equal(Object.hasOwn(results[0].preview,'tileTemplate'),false);
  validateImageryResult({...results[0],id:`ontario:${results[0].id}`},ONTARIO_IMAGERY_PROVIDER);
});

test('Ontario overlapping collection years remain distinct metadata links without shared raster bytes',async()=>{
  const root='https://ws.lioservices.lrc.gov.on.ca/arcgis2/rest/services/LIO_Imagery/';
  const sourceUrl=new URL('Ontario_Imagery_Web_Map_Service_Source/MapServer',root);
  const imageUrl=new URL('Ontario_Imagery_Web_Map_Service/MapServer',root);
  const layers=[
    {id:1,name:'Digital Raster Acquisition Project East 2024 (Aerial)',fullExtent:mapService.fullExtent},
    {id:2,name:'South Central Ontario Orthophotography 2023 (Aerial)',fullExtent:mapService.fullExtent}
  ];
  const routes=new Map([
    [sourceUrl.pathname,{layers:layers.map(({id,name})=>({id,name}))}],
    [imageUrl.pathname,{...mapService,copyrightText:''}]
  ]);
  for(const layer of layers)routes.set(`${sourceUrl.pathname}/${layer.id}`,layer);
  const results=await ONTARIO_IMAGERY_PROVIDER.search({
    location:{lat:43.65,lng:-79.38},year:2024,fetchImpl:routedFetch(routes)
  });
  assert.deepEqual(results.map(value=>value.year),[2023,2024]);
  assert.equal(new Set(results.map(value=>value.preview.url)).size,2);
  assert.ok(results.every(value=>value.preview.url===value.sourceUrl));
  assert.ok(results.every(value=>value.preview.kind==='official-link'&&value.export===null));
  assert.ok(results.every(value=>!Object.hasOwn(value.preview,'tileTemplate')));
  assert.ok(results.every(value=>!value.preview.url.includes('Ontario_Imagery_Web_Map_Service/MapServer')));
});

test('provider searches never request raster, tile or export operations in fixture mode',async()=>{
  const calls=[];
  const root='https://gis.toronto.ca/arcgis/rest/services/basemap/';
  await TORONTO_IMAGERY_PROVIDER.search({
    location:{lat:43.65,lng:-79.38},year:1939,fetchImpl:routedFetch(providerRoutes(root,torontoDirectory),calls)
  });
  assert.ok(calls.length>1);
  assert.ok(calls.every(({url})=>!/(?:\/tile\/|\/export(?:\/|$))/i.test(url.pathname)));
});

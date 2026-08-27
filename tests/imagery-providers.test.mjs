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
  return {
    ok:status>=200&&status<300,status,url,
    headers:{get(name){
      if(name.toLowerCase()==='content-type')return type;
      if(name.toLowerCase()==='content-length')return contentLength===undefined?String(new TextEncoder().encode(body).byteLength):String(contentLength);
      return null;
    }},
    text:async()=>body
  };
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
    'https://gis.toronto.ca/arcgis/rest/services/basemap/#fragment',
    '//gis.toronto.ca/arcgis/rest/services/basemap/'
  ]) await assert.rejects(fetchArcGisJson(url,options),/official|origin|root|credential|traversal|query|parameter|fragment|absolute|path/i);

  await assert.rejects(fetchArcGisJson(root,{
    ...options,fetchImpl:async url=>jsonResponse({},'https://evil.example/arcgis/rest/services/basemap/?f=json')
  }),/redirect|official|origin|root/i);
  await assert.rejects(fetchArcGisJson(root,{
    ...options,fetchImpl:async url=>jsonResponse({},`${root}?f=pjson`)
  }),/redirect|preserve|f=json/i);
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

test('safe ArcGIS JSON fetch aborts promptly while a response body is still pending',async()=>{
  const root='https://maps.ottawa.ca/arcgis/rest/services/';
  const controller=new AbortController();
  let releaseBody;
  const body=new Promise(resolve=>{releaseBody=resolve;});
  const pending=fetchArcGisJson(root,{
    signal:controller.signal,allowedOrigins:['https://maps.ottawa.ca'],allowedRoots:[root],
    fetchImpl:async url=>({...jsonResponse({},url),text:()=>body})
  });
  await new Promise(resolve=>setTimeout(resolve,0));
  controller.abort();
  const outcome=await Promise.race([
    pending.then(()=> 'resolved',error=>error.name),
    new Promise(resolve=>setTimeout(()=>resolve('still-pending'),50))
  ]);
  releaseBody('{}');
  await pending.catch(()=>{});
  assert.equal(outcome,'AbortError');
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

test('Toronto blank attribution stays unknown and a service without Export Map stays link-only',async()=>{
  const root='https://gis.toronto.ca/arcgis/rest/services/basemap/';
  const directory={
    services:[
      {name:'basemap/cot_historic_aerial_1939',type:'MapServer'},
      {name:'basemap/cot_ortho_2012_color_5cm',type:'MapServer'}
    ],
    metadata:{
      'basemap/cot_historic_aerial_1939':{copyrightText:''},
      'basemap/cot_ortho_2012_color_5cm':{capabilities:'Query'}
    }
  };
  const results=await TORONTO_IMAGERY_PROVIDER.search({
    location:{lat:43.65,lng:-79.38},year:1972,fetchImpl:routedFetch(providerRoutes(root,directory))
  });
  assert.deepEqual(results.map(value=>value.policy),['unknown','link-only']);
  assert.ok(results.every(value=>value.export===null&&!Object.hasOwn(value.preview,'tileTemplate')));
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
  assert.equal(results[0].policy,'exportable');
  assert.equal(results[0].licenseUrl,'https://www.ontario.ca/page/open-government-licence-ontario');
  assert.equal(results[0].preview.layer,0);
  validateImageryResult({...results[0],id:`ontario:${results[0].id}`},ONTARIO_IMAGERY_PROVIDER);
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

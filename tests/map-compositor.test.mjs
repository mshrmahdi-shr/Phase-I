import test from 'node:test';
import assert from 'node:assert/strict';
import {createProject} from '../src/core.mjs';
import {JSDOM} from 'jsdom';
import {createHash} from 'node:crypto';
import {TORONTO_IMAGERY_PROVIDER} from '../src/imagery/providers/toronto.mjs';
import {projectPoint,unprojectPoint} from '../src/sheet-layout.mjs';

test('imagery request plans stay bounded, use final projected WMS extent, and require no unrelated tiles',async()=>{
  const {sheetGeometry}=await import('../src/sheet-layout.mjs');
  const {imageryPlan}=await import('../src/map-compositor.mjs');
  const project={...createProject(),location:{lat:43.7,lng:-79.3}};
  const g=sheetGeometry(project,'C');const c=imageryPlan('C',g);
  assert.equal(c.length,1);const url=new URL(c[0].url);
  assert.equal(url.searchParams.get('SRS'),'EPSG:3857');assert.equal(url.searchParams.get('LAYERS'),'WMS-Toporama');
  assert.equal(url.searchParams.get('BBOX'),Object.values(g.projected).join(','));
  assert.ok(Number(url.searchParams.get('WIDTH'))<=1536);
  for(const code of ['A','B','D','E']){const plan=imageryPlan(code,sheetGeometry(project,code));assert.ok(plan.length>0&&plan.length<=36);}
});
test('bounded compositor rejects pre-aborted work before allocating a browser surface',async t=>{
  const {composeMap}=await import('../src/map-compositor.mjs');
  const {sheetGeometry}=await import('../src/sheet-layout.mjs');
  const project={...createProject(),location:{lat:43.7,lng:-79.3}},geometry=sheetGeometry(project,'A');
  const controller=new AbortController();controller.abort();
  await assert.rejects(composeMap({project,code:'A',geometry,signal:controller.signal}),{name:'AbortError'});
  const previous=globalThis.document;delete globalThis.document;t.after(()=>{if(previous!==undefined)globalThis.document=previous;});
  await assert.rejects(composeMap({project,code:'A',geometry}),/canvas|browser/i);
});

function browserSurface(t,{failure=false,controller,stall=false,decode}={}){
  let active=0,peak=0,decoded=0,closed=0,drawn=0,aborted=0;
  const ctx={fillRect(){},drawImage(){drawn++;},beginPath(){},moveTo(){},lineTo(){},closePath(){},fill(){},stroke(){},arc(){},setLineDash(){},strokeText(){},fillText(){}};
  const dom=new JSDOM('<!doctype html><body></body>'),document=dom.window.document;
  let canvas;
  dom.window.HTMLCanvasElement.prototype.getContext=function(){canvas=this;return ctx;};
  dom.window.HTMLCanvasElement.prototype.toDataURL=function(){assert.ok(this.width>0&&this.height>0);assert.ok(document.body.contains(this),'rendering surface is attached independently of the editor');return 'data:image/jpeg;base64,AAAA';};
  const globals={document:globalThis.document,fetch:globalThis.fetch,createImageBitmap:globalThis.createImageBitmap};
  globalThis.document=document;
  globalThis.createImageBitmap=async()=>{decoded++;const bitmap={width:256,height:256,close(){closed++;}};return decode?decode(bitmap):bitmap;};
  let count=0;
  globalThis.fetch=async(url,{signal})=>{
    const request=++count;active++;peak=Math.max(peak,active);
    try{await new Promise((resolve,reject)=>{const timer=stall?null:setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},request===1?0:5);const abort=()=>{aborted++;clearTimeout(timer);reject(new DOMException('Cancelled','AbortError'));};signal.addEventListener('abort',abort,{once:true});});
      if(failure&&request===1)return {ok:false,status:503};if(controller&&request===1)controller.abort();
      return {ok:true,headers:new Headers({'content-type':'image/png'}),blob:async()=>new Blob(['image'])};
    }finally{active--;}
  };
  t.after(()=>{for(const [key,value] of Object.entries(globals)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}});
  return {get canvas(){return canvas;},document,stats:()=>({active,peak,decoded,closed,drawn,aborted})};
}
test('successful raster owns nonzero canvas, bounds, bounded fetches and deterministic bitmap/canvas disposal',async t=>{
  const {composeMap,imageryPlan}=await import('../src/map-compositor.mjs'),{sheetGeometry}=await import('../src/sheet-layout.mjs');
  const project={...createProject(),location:{lat:43.7,lng:-79.3}},geometry=sheetGeometry(project,'A'),surface=browserSurface(t);
  const image=await composeMap({project,code:'A',geometry});
  assert.deepEqual(image.bounds,geometry.bounds);assert.equal(image.width,geometry.raster.width);
  const stats=surface.stats();assert.equal(stats.active,0);assert.ok(stats.peak<=4);assert.equal(stats.decoded,imageryPlan('A',geometry).length);assert.equal(stats.closed,stats.decoded);assert.equal(stats.drawn,stats.decoded);
  image.dispose();image.dispose();assert.equal(surface.canvas.width,0);assert.equal(surface.canvas.height,0);
  assert.equal(surface.document.body.children.length,0);
});
for(const mode of ['failure','cancel'])test(`${mode} aborts sibling fetches and releases partial raster before rejection`,async t=>{
  const {composeMap}=await import('../src/map-compositor.mjs'),{sheetGeometry}=await import('../src/sheet-layout.mjs');
  const project={...createProject(),location:{lat:43.7,lng:-79.3}},geometry=sheetGeometry(project,'A'),controller=new AbortController();
  const surface=browserSurface(t,{failure:mode==='failure',controller:mode==='cancel'?controller:null});
  await assert.rejects(composeMap({project,code:'A',geometry,signal:controller.signal}),mode==='cancel'?{name:'AbortError'}:/HTTP 503/);
  assert.equal(surface.canvas.width,0);assert.equal(surface.stats().active,0);assert.equal(surface.stats().decoded,surface.stats().closed);assert.ok(surface.stats().aborted>0);
  assert.equal(surface.document.body.children.length,0);
});
test('stalled image requests time out, abort siblings and remove their visible preview',async t=>{
  const {composeMap}=await import('../src/map-compositor.mjs'),{sheetGeometry}=await import('../src/sheet-layout.mjs');
  const project={...createProject(),location:{lat:43.7,lng:-79.3}},geometry=sheetGeometry(project,'A'),surface=browserSurface(t,{stall:true});
  await assert.rejects(composeMap({project,code:'A',geometry,requestTimeoutMs:5}),/timed out/i);
  assert.equal(surface.stats().active,0);assert.equal(surface.canvas.width,0);assert.equal(surface.document.body.children.length,0);
});
for(const mode of ['timeout','cancel'])test(`${mode} during bitmap decoding promptly releases the raster and closes late bitmaps`,async t=>{
  const {composeMap}=await import('../src/map-compositor.mjs'),{sheetGeometry}=await import('../src/sheet-layout.mjs');
  const project={...createProject(),location:{lat:43.7,lng:-79.3}},geometry=sheetGeometry(project,'A'),controller=new AbortController();
  const pending=[];let started;const decoding=new Promise(resolve=>{started=resolve;});
  const surface=browserSurface(t,{decode:bitmap=>new Promise(resolve=>{pending.push(()=>resolve(bitmap));started();})});
  const outcome=composeMap({project,code:'A',geometry,signal:controller.signal,requestTimeoutMs:mode==='timeout'?5:30000}).then(result=>({result}),error=>({error}));
  await decoding;if(mode==='cancel')controller.abort();
  let timer;
  try{
    const observed=await Promise.race([outcome,new Promise(resolve=>{timer=setTimeout(()=>resolve({pending:true}),50);})]);
    assert.ok(!observed.pending,'cancellation/timeout must settle without waiting for the bitmap decoder');
    if(mode==='cancel')assert.equal(observed.error?.name,'AbortError');else assert.match(observed.error?.message||'',/timed out/i);
    assert.equal(surface.canvas.width,0);assert.equal(surface.canvas.height,0);assert.equal(surface.document.body.children.length,0);assert.equal(surface.stats().active,0);
    assert.equal(surface.stats().closed,0,'the decoder has not produced a bitmap yet');
  }finally{clearTimeout(timer);pending.forEach(resolve=>resolve());await outcome;}
  await new Promise(resolve=>setImmediate(resolve));
  assert.ok(pending.length>0);assert.equal(surface.stats().closed,pending.length,'each bitmap resolving after cancellation is closed exactly once');assert.equal(surface.stats().drawn,0);
});
test('map overlays retain holes, distinguish site/building outlines and anchor SITE with the shared transform',async()=>{
  const {paintMapOverlays}=await import('../src/map-compositor.mjs'),{sheetGeometry}=await import('../src/sheet-layout.mjs');
  const ring=[[-79.301,43.699],[-79.299,43.699],[-79.299,43.701],[-79.301,43.701],[-79.301,43.699]];
  const project={...createProject(),location:{lat:43.7,lng:-79.3},siteBoundary:ring,buildingBoundary:ring},geometry=sheetGeometry(project,'A');
  const fills=[],strokes=[],points=[],labels=[];let paths=0;
  const ctx={beginPath(){paths=0;},moveTo(){paths++;},lineTo(){},closePath(){},fill(rule){fills.push({rule,paths,alpha:this.globalAlpha});},stroke(){strokes.push({color:this.strokeStyle,width:this.lineWidth,dash:this.dash});},setLineDash(dash){this.dash=dash;},arc(x,y){points.push([x,y]);},strokeText(){},fillText(text){labels.push(text);}};
  paintMapOverlays(ctx,{project,geometry,features:[{polygon:ring,holes:[ring],fillOpacity:.6,color:'#ff0000'}]});
  assert.deepEqual(fills[0],{rule:'evenodd',paths:2,alpha:.6});
  assert.equal(strokes[1].color,'#ef4444');assert.deepEqual(strokes[1].dash,[]);
  assert.equal(strokes[2].color,'#111111');assert.equal(strokes[2].dash.length,2);assert.ok(strokes[1].width>strokes[2].width);
  assert.deepEqual(labels,['SITE']);assert.ok(Math.abs(points[0][0]-geometry.raster.width/2)<.001);assert.ok(Math.abs(points[0][1]-geometry.raster.height/2)<.1);
});

function a3Bounds(location,halfWidth=2000){const [x,y]=projectPoint([location.lng,location.lat]),halfHeight=halfWidth/(420/297),sw=unprojectPoint([x-halfWidth,y-halfHeight]),ne=unprojectPoint([x+halfWidth,y+halfHeight]);return {west:sw[0],south:sw[1],east:ne[0],north:ne[1]};}
const historicalBounds=a3Bounds({lng:-79.38,lat:43.65}),historicalCoverage={west:-79.5,south:43.5,east:-79.2,north:43.8};
const historicalSource='https://gis.toronto.ca/arcgis/rest/services/basemap/cot_historic_aerial_1972/MapServer';
function officialResult(overrides={}){return {id:'toronto:cot-historic-aerial-1972',providerId:'toronto',title:'City of Toronto aerial imagery 1972',year:1972,resolutionMeters:.2,coverage:{...historicalCoverage},
  preview:{kind:'arcgis-map-service',url:historicalSource,tileTemplate:`${historicalSource}/tile/{z}/{y}/{x}`},export:{kind:'arcgis-export',url:`${historicalSource}/export`,maxWidth:1024,maxHeight:900},
  policy:'exportable',sourceUrl:historicalSource,licenseUrl:'https://open.toronto.ca/open-data-licence/',attribution:'City of Toronto',...overrides};}
function historicalProject(item){return {...createProject(),location:{lat:43.65,lng:-79.38},historical:[item],historicalSequenceCounters:{'1972':1},
  siteBoundary:[[-79.39,43.64],[-79.37,43.64],[-79.37,43.66],[-79.39,43.66],[-79.39,43.64]],buildingBoundary:[]};}
function officialHistorical(overrides={}){return {id:'6f9719eb-3083-4bdb-a35b-d638a6efac19',year:1972,sequence:1,title:'City of Toronto aerial imagery 1972',mode:'official',providerId:'toronto',
  sourceUrl:historicalSource,licenseUrl:'https://open.toronto.ca/open-data-licence/',attribution:'City of Toronto',policy:'exportable',resolutionMeters:.2,bounds:{...historicalBounds},placement:null,assetId:null,
  officialExport:{kind:'arcgis-export',url:`${historicalSource}/export`,layer:null,maxWidth:1024,maxHeight:900,resultId:'toronto:cot-historic-aerial-1972',coverage:{...historicalCoverage},preview:{kind:'arcgis-map-service',url:historicalSource,layer:null,tileTemplate:`${historicalSource}/tile/{z}/{y}/{x}`}},createdAt:'2026-08-27T12:00:00.000Z',updatedAt:'2026-08-27T12:00:00.000Z',...overrides};}

test('official historical plans stay inside the current provider root and tile only the final crop',async()=>{
  const {historicalSheetGeometry}=await import('../src/historical-layout.mjs');
  const {historicalImageryPlan}=await import('../src/map-compositor.mjs');
  const item=officialHistorical(),p=historicalProject(item),geometry=historicalSheetGeometry(p,item,150);
  const plan=historicalImageryPlan({project:p,item,geometry,providers:[TORONTO_IMAGERY_PROVIDER],currentResult:officialResult()});
  assert.ok(plan.length>1&&plan.length<=64);
  let pixels=0;
  for(const request of plan){
    const url=new URL(request.url);assert.equal(url.origin,'https://gis.toronto.ca');assert.ok(url.pathname.startsWith('/arcgis/rest/services/basemap/'));
    const [width,height]=url.searchParams.get('size').split(',').map(Number);
    assert.equal(width,request.expectedWidth);assert.equal(height,request.expectedHeight);assert.ok(width<=1024&&height<=900);pixels+=width*height;
    assert.equal(url.searchParams.get('bboxSR'),'3857');assert.equal(url.searchParams.get('imageSR'),'3857');
  }
  assert.equal(pixels,geometry.raster.width*geometry.raster.height,'requests cover exactly the final raster viewport once');
  assert.throws(()=>historicalImageryPlan({project:p,item:{...item,officialExport:{...item.officialExport,url:'https://evil.test/MapServer/export'}},geometry,providers:[TORONTO_IMAGERY_PROVIDER],currentResult:officialResult()}),/official provider|root|approved/i);
  assert.throws(()=>historicalImageryPlan({project:p,item:{...item,bounds:{...item.bounds,east:-78}},geometry,providers:[TORONTO_IMAGERY_PROVIDER],currentResult:officialResult()}),/approved|coverage|crop/i);
});

test('official historical export binds the stable current result to source, preview, export, year and footprint',async()=>{
  const {historicalSheetGeometry}=await import('../src/historical-layout.mjs'),{historicalImageryPlan,revalidateHistoricalOfficialSource}=await import('../src/map-compositor.mjs');
  const item=officialHistorical(),p=historicalProject(item),geometry=historicalSheetGeometry(p,item,150),wrongSource='https://gis.toronto.ca/arcgis/rest/services/basemap/cot_ortho_2025_test/MapServer';
  for(const currentResult of [
    officialResult({id:'toronto:cot-ortho-2025-test'}),
    officialResult({year:2025,title:'City of Toronto aerial imagery 2025'}),
    officialResult({sourceUrl:wrongSource,preview:{kind:'arcgis-map-service',url:wrongSource,tileTemplate:`${wrongSource}/tile/{z}/{y}/{x}`},export:{kind:'arcgis-export',url:`${wrongSource}/export`,maxWidth:1024,maxHeight:900}}),
    officialResult({coverage:{west:-79.39,south:43.64,east:-79.37,north:43.66}}),
    officialResult({export:{kind:'arcgis-export',url:`${historicalSource}/export`,layer:7,maxWidth:2048,maxHeight:900}})
  ])assert.throws(()=>historicalImageryPlan({project:p,item,geometry,providers:[TORONTO_IMAGERY_PROVIDER],currentResult}),/current official|identity|source|coverage|crop|descriptor|changed|stale/i);
  assert.equal(typeof revalidateHistoricalOfficialSource,'function');
});

test('manual historical composition verifies the strict asset hash and applies its immutable affine',async t=>{
  const {historicalSheetGeometry}=await import('../src/historical-layout.mjs');
  const {composeHistoricalImage}=await import('../src/map-compositor.mjs');
  const {placementFromExtent}=await import('../src/imagery/placement.mjs');
  const bytes=new Uint8Array([1,2,3,4]),assetId='237589d9-3d5d-4817-9d0a-a5fb2d151286';
  const placement=placementFromExtent({bounds:{west:-79.5,south:43.58,east:-79.3,north:43.72},width:2,height:2,rotationDegrees:17});
  const item={...officialHistorical({mode:'manual',providerId:null,sourceUrl:null,licenseUrl:null,attribution:'Municipal archive <safe>',resolutionMeters:null,placement,assetId,officialExport:null})};
  const p=historicalProject(item),geometry=historicalSheetGeometry(p,item,150),hash=createHash('sha256').update(bytes).digest('hex');
  const asset={metadata:{id:assetId,kind:'historical-image',mime:'image/png',size:bytes.length,width:2,height:2,sha256:hash,createdAt:'2026-08-27T12:00:00.000Z'},blob:new Blob([bytes],{type:'image/png'})};
  const transforms=[],draws=[];let canvas,closed=0;
  const dom=new JSDOM('<!doctype html><body></body>');
  dom.window.HTMLCanvasElement.prototype.getContext=function(){canvas=this;return {fillRect(){},drawImage(...args){draws.push(args);},beginPath(){},moveTo(){},lineTo(){},closePath(){},fill(){},stroke(){},arc(){},setLineDash(){},strokeText(){},fillText(){},save(){},restore(){},setTransform(...args){transforms.push(args);}};};
  dom.window.HTMLCanvasElement.prototype.toDataURL=()=> 'data:image/jpeg;base64,AAAA';
  const previous={document:globalThis.document,createImageBitmap:globalThis.createImageBitmap};globalThis.document=dom.window.document;globalThis.createImageBitmap=async()=>({width:2,height:2,close(){closed++;}});
  t.after(()=>{for(const [key,value] of Object.entries(previous)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}dom.window.close();});
  const image=await composeHistoricalImage({project:p,item,geometry,assetStore:{get:async()=>asset},providers:[TORONTO_IMAGERY_PROVIDER]});
  assert.deepEqual(image.bounds,historicalBounds);assert.equal(draws.length,1);assert.equal(transforms.length,1);assert.ok(transforms[0].some(value=>Math.abs(value)>.001));assert.equal(closed,1);
  image.dispose();image.dispose();assert.equal(canvas.width,0);assert.equal(dom.window.document.body.children.length,0);
  for(const tampered of [{...asset,metadata:{...asset.metadata,sha256:'0'.repeat(64)}},{...asset,metadata:{...asset.metadata,kind:'company-logo'}}]){
    await assert.rejects(composeHistoricalImage({project:p,item,geometry,assetStore:{get:async()=>tampered}}),/hash|integrity|another feature/i);
  }
});

test('historical source failure aborts sibling tiles and disposes the independent surface',async t=>{
  const {historicalSheetGeometry}=await import('../src/historical-layout.mjs');
  const {composeHistoricalImage}=await import('../src/map-compositor.mjs');
  const item=officialHistorical(),p=historicalProject(item),geometry=historicalSheetGeometry(p,item,150),dom=new JSDOM('<!doctype html><body></body>');let canvas,aborted=0;
  dom.window.HTMLCanvasElement.prototype.getContext=function(){canvas=this;return {fillRect(){}};};
  const previous=globalThis.document;globalThis.document=dom.window.document;t.after(()=>{if(previous===undefined)delete globalThis.document;else globalThis.document=previous;dom.window.close();});
  let request=0;
  const fetchImpl=async(url,{signal})=>{request++;if(request===1)return {ok:false,status:503,headers:new Headers()};return new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>{aborted++;reject(new DOMException('Cancelled','AbortError'));},{once:true});});};
  await assert.rejects(composeHistoricalImage({project:p,item,geometry,providers:[TORONTO_IMAGERY_PROVIDER],currentOfficialResult:officialResult(),fetchImpl}),/HTTP 503|request failed/i);
  assert.ok(aborted>0);assert.equal(canvas.width,0);assert.equal(canvas.height,0);assert.equal(dom.window.document.body.children.length,0);
});

test('official historical responses enforce declared and streamed byte limits before Blob materialization',async t=>{
  const {historicalSheetGeometry}=await import('../src/historical-layout.mjs'),{composeHistoricalImage}=await import('../src/map-compositor.mjs');
  const item=officialHistorical({officialExport:{...officialHistorical().officialExport,maxWidth:4096,maxHeight:4096}}),p=historicalProject(item),geometry=historicalSheetGeometry(p,item,150),current=officialResult({export:{...officialResult().export,maxWidth:4096,maxHeight:4096}});
  const dom=new JSDOM('<!doctype html><body></body>'),previous={document:globalThis.document,createImageBitmap:globalThis.createImageBitmap};globalThis.document=dom.window.document;
  dom.window.HTMLCanvasElement.prototype.getContext=()=>({fillRect(){},drawImage(){},beginPath(){},moveTo(){},lineTo(){},closePath(){},fill(){},stroke(){},arc(){},setLineDash(){},strokeText(){},fillText(){}});
  dom.window.HTMLCanvasElement.prototype.toDataURL=()=> 'data:image/jpeg;base64,AAAA';globalThis.createImageBitmap=async()=>({width:geometry.raster.width,height:geometry.raster.height,close(){}});
  t.after(()=>{for(const [key,value] of Object.entries(previous)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}dom.window.close();});
  let blobCalls=0,readerCalls=0;
  const declared=async()=>({ok:true,status:200,headers:new Headers({'content-type':'image/png','content-length':'100000000'}),body:{getReader(){readerCalls++;throw Error('must not open reader');}},blob:async()=>{blobCalls++;return new Blob(['small'],{type:'image/png'});}});
  await assert.rejects(composeHistoricalImage({project:p,item,geometry,providers:[TORONTO_IMAGERY_PROVIDER],currentOfficialResult:current,fetchImpl:declared}),/size|byte|16 MB|limit/i);
  assert.equal(blobCalls,0,'oversized declared responses are rejected before body materialization');assert.equal(readerCalls,0,'oversized declared responses are rejected before opening the stream');

  let reads=0,cancelled=0,released=0;const chunk=new Uint8Array(8_000_001),reader={async read(){reads++;return reads<=2?{done:false,value:chunk}:{done:true}},async cancel(){cancelled++;},releaseLock(){released++;}};
  const streamed=async()=>({ok:true,status:200,headers:new Headers({'content-type':'image/png'}),body:{getReader:()=>reader},blob:async()=>{blobCalls++;return new Blob(['small'],{type:'image/png'});}});
  await assert.rejects(composeHistoricalImage({project:p,item,geometry,providers:[TORONTO_IMAGERY_PROVIDER],currentOfficialResult:current,fetchImpl:streamed}),/size|byte|16 MB|limit/i);
  assert.equal(blobCalls,0,'streaming is the only body materialization path');assert.ok(cancelled>=1);assert.equal(released,1);

  let readStarted,resolveRead,abortCancelled=0,abortReleased=0;const began=new Promise(resolve=>readStarted=resolve),abortReader={read(){readStarted();return new Promise(resolve=>resolveRead=resolve);},async cancel(){abortCancelled++;resolveRead?.({done:true});},releaseLock(){abortReleased++;}};
  const abortFetch=async()=>({ok:true,status:200,headers:new Headers({'content-type':'image/png'}),body:{getReader:()=>abortReader}}),abortController=new AbortController(),composing=composeHistoricalImage({project:p,item,geometry,providers:[TORONTO_IMAGERY_PROVIDER],currentOfficialResult:current,fetchImpl:abortFetch,signal:abortController.signal});
  await began;abortController.abort();await assert.rejects(composing,error=>error.name==='AbortError');assert.equal(abortCancelled,1);assert.equal(abortReleased,1);
});

test('concurrent official streams charge the shared aggregate budget before completed Blobs decode',async t=>{
  const {historicalSheetGeometry}=await import('../src/historical-layout.mjs'),{composeHistoricalImage}=await import('../src/map-compositor.mjs');
  const item=officialHistorical({officialExport:{...officialHistorical().officialExport,maxWidth:500,maxHeight:4096}}),p=historicalProject(item),geometry=historicalSheetGeometry(p,item,150),current=officialResult({export:{...officialResult().export,maxWidth:500,maxHeight:4096}}),dom=new JSDOM('<!doctype html><body></body>'),previous={document:globalThis.document,createImageBitmap:globalThis.createImageBitmap};globalThis.document=dom.window.document;
  dom.window.HTMLCanvasElement.prototype.getContext=()=>({fillRect(){},drawImage(){},beginPath(){},moveTo(){},lineTo(){},closePath(){},fill(){},stroke(){},arc(){},setLineDash(){},strokeText(){},fillText(){}});dom.window.HTMLCanvasElement.prototype.toDataURL=()=> 'data:image/jpeg;base64,AAAA';
  let decodeCalls=0,requestIndex=0;const sizes=new Map(),pendingDone=[];globalThis.createImageBitmap=async blob=>{decodeCalls++;const header=new DataView(await blob.slice(0,4).arrayBuffer()),index=header.getUint32(0);if(decodeCalls===2)for(const resolve of pendingDone.splice(0))resolve({done:true});const [width,height]=sizes.get(index);return {width,height,close(){}};};
  const padding=new Uint8Array(12_999_996),fetchImpl=async url=>{const index=requestIndex++,[width,height]=new URL(url).searchParams.get('size').split(',').map(Number),header=new Uint8Array(4);new DataView(header.buffer).setUint32(0,index);sizes.set(index,[width,height]);let read=0,release;
    const reader={async read(){read++;if(read===1)return {done:false,value:header};if(read===2)return {done:false,value:padding};if(index===0||index===4)return {done:true};return new Promise(resolve=>{release=resolve;pendingDone.push(resolve);});},async cancel(){release?.({done:true});},releaseLock(){}};
    return {ok:true,status:200,headers:new Headers({'content-type':'image/png'}),body:{getReader:()=>reader}};};
  t.after(()=>{for(const [key,value] of Object.entries(previous)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}dom.window.close();});
  const outcome=await composeHistoricalImage({project:p,item,geometry,providers:[TORONTO_IMAGERY_PROVIDER],currentOfficialResult:current,fetchImpl}).then(()=>null,error=>error);
  assert.equal(requestIndex,5);assert.match(outcome?.message||'',/64 MB|total byte|memory limit/i,`decode count was ${decodeCalls}`);assert.equal(decodeCalls,1,'the fifth 13 MB response is rejected while three earlier 13 MB streams remain resident');
});

const naplBounds=a3Bounds({lng:-104.6,lat:50.46},600),naplCoverage={west:-104.76,south:50.42,east:-104.56,north:50.5};
const naplService='https://datacube.services.geo.ca/ows/aerial';
function naplExportUrl(){const url=new URL(naplService);url.searchParams.set('LAYERS','regina');url.searchParams.set('TIME','1947-07-01T12:00:00Z');return url.href;}
function naplOfficialResult(overrides={}){return {id:'napl:regina-1947',providerId:'napl',title:'NAPL Regina, Saskatchewan aerial imagery 1947',year:1947,resolutionMeters:null,coverage:{...naplCoverage},
  preview:{kind:'wms-export',url:naplExportUrl()},export:{kind:'wms-export',url:naplExportUrl(),maxWidth:1024,maxHeight:900},
  policy:'exportable',sourceUrl:'https://datacube.services.geo.ca/web/napl-regina.xml?request=GetCapabilities&service=WMS&version=1.3.0&layers=regina',licenseUrl:'https://open.canada.ca/en/open-government-licence-canada',attribution:'Natural Resources Canada — National Air Photo Library',...overrides};}
function naplProject(item){return {...createProject(),location:{lat:50.46,lng:-104.6},historical:[item],historicalSequenceCounters:{'1947':1},
  siteBoundary:[[-104.61,50.45],[-104.59,50.45],[-104.59,50.47],[-104.61,50.47],[-104.61,50.45]],buildingBoundary:[]};}
function naplHistorical(overrides={}){return {id:'2c9f5e1a-1234-4a5b-8c9d-abc123456789',year:1947,sequence:1,title:'NAPL Regina, Saskatchewan aerial imagery 1947',mode:'official',providerId:'napl',
  sourceUrl:naplOfficialResult().sourceUrl,licenseUrl:naplOfficialResult().licenseUrl,attribution:naplOfficialResult().attribution,policy:'exportable',resolutionMeters:null,bounds:{...naplBounds},placement:null,assetId:null,
  officialExport:{kind:'wms-export',url:naplExportUrl(),layer:null,maxWidth:1024,maxHeight:900,resultId:'napl:regina-1947',coverage:{...naplCoverage},preview:{kind:'wms-export',url:naplExportUrl(),layer:null,tileTemplate:null}},createdAt:'2026-08-27T12:00:00.000Z',updatedAt:'2026-08-27T12:00:00.000Z',...overrides};}

test('WMS-backed official (NAPL) plans tile a valid GetMap request inside the current provider root',async()=>{
  const {NAPL_IMAGERY_PROVIDER}=await import('../src/imagery/providers/napl.mjs');
  const {historicalSheetGeometry}=await import('../src/historical-layout.mjs');
  const {historicalImageryPlan}=await import('../src/map-compositor.mjs');
  const item=naplHistorical(),p=naplProject(item),geometry=historicalSheetGeometry(p,item,150);
  const plan=historicalImageryPlan({project:p,item,geometry,providers:[NAPL_IMAGERY_PROVIDER],currentResult:naplOfficialResult()});
  assert.ok(plan.length>=1&&plan.length<=64);
  let pixels=0;
  for(const request of plan){
    const url=new URL(request.url);assert.equal(url.origin,'https://datacube.services.geo.ca');assert.equal(url.pathname,'/ows/aerial');
    assert.equal(url.searchParams.get('SERVICE'),'WMS');assert.equal(url.searchParams.get('REQUEST'),'GetMap');
    assert.equal(url.searchParams.get('LAYERS'),'regina');assert.equal(url.searchParams.get('TIME'),'1947-07-01T12:00:00Z');
    assert.equal(url.searchParams.get('CRS'),'EPSG:3857');
    assert.equal(Number(url.searchParams.get('WIDTH')),request.expectedWidth);assert.equal(Number(url.searchParams.get('HEIGHT')),request.expectedHeight);
    pixels+=Number(url.searchParams.get('WIDTH'))*Number(url.searchParams.get('HEIGHT'));
  }
  assert.equal(pixels,geometry.raster.width*geometry.raster.height,'requests cover exactly the final raster viewport once');
  assert.throws(()=>historicalImageryPlan({project:p,item:{...item,officialExport:{...item.officialExport,url:naplService}},geometry,providers:[NAPL_IMAGERY_PROVIDER],currentResult:naplOfficialResult()}),/official provider|root|approved/i);
  assert.throws(()=>historicalImageryPlan({project:p,item:{...item,officialExport:{...item.officialExport,url:'https://evil.test/ows/aerial?LAYERS=regina&TIME=1947-07-01T12:00:00Z'}},geometry,providers:[NAPL_IMAGERY_PROVIDER],currentResult:naplOfficialResult()}),/official provider|root|approved/i);
});

test('an unrecognized official export kind is rejected even when the item is otherwise self-consistent',async()=>{
  const {NAPL_IMAGERY_PROVIDER}=await import('../src/imagery/providers/napl.mjs');
  const {historicalSheetGeometry}=await import('../src/historical-layout.mjs');
  const {historicalImageryPlan}=await import('../src/map-compositor.mjs');
  const item=naplHistorical({officialExport:{...naplHistorical().officialExport,kind:'wcs-export'}}),p=naplProject(item),geometry=historicalSheetGeometry(p,item,150);
  assert.throws(()=>historicalImageryPlan({project:p,item,geometry,providers:[NAPL_IMAGERY_PROVIDER],currentResult:naplOfficialResult()}),/kind is unsupported|approved/i);
});

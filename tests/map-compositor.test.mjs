import test from 'node:test';
import assert from 'node:assert/strict';
import {createProject} from '../src/core.mjs';
import {JSDOM} from 'jsdom';

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

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';
import {IDBFactory} from 'fake-indexeddb';
import {createAssetStore} from '../src/asset-store.mjs';
import {createProject} from '../src/core.mjs';
import {defineImageryProvider} from '../src/imagery/provider-registry.mjs';
import {projectWebMercator,unprojectWebMercator} from '../src/imagery/placement.mjs';
import {createHistoricalImageryUI,historicalFigureCode,migrateLegacyHistoricalImagery} from '../src/historical-ui.mjs';

const HTML=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const SITE={lat:43.65,lng:-79.38};
function a3Bounds(location,halfWidth=1000){const [x,y]=projectWebMercator([location.lng,location.lat]),halfHeight=halfWidth/(420/297),sw=unprojectWebMercator([x-halfWidth,y-halfHeight]),ne=unprojectWebMercator([x+halfWidth,y+halfHeight]);return {west:sw[0],south:sw[1],east:ne[0],north:ne[1]};}
const BOUNDS=a3Bounds(SITE);
const ASSET_BYTES=new Uint8Array([1,2,3]);
const ASSET_SHA256='039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81';

function result({id='flight-1972',year=1972,title='Aerial 1972',policy='exportable'}={}){
  const exportable=policy==='exportable';
  return {id,providerId:'official',title,year,resolutionMeters:.25,coverage:{west:-80,south:43,east:-79,north:44},
    preview:exportable?{kind:'arcgis-map-service',url:`https://official.test/maps/${id}/MapServer`,tileTemplate:`https://official.test/maps/${id}/MapServer/tile/{z}/{y}/{x}`}:{kind:'official-link',url:`https://official.test/maps/${id}/MapServer`},
    export:exportable?{kind:'arcgis-export',url:`https://official.test/maps/${id}/MapServer/export`,maxWidth:4096,maxHeight:4096}:null,
    policy,sourceUrl:`https://official.test/maps/${id}/MapServer`,licenseUrl:'https://official.test/license/',attribution:'Official archive'};
}

function provider({search=async()=>[],policy='exportable',attribution='Official archive'}={}){
  return defineImageryProvider({id:'official',label:'Official archive',organization:'Official archive',priority:1,
    coverage:{west:-80,south:43,east:-79,north:44},licenseUrl:'https://official.test/license/',attribution,policy,
    allowedOrigins:['https://official.test'],allowedRoots:['https://official.test/maps/','https://official.test/license/'],covers:()=>true,search});
}

const STAMP='2026-08-27T12:00:00.000Z';
function officialItem({id='74f14168-4de6-4c5f-88f4-87db8ec731c2',sequence=1,attribution='Official archive',kind='arcgis-export'}={}){
  return {id,year:1972,sequence,title:'Saved flight',mode:'official',providerId:'official',sourceUrl:'https://official.test/maps/flight-1972/MapServer',
    licenseUrl:'https://official.test/license/',attribution,policy:'exportable',resolutionMeters:.25,bounds:{...BOUNDS},placement:null,assetId:null,
    officialExport:{kind,url:'https://official.test/maps/flight-1972/MapServer/export',layer:null,maxWidth:4096,maxHeight:4096,resultId:'official:flight-1972',coverage:{west:-80,south:43,east:-79,north:44},preview:{kind:'arcgis-map-service',url:'https://official.test/maps/flight-1972/MapServer',layer:null,tileTemplate:'https://official.test/maps/flight-1972/MapServer/tile/{z}/{y}/{x}'}},createdAt:STAMP,updatedAt:STAMP};
}
function manualItem({id='74f14168-4de6-4c5f-88f4-87db8ec731c2',assetId='3caa1022-b2e7-4c63-8ca8-12f4845e1be1',sequence=1}={}){
  const center=projectWebMercator([SITE.lng,SITE.lat]);
  return {id,year:1960,sequence,title:'scan.png',mode:'manual',providerId:null,sourceUrl:null,licenseUrl:null,attribution:'Archive scan',policy:'exportable',resolutionMeters:null,
    bounds:a3Bounds(SITE,40),placement:{center,groundWidth:100,groundHeight:80,sourceWidth:2,sourceHeight:1,rotationDegrees:0},assetId,
    officialExport:null,createdAt:STAMP,updatedAt:STAMP};
}
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
async function eventually(predicate,message='condition did not become true'){
  for(let attempt=0;attempt<100;attempt++){if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,2));}
  assert.fail(message);
}

function boundsObject(value=BOUNDS){return {getNorth:()=>value.north,getSouth:()=>value.south,getEast:()=>value.east,getWest:()=>value.west};}
function fakeMap(document){
  function displayedBounds(value){const sw=projectWebMercator([value.west,value.south]),ne=projectWebMercator([value.east,value.north]),center=[(sw[0]+ne[0])/2,(sw[1]+ne[1])/2],scale=Math.max((ne[0]-sw[0])/900,(ne[1]-sw[1])/636),displaySw=unprojectWebMercator([center[0]-scale*450,center[1]-scale*318]),displayNe=unprojectWebMercator([center[0]+scale*450,center[1]+scale*318]);return {west:displaySw[0],south:displaySw[1],east:displayNe[0],north:displayNe[1]};}
  let bounds=displayedBounds(BOUNDS),center={lat:SITE.lat,lng:SITE.lng},zoom=16;const listeners=new Map(),layers=new Set();
  const container=document.getElementById('map');Object.defineProperties(container,{clientWidth:{value:900,configurable:true},clientHeight:{value:636,configurable:true}});
  return {
    layers,listeners,getContainer:()=>container,getBounds:()=>boundsObject(bounds),getCenter:()=>({...center}),getZoom:()=>zoom,getSize:()=>({x:900,y:636}),
    containerPointToLatLng:([x,y])=>{const sw=projectWebMercator([bounds.west,bounds.south]),ne=projectWebMercator([bounds.east,bounds.north]);const point=unprojectWebMercator([sw[0]+(ne[0]-sw[0])*x/900,ne[1]-(ne[1]-sw[1])*y/636]);return {lat:point[1],lng:point[0]};},
    fitBounds(value){const pair=Array.isArray(value)?value:[[value.south,value.west],[value.north,value.east]];bounds=displayedBounds({south:pair[0][0],west:pair[0][1],north:pair[1][0],east:pair[1][1]});center={lat:(bounds.north+bounds.south)/2,lng:(bounds.east+bounds.west)/2};return this;},
    setView(value,nextZoom){center={lat:value.lat??value[0],lng:value.lng??value[1]};zoom=nextZoom;return this;},
    on(name,fn){for(const event of name.split(' ')){if(!listeners.has(event))listeners.set(event,new Set());listeners.get(event).add(fn);}return this;},
    off(name,fn){for(const event of name.split(' '))listeners.get(event)?.delete(fn);return this;},
    fire(name,event){for(const fn of listeners.get(name)||[])fn(event);},hasLayer:layer=>layers.has(layer),removeLayer(layer){layers.delete(layer);return this;}
  };
}

function fakeLeaflet(map){
  const layer=(url,options={})=>({url,options,addTo(){map.layers.add(this);return this;},remove(){map.layers.delete(this);}});
  return {tileLayer:(url,options)=>layer(url,options),imageOverlay:(url,bounds,options)=>layer(url,options),latLng:(lat,lng)=>({lat,lng})};
}

function memoryStore(){
  const values=new Map();return {values,async put(value){if(values.has(value.metadata.id))throw Error('duplicate');values.set(value.metadata.id,value);},async get(id){return values.get(id)||null;},async delete(id){return values.delete(id);}};
}

function storedAsset({id='3caa1022-b2e7-4c63-8ca8-12f4845e1be1',kind='historical-image',sha256=ASSET_SHA256,extraMetadata}={}){
  const blob=new Blob([ASSET_BYTES],{type:'image/png'});
  return {metadata:{id,kind,mime:'image/png',size:blob.size,width:2,height:1,sha256,createdAt:STAMP,...extraMetadata},blob};
}

function harness({providers=[provider({search:async()=>[result()]})],project,store:providedStore=memoryStore(),decodeImage,overlayFactory,hashBlob,saveProject,isAssetReferencedOutsideHistorical}={}){
  const dom=new JSDOM(HTML,{url:'https://app.test/',pretendToBeVisual:true}),document=dom.window.document,map=fakeMap(document),L=fakeLeaflet(map),assetStore=providedStore;
  let current=project||Object.assign(createProject(),{location:{...SITE}}),saveCalls=0;
  const controller=createHistoricalImageryUI({document,map,L,assetStore,providers,getProject:()=>current,
    saveProject:async next=>{const saved=saveProject?await saveProject(next,current):true;if(saved!==false){current={...current,historical:next.historical,historicalSequenceCounters:next.historicalSequenceCounters,updatedAt:next.updatedAt};saveCalls++;}return saved;},onChanged:()=>{},confirm:()=>true,
    ...(hashBlob?{hashBlob}:{}),...(isAssetReferencedOutsideHistorical?{isAssetReferencedOutsideHistorical}:{}),
    decodeImage:decodeImage|| (async file=>({blob:new Blob([await file.arrayBuffer()],{type:'image/png'}),mime:'image/png',width:2,height:1,geo:null})),
    overlayFactory:overlayFactory||(()=>({addTo(){return this;},remove(){},ready:Promise.resolve()}))});
  return {dom,document,map,L,store:assetStore,controller,get project(){return current;},get saveCalls(){return saveCalls;}};
}

test('historical codes use stored per-year sequences and do not renumber surviving IDs',()=>{
  const items=[{id:'a',year:1972,sequence:2},{id:'b',year:1960,sequence:1},{id:'c',year:1972,sequence:1}];
  assert.equal(historicalFigureCode(items,'a'),'H-1972-2');
  assert.equal(historicalFigureCode(items.filter(item=>item.id!=='c'),'a'),'H-1972-2');
  assert.equal(historicalFigureCode([...items].reverse(),'c'),'H-1972-1');
  assert.throws(()=>historicalFigureCode(items,'missing'),/not found/i);
});

test('historical modal focuses its primary field, traps reverse Tab, and restores focus on Escape',()=>{
  const h=harness(),launcher=h.document.getElementById('manageHistorical');launcher.focus();h.controller.open();
  assert.equal(h.document.activeElement,h.document.getElementById('historicalYear'));
  const close=h.document.getElementById('closeHistorical');close.focus();close.dispatchEvent(new h.dom.window.KeyboardEvent('keydown',{key:'Tab',shiftKey:true,bubbles:true,cancelable:true}));
  assert.equal(h.document.activeElement,h.document.getElementById('searchHistorical'));
  h.document.dispatchEvent(new h.dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
  assert.equal(h.document.getElementById('historicalDialog').hidden,true);assert.equal(h.document.activeElement,launcher);
  h.controller.destroy();h.dom.window.close();
});

test('search renders exact, nearby and opt-in remaining results as text while isolating provider retry errors',async()=>{
  let attempts=0;
  const good=provider({search:async()=>[
    result({id:'exact',title:'<img src=x onerror=alert(1)>'}),result({id:'near-a',year:1971}),result({id:'near-b',year:1973}),
    result({id:'near-c',year:1960}),result({id:'remaining',year:1950}),result({id:'link',year:1972,policy:'link-only'})
  ]});
  const failed=defineImageryProvider({...provider(),id:'failed',priority:2,search:async()=>{attempts++;if(attempts===1)throw Error('catalogue offline');return [];}});
  const h=harness({providers:[good,failed]});h.controller.open();
  h.document.getElementById('historicalYear').value='1972';h.document.getElementById('searchHistorical').click();await h.controller.whenIdle();
  assert.equal(h.document.querySelectorAll('[data-result-group="exact"] .historical-result').length,2);
  assert.equal(h.document.querySelectorAll('[data-result-group="nearby"] .historical-result').length,3);
  assert.equal(h.document.querySelector('[data-result-group="remaining"]').hidden,true);
  assert.equal(h.document.querySelector('.historical-result-title').textContent,'<img src=x onerror=alert(1)>');
  assert.equal(h.document.querySelector('.historical-result-title img'),null);
  assert.match(h.document.getElementById('historicalProviderErrors').textContent,/catalogue offline/i);
  h.document.querySelector('[data-retry-provider="failed"]').click();await h.controller.whenIdle();
  assert.doesNotMatch(h.document.getElementById('historicalProviderErrors').textContent,/catalogue offline/i);
  h.document.getElementById('showAllHistorical').click();assert.equal(h.document.querySelector('[data-result-group="remaining"]').hidden,false);
  const linkCard=[...h.document.querySelectorAll('.historical-result')].find(card=>card.textContent.includes('link-only'));
  assert.equal(linkCard.querySelector('button'),null);assert.equal(linkCard.querySelector('a').rel,'noopener noreferrer');
  h.controller.destroy();h.dom.window.close();
});

test('official preview/cancel restores the map and approval snapshots a provider-root export descriptor',async()=>{
  const h=harness();h.controller.open();h.document.getElementById('historicalYear').value='1972';h.document.getElementById('searchHistorical').click();await h.controller.whenIdle();
  h.document.querySelector('.historical-result button').click();await h.controller.whenIdle();
  assert.equal(h.document.getElementById('historicalCropControls').hidden,false);assert.equal(h.map.layers.size,1);assert.equal(h.document.getElementById('historicalDialog').classList.contains('historical-cropping'),true);
  h.document.getElementById('cancelHistoricalCrop').click();assert.equal(h.map.layers.size,0);assert.equal(h.document.getElementById('historicalCropControls').hidden,true);assert.equal(h.document.getElementById('historicalDialog').classList.contains('historical-cropping'),false);
  assert.equal(h.document.activeElement,h.document.getElementById('closeHistorical'),'crop cancel moves focus before hiding its active controls');
  h.document.querySelector('.historical-result button').click();await h.controller.whenIdle();
  const frame=h.document.getElementById('historicalCropFrame');
  assert.ok(Math.abs(Number.parseFloat(frame.style.width)-809.45)<.02,'visible frame uses 90% of the map while preserving the A3 ratio');
  const mapBounds=h.map.getBounds(),visibleSpan=mapBounds.getEast()-mapBounds.getWest();
  h.document.getElementById('useHistoricalCrop').click();h.document.getElementById('commitHistorical').click();await h.controller.whenIdle();
  assert.equal(h.project.historical.length,1,h.document.getElementById('historicalStatus').textContent);const item=h.project.historical[0];
  const expectedFraction=Number.parseFloat(frame.style.width)/h.map.getSize().x;
  assert.ok(Math.abs((item.bounds.east-item.bounds.west)/visibleSpan-expectedFraction)<1e-8,'saved crop matches the visible frame width');
  assert.equal(item.mode,'official');assert.equal(item.sequence,1);assert.equal(item.policy,'exportable');assert.equal(item.assetId,null);
  assert.deepEqual(item.officialExport,{kind:'arcgis-export',url:'https://official.test/maps/flight-1972/MapServer/export',layer:null,maxWidth:4096,maxHeight:4096,
    resultId:'official:flight-1972',coverage:{west:-80,south:43,east:-79,north:44},preview:{kind:'arcgis-map-service',url:'https://official.test/maps/flight-1972/MapServer',layer:null,tileTemplate:'https://official.test/maps/flight-1972/MapServer/tile/{z}/{y}/{x}'}});
  assert.equal(historicalFigureCode(h.project.historical,item.id),'H-1972-1');assert.equal(Object.keys(item).length,17);
  await h.controller.refresh();h.document.querySelector(`[data-historical-id="${item.id}"] [data-action="view"]`).click();await h.controller.whenIdle();
  assert.equal(h.map.layers.size,1);assert.match([...h.map.layers][0].url,/\/export\?.*f=image.*bbox=/);
  h.controller.destroy();h.dom.window.close();
});

test('closing during crop transfers focus to the dialog trigger before active controls are hidden',async()=>{
  const h=harness(),launcher=h.document.getElementById('manageHistorical');launcher.focus();h.controller.open();h.document.getElementById('historicalYear').value='1972';h.document.getElementById('searchHistorical').click();await h.controller.whenIdle();
  h.document.querySelector('.historical-result button').click();await h.controller.whenIdle();let cropVisibleAtFocus=false;launcher.addEventListener('focus',()=>{cropVisibleAtFocus=!h.document.getElementById('historicalCropControls').hidden;},{once:true});
  h.document.getElementById('closeHistorical').click();assert.equal(cropVisibleAtFocus,true);assert.equal(h.document.activeElement,launcher);assert.equal(h.document.getElementById('historicalDialog').hidden,true);h.controller.destroy();h.dom.window.close();
});

test('manual mode requires citation and permission, validates basename, stores before project metadata, and reports missing reload assets',async()=>{
  const h=harness();h.controller.open();h.document.getElementById('historicalManualMode').click();
  const image={name:'scan.png',size:4,type:'image/png',arrayBuffer:async()=>new Uint8Array([1,2,3,4]).buffer};
  const wrongWorld={name:'other.pgw',size:12,text:async()=>"1\n0\n0\n-1\n0\n0\n"};
  Object.defineProperty(h.document.getElementById('manualHistoricalFile'),'files',{value:[image],configurable:true});
  Object.defineProperty(h.document.getElementById('manualWorldFile'),'files',{value:[wrongWorld],configurable:true});
  h.document.getElementById('manualHistoricalYear').value='1960';h.document.getElementById('previewManualHistorical').click();await h.controller.whenIdle();
  assert.match(h.document.getElementById('historicalStatus').textContent,/source|citation|permission/i);
  h.document.getElementById('manualCitation').value='Municipal archive scan';h.document.getElementById('manualPermission').checked=true;
  h.document.getElementById('previewManualHistorical').click();await h.controller.whenIdle();assert.match(h.document.getElementById('historicalStatus').textContent,/basename/i);
  Object.defineProperty(h.document.getElementById('manualWorldFile'),'files',{value:[],configurable:true});
  h.document.getElementById('previewManualHistorical').click();await h.controller.whenIdle();
  h.document.getElementById('useHistoricalCrop').click();h.document.getElementById('commitHistorical').click();await h.controller.whenIdle();
  const item=h.project.historical[0];assert.equal(item.mode,'manual');assert.equal(item.title,'scan.png');assert.ok(h.store.values.has(item.assetId));
  assert.ok(item.placement);assert.equal(item.placement.sourceWidth,2);assert.equal(item.officialExport,null);
  await h.controller.refresh();assert.match(h.document.getElementById('historicalApprovedList').textContent,/Ready/i);
  await h.store.delete(item.assetId);await h.controller.refresh();assert.match(h.document.getElementById('historicalApprovedList').textContent,/Missing asset|Not ready/i);
  h.controller.destroy();h.dom.window.close();
});

test('approved list edit keeps codes stable and delete confirmation preserves the next sequence counter',async()=>{
  let searches=0;const h=harness({providers:[provider({search:async()=>{searches++;return [result()];}})]});
  async function add(){h.controller.open();h.document.getElementById('historicalYear').value='1972';h.document.getElementById('searchHistorical').click();await h.controller.whenIdle();h.document.querySelector('.historical-result button').click();await h.controller.whenIdle();h.document.getElementById('useHistoricalCrop').click();h.document.getElementById('commitHistorical').click();await h.controller.whenIdle();}
  await add();await add();const [first,second]=h.project.historical;assert.equal(historicalFigureCode(h.project.historical,second.id),'H-1972-2');h.controller.close();
  await h.controller.refresh();const firstRow=h.document.querySelector(`[data-historical-id="${first.id}"]`);firstRow.querySelector('[data-action="edit"]').click();
  await h.controller.whenIdle();assert.equal(searches,3,'official Edit reacquires current source coverage after the two initial searches');assert.equal(h.document.getElementById('historicalDialog').hidden,false);assert.equal(h.document.getElementById('historicalCropControls').hidden,false);assert.equal(h.document.activeElement,h.document.getElementById('useHistoricalCrop'));
  h.document.getElementById('useHistoricalCrop').click();h.document.getElementById('commitHistorical').click();await h.controller.whenIdle();
  assert.equal(historicalFigureCode(h.project.historical,first.id),'H-1972-1');
  h.document.querySelector(`[data-historical-id="${second.id}"] [data-action="delete"]`).click();await h.controller.whenIdle();
  assert.equal(h.project.historicalSequenceCounters['1972'],2);assert.equal(historicalFigureCode(h.project.historical,first.id),'H-1972-1');
  h.controller.destroy();h.dom.window.close();
});

test('legacy migration commits metadata only after every decoded asset and rolls back new assets and project save on failure',async()=>{
  const original=Object.assign(createProject(),{location:{...SITE},historical:[
    {id:'old-a',year:1960,name:'a.png',size:1,dataUrl:'data:image/png;base64,AQ=='},
    {id:'old-b',year:1970,name:'b.png',size:1,dataUrl:'data:image/png;base64,Ag=='}
  ]});
  const values=new Map();let puts=0,saves=0;
  const store={async put(asset){puts++;if(puts===2)throw Error('quota');values.set(asset.metadata.id,asset);},async delete(id){values.delete(id);}};
  await assert.rejects(()=>migrateLegacyHistoricalImagery({project:original,assetStore:store,saveProject:()=>{saves++;},
    decodeImage:async file=>({blob:new Blob([await file.arrayBuffer()],{type:'image/png'}),mime:'image/png',width:1,height:1,geo:null})}),/backup|quota/i);
  assert.equal(values.size,0);assert.equal(saves,0);assert.equal(original.historical[0].dataUrl,'data:image/png;base64,AQ==');
});

test('successful legacy migration writes all assets, then persists a cloned approved project without mutating the source',async()=>{
  const original=Object.assign(createProject(),{location:{...SITE},historical:[{id:'old-a',year:1960,name:'a.png',size:1,dataUrl:'data:image/png;base64,AQ=='}]});
  const store=memoryStore();let saved;
  const migrated=await migrateLegacyHistoricalImagery({project:original,assetStore:store,saveProject:value=>{saved=value;return true;},
    uuid:()=> '74f14168-4de6-4c5f-88f4-87db8ec731c2',now:()=> '2026-08-27T12:00:00.000Z',
    decodeImage:async file=>({blob:new Blob([await file.arrayBuffer()],{type:'image/png'}),mime:'image/png',width:2,height:1,geo:null})});
  assert.equal(store.values.size,1);assert.equal(saved,migrated.project);assert.equal(saved.historical[0].mode,'manual');assert.equal(saved.historical[0].sequence,1);
  const bounds=saved.historical[0].bounds,sw=projectWebMercator([bounds.west,bounds.south]),ne=projectWebMercator([bounds.east,bounds.north]);
  assert.ok(Math.abs((ne[0]-sw[0])/(ne[1]-sw[1])-420/297)<1e-6,'migration chooses an A3 crop inside the source placement');
  assert.equal(original.historical[0].dataUrl,'data:image/png;base64,AQ==');assert.equal(Object.hasOwn(saved.historical[0],'dataUrl'),false);
});

test('manual save snapshots one selected file and stale cancel or replacement cannot corrupt the asset transaction',async()=>{
  const hashing=deferred(),started=deferred();let hashedBytes;
  const h=harness({hashBlob:async blob=>{hashedBytes=[...new Uint8Array(await blob.arrayBuffer())];started.resolve();return hashing.promise;}});
  h.controller.open();h.document.getElementById('historicalManualMode').click();
  const input=h.document.getElementById('manualHistoricalFile'),year=h.document.getElementById('manualHistoricalYear'),citation=h.document.getElementById('manualCitation');
  const fileA={name:'a.png',size:3,type:'image/png',arrayBuffer:async()=>new Uint8Array([1,2,3]).buffer};
  const fileB={name:'b.png',size:3,type:'image/png',arrayBuffer:async()=>new Uint8Array([7,8,9]).buffer};
  Object.defineProperty(input,'files',{value:[fileA],configurable:true});year.value='1960';citation.value='Archive A';h.document.getElementById('manualPermission').checked=true;
  h.document.getElementById('previewManualHistorical').click();await h.controller.whenIdle();h.document.getElementById('useHistoricalCrop').click();h.document.getElementById('commitHistorical').click();
  await Promise.race([started.promise,new Promise((_,reject)=>setTimeout(()=>reject(Error('manual save did not invoke the controlled hash operation')),100))]);
  h.document.getElementById('cancelHistoricalCrop').click();Object.defineProperty(input,'files',{value:[fileB],configurable:true});year.value='1970';citation.value='Archive B';h.document.getElementById('previewManualHistorical').click();
  hashing.resolve('a'.repeat(64));await eventually(()=>h.saveCalls===1,'manual save did not settle');
  const item=h.project.historical[0],asset=await h.store.get(item.assetId);
  assert.deepEqual(hashedBytes,[1,2,3]);assert.deepEqual([...new Uint8Array(await asset.blob.arrayBuffer())],[1,2,3]);
  assert.equal(item.title,'a.png');assert.equal(item.attribution,'Archive A');assert.equal(item.year,1960);assert.equal(asset.metadata.sha256,'a'.repeat(64));
  h.controller.destroy();h.dom.window.close();
});

test('destroy aborts a manual hash transaction and compensates a save that completes after ownership is lost',async()=>{
  async function stagedManual(h){
    h.controller.open();h.document.getElementById('historicalManualMode').click();const file={name:'staged.png',size:3,type:'image/png',arrayBuffer:async()=>new Uint8Array([1,2,3]).buffer};
    Object.defineProperty(h.document.getElementById('manualHistoricalFile'),'files',{value:[file],configurable:true});h.document.getElementById('manualHistoricalYear').value='1960';h.document.getElementById('manualCitation').value='Archive';h.document.getElementById('manualPermission').checked=true;
    h.document.getElementById('previewManualHistorical').click();await h.controller.whenIdle();h.document.getElementById('useHistoricalCrop').click();h.document.getElementById('commitHistorical').click();
  }
  const hashStarted=deferred(),hashGate=deferred(),first=harness({hashBlob:async()=>{hashStarted.resolve();return hashGate.promise;}});await stagedManual(first);await hashStarted.promise;first.controller.destroy();hashGate.resolve('a'.repeat(64));await first.controller.whenIdle();
  assert.equal(first.project.historical.length,0);assert.equal(first.store.values.size,0);first.dom.window.close();

  const saveStarted=deferred(),saveGate=deferred();let saveAttempt=0;
  const second=harness({hashBlob:async()=> 'b'.repeat(64),saveProject:async()=>{saveAttempt++;if(saveAttempt===1){saveStarted.resolve();await saveGate.promise;}return true;}});await stagedManual(second);await saveStarted.promise;second.project.name='Concurrent project name';second.project.siteBoundary=[[-79.4,43.64],[-79.3,43.64],[-79.3,43.7],[-79.4,43.64]];second.controller.destroy();saveGate.resolve();await second.controller.whenIdle();
  assert.equal(second.project.historical.length,0,'late save compensation reverses only its historical item');assert.equal(second.project.name,'Concurrent project name');assert.equal(second.project.siteBoundary.length,4,'scoped compensation preserves unrelated geometry');assert.equal(second.store.values.size,0,'compensated save rolls back its unreferenced asset');assert.equal(saveAttempt,2);
  second.dom.window.close();
});

test('manual save rebases its historical delta after hashing and never overwrites concurrent project edits',async()=>{
  const hashStarted=deferred(),hashGate=deferred(),h=harness({hashBlob:async()=>{hashStarted.resolve();return hashGate.promise;}});
  h.controller.open();h.document.getElementById('historicalManualMode').click();const file={name:'concurrent.png',size:3,type:'image/png',arrayBuffer:async()=>ASSET_BYTES.slice().buffer};
  Object.defineProperty(h.document.getElementById('manualHistoricalFile'),'files',{value:[file],configurable:true});h.document.getElementById('manualHistoricalYear').value='1960';h.document.getElementById('manualCitation').value='Archive';h.document.getElementById('manualPermission').checked=true;
  h.document.getElementById('previewManualHistorical').click();await h.controller.whenIdle();h.document.getElementById('useHistoricalCrop').click();h.document.getElementById('commitHistorical').click();await hashStarted.promise;
  h.project.name='Edited while hashing';h.project.buildingBoundary=[[-79.39,43.64],[-79.37,43.64],[-79.37,43.66],[-79.39,43.64]];hashGate.resolve(ASSET_SHA256);await h.controller.whenIdle();
  assert.equal(h.project.name,'Edited while hashing');assert.equal(h.project.buildingBoundary.length,4);assert.equal(h.project.historical.length,1);
  h.controller.destroy();h.dom.window.close();
});

test('manual save rejects a crop when SITE moves during hashing and preserves the newer SITE',async()=>{
  const hashStarted=deferred(),hashGate=deferred(),h=harness({hashBlob:async()=>{hashStarted.resolve();return hashGate.promise;}});
  h.controller.open();h.document.getElementById('historicalManualMode').click();const file={name:'moved.png',size:3,type:'image/png',arrayBuffer:async()=>ASSET_BYTES.slice().buffer};
  Object.defineProperty(h.document.getElementById('manualHistoricalFile'),'files',{value:[file],configurable:true});h.document.getElementById('manualHistoricalYear').value='1960';h.document.getElementById('manualCitation').value='Archive';h.document.getElementById('manualPermission').checked=true;
  h.document.getElementById('previewManualHistorical').click();await h.controller.whenIdle();h.document.getElementById('useHistoricalCrop').click();h.document.getElementById('commitHistorical').click();await hashStarted.promise;
  h.project.location={lat:44.5,lng:-80.5};hashGate.resolve(ASSET_SHA256);await h.controller.whenIdle();
  assert.deepEqual(h.project.location,{lat:44.5,lng:-80.5});assert.equal(h.project.historical.length,0);assert.equal(h.store.values.size,0);assert.match(h.document.getElementById('historicalStatus').textContent,/SITE|crop|placement/i);
  h.controller.destroy();h.dom.window.close();
});

test('saved official readiness follows current provider policy and Leaflet receives only escaped registered attribution',async()=>{
  const project=Object.assign(createProject(),{location:{...SITE},historical:[officialItem({attribution:'<img src=x onerror=alert(1)>'})],historicalSequenceCounters:{'1972':1}});
  const h=harness({project,providers:[provider({attribution:'<b>Registered archive</b>'})]});await h.controller.refresh();
  const row=h.document.querySelector('[data-historical-id]');row.querySelector('[data-action="view"]').click();await h.controller.whenIdle();
  assert.equal(h.document.getElementById('historicalDialog').hidden,false);assert.equal(h.document.getElementById('historicalViewControls').hidden,false);
  assert.equal(h.document.activeElement,h.document.getElementById('cancelHistoricalView'));
  const layer=[...h.map.layers][0];assert.equal(layer.options.attribution,'&lt;b&gt;Registered archive&lt;/b&gt;');assert.doesNotMatch(layer.options.attribution,/<[a-z]/i);
  h.document.getElementById('cancelHistoricalView').click();assert.equal(h.map.layers.size,0);assert.equal(h.document.getElementById('historicalViewControls').hidden,true);
  assert.equal(h.document.activeElement,h.document.getElementById('closeHistorical'),'view cancel moves focus before hiding its active controls');
  h.controller.destroy();h.dom.window.close();

  for(const [policy,kind] of [['link-only','arcgis-export'],['exportable','unsupported-export']]){
    const next=Object.assign(createProject(),{location:{...SITE},historical:[officialItem({kind})],historicalSequenceCounters:{'1972':1}});
    const downgraded=harness({project:next,providers:[provider({policy})]});await downgraded.controller.refresh();
    const saved=downgraded.document.querySelector('[data-historical-id]');assert.match(saved.textContent,/Not ready|unavailable/i);assert.equal(saved.querySelector('[data-action="view"]').disabled,true);assert.equal(saved.querySelector('[data-action="edit"]').disabled,true);
    downgraded.controller.destroy();downgraded.dom.window.close();
  }
});

test('deleting a shared manual asset keeps it while a surviving approved item references it',async()=>{
  const assetId='3caa1022-b2e7-4c63-8ca8-12f4845e1be1',store=memoryStore();
  await store.put(storedAsset({id:assetId}));
  const first=manualItem({assetId,sequence:1}),second=manualItem({id:'9833e469-c7e8-4ef1-84f1-b89c608c2126',assetId,sequence:2});
  const project=Object.assign(createProject(),{location:{...SITE},historical:[first,second],historicalSequenceCounters:{'1960':2}}),h=harness({project,store});
  await h.controller.refresh();h.document.querySelector(`[data-historical-id="${first.id}"] [data-action="delete"]`).click();await h.controller.whenIdle();
  assert.deepEqual(h.project.historical.map(item=>item.id),[second.id]);assert.ok(await store.get(assetId));
  await h.controller.refresh();assert.match(h.document.querySelector(`[data-historical-id="${second.id}"]`).textContent,/Ready/i);
  h.controller.destroy();h.dom.window.close();
});

test('failed project persistence never deletes the manual asset or approved item',async()=>{
  const assetId='3caa1022-b2e7-4c63-8ca8-12f4845e1be1',store=memoryStore();
  await store.put(storedAsset({id:assetId}));
  const item=manualItem({assetId}),project=Object.assign(createProject(),{location:{...SITE},historical:[item],historicalSequenceCounters:{'1960':1}}),h=harness({project,store,saveProject:async()=>false});
  await h.controller.refresh();h.document.querySelector('[data-action="delete"]').click();await h.controller.whenIdle();assert.equal(h.project.historical.length,1);assert.ok(await store.get(assetId));
  h.controller.destroy();h.dom.window.close();
});

test('delete persists only its historical delta while an async save overlaps unrelated edits',async()=>{
  const store=memoryStore(),asset=storedAsset();await store.put(asset);const project=Object.assign(createProject(),{location:{...SITE},historical:[manualItem({assetId:asset.metadata.id})],historicalSequenceCounters:{'1960':1}}),saveStarted=deferred(),saveGate=deferred();
  const h=harness({project,store,saveProject:async()=>{saveStarted.resolve();await saveGate.promise;return true;}});await h.controller.refresh();h.document.querySelector('[data-action="delete"]').click();await saveStarted.promise;
  h.project.name='Edited while delete saved';h.project.siteBoundary=[[-79.4,43.64],[-79.3,43.64],[-79.3,43.7],[-79.4,43.64]];saveGate.resolve();await h.controller.whenIdle();
  assert.equal(h.project.historical.length,0);assert.equal(h.project.name,'Edited while delete saved');assert.equal(h.project.siteBoundary.length,4);assert.equal(await store.get(asset.metadata.id),null);h.controller.destroy();h.dom.window.close();
});

test('late manual View and Edit asset reads cannot create overlays after destroy and actions open their dialog',async()=>{
  for(const action of ['view','edit']){
    const assetId='3caa1022-b2e7-4c63-8ca8-12f4845e1be1',asset=storedAsset({id:assetId});
    const late=deferred();let delayed=false,adds=0;
    const store={async put(){},async delete(){},async get(){return delayed?late.promise:asset;}};
    const project=Object.assign(createProject(),{location:{...SITE},historical:[manualItem({assetId})],historicalSequenceCounters:{'1960':1}});
    const h=harness({project,store,overlayFactory:()=>({addTo(){adds++;return this;},remove(){},ready:Promise.resolve()})});await h.controller.refresh();delayed=true;
    h.document.querySelector(`[data-action="${action}"]`).click();assert.equal(h.document.getElementById('historicalDialog').hidden,false,`${action} opens the owning dialog`);
    h.controller.destroy();late.resolve(asset);await new Promise(resolve=>setTimeout(resolve,5));assert.equal(adds,0,`${action} cannot add an overlay after destroy`);h.dom.window.close();
  }
});

test('late world-file and overlay completions are cleaned after close',async()=>{
  const worldRead=deferred(),worldStarted=deferred(),overlayReady=deferred();let adds=0,removes=0,currentReady=Promise.resolve();
  const h=harness({overlayFactory:()=>({addTo(){adds++;return this;},remove(){removes++;},ready:currentReady})});h.controller.open();h.document.getElementById('historicalManualMode').click();
  const image={name:'scan.png',size:3,type:'image/png',arrayBuffer:async()=>new Uint8Array([1,2,3]).buffer},world={name:'scan.pgw',size:12,text:()=>{worldStarted.resolve();return worldRead.promise;}};
  Object.defineProperty(h.document.getElementById('manualHistoricalFile'),'files',{value:[image],configurable:true});Object.defineProperty(h.document.getElementById('manualWorldFile'),'files',{value:[world],configurable:true});
  h.document.getElementById('manualHistoricalYear').value='1960';h.document.getElementById('manualCitation').value='Archive';h.document.getElementById('manualPermission').checked=true;
  h.document.getElementById('previewManualHistorical').click();await worldStarted.promise;h.controller.close();worldRead.resolve('1\n0\n0\n-1\n-79.38\n43.65\n');await h.controller.whenIdle();
  assert.equal(adds,0);assert.equal(h.document.getElementById('historicalDialog').hidden,true);

  h.controller.open();currentReady=overlayReady.promise;Object.defineProperty(h.document.getElementById('manualWorldFile'),'files',{value:[],configurable:true});h.document.getElementById('previewManualHistorical').click();await eventually(()=>adds===1);h.controller.close();assert.ok(removes>=1);overlayReady.resolve();await h.controller.whenIdle();assert.equal(h.document.getElementById('historicalDialog').hidden,true);
  h.controller.destroy();h.dom.window.close();
});

test('search and approved list expose accessible metadata thumbnails and explicit coverage or placement status',async()=>{
  const store=memoryStore(),assetId='3caa1022-b2e7-4c63-8ca8-12f4845e1be1';
  await store.put(storedAsset({id:assetId}));
  const project=Object.assign(createProject(),{location:{...SITE},historical:[manualItem({assetId})],historicalSequenceCounters:{'1960':1}}),h=harness({project,store});
  h.controller.open();h.document.getElementById('historicalYear').value='1972';h.document.getElementById('searchHistorical').click();await h.controller.whenIdle();
  const resultCard=h.document.querySelector('.historical-result');assert.equal(resultCard.querySelector('.historical-result-thumbnail').getAttribute('role'),'img');assert.match(resultCard.querySelector('.historical-result-thumbnail').textContent,/1972|Official archive/i);assert.match(resultCard.querySelector('.historical-coverage-status').textContent,/SITE.*crop/i);
  await h.controller.refresh();let approved=h.document.querySelector('[data-historical-id]');assert.equal(approved.querySelector('.historical-approved-thumbnail').getAttribute('role'),'img');assert.match(approved.querySelector('.historical-placement-status').textContent,/placement|crop|SITE/i);
  await store.delete(assetId);await h.controller.refresh();approved=h.document.querySelector('[data-historical-id]');assert.ok(approved.querySelector('.historical-approved-thumbnail'));assert.match(approved.querySelector('.historical-placement-status').textContent,/Missing asset/i);
  h.controller.destroy();h.dom.window.close();
});

test('foreign, malformed, or hash-mismatched assets are never ready, previewed, or deleted by historical imagery',async()=>{
  for(const asset of [storedAsset({kind:'company-logo'}),storedAsset({sha256:'0'.repeat(64)}),storedAsset({extraMetadata:{owner:'other'}})]){
    const store=memoryStore();await store.put(asset);const project=Object.assign(createProject(),{location:{...SITE},historical:[manualItem({assetId:asset.metadata.id})],historicalSequenceCounters:{'1960':1}}),h=harness({project,store});
    await h.controller.refresh();const row=h.document.querySelector('[data-historical-id]');assert.match(row.textContent,/Not ready/i);assert.equal(row.querySelector('[data-action="view"]').disabled,true);assert.equal(row.querySelector('[data-action="edit"]').disabled,true);
    row.querySelector('[data-action="delete"]').click();await h.controller.whenIdle();assert.equal(h.project.historical.length,0);assert.ok(await store.get(asset.metadata.id),'historical deletion preserves an asset it does not own and verify');h.controller.destroy();h.dom.window.close();
  }
});

test('an imagery asset referenced by another subsystem is preserved after its last historical item is deleted',async()=>{
  const store=memoryStore(),asset=storedAsset();await store.put(asset);const project=Object.assign(createProject(),{location:{...SITE},historical:[manualItem({assetId:asset.metadata.id})],historicalSequenceCounters:{'1960':1}});
  const h=harness({project,store,isAssetReferencedOutsideHistorical:id=>id===asset.metadata.id});await h.controller.refresh();h.document.querySelector('[data-action="delete"]').click();await h.controller.whenIdle();
  assert.equal(h.project.historical.length,0);assert.ok(await store.get(asset.metadata.id));h.controller.destroy();h.dom.window.close();
});

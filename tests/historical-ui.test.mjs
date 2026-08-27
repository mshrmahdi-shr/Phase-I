import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';
import {IDBFactory} from 'fake-indexeddb';
import {createAssetStore} from '../src/asset-store.mjs';
import {createProject} from '../src/core.mjs';
import {defineImageryProvider} from '../src/imagery/provider-registry.mjs';
import {projectWebMercator} from '../src/imagery/placement.mjs';
import {createHistoricalImageryUI,historicalFigureCode,migrateLegacyHistoricalImagery} from '../src/historical-ui.mjs';

const HTML=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const SITE={lat:43.65,lng:-79.38};
const BOUNDS={north:43.66,south:43.64,east:-79.37,west:-79.39};

function result({id='flight-1972',year=1972,title='Aerial 1972',policy='exportable'}={}){
  const exportable=policy==='exportable';
  return {id,providerId:'official',title,year,resolutionMeters:.25,coverage:{west:-80,south:43,east:-79,north:44},
    preview:exportable?{kind:'arcgis-map-service',url:`https://official.test/maps/${id}/MapServer`,tileTemplate:`https://official.test/maps/${id}/MapServer/tile/{z}/{y}/{x}`}:{kind:'official-link',url:`https://official.test/maps/${id}/MapServer`},
    export:exportable?{kind:'arcgis-export',url:`https://official.test/maps/${id}/MapServer/export`,maxWidth:4096,maxHeight:4096}:null,
    policy,sourceUrl:`https://official.test/maps/${id}/MapServer`,licenseUrl:'https://official.test/license/',attribution:'Official archive'};
}

function provider({search=async()=>[]}={}){
  return defineImageryProvider({id:'official',label:'Official archive',organization:'Official archive',priority:1,
    coverage:{west:-80,south:43,east:-79,north:44},licenseUrl:'https://official.test/license/',attribution:'Official archive',policy:'exportable',
    allowedOrigins:['https://official.test'],allowedRoots:['https://official.test/maps/','https://official.test/license/'],covers:()=>true,search});
}

function boundsObject(value=BOUNDS){return {getNorth:()=>value.north,getSouth:()=>value.south,getEast:()=>value.east,getWest:()=>value.west};}
function fakeMap(document){
  let bounds={...BOUNDS},center={lat:SITE.lat,lng:SITE.lng},zoom=16;const listeners=new Map(),layers=new Set();
  const container=document.getElementById('map');Object.defineProperties(container,{clientWidth:{value:900,configurable:true},clientHeight:{value:636,configurable:true}});
  return {
    layers,listeners,getContainer:()=>container,getBounds:()=>boundsObject(bounds),getCenter:()=>({...center}),getZoom:()=>zoom,getSize:()=>({x:900,y:636}),
    containerPointToLatLng:([x,y])=>({lat:bounds.north-(bounds.north-bounds.south)*y/636,lng:bounds.west+(bounds.east-bounds.west)*x/900}),
    fitBounds(value){const pair=Array.isArray(value)?value:[[value.south,value.west],[value.north,value.east]];bounds={south:pair[0][0],west:pair[0][1],north:pair[1][0],east:pair[1][1]};center={lat:(bounds.north+bounds.south)/2,lng:(bounds.east+bounds.west)/2};return this;},
    setView(value,nextZoom){center={lat:value.lat??value[0],lng:value.lng??value[1]};zoom=nextZoom;return this;},
    on(name,fn){for(const event of name.split(' ')){if(!listeners.has(event))listeners.set(event,new Set());listeners.get(event).add(fn);}return this;},
    off(name,fn){for(const event of name.split(' '))listeners.get(event)?.delete(fn);return this;},
    fire(name,event){for(const fn of listeners.get(name)||[])fn(event);},hasLayer:layer=>layers.has(layer),removeLayer(layer){layers.delete(layer);return this;}
  };
}

function fakeLeaflet(map){
  const layer=url=>({url,addTo(){map.layers.add(this);return this;},remove(){map.layers.delete(this);}});
  return {tileLayer:url=>layer(url),imageOverlay:url=>layer(url),latLng:(lat,lng)=>({lat,lng})};
}

function memoryStore(){
  const values=new Map();return {values,async put(value){if(values.has(value.metadata.id))throw Error('duplicate');values.set(value.metadata.id,value);},async get(id){return values.get(id)||null;},async delete(id){return values.delete(id);}};
}

function harness({providers=[provider({search:async()=>[result()]})],project}={}){
  const dom=new JSDOM(HTML,{url:'https://app.test/',pretendToBeVisual:true}),document=dom.window.document,map=fakeMap(document),L=fakeLeaflet(map),store=memoryStore();
  let current=project||Object.assign(createProject(),{location:{...SITE}}),saveCalls=0;
  const controller=createHistoricalImageryUI({document,map,L,assetStore:store,providers,getProject:()=>current,
    saveProject:next=>{current=next;saveCalls++;return true;},onChanged:()=>{},confirm:()=>true,
    decodeImage:async file=>({blob:new Blob([await file.arrayBuffer()],{type:'image/png'}),mime:'image/png',width:2,height:1,geo:null}),
    overlayFactory:()=>({addTo(){return this;},remove(){},ready:Promise.resolve()})});
  return {dom,document,map,L,store,controller,get project(){return current;},get saveCalls(){return saveCalls;}};
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
  h.document.querySelector('.historical-result button').click();await h.controller.whenIdle();
  const frame=h.document.getElementById('historicalCropFrame');
  assert.ok(Math.abs(Number.parseFloat(frame.style.width)-809.45)<.02,'visible frame uses 90% of the map while preserving the A3 ratio');
  const mapBounds=h.map.getBounds(),visibleSpan=mapBounds.getEast()-mapBounds.getWest();
  h.document.getElementById('useHistoricalCrop').click();h.document.getElementById('commitHistorical').click();await h.controller.whenIdle();
  assert.equal(h.project.historical.length,1);const item=h.project.historical[0];
  const expectedFraction=Number.parseFloat(frame.style.width)/h.map.getSize().x;
  assert.ok(Math.abs((item.bounds.east-item.bounds.west)/visibleSpan-expectedFraction)<1e-8,'saved crop matches the visible frame width');
  assert.equal(item.mode,'official');assert.equal(item.sequence,1);assert.equal(item.policy,'exportable');assert.equal(item.assetId,null);
  assert.deepEqual(item.officialExport,{kind:'arcgis-export',url:'https://official.test/maps/flight-1972/MapServer/export',layer:null,maxWidth:4096,maxHeight:4096});
  assert.equal(historicalFigureCode(h.project.historical,item.id),'H-1972-1');assert.equal(Object.keys(item).length,17);
  await h.controller.refresh();h.document.querySelector(`[data-historical-id="${item.id}"] [data-action="view"]`).click();await h.controller.whenIdle();
  assert.equal(h.map.layers.size,1);assert.match([...h.map.layers][0].url,/\/export\?.*f=image.*bbox=/);
  h.controller.destroy();h.dom.window.close();
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
  await add();await add();const [first,second]=h.project.historical;assert.equal(historicalFigureCode(h.project.historical,second.id),'H-1972-2');
  await h.controller.refresh();const firstRow=h.document.querySelector(`[data-historical-id="${first.id}"]`);firstRow.querySelector('[data-action="edit"]').click();
  await h.controller.whenIdle();assert.equal(searches,3,'official Edit reacquires current source coverage after the two initial searches');
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

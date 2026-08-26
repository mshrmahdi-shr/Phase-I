import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import fs from 'node:fs';
import {createProject} from '../src/core.mjs';

test('index exposes the core Phase I workflow controls', () => {
  const html=fs.readFileSync(new URL('../index.html', import.meta.url),'utf8');
  for (const id of ['address','searchAddress','drawSite','drawBuilding','finishDraw','figureList','uploadAerial','uploadGeology','printA3','exportDxf']) {
    assert.match(html,new RegExp(`id=["']${id}["']`),`missing #${id}`);
  }
});

test('print panel stays visible until all live requirements are corrected',async()=>{
  const {createPreflight}=await import('../print-preflight.mjs');
  const dom=new JSDOM('<button id="printA3"></button><div id="printValidation" hidden></div>');
  let state={project:{},figureCode:'A'};
  const controller=createPreflight({document:dom.window.document,getState:()=>state});
  assert.equal(controller.check(),false);
  const panel=dom.window.document.getElementById('printValidation');
  assert.equal(panel.hidden,false);
  state.project.name='Filled';controller.refresh();
  assert.equal(panel.hidden,false);
  assert.equal(panel.querySelectorAll('li').length,4);
  state.project={name:'Ready',projectNo:'1',date:'2026-08-26',address:'Public test site',location:{lat:43,lng:-79}};
  controller.refresh();assert.equal(panel.hidden,true);
  state.figureCode='D';state.geologyLoaded=true;state.geologySiteUnit=null;
  assert.equal(controller.check(),false);
  assert.match(panel.textContent,/detected/);
});

test('app uses assigned sources, keeps Toporama on C, shows source failure, and shares a segmented scale',async t=>{
  const dom=new JSDOM(fs.readFileSync(new URL('../index.html',import.meta.url),'utf8'),{url:'https://example.test/',pretendToBeVisual:true});
  const previous={};
  for(const key of ['window','document','navigator','localStorage','location','L','JSZip','DOMParser','Element','fetch'])previous[key]=Object.getOwnPropertyDescriptor(globalThis,key);
  for(const key of ['window','document','navigator','localStorage','location','DOMParser','Element'])Object.defineProperty(globalThis,key,{value:key==='window'?dom.window:dom.window[key],configurable:true,writable:true});
  const L=(await import('leaflet')).default;globalThis.L=L;globalThis.JSZip=(await import('jszip')).default;
  L.Browser.svg=true;
  let map;L.Map.addInitHook(function(){map=this;});
  const document=dom.window.document,$=id=>document.getElementById(id),container=$('map');
  Object.defineProperties(container,{clientWidth:{value:900},clientHeight:{value:650}});
  const p={...createProject({name:'QA',projectNo:'FE 26-15876',address:'Toronto',date:'2026-08-26'}),location:{lat:43.65,lng:-79.38}};
  localStorage.setItem('phase-i-esa-project-v2',JSON.stringify(p));
  globalThis.fetch=async()=>{throw Error('No network in this test');};
  t.after(()=>{map?.remove();dom.window.close();for(const [key,descriptor] of Object.entries(previous))descriptor?Object.defineProperty(globalThis,key,descriptor):delete globalThis[key];});
  await import('../app.js?source-integration');
  const choose=code=>[...document.querySelectorAll('.figure-row')].find(row=>row.querySelector('.figure-code').textContent===`FIGURE ${code}`).querySelector('button').click();
  assert.equal($('projectNo').value,'FE 26-15876');assert.equal($('projectNo').placeholder,'AB-12345');
  choose('C');
  const layers=()=>Object.values(map._layers).filter(layer=>layer instanceof L.TileLayer);
  assert.equal(layers().length,1);assert.match(layers()[0]._url,/toporama_en$/);
  document.querySelector('[data-map="satellite"]').click();assert.match(layers()[0]._url,/toporama_en$/);
  layers()[0].fire('tileerror');assert.match($('mapSourceStatus').textContent,/Toporama.*failed|failed.*Toporama/i);
  assert.equal(document.querySelectorAll('#metricScale .scale-segment').length,4);
  assert.match($('metricScale').textContent,/Approximate ground scale/);
  assert.match($('metricScale').textContent,/\d.*m/);
  assert.equal(layers()[0].options.maxZoom,24);
  choose('A');document.querySelector('[data-map="satellite"]').click();
  assert.match(layers()[0]._url,/World_Imagery/);
  await $('printA3').onclick();assert.match(layers()[0]._url,/tile.openstreetmap.org/);
  $('closePrint').click();
  map.setView([43.651,-79.381],16,{animate:false});
  const row=code=>[...document.querySelectorAll('.figure-row')].find(item=>item.querySelector('.figure-code').textContent===`FIGURE ${code}`);
  row('B').querySelectorAll('button')[1].click();
  const savedView=JSON.parse(localStorage.getItem('phase-i-esa-project-v2')).figures.B;
  assert.ok(savedView.bounds&&savedView.extentMeters>100,'Use for A3 must persist the visible map extent');
  assert.notEqual(row('B').querySelector('.badge').textContent,'100 m');
  assert.match($('mapSourceStatus').textContent,/Figure B.*saved/i);
  choose('A');row('B').querySelectorAll('button')[0].click();
  const restored=map.getBounds();
  assert.ok(restored.getNorth()>=savedView.bounds.north&&restored.getSouth()<=savedView.bounds.south);
  assert.ok(restored.getEast()>=savedView.bounds.east&&restored.getWest()<=savedView.bounds.west);
  assert.match($('mapSourceStatus').textContent,/Figure B.*restored/i);
  $('exportPdf').click();assert.equal($('exportDialog').hidden,false);
  $('selectAllReady').click();assert.equal($('downloadPdf').textContent,'Download PDF (2 sheets)');
  $('cancelExport').click();
  await t.test('official Bedrock commits source only for the current SITE and custom reload stays explicit',async t=>{
    const feature={name:'55B — Georgian Bay Formation',description:'Official test unit',unitCode:'55b',color:'#99bb88',fillOpacity:.6,
      polygon:[[-80,43],[-79,43],[-79,44],[-80,44],[-80,43]],holes:[]};
    const manifest={version:1,source:'MRD126-REV1',complete:true,cachedAt:'2026-08-26T12:00:00Z',counts:{expected:1,saved:1,failed:0,pending:0},
      files:[{path:'files/test.json',featureCount:1,bounds:{west:-80,south:43,east:-79,north:44}}]};
    let release;const gate=new Promise(resolve=>release=resolve),requests=[];
    globalThis.fetch=async url=>{requests.push(url);if(url.endsWith('manifest.json'))await gate;return {ok:true,json:async()=>url.endsWith('manifest.json')?manifest:{features:[feature]}};};
    choose('E');assert.equal(requests.length,1,'Figure E automatically starts its official cache load');
    const marker=Object.values(map._layers).find(layer=>layer instanceof L.Marker);marker.setLatLng([43.66,-79.38]);marker.fire('dragend');
    release();await new Promise(resolve=>setTimeout(resolve,0));
    assert.match($('geologyStatus').textContent,/SITE changed/);
    assert.equal(JSON.parse(localStorage.getItem('phase-i-esa-project-v2')).geology.bedrock,null);
    await $('loadBedrock').onclick();
    assert.equal(JSON.parse(localStorage.getItem('phase-i-esa-project-v2')).geology.bedrock.source.id,'MRD126-REV1');
    $('exportPdf').click();assert.equal($('exportFigureE').disabled,false);$('cancelExport').click();
    const text='<kml><Document><Placemark><name>55b Custom meaning</name><description>Customer geology</description><Polygon><outerBoundaryIs><LinearRing><coordinates>-80,43 -79,43 -79,44 -80,44 -80,43</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></Document></kml>';
    $('geologyKind').value='bedrock';await $('uploadGeology').onchange({target:{files:[{name:'customer.kml',text:async()=>text}]}});
    const count=requests.length;choose('A');choose('E');
    assert.equal(requests.length,count);assert.match($('geoLegend').textContent,/Custom meaning/);
    assert.equal(JSON.parse(localStorage.getItem('phase-i-esa-project-v2')).geology.bedrock.source.id,'custom');
    // Exercise the real exporter through its cancellation path. Only browser
    // canvas and external I/O boundaries are substituted; jsPDF stays real.
    let releaseLoad,startImagery;
    const loadGate=new Promise(resolve=>releaseLoad=resolve),imageryStarted=new Promise(resolve=>startImagery=resolve);
    globalThis.fetch=async(url,{signal}={})=>{
      if(url.includes('/mrd126-cache/')){if(url.endsWith('manifest.json'))await loadGate;return {ok:true,json:async()=>url.endsWith('manifest.json')?manifest:{features:[feature]}};}
      startImagery();return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
    };
    const loading=$('loadBedrock').onclick();
    container.scrollIntoView=()=>{};$('drawSite').click();map.fire('click',{latlng:L.latLng(43.661,-79.381)});
    $('exportPdf').click();$('clearExport').click();$('exportFigureA').click();
    const nativeContext=dom.window.HTMLCanvasElement.prototype.getContext;
    dom.window.HTMLCanvasElement.prototype.getContext=()=>({fillRect(){}});
    // Select the engine's Node jsPDF loading branch; the source-root app does
    // not have build-generated vendor files. Restore the browser immediately.
    const browser=globalThis.window;delete globalThis.window;
    const exporting=$('downloadPdf').onclick();globalThis.window=browser;
    try{
      await imageryStarted;releaseLoad();await loading;
      assert.equal($('loadBedrock').disabled,true,'editing stays locked while exporting');
      $('cancelExport').click();await exporting;
      assert.equal($('loadBedrock').disabled,false,'a load completed during export must not leave its button disabled');
      assert.equal($('projectName').disabled,false);assert.match($('exportProgress').textContent,/cancelled/i);
      assert.equal($('drawState').textContent,'Drawing site','cancellation must preserve unfinished editor drawing');
      assert.ok(Object.values(map._layers).some(layer=>layer instanceof L.Polyline&&!(layer instanceof L.Polygon)&&layer.getLatLngs().length===1));
    }finally{releaseLoad();$('cancelExport').click();await exporting;dom.window.HTMLCanvasElement.prototype.getContext=nativeContext;}

    function deferred(){let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};}
    function gateOfficialRequests(gates){
      let next=0;
      globalThis.fetch=async url=>{
        if(url.endsWith('manifest.json')||url.endsWith('mrd128.kml'))await gates[next++].promise;
        return {ok:true,text:async()=>text,json:async()=>url.endsWith('manifest.json')?manifest:{features:[feature]}};
      };
    }
    for(const [kind,buttonId] of [['bedrock','loadBedrock'],['surficial','loadMrd128']]){
      await t.test(`custom ${kind} import supersedes dataset commit without stranding its official reload button`,async()=>{
        const officialGate=deferred(),importGate=deferred();gateOfficialRequests([officialGate]);
        const loading=$(buttonId).onclick();assert.equal($(buttonId).disabled,true);
        $('geologyKind').value=kind;
        const importing=$('uploadGeology').onchange({target:{files:[{name:`replacement-${kind}.kml`,text:()=>importGate.promise}]}});
        officialGate.resolve();await loading;
        try{
          assert.equal($(buttonId).disabled,false,'the completed official request must release its own button even after import supersedes its data');
        }finally{importGate.resolve(text);await importing;}
        const saved=JSON.parse(localStorage.getItem('phase-i-esa-project-v2')).geology[kind];
        assert.equal(saved.source.id,'custom');assert.match(saved.name,new RegExp(`replacement-${kind}`));
      });
      await t.test(`older ${kind} request cannot unlock a newer official request after custom import`,async()=>{
        const olderGate=deferred(),newerGate=deferred();gateOfficialRequests([olderGate,newerGate]);
        const older=$(buttonId).onclick();
        $('geologyKind').value=kind;
        await $('uploadGeology').onchange({target:{files:[{name:`latest-${kind}.kml`,text:async()=>text}]}});
        const newer=$(buttonId).onclick();olderGate.resolve();await older;
        try{assert.equal($(buttonId).disabled,true,'the newer official request still owns the loading button');}
        finally{newerGate.resolve();await newer;}
        assert.equal($(buttonId).disabled,false);
        assert.equal(JSON.parse(localStorage.getItem('phase-i-esa-project-v2')).geology[kind].source.id,kind==='bedrock'?'MRD126-REV1':'MRD128-REV');
      });
    }
  });
  await t.test('native preview refuses imported extents below the shared figure minimum',async()=>{
    choose('A');p.figures.A.extentMeters=100;
    // jsdom cannot navigate after JSON import; assert that expected boundary
    // without treating its navigation diagnostic as an application failure.
    const navigation=[];dom.virtualConsole.removeAllListeners('jsdomError');dom.virtualConsole.on('jsdomError',error=>navigation.push(error));
    await $('importJson').onchange({target:{files:[{text:async()=>JSON.stringify(p)}]}});
    assert.equal(navigation.length,1);assert.match(navigation[0].message,/navigation/);
    assert.equal(await $('printA3').onclick(),false);
    assert.match($('printStatus').textContent,/500 m/);$('closePrint').click();
  });
});

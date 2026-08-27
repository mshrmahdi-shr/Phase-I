import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';
import {createProject} from '../src/core.mjs';
import {TORONTO_IMAGERY_PROVIDER} from '../src/imagery/providers/toronto.mjs';

const project=()=>({...createProject({name:'Public QA',projectNo:'FE 26-15876',address:'Toronto, Ontario',date:'2026-08-26'}),location:{lng:-79.38,lat:43.65}});
const polygon={name:'Custom unit',description:'Custom description',unitCode:'55b',color:'#123456',fillOpacity:.6,
  polygon:[[-80,43],[-79,43],[-79,44],[-80,44],[-80,43]],holes:[]};
const dataset=()=>({features:[structuredClone(polygon)],source:{id:'custom',name:'Custom bedrock.kml'},coverage:null});
const surficialDataset=()=>({features:Array.from({length:28},(_,index)=>({...structuredClone(polygon),
  name:`Official surficial unit ${index+1}`,unitCode:`S${index+1}`,
  description:'Official Quaternary geology description with deposits, sediments, landforms, and interpretive qualifiers preserved in full.',
})),source:{name:'Official surficial geology'},coverage:null});
const companyProfile=()=>({schemaVersion:1,id:'company-1',companyName:'Acme Environmental',address:'22 King Street',phone:'416-555-0110',
  email:'hello@acme.test',website:'https://acme.test',preparedBy:'',reviewedBy:'',logoAssetId:'logo-1',logoMime:'image/png',
  logoWidth:320,logoHeight:160,logoPlacement:{align:'left',scale:1},updatedAt:'2026-08-26T12:00:00Z'});

test('selection evaluates actual prerequisites, not active figure or saved geology badges',async()=>{
  const {exportRows,selectedReadyCodes}=await import('../src/export-selection.mjs');
  const p=project();p.geology={surficial:{count:10,siteUnit:'9c'},bedrock:{count:20,siteUnit:'55b'}};
  const rows=exportRows({project:p,datasets:{},companyProfile:companyProfile(),active:'E'});
  assert.deepEqual(rows.filter(r=>r.ready).map(r=>r.code),['A','C']);
  assert.match(rows[1].reasons.join(' '),/Site Boundary/);
  assert.match(rows[3].reasons.join(' '),/Surficial|surficial/);
  assert.match(rows[4].reasons.join(' '),/Bedrock|bedrock/);
  assert.deepEqual(selectedReadyCodes(rows,['E','C','A','C','Z']),['A','C']);
  assert.deepEqual(selectedReadyCodes(rows,[]),[]);
});

test('geology readiness checks the fitted batch footprint, actual geometry and SITE holes',async()=>{
  const {exportRows,selectedReadyCodes}=await import('../src/export-selection.mjs');
  const p=project(),datasets={bedrock:dataset()},company=companyProfile();
  let rows=exportRows({project:p,datasets,companyProfile:company});
  assert.deepEqual(selectedReadyCodes(rows,['E','A','C']),['A','C','E']);
  datasets.bedrock.coverage={west:-79.39,east:-79.37,south:43.64,north:43.66};
  rows=exportRows({project:p,datasets,companyProfile:company});assert.equal(rows[4].ready,false);assert.match(rows[4].reasons.join(' '),/extent|cover/);
  datasets.bedrock.coverage=null;
  datasets.bedrock.features[0].holes=[[[-79.4,43.6],[-79.3,43.6],[-79.3,43.7],[-79.4,43.7],[-79.4,43.6]]];
  assert.equal(exportRows({project:p,datasets,companyProfile:company})[4].ready,false);
  datasets.bedrock.features[0].holes=[];datasets.bedrock.features[0].polygon.pop();
  assert.equal(exportRows({project:p,datasets,companyProfile:company})[4].ready,false);
});

function fixture(){
  const dom=new JSDOM(fs.readFileSync(new URL('../index.html',import.meta.url),'utf8'),{url:'https://example.test/'});
  const document=dom.window.document;
  return {dom,document,$:id=>document.getElementById(id)};
}

test('real dialog selects ready rows only, clears, invalidates live selections, and safely displays text',async()=>{
  const {createExportDialog}=await import('../src/export-selection.mjs');
  const {document,$}=fixture();const p=project(),state={project:p,datasets:{bedrock:dataset()},companyProfile:companyProfile()};
  p.figures.E.title='<img src=x onerror=alert(1)> فارسی';p.exportPreferences={codes:['E','C','A']};
  const dialog=createExportDialog({document,getState:()=>state,save(){},setBusy(){},exportPdf:async()=>{throw Error('unused');},download(){}});
  dialog.open();
  assert.equal($('exportDialog').hidden,false);
  assert.equal($('exportFigureB').disabled,true);assert.equal($('exportFigureE').checked,true);
  assert.equal($('exportRows').querySelector('img'),null);assert.match($('exportRows').textContent,/فارسی/);
  assert.equal($('downloadPdf').textContent,'Download PDF (3 sheets)');
  $('clearExport').click();assert.equal($('downloadPdf').disabled,true);
  $('exportFigureA').click();assert.equal($('downloadPdf').textContent,'Download PDF (1 sheet)');
  $('selectAllReady').click();assert.deepEqual(p.exportPreferences.codes,['A','C','E']);
  state.datasets.bedrock.features=[];dialog.refresh();
  assert.equal($('exportFigureE').checked,false);assert.equal($('exportFigureE').disabled,true);
  assert.deepEqual(p.exportPreferences.codes,['A','C']);
  $('cancelExport').click();assert.equal($('exportDialog').hidden,true);
});

test('selection reports planned Figure D continuation sheets without blocking the official legend',async()=>{
  const {createExportDialog}=await import('../src/export-selection.mjs');
  const {planPdfExport}=await import('../src/pdf-export.mjs');
  const {document,$}=fixture(),p=project();p.exportPreferences={codes:['D']};
  const state={project:p,datasets:{surficial:surficialDataset()},companyProfile:companyProfile()};
  const dialog=createExportDialog({document,getState:()=>state,save(){},setBusy(){},
    planPdf:planPdfExport,
    exportPdf:async()=>{throw Error('unused');},download(){}});
  await dialog.open();
  assert.equal($('exportFigureD').disabled,false);
  assert.equal($('exportReasonD').textContent,'Figure D will include 1 legend continuation sheet.');
  assert.equal($('downloadPdf').textContent,'Download PDF (2 sheets)');
});

test('planner rejection disables and unchecks only the affected row and guards download',async()=>{
  const {createExportDialog}=await import('../src/export-selection.mjs');
  const {planPdfExport}=await import('../src/pdf-export.mjs');
  for(const description of ['Unsupported 𠀀','x\n'.repeat(6000)]){
    const {document,dom,$}=fixture(),p=project(),surficial=surficialDataset();p.exportPreferences={codes:['D']};
    surficial.features[0].unitCode='UNIT-BLOCKED';surficial.features[0].description=description;
    let exports=0;
    const dialog=createExportDialog({document,getState:()=>({project:p,datasets:{surficial},companyProfile:companyProfile()}),save(){},setBusy(){},
      planPdf:planPdfExport,exportPdf:async()=>{exports++;return {blob:new Blob(['pdf']),filename:'invalid.pdf',pageCount:1};},download(){}});
    await dialog.open();
    assert.equal($('exportFigureD').checked,false);assert.equal($('exportFigureD').disabled,true);
    assert.deepEqual(p.exportPreferences.codes,[]);assert.equal($('downloadPdf').disabled,true);
    assert.match($('exportReasonD').textContent,/Figure D.*(?:Unsupported font character|Legend entry UNIT-BLOCKED)/);
    assert.equal($('exportFigureA').disabled,false,'an unrelated valid row remains usable');
    await dialog.start();assert.equal(exports,0,'download cannot start without a currently planned selected figure');
    dom.window.close();
  }
});

function deferredPlanner(){
  const calls=[];
  return {calls,planPdf(args){
    const code=args.codes[0];if(code!=='D')return Promise.resolve({pageCount:1,continuationCounts:{[code]:0}});
    let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});calls.push({args,resolve,reject});return promise;
  }};
}

test('an older planning success cannot overwrite a newer failure',async()=>{
  const {createExportDialog}=await import('../src/export-selection.mjs');
  const {document,dom,$}=fixture(),p=project(),surficial=surficialDataset(),planner=deferredPlanner();p.exportPreferences={codes:['D']};
  const state={project:p,datasets:{surficial},companyProfile:companyProfile()};
  const dialog=createExportDialog({document,getState:()=>state,save(){},setBusy(){},planPdf:planner.planPdf,exportPdf:async()=>{throw Error('unused');},download(){}});
  const older=dialog.open();assert.equal(planner.calls.length,1);
  surficial.features[0].description='new invalid snapshot';const newer=dialog.refresh();assert.equal(planner.calls.length,2);
  planner.calls[1].reject(Error('Figure D: Unsupported font character U+20000.'));await newer;
  planner.calls[0].resolve({pageCount:2,continuationCounts:{D:1}});await older;await new Promise(resolve=>setImmediate(resolve));
  assert.equal($('exportFigureD').disabled,true);assert.equal($('exportFigureD').checked,false);assert.equal($('downloadPdf').disabled,true);
  assert.match($('exportReasonD').textContent,/U\+20000/);assert.deepEqual(p.exportPreferences.codes,[]);dom.window.close();
});

test('an older planning failure cannot overwrite a newer success',async()=>{
  const {createExportDialog}=await import('../src/export-selection.mjs');
  const {document,dom,$}=fixture(),p=project(),surficial=surficialDataset(),planner=deferredPlanner();p.exportPreferences={codes:['D']};
  const state={project:p,datasets:{surficial},companyProfile:companyProfile()};
  const dialog=createExportDialog({document,getState:()=>state,save(){},setBusy(){},planPdf:planner.planPdf,exportPdf:async()=>{throw Error('unused');},download(){}});
  const older=dialog.open();surficial.features[0].description='new valid snapshot';const newer=dialog.refresh();
  planner.calls[1].resolve({pageCount:3,continuationCounts:{D:2}});await newer;
  planner.calls[0].reject(Error('Figure D: stale failure'));await older;await new Promise(resolve=>setImmediate(resolve));
  assert.equal($('exportFigureD').disabled,false);assert.equal($('exportFigureD').checked,true);
  assert.equal($('exportReasonD').textContent,'Figure D will include 2 legend continuation sheets.');
  assert.equal($('downloadPdf').disabled,false);assert.equal($('downloadPdf').textContent,'Download PDF (3 sheets)');
  assert.deepEqual(p.exportPreferences.codes,['D']);dom.window.close();
});

test('dialog snapshots input, prevents duplicates, reports per-phase progress, and downloads only a full result',async()=>{
  const {createExportDialog}=await import('../src/export-selection.mjs');
  const {document,$}=fixture();const p=project();p.exportPreferences={codes:['C','A']};
  let release,calls=0,input;const pending=new Promise(r=>release=r),busy=[],downloads=[];
  const company=companyProfile();
  const dialog=createExportDialog({document,getState:()=>({project:p,datasets:{},companyProfile:company}),save(){},setBusy:value=>busy.push(value),
    exportPdf:async args=>{calls++;input=args;await pending;return {blob:new Blob(['pdf']),filename:'fe-26-15876-figures-AC.pdf',pageCount:2};},download:r=>downloads.push(r)});
  dialog.open();const running=dialog.start();await dialog.start();
  assert.equal(calls,1);assert.equal($('downloadPdf').disabled,true);assert.equal($('cancelExport').disabled,false);
  p.name='Changed after start';assert.equal(input.project.name,'Public QA');assert.deepEqual(input.codes,['A','C']);
  company.companyName='Changed Company';assert.equal(input.companyProfile.companyName,'Acme Environmental');
  input.onProgress({phase:'sheet',code:'C',completed:1,total:2});assert.match($('exportProgress').textContent,/2 of 2/);
  input.onProgress({phase:'imagery',code:'C',completed:3,total:4});assert.match($('exportProgress').textContent,/3 of 4.*source images/);
  release();await running;
  assert.equal(downloads.length,1);assert.equal(downloads[0].filename,'fe-26-15876-figures-AC.pdf');
  assert.deepEqual(busy,[true,false]);assert.equal(dialog.busy,false);
  dialog.close();dialog.open();assert.equal($('cancelExport').textContent,'Cancel');
});

test('Escape cancels work and a late successful result never downloads; failure restores editing',async()=>{
  const {createExportDialog}=await import('../src/export-selection.mjs');
  const {document,dom,$}=fixture();const p=project();p.exportPreferences={codes:['A']};
  let release,input;const busy=[],downloads=[];
  const dialog=createExportDialog({document,getState:()=>({project:p,datasets:{},companyProfile:companyProfile()}),save(){},setBusy:value=>busy.push(value),
    exportPdf:args=>{input=args;return new Promise(r=>release=r);},download:r=>downloads.push(r)});
  dialog.open();const running=dialog.start();
  document.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
  assert.equal(input.signal.aborted,true);release({blob:new Blob(['pdf']),filename:'x',pageCount:1});await running;
  assert.equal(downloads.length,0);assert.match($('exportProgress').textContent,/cancelled/i);assert.deepEqual(busy,[true,false]);
  dialog.close();
  const failure=createExportDialog({document,getState:()=>({project:p,datasets:{},companyProfile:companyProfile()}),save(){},setBusy:value=>busy.push(value),exportPdf:async()=>{throw Error('Figure A: source unavailable');},download:r=>downloads.push(r)});
  failure.open();await failure.start();assert.match($('exportProgress').textContent,/Figure A: source unavailable/);assert.equal(failure.busy,false);assert.equal(downloads.length,0);
});

test('browser download rechecks cancellation after URL creation and always revokes the URL',async t=>{
  const {downloadPdf}=await import('../src/export-selection.mjs');
  const {document,dom}=fixture(),controller=new AbortController(),revoked=[];let clicks=0,cleanup;
  const original={create:URL.createObjectURL,revoke:URL.revokeObjectURL,setTimeout:globalThis.setTimeout};
  t.after(()=>{URL.createObjectURL=original.create;URL.revokeObjectURL=original.revoke;globalThis.setTimeout=original.setTimeout;dom.window.close();});
  URL.createObjectURL=()=>{controller.abort();return 'blob:cancelled';};URL.revokeObjectURL=url=>revoked.push(url);
  globalThis.setTimeout=fn=>{cleanup=fn;};
  document.addEventListener('click',event=>{if(event.target.tagName==='A')clicks++;});
  assert.throws(()=>downloadPdf({blob:new Blob(['pdf']),filename:'test.pdf'},{document,signal:controller.signal}),{name:'AbortError'});
  assert.equal(clicks,0);assert.equal(document.querySelectorAll('a[download]').length,0);
  cleanup();assert.deepEqual(revoked,['blob:cancelled']);
});

function historicalItem({id='74f14168-4de6-4c5f-88f4-87db8ec731c2',year=1972,sequence=1,policy='exportable'}={}){return {id,year,sequence,title:`Archive flight ${sequence}`,mode:'official',providerId:'toronto',
  sourceUrl:'https://gis.toronto.ca/arcgis/rest/services/basemap/cot_historic_aerial_1972/MapServer',licenseUrl:'https://open.toronto.ca/open-data-licence/',attribution:'City of Toronto',policy,resolutionMeters:.2,
  bounds:{west:-79.405,south:43.632,east:-79.355,north:43.668},placement:null,assetId:null,
  officialExport:{kind:'arcgis-export',url:'https://gis.toronto.ca/arcgis/rest/services/basemap/cot_historic_aerial_1972/MapServer/export',layer:null,maxWidth:4096,maxHeight:4096},createdAt:'2026-08-27T12:00:00.000Z',updatedAt:'2026-08-27T12:00:00.000Z'};}

test('selection rows place A-E before stable historical year/sequence order and expose actionable blockers',async()=>{
  const {exportRows,selectedReadySelection}=await import('../src/export-selection.mjs'),p=project();
  const later=historicalItem({id:'9833e469-c7e8-4ef1-84f1-b89c608c2126',sequence:2}),first=historicalItem(),blocked=historicalItem({id:'3caa1022-b2e7-4c63-8ca8-12f4845e1be1',year:1980,sequence:1,policy:'link-only'});
  p.historical=[later,blocked,first];p.historicalSequenceCounters={'1972':2,'1980':1};
  const rows=exportRows({project:p,datasets:{},companyProfile:companyProfile(),providers:[TORONTO_IMAGERY_PROVIDER],historicalAssetStates:new Map()});
  assert.deepEqual(rows.slice(0,5).map(row=>row.selection),['A','B','C','D','E'].map(code=>({kind:'figure',code})));
  assert.deepEqual(rows.slice(5).map(row=>row.id),[first.id,later.id,blocked.id]);assert.equal(rows.at(-1).ready,false);assert.match(rows.at(-1).reasons.join(' '),/link-only|exportable|policy/i);
  assert.deepEqual(selectedReadySelection(rows,[{kind:'historical',id:later.id},{kind:'figure',code:'C'},{kind:'historical',id:first.id},{kind:'historical',id:blocked.id}]),[{kind:'figure',code:'C'},{kind:'historical',id:first.id},{kind:'historical',id:later.id}]);
  const downgraded={...TORONTO_IMAGERY_PROVIDER,policy:'link-only'};
  const stale=exportRows({project:{...p,historical:[first]},datasets:{},companyProfile:companyProfile(),providers:[downgraded]}).at(-1);assert.equal(stale.ready,false);assert.match(stale.reasons.join(' '),/current provider policy/i);
});

test('dialog persists typed historical selection, keeps legacy codes, and snapshots selected item before export',async()=>{
  const {createExportDialog}=await import('../src/export-selection.mjs'),{document,dom,$}=fixture(),p=project(),item=historicalItem();p.historical=[item];p.historicalSequenceCounters={'1972':1};
  p.exportPreferences={...p.exportPreferences,codes:['A'],selection:[{kind:'figure',code:'A'},{kind:'historical',id:item.id}]};let input,release;const pending=new Promise(resolve=>{release=resolve;}),downloads=[];
  const state={project:p,datasets:{},companyProfile:companyProfile(),providers:[TORONTO_IMAGERY_PROVIDER]};
  const dialog=createExportDialog({document,getState:()=>state,save(){},setBusy(){},planPdf:async({selection})=>({pageCount:1,continuationCounts:selection[0].kind==='figure'?{[selection[0].code]:0}:{}}),
    exportPdf:async args=>{input=args;await pending;return {blob:new Blob(['pdf']),filename:'combined.pdf',pageCount:2};},download:value=>downloads.push(value)});
  await dialog.open();const historical=document.querySelector('[data-export-kind="historical"] input');assert.equal(historical.checked,true);assert.equal(historical.disabled,false);assert.match(historical.closest('label').textContent,/H-1972-1.*1972.*City of Toronto.*Licence: exportable/i);
  const running=dialog.start();p.historical[0].title='Changed after export click';assert.equal(input.selection.length,2);assert.equal(input.project.historical[0].title,'Archive flight 1');release();await running;assert.equal(downloads.length,1);
  assert.deepEqual(p.exportPreferences.codes,['A']);assert.deepEqual(p.exportPreferences.selection,[{kind:'figure',code:'A'},{kind:'historical',id:item.id}]);dom.window.close();
});

test('historical planning failure keeps its visible row but clears persisted selection and blocks download',async()=>{
  const {createExportDialog}=await import('../src/export-selection.mjs'),{document,dom,$}=fixture(),p=project(),item=historicalItem();p.historical=[item];p.historicalSequenceCounters={'1972':1};p.exportPreferences={...p.exportPreferences,codes:[],selection:[{kind:'historical',id:item.id}]};
  const dialog=createExportDialog({document,getState:()=>({project:p,datasets:{},companyProfile:companyProfile(),providers:[TORONTO_IMAGERY_PROVIDER]}),save(){},setBusy(){},
    planPdf:async({selection})=>{if(selection[0].kind==='historical')throw Error('H-1972-1: Missing historical image asset. Restore the project package.');return {pageCount:1,continuationCounts:{[selection[0].code]:0}};},exportPdf:async()=>{throw Error('must not export');},download(){}});
  await dialog.open();const row=document.querySelector('[data-export-kind="historical"]'),checkbox=row.querySelector('input');assert.equal(checkbox.disabled,true);assert.equal(checkbox.checked,false);assert.match(row.textContent,/Missing historical image asset.*Restore/i);assert.deepEqual(p.exportPreferences.selection,[]);assert.equal($('downloadPdf').disabled,true);dom.window.close();
});

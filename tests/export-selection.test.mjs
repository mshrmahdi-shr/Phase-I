import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';
import {createProject} from '../src/core.mjs';

const project=()=>({...createProject({name:'Public QA',projectNo:'FE 26-15876',address:'Toronto, Ontario',date:'2026-08-26'}),location:{lng:-79.38,lat:43.65}});
const polygon={name:'Custom unit',description:'Custom description',unitCode:'55b',color:'#123456',fillOpacity:.6,
  polygon:[[-80,43],[-79,43],[-79,44],[-80,44],[-80,43]],holes:[]};
const dataset=()=>({features:[structuredClone(polygon)],source:{id:'custom',name:'Custom bedrock.kml'},coverage:null});
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

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';
import {createCadExportController,downloadCadPackage} from '../src/cad-ui.mjs';

const HTML=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');

function profile(){return {schemaVersion:1,id:'company-1',companyName:'Acme Environmental',address:'22 King Street',phone:'416-555-0110',email:'hello@acme.test',website:'https://acme.test',preparedBy:'',reviewedBy:'',logoAssetId:'logo-1',logoMime:'image/png',logoWidth:320,logoHeight:160,logoPlacement:{align:'left',scale:1},updatedAt:'2026-08-26T12:00:00Z'};}
function snapshot(overrides={}){return {project:{name:'Public QA',projectNo:'AB-12345',dpi:300,location:{lat:43.65,lng:-79.38}},companyProfile:profile(),selection:[{kind:'figure',code:'A'},{kind:'historical',id:'74f14168-4de6-4c5f-88f4-87db8ec731c2'}],datasets:{},providers:[],assetStore:{},blockers:[],ready:true,...overrides};}
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function fixture(options={}){
  const dom=new JSDOM(HTML,{url:'https://app.test/',pretendToBeVisual:true}),document=dom.window.document,downloads=[],busy=[];
  let current=snapshot();
  const controller=createCadExportController({document,getSnapshot:()=>current,setBusy:value=>busy.push(value),download:(result,context)=>downloads.push({result,context}),exportPackage:async()=>({blob:new Blob(['zip'],{type:'application/zip'}),filename:'ab-12345-cad-package.zip',imageCount:2,pageCount:2,crs:{zone:17,name:'NAD83 / UTM zone 17N',units:'m'}}),...options});
  return {dom,document,controller,downloads,busy,get snapshot(){return current;},set snapshot(value){current=value;}};
}

test('CAD controls use the shared image count and show a fail-closed SITE CRS preview',()=>{
  const h=fixture(),byId=id=>h.document.getElementById(id);
  for(const id of ['downloadCad','cadSelectionCount','cadCrs','cadReadiness'])assert.ok(byId(id),`missing #${id}`);
  h.controller.refresh();
  assert.equal(byId('downloadCad').textContent,'Download AutoCAD ZIP (2 images)');
  assert.equal(byId('cadSelectionCount').textContent,'2 images selected');
  assert.match(byId('cadCrs').textContent,/NAD83 \/ UTM zone 17N.*metres/i);
  assert.equal(byId('downloadCad').disabled,false);
  h.snapshot=snapshot({project:{name:'Public QA',projectNo:'AB-12345',dpi:300,location:{lat:43.65,lng:-78}},ready:false,blockers:['SITE lies on an ambiguous UTM boundary. Move SITE off the zone boundary.','H-1972-1 is link-only. Approve an exportable source or upload the image manually.']});
  h.controller.refresh();assert.equal(byId('downloadCad').disabled,true);assert.match(byId('cadCrs').textContent,/unavailable/i);assert.match(byId('cadReadiness').textContent,/link-only.*upload.*manually/i);
  h.controller.destroy();h.dom.window.close();
});

test('CAD readiness visibly blocks a selected geology overlay with incomplete legal provenance',()=>{
  const h=fixture(),byId=id=>h.document.getElementById(id);
  h.snapshot=snapshot({selection:[{kind:'figure',code:'D'}],datasets:{surficial:{source:{id:'custom',name:'uploaded-surficial.kml'}}}});
  h.controller.refresh();
  assert.equal(byId('downloadCad').disabled,true);
  assert.match(byId('cadReadiness').textContent,/Figure D.*source.*credits.*licen[cs]e.*permission.*before CAD export/i);
  h.controller.destroy();h.dom.window.close();
});

test('CAD readiness requires the persisted rights confirmation even when text evidence exists',()=>{
  const h=fixture(),byId=id=>h.document.getElementById(id),source={id:'custom',name:'uploaded.kml',credits:'Example Engineer',sourceUrl:null,license:'Written project licence',redistributionEvidence:'Permission email on file',acquisitionYear:null,acquisitionYearVerification:'unknown',permissionConfirmed:false};
  h.snapshot=snapshot({selection:[{kind:'figure',code:'E'}],datasets:{bedrock:{source}}});h.controller.refresh();assert.equal(byId('downloadCad').disabled,true);assert.match(byId('cadReadiness').textContent,/confirm|permission|rights/i);h.controller.destroy();h.dom.window.close();
});

test('CAD export snapshots once, prevents duplicate clicks, maps phases, and restores every control',async()=>{
  const gate=deferred();let calls=0,input;
  const h=fixture({exportPackage:async args=>{calls++;input=args;return gate.promise;}}),byId=id=>h.document.getElementById(id);
  byId('exportFigureA')?.removeAttribute('disabled');byId('selectAllReady').disabled=true;
  const running=h.controller.start();await h.controller.start();
  assert.equal(calls,1);assert.equal(byId('downloadCad').disabled,true);assert.equal(byId('cancelExport').disabled,false);assert.equal(byId('selectAllReady').disabled,true);
  h.snapshot.project.name='Changed after click';assert.equal(input.project.name,'Public QA');assert.equal(input.signal.aborted,false);
  for(const [phase,pattern] of [['preflight',/validating/i],['sheet',/composing images/i],['assembling',/writing CAD/i],['pdf-complete',/writing PDF/i],['compressing',/compressing/i],['complete',/complete/i]]){input.onProgress({phase,completed:1,total:2,percent:50});assert.match(byId('exportProgress').textContent,pattern);}
  gate.resolve({blob:new Blob(['zip'],{type:'application/zip'}),filename:'ab-12345-cad-package.zip',imageCount:2,pageCount:2,crs:{zone:17,name:'NAD83 / UTM zone 17N',units:'m'}});await running;
  assert.equal(h.downloads.length,1);assert.deepEqual(h.busy,[true,false]);assert.equal(byId('selectAllReady').disabled,true,'pre-existing disabled state is restored');assert.equal(byId('downloadCad').disabled,false);assert.equal(h.controller.busy,false);
  h.controller.destroy();h.dom.window.close();
});

test('Cancel and Escape abort; late success never downloads and editing is restored',async()=>{
  for(const mode of ['button','escape']){
    const gate=deferred();let input;const h=fixture({exportPackage:args=>{input=args;return gate.promise;}}),byId=id=>h.document.getElementById(id);
    const running=h.controller.start();
    if(mode==='button')byId('cancelExport').click();else h.document.dispatchEvent(new h.dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
    assert.equal(input.signal.aborted,true);assert.match(byId('exportProgress').textContent,/cancelling/i);
    gate.resolve({blob:new Blob(['late'],{type:'application/zip'}),filename:'late.zip',imageCount:2,pageCount:2,crs:{zone:17,name:'NAD83 / UTM zone 17N',units:'m'}});await running;
    assert.equal(h.downloads.length,0);assert.deepEqual(h.busy,[true,false]);assert.match(byId('exportProgress').textContent,/cancelled.*no.*download/i);assert.equal(byId('downloadCad').disabled,false);
    h.controller.destroy();h.dom.window.close();
  }
});

test('failure is actionable and restores editing without publishing a partial result',async()=>{
  const h=fixture({exportPackage:async()=>{throw new Error('H-1972-1: saved manual image asset is missing. Upload it again.');}}),byId=id=>h.document.getElementById(id);
  await h.controller.start();assert.equal(h.downloads.length,0);assert.match(byId('exportProgress').textContent,/Export blocked.*H-1972-1.*Upload it again/i);assert.deepEqual(h.busy,[true,false]);assert.equal(h.controller.busy,false);assert.equal(byId('downloadCad').disabled,false);
  h.controller.destroy();h.dom.window.close();
});

test('browser ZIP download defers successful revoke but immediately cleans abort, click, and scheduler failures',async t=>{
  const dom=new JSDOM('<body></body>',{url:'https://app.test/'}),document=dom.window.document,original={create:URL.createObjectURL,revoke:URL.revokeObjectURL,click:dom.window.HTMLAnchorElement.prototype.click},revoked=[],scheduled=[];let clicks=0;
  t.after(()=>{URL.createObjectURL=original.create;URL.revokeObjectURL=original.revoke;dom.window.close();});document.addEventListener('click',event=>{if(event.target.tagName==='A')clicks++;});
  URL.createObjectURL=()=> 'blob:success';URL.revokeObjectURL=url=>revoked.push(url);
  downloadCadPackage({blob:new Blob(['zip'],{type:'application/zip'}),filename:'safe.zip'},{document,scheduleRevoke:callback=>scheduled.push(callback)});assert.equal(clicks,1);assert.deepEqual(revoked,[],'successful URL remains valid until a later task');assert.equal(scheduled.length,1);assert.equal(document.querySelectorAll('a[download]').length,0);scheduled.shift()();assert.deepEqual(revoked,['blob:success']);
  const controller=new AbortController();URL.createObjectURL=()=>{controller.abort();return 'blob:cancelled';};
  assert.throws(()=>downloadCadPackage({blob:new Blob(['zip'],{type:'application/zip'}),filename:'late.zip'},{document,signal:controller.signal}),{name:'AbortError'});assert.equal(clicks,1);assert.deepEqual(revoked,['blob:success','blob:cancelled']);assert.equal(document.querySelectorAll('a[download]').length,0);
  URL.createObjectURL=()=> 'blob:click-error';dom.window.HTMLAnchorElement.prototype.click=()=>{throw new Error('click failed');};assert.throws(()=>downloadCadPackage({blob:new Blob(['zip'],{type:'application/zip'}),filename:'bad.zip'},{document}),/click failed/);assert.deepEqual(revoked,['blob:success','blob:cancelled','blob:click-error']);
  dom.window.HTMLAnchorElement.prototype.click=original.click;URL.createObjectURL=()=> 'blob:scheduler-error';downloadCadPackage({blob:new Blob(['zip'],{type:'application/zip'}),filename:'safe.zip'},{document,scheduleRevoke:()=>{throw new Error('timer unavailable');}});assert.deepEqual(revoked,['blob:success','blob:cancelled','blob:click-error','blob:scheduler-error']);
});

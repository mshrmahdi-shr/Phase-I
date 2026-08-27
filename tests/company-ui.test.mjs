import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';
import JSZip from 'jszip';
import {exportCompanyTemplate} from '../src/company-template.mjs';
import {createCompanyProfileDialog} from '../src/company-ui.mjs';

const PNG=new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,0]);

async function sha256(bytes){
  return Buffer.from(await crypto.subtle.digest('SHA-256',bytes)).toString('hex');
}

async function asset(id='logo-old',companyName='Old Engineering'){
  const blob=new Blob([PNG],{type:'image/png'});
  const metadata={id,kind:'company-logo',mime:'image/png',size:blob.size,width:320,height:160,
    sha256:await sha256(PNG),createdAt:'2026-08-26T12:00:00Z'};
  const profile={schemaVersion:1,id:`profile-${id}`,companyName,address:'1 Main Street',phone:'555-0100',
    email:'office@example.com',website:'https://example.com',preparedBy:'A. Person',reviewedBy:'R. Person',
    logoAssetId:id,logoMime:'image/png',logoWidth:320,logoHeight:160,
    logoPlacement:{align:'left',scale:1},updatedAt:'2026-08-26T12:00:00Z'};
  return {metadata,blob,profile};
}

function memoryStore(initial=[]){
  const values=new Map(initial.map(value=>[value.metadata.id,value]));
  return {
    values,
    async get(id){return values.get(id)||null;},
    async put(value){if(values.has(value.metadata.id))throw new DOMException('duplicate','ConstraintError');values.set(value.metadata.id,value);},
    async delete(id){return values.delete(id);}
  };
}

function setup({persisted=null,store=memoryStore(),loadProfile,saveProfile}={}){
  const dom=new JSDOM(fs.readFileSync(new URL('../index.html',import.meta.url),'utf8'),{url:'https://example.test/',pretendToBeVisual:true});
  dom.window.createImageBitmap=async()=>({width:320,height:160,close(){}});
  let saved=persisted?structuredClone(persisted):null;
  const changes=[];
  const controller=createCompanyProfileDialog({
    document:dom.window.document,assetStore:store,Zip:JSZip,
    loadProfile:loadProfile||(()=>saved),
    saveProfile:saveProfile||((profile)=>{saved=structuredClone(profile);}),
    onChanged:profile=>changes.push(profile)
  });
  return {dom,store,controller,changes,get saved(){return saved;},set saved(value){saved=value;}};
}

function fill(document,{companyName='Acme Environmental'}={}){
  const values={companyName,companyAddress:'22 King Street',companyPhone:'416-555-0110',companyEmail:'hello@acme.test',
    companyWebsite:'https://acme.test',companyPreparedBy:'Pat Lee',companyReviewedBy:'Sam Roy'};
  for(const [id,value] of Object.entries(values))document.getElementById(id).value=value;
}

function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
async function eventually(predicate){for(let tries=0;tries<100;tries++){if(predicate())return;await new Promise(resolve=>setImmediate(resolve));}assert.ok(predicate(),'condition did not become true');}

test('first use stays gated with field errors until a decoded PNG logo and every required field save',async t=>{
  const fixture=setup();t.after(()=>{fixture.controller.destroy();fixture.dom.window.close();});
  assert.equal(await fixture.controller.refresh(),null);
  await fixture.controller.open();
  const document=fixture.dom.window.document,dialog=document.getElementById('companyProfileDialog');
  assert.equal(dialog.hidden,false);assert.equal(document.getElementById('closeCompanyProfile').disabled,true);
  let importChoices=0;document.getElementById('importCompanyTemplateFile').click=()=>{importChoices++;};
  document.getElementById('importCompanyTemplateInDialog').click();assert.equal(importChoices,1);
  await document.getElementById('companyProfileForm').onsubmit({preventDefault(){}});
  for(const id of ['companyNameError','companyAddressError','companyPhoneError','companyEmailError','companyWebsiteError','logoError'])assert.ok(document.getElementById(id).textContent,id);
  for(const id of ['companyName','companyAddress','companyPhone','companyEmail','companyWebsite','companyLogo'])assert.equal(document.getElementById(id).getAttribute('aria-invalid'),'true',id);
  fill(document);
  let decoded=0;fixture.dom.window.createImageBitmap=async()=>{decoded++;return {width:320,height:160,close(){}};};
  await document.getElementById('companyLogo').onchange({target:{files:[new Blob([PNG],{type:'image/png'})]}});
  const align=document.getElementById('companyLogoAlign'),scale=document.getElementById('companyLogoScale'),preview=document.querySelector('.logo-preview-box');
  scale.value='2';await document.getElementById('companyProfileForm').onsubmit({preventDefault(){}});
  assert.equal(dialog.hidden,false);assert.match(document.getElementById('logoPlacementError').textContent,/0\.5 to 1\.5/);
  align.value='right';align.onchange();scale.value='1.25';scale.oninput();
  assert.equal(preview.dataset.logoAlign,'right');assert.equal(document.getElementById('companyLogoPreview').style.transform,'scale(1.25)');
  await document.getElementById('companyProfileForm').onsubmit({preventDefault(){}});
  assert.equal(decoded,1);assert.equal(dialog.hidden,true);assert.equal(fixture.saved.companyName,'Acme Environmental');
  assert.match(fixture.saved.logoAssetId,/^company-logo-/);assert.equal('logoDataUrl' in fixture.saved,false);
  assert.equal(fixture.store.values.size,1);assert.equal(fixture.changes.at(-1).companyName,'Acme Environmental');
});

test('logo selection rejects spoofed, over-4-MiB and over-16-megapixel files before storage',async t=>{
  const fixture=setup();t.after(()=>{fixture.controller.destroy();fixture.dom.window.close();});
  await fixture.controller.open();const document=fixture.dom.window.document,input=document.getElementById('companyLogo'),error=document.getElementById('logoError');
  await input.onchange({target:{files:[new Blob(['not a png'],{type:'image/png'})]}});
  assert.match(error.textContent,/signature|PNG or JPEG/i);
  const large=new Uint8Array(4*1024*1024+1);large.set(PNG);
  await input.onchange({target:{files:[new Blob([large],{type:'image/png'})]}});
  assert.match(error.textContent,/4 MiB/i);
  fixture.dom.window.createImageBitmap=async()=>({width:5000,height:4000,close(){}});
  await input.onchange({target:{files:[new Blob([PNG],{type:'image/png'})]}});
  assert.match(error.textContent,/16 megapixels/i);assert.equal(fixture.store.values.size,0);
});

test('failed profile persistence removes only the new logo and preserves the old valid profile and asset',async t=>{
  const old=await asset(),store=memoryStore([old]);let saved=structuredClone(old.profile),fail=true;
  const fixture=setup({persisted:saved,store,saveProfile:profile=>{if(fail)throw Error('localStorage unavailable');saved=structuredClone(profile);}});
  t.after(()=>{fixture.controller.destroy();fixture.dom.window.close();});
  await fixture.controller.refresh();await fixture.controller.open();const document=fixture.dom.window.document;
  fill(document,{companyName:'Replacement Company'});
  await document.getElementById('companyLogo').onchange({target:{files:[new Blob([PNG],{type:'image/png'})]}});
  await document.getElementById('companyProfileForm').onsubmit({preventDefault(){}});
  assert.equal(saved.companyName,'Old Engineering');assert.deepEqual([...store.values.keys()],['logo-old']);
  assert.match(document.getElementById('companyProfileStatus').textContent,/localStorage unavailable/);
  fail=false;await document.getElementById('companyProfileForm').onsubmit({preventDefault(){}});
  assert.equal(saved.companyName,'Replacement Company');assert.equal(store.values.has('logo-old'),false);assert.equal(store.values.size,1);
});

test('template import previews without mutation and replaces only after explicit confirmation',async t=>{
  const old=await asset(),incoming=await asset('logo-incoming','Imported Engineering'),store=memoryStore([old]);
  const template=await exportCompanyTemplate({profile:incoming.profile,assetStore:memoryStore([incoming]),Zip:JSZip});
  let saved=structuredClone(old.profile),fail=true;
  const fixture=setup({persisted:saved,store,saveProfile:profile=>{if(fail)throw Error('metadata unavailable');saved=structuredClone(profile);}});
  t.after(()=>{fixture.controller.destroy();fixture.dom.window.close();});
  await fixture.controller.refresh();const document=fixture.dom.window.document;
  await document.getElementById('importCompanyTemplateFile').onchange({target:{files:[template.blob]}});
  assert.equal(document.getElementById('companyImportPreview').hidden,false);
  assert.match(document.getElementById('companyImportSummary').textContent,/Imported Engineering/);
  assert.equal(saved.companyName,'Old Engineering');assert.deepEqual([...store.values.keys()],['logo-old']);
  await document.getElementById('confirmCompanyImport').onclick();
  assert.equal(saved.companyName,'Old Engineering');assert.deepEqual([...store.values.keys()],['logo-old']);
  assert.match(document.getElementById('companyProfileStatus').textContent,/metadata unavailable/);
  fail=false;
  await document.getElementById('confirmCompanyImport').onclick();
  assert.equal(saved.companyName,'Imported Engineering');assert.notEqual(saved.logoAssetId,'logo-incoming');
  assert.equal(store.values.has('logo-old'),false);assert.equal(store.values.size,1);
});

test('successful import retires a staged manual logo so a later text save keeps the imported asset',async t=>{
  const old=await asset(),incoming=await asset('logo-import-source','Imported Brand'),store=memoryStore([old]);
  const template=await exportCompanyTemplate({profile:incoming.profile,assetStore:memoryStore([incoming]),Zip:JSZip});
  const fixture=setup({persisted:old.profile,store});t.after(()=>{fixture.controller.destroy();fixture.dom.window.close();});
  await fixture.controller.refresh();await fixture.controller.open();const document=fixture.dom.window.document,logoInput=document.getElementById('companyLogo');
  fixture.dom.window.createImageBitmap=async()=>({width:640,height:320,close(){}});
  await logoInput.onchange({target:{files:[new Blob([PNG],{type:'image/png'})]}});
  Object.defineProperty(logoInput,'value',{value:'C:\\fakepath\\manual-a.png',writable:true,configurable:true});
  fixture.dom.window.createImageBitmap=async()=>({width:320,height:160,close(){}});
  await document.getElementById('importCompanyTemplateFile').onchange({target:{files:[template.blob],value:'template-b.zip'}});
  assert.equal(await document.getElementById('confirmCompanyImport').onclick(),true);
  const importedId=fixture.saved.logoAssetId;
  assert.equal(logoInput.value,'');assert.equal(store.values.size,1);assert.equal(store.values.has(importedId),true);
  await fixture.controller.open();document.getElementById('companyName').value='Imported Brand Edited';
  assert.equal(await document.getElementById('companyProfileForm').onsubmit({preventDefault(){}}),true);
  assert.equal(fixture.saved.logoAssetId,importedId);assert.equal(fixture.saved.logoWidth,320);
  assert.deepEqual([...store.values.keys()],[importedId]);
});

test('successful import clears a stale manual logo error before a later text save',async t=>{
  const old=await asset(),incoming=await asset('logo-import-source','Valid Imported Brand'),store=memoryStore([old]);
  const template=await exportCompanyTemplate({profile:incoming.profile,assetStore:memoryStore([incoming]),Zip:JSZip});
  const fixture=setup({persisted:old.profile,store});t.after(()=>{fixture.controller.destroy();fixture.dom.window.close();});
  await fixture.controller.refresh();await fixture.controller.open();const document=fixture.dom.window.document,logoInput=document.getElementById('companyLogo');
  await logoInput.onchange({target:{files:[new Blob(['not an image'],{type:'image/png'})]}});
  assert.match(document.getElementById('logoError').textContent,/signature|PNG or JPEG/i);
  await document.getElementById('importCompanyTemplateFile').onchange({target:{files:[template.blob],value:'template-b.zip'}});
  assert.equal(await document.getElementById('confirmCompanyImport').onclick(),true);
  const importedId=fixture.saved.logoAssetId;
  assert.equal(document.getElementById('logoError').textContent,'');assert.equal(logoInput.getAttribute('aria-invalid'),null);
  await fixture.controller.open();document.getElementById('companyName').value='Valid Imported Brand Edited';
  assert.equal(await document.getElementById('companyProfileForm').onsubmit({preventDefault(){}}),true);
  assert.equal(fixture.saved.logoAssetId,importedId);assert.deepEqual([...store.values.keys()],[importedId]);
});

test('failed import preserves a staged manual logo for saving after import cancellation',async t=>{
  const old=await asset(),incoming=await asset('logo-import-source','Rejected Import'),store=memoryStore([old]);
  const template=await exportCompanyTemplate({profile:incoming.profile,assetStore:memoryStore([incoming]),Zip:JSZip});
  let saved=structuredClone(old.profile),rejectImport=true;
  const fixture=setup({persisted:old.profile,store,saveProfile:profile=>{if(rejectImport)throw Error('metadata unavailable');saved=structuredClone(profile);}});
  t.after(()=>{fixture.controller.destroy();fixture.dom.window.close();});
  await fixture.controller.refresh();await fixture.controller.open();const document=fixture.dom.window.document,logoInput=document.getElementById('companyLogo');
  fixture.dom.window.createImageBitmap=async()=>({width:640,height:320,close(){}});
  await logoInput.onchange({target:{files:[new Blob([PNG],{type:'image/png'})]}});
  Object.defineProperty(logoInput,'value',{value:'C:\\fakepath\\manual-a.png',writable:true,configurable:true});
  fixture.dom.window.createImageBitmap=async()=>({width:320,height:160,close(){}});
  await document.getElementById('importCompanyTemplateFile').onchange({target:{files:[template.blob],value:'template-b.zip'}});
  assert.equal(await document.getElementById('confirmCompanyImport').onclick(),false);
  assert.equal(logoInput.value,'C:\\fakepath\\manual-a.png');assert.deepEqual([...store.values.keys()],['logo-old']);
  assert.equal(document.getElementById('cancelCompanyImport').onclick(),true);
  rejectImport=false;document.getElementById('companyName').value='Manual Draft Saved';
  assert.equal(await document.getElementById('companyProfileForm').onsubmit({preventDefault(){}}),true);
  assert.equal(saved.companyName,'Manual Draft Saved');assert.equal(saved.logoWidth,640);assert.notEqual(saved.logoAssetId,'logo-old');
  assert.equal(store.values.size,1);assert.equal(store.values.has(saved.logoAssetId),true);assert.equal(store.values.has('logo-old'),false);
});

test('template export downloads safely, revokes its URL, and closing edit restores keyboard focus',async t=>{
  const current=await asset(),fixture=setup({persisted:current.profile,store:memoryStore([current])});
  const document=fixture.dom.window.document,edit=document.getElementById('editCompanyProfile');
  const original={create:URL.createObjectURL,revoke:URL.revokeObjectURL};let revoked,clicked;
  URL.createObjectURL=()=> 'blob:company-template';URL.revokeObjectURL=url=>{revoked=url;};
  document.addEventListener('click',event=>{if(event.target.tagName==='A'){clicked={href:event.target.href,download:event.target.download};event.preventDefault();}});
  t.after(()=>{URL.createObjectURL=original.create;URL.revokeObjectURL=original.revoke;fixture.controller.destroy();fixture.dom.window.close();});
  await fixture.controller.refresh();edit.focus();await fixture.controller.open();
  document.getElementById('companyName').value='Edited Engineering';await document.getElementById('companyProfileForm').onsubmit({preventDefault(){}});
  await fixture.controller.open();assert.equal(document.getElementById('companyName').value,'Edited Engineering');fixture.controller.close();assert.equal(document.activeElement,edit);
  await document.getElementById('exportCompanyTemplate').onclick();
  assert.equal(clicked.download,'edited-engineering.phasei-template.zip');assert.match(clicked.href,/blob:company-template$/);
  await new Promise(resolve=>setTimeout(resolve,0));assert.equal(revoked,'blob:company-template');
});

test('save waits for the current logo decode and never persists the previous logo',async t=>{
  const old=await asset(),store=memoryStore([old]),fixture=setup({persisted:old.profile,store});
  t.after(()=>{fixture.controller.destroy();fixture.dom.window.close();});
  await fixture.controller.refresh();await fixture.controller.open();const document=fixture.dom.window.document,gated=deferred();
  fixture.dom.window.createImageBitmap=()=>gated.promise;fill(document,{companyName:'Waiting Company'});
  const selecting=document.getElementById('companyLogo').onchange({target:{files:[new Blob([PNG],{type:'image/png'})]}});
  const saving=document.getElementById('companyProfileForm').onsubmit({preventDefault(){}});
  await Promise.resolve();assert.equal(fixture.saved.companyName,'Old Engineering');assert.equal(document.getElementById('companyProfileDialog').hidden,false);
  assert.equal(document.getElementById('saveCompanyProfile').disabled,true);assert.match(document.getElementById('companyProfileStatus').textContent,/decod|prepar/i);
  gated.resolve({width:640,height:320,close(){}});await selecting;assert.equal(await saving,true);
  assert.equal(fixture.saved.companyName,'Waiting Company');assert.equal(fixture.saved.logoWidth,640);assert.equal(store.values.has('logo-old'),false);
});

test('a stale logo decode cannot overwrite a newer selection that finished first',async t=>{
  const old=await asset(),store=memoryStore([old]),fixture=setup({persisted:old.profile,store});
  t.after(()=>{fixture.controller.destroy();fixture.dom.window.close();});
  await fixture.controller.refresh();await fixture.controller.open();const document=fixture.dom.window.document,a=deferred(),b=deferred(),gates=[a,b];
  fixture.dom.window.createImageBitmap=()=>gates.shift().promise;fill(document,{companyName:'Latest Logo Company'});
  const selectingA=document.getElementById('companyLogo').onchange({target:{files:[new Blob([PNG],{type:'image/png'})]}});
  const selectingB=document.getElementById('companyLogo').onchange({target:{files:[new Blob([PNG],{type:'image/png'})]}});
  b.resolve({width:800,height:400,close(){}});await selectingB;
  a.resolve({width:200,height:100,close(){}});await selectingA;
  assert.equal(await document.getElementById('companyProfileForm').onsubmit({preventDefault(){}}),true);
  assert.equal(fixture.saved.logoWidth,800);assert.equal([...store.values.values()][0].metadata.width,800);
});

test('a stale template decode cannot replace a newer import preview',async t=>{
  const old=await asset(),incomingA=await asset('logo-a','Import A'),incomingB=await asset('logo-b','Import B'),store=memoryStore([old]);
  const [templateA,templateB]=await Promise.all([incomingA,incomingB].map(incoming=>exportCompanyTemplate({profile:incoming.profile,assetStore:memoryStore([incoming]),Zip:JSZip})));
  const fixture=setup({persisted:old.profile,store});t.after(()=>{fixture.controller.destroy();fixture.dom.window.close();});await fixture.controller.refresh();
  const document=fixture.dom.window.document,a=deferred(),b=deferred(),gates=[a,b];let decodes=0;
  fixture.dom.window.createImageBitmap=()=>{decodes++;return gates.shift()?.promise||Promise.resolve({width:320,height:160,close(){}});};
  const waitForDecode=async count=>{for(let tries=0;decodes<count&&tries<50;tries++)await new Promise(resolve=>setImmediate(resolve));assert.equal(decodes,count);};
  const importingA=document.getElementById('importCompanyTemplateFile').onchange({target:{files:[templateA.blob],value:'a'}});await waitForDecode(1);
  const importingB=document.getElementById('importCompanyTemplateFile').onchange({target:{files:[templateB.blob],value:'b'}});await waitForDecode(2);
  b.resolve({width:320,height:160,close(){}});assert.equal(await importingB,true);a.resolve({width:320,height:160,close(){}});assert.equal(await importingA,false);
  assert.match(document.getElementById('companyImportSummary').textContent,/Import B/);assert.doesNotMatch(document.getElementById('companyImportSummary').textContent,/Import A/);
  assert.equal(await document.getElementById('confirmCompanyImport').onclick(),true,document.getElementById('companyProfileStatus').textContent);assert.equal(fixture.saved.companyName,'Import B');
});

test('destroy force-cleans an open first-use dialog and restores the host',async()=>{
  const fixture=setup();await fixture.controller.open();const document=fixture.dom.window.document,header=document.querySelector('header');
  assert.equal(document.getElementById('companyProfileDialog').hidden,false);assert.equal(header.inert,true);
  assert.equal(fixture.controller.close(),false);assert.equal(document.getElementById('companyProfileDialog').hidden,false);
  fixture.controller.destroy();assert.equal(document.getElementById('companyProfileDialog').hidden,true);
  assert.equal(document.body.classList.contains('company-profile-open'),false);assert.equal(Boolean(header.inert),false);
  fixture.dom.window.close();
});

test('double import confirmation shares one durable mutation and commits one replacement asset',async t=>{
  const old=await asset(),incoming=await asset('logo-incoming','Imported Once'),store=memoryStore([old]);
  const template=await exportCompanyTemplate({profile:incoming.profile,assetStore:memoryStore([incoming]),Zip:JSZip});let saves=0;
  const fixture=setup({persisted:old.profile,store,saveProfile:()=>{saves++;return true;}});t.after(()=>{fixture.controller.destroy();fixture.dom.window.close();});
  await fixture.controller.refresh();const document=fixture.dom.window.document;await document.getElementById('importCompanyTemplateFile').onchange({target:{files:[template.blob],value:'template'}});
  const gate=deferred(),originalPut=store.put.bind(store);let puts=0;store.put=async value=>{puts++;await gate.promise;return originalPut(value);};
  const first=document.getElementById('confirmCompanyImport').onclick(),second=document.getElementById('confirmCompanyImport').onclick();
  assert.strictEqual(second,first);
  await eventually(()=>puts>0);await new Promise(resolve=>setImmediate(resolve));const observedPuts=puts;
  gate.resolve();const results=await Promise.all([first,second]);
  assert.equal(observedPuts,1);assert.deepEqual(results,[true,true]);assert.equal(saves,1);
  assert.equal(store.values.size,1);assert.equal(store.values.has('logo-old'),false);
});

test('save in flight blocks import interleaving and all conflicting dialog paths',async t=>{
  const old=await asset(),incoming=await asset('logo-incoming','Imported Later'),store=memoryStore([old]);
  const template=await exportCompanyTemplate({profile:incoming.profile,assetStore:memoryStore([incoming]),Zip:JSZip}),gate=deferred();let saves=0;
  const fixture=setup({persisted:old.profile,store,saveProfile:()=>{saves++;return gate.promise;}});t.after(()=>{fixture.controller.destroy();fixture.dom.window.close();});
  await fixture.controller.refresh();const document=fixture.dom.window.document;await document.getElementById('importCompanyTemplateFile').onchange({target:{files:[template.blob],value:'template'}});
  document.getElementById('companyName').value='Saved Edit';const saving=document.getElementById('companyProfileForm').onsubmit({preventDefault(){}}),duplicate=document.getElementById('companyProfileForm').onsubmit({preventDefault(){}});
  assert.strictEqual(duplicate,saving);await eventually(()=>saves===1);
  const confirming=document.getElementById('confirmCompanyImport').onclick(),selection=await document.getElementById('companyLogo').onchange({target:{files:[new Blob([PNG],{type:'image/png'})]}}),observed={
    saves,assets:store.values.size,close:fixture.controller.close(),hidden:document.getElementById('companyProfileDialog').hidden,
    busy:document.getElementById('companyProfileForm').getAttribute('aria-busy'),disabled:['saveCompanyProfile','companyLogo','importCompanyTemplateFile','confirmCompanyImport','cancelCompanyImport','closeCompanyProfile'].map(id=>document.getElementById(id).disabled),
    status:document.getElementById('companyProfileStatus').textContent
  };
  gate.resolve(true);const [saved,savedAgain,imported]=await Promise.all([saving,duplicate,confirming]);
  assert.deepEqual(observed,{saves:1,assets:1,close:false,hidden:false,busy:'true',disabled:[true,true,true,true,true,true],status:observed.status});assert.match(observed.status,/saving.*company profile/i);
  assert.equal(saved,true);assert.equal(savedAgain,true);assert.equal(imported,false);assert.equal(selection,false);assert.equal(saves,1);assert.equal(store.values.size,1);
});

test('cancel cannot contradict an in-flight import failure, which rolls back and restores retry',async t=>{
  const old=await asset(),incoming=await asset('logo-incoming','Retry Import'),store=memoryStore([old]);
  const template=await exportCompanyTemplate({profile:incoming.profile,assetStore:memoryStore([incoming]),Zip:JSZip}),failure=deferred();let saves=0;
  const fixture=setup({persisted:old.profile,store,saveProfile:()=>++saves===1?failure.promise:true});t.after(()=>{fixture.controller.destroy();fixture.dom.window.close();});
  await fixture.controller.refresh();const document=fixture.dom.window.document;await document.getElementById('importCompanyTemplateFile').onchange({target:{files:[template.blob],value:'template'}});
  const confirming=document.getElementById('confirmCompanyImport').onclick();await eventually(()=>saves===1);const before=document.getElementById('companyProfileStatus').textContent;
  const cancelResult=document.getElementById('cancelCompanyImport').onclick(),observed={busy:document.getElementById('companyProfileForm').getAttribute('aria-busy'),cancelDisabled:document.getElementById('cancelCompanyImport').disabled,
    previewHidden:document.getElementById('companyImportPreview').hidden,status:document.getElementById('companyProfileStatus').textContent,assets:store.values.size};
  failure.reject(new Error('metadata unavailable'));assert.equal(await confirming,false);
  const afterFailure={assets:[...store.values.keys()],confirmDisabled:document.getElementById('confirmCompanyImport').disabled,cancelDisabled:document.getElementById('cancelCompanyImport').disabled,
    logoDisabled:document.getElementById('companyLogo').disabled,busy:document.getElementById('companyProfileForm').getAttribute('aria-busy'),focus:document.activeElement.id};
  const retried=await document.getElementById('confirmCompanyImport').onclick();
  assert.equal(cancelResult,false);assert.deepEqual(observed,{busy:'true',cancelDisabled:true,previewHidden:false,status:before,assets:2});assert.match(before,/saving.*imported/i);
  assert.deepEqual(afterFailure,{assets:['logo-old'],confirmDisabled:false,cancelDisabled:false,logoDisabled:false,busy:'false',focus:'confirmCompanyImport'});
  assert.equal(retried,true);assert.equal(saves,2);assert.equal(store.values.size,1);assert.equal(store.values.has('logo-old'),false);
});

test('destroy during an awaited first-use open cannot later show the dialog or inert the host',async()=>{
  const old=await asset(),store=memoryStore([old]),read=deferred();let reads=0;store.get=()=>{reads++;return read.promise;};
  const fixture=setup({persisted:old.profile,store}),document=fixture.dom.window.document,header=document.querySelector('header');
  const opening=fixture.controller.open();await eventually(()=>reads===1);fixture.controller.destroy();read.resolve(old);await opening;
  assert.equal(document.getElementById('companyProfileDialog').hidden,true);assert.equal(document.body.classList.contains('company-profile-open'),false);assert.equal(Boolean(header.inert),false);
  fixture.dom.window.close();
});

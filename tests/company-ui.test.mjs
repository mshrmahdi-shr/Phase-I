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

function setup({persisted=null,store=memoryStore(),saveProfile}={}){
  const dom=new JSDOM(fs.readFileSync(new URL('../index.html',import.meta.url),'utf8'),{url:'https://example.test/',pretendToBeVisual:true});
  dom.window.createImageBitmap=async()=>({width:320,height:160,close(){}});
  let saved=persisted?structuredClone(persisted):null;
  const changes=[];
  const controller=createCompanyProfileDialog({
    document:dom.window.document,assetStore:store,Zip:JSZip,
    loadProfile:async()=>saved,
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
